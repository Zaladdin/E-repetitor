import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, ApiRequest, Role, lockActiveSession } from './common';
import { Database } from './database';
import { notifyResult } from './notifications.events';
import { AttemptMutationView, AttemptQueryDto, AttemptVersionDto, AttemptView, ReviewAttemptDto, SaveAnswersDto, StartAttemptDto } from './tests.dto';
import { AssignmentRow, TestAssignmentsService } from './tests.assignments';
import { AttemptRow, attemptEvent, attemptSummary, closedGrades, conflictTest, expireAttempt, invalidTest, iso, missingTest, resultVisibility, staleTest, testProfile, validateAnswers } from './tests.shared';

const mutation = (a: AttemptRow): AttemptMutationView => ({ id: a.id, status: a.status, version: a.version });
const expiredError = () => new ApiError(409, 'attempt_expired', 'Время попытки истекло. Ответы сохранены, но отправить их уже нельзя.');
const submitted = new Set(['submitted', 'waiting_review', 'completed', 'published']);

@Injectable()
export class TestAttemptsService {
  constructor(private readonly db: Database, private readonly assignments: TestAssignmentsService) {}
  private async context(client: PoolClient, profile: string, role: Role, id: string, lock: boolean) {
    const reference = await client.query<{ assignment_id: string }>('SELECT assignment_id FROM test_attempts WHERE id=$1', [id]);
    if (!reference.rows[0]) throw missingTest();
    const assignment = lock && role !== 'parent' ? await this.assignments.lock(client, profile, role, reference.rows[0].assignment_id)
      : await this.assignments.row(client, profile, role, reference.rows[0].assignment_id);
    const result = await client.query<AttemptRow>(`SELECT * FROM test_attempts WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    const attempt = result.rows[0]; if (!attempt || (role === 'parent' && attempt.status !== 'published')) throw missingTest();
    return { assignment, attempt };
  }
  async start(req: ApiRequest, id: string, dto: StartAttemptDto): Promise<AttemptMutationView> {
    const result = await this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const student = await testProfile(client, user, 'student');
      const assignment = await this.assignments.lock(client, student, 'student', id);
      const rows = await client.query<AttemptRow>('SELECT * FROM test_attempts WHERE assignment_id=$1 ORDER BY number FOR UPDATE', [id]);
      for (const a of rows.rows) await expireAttempt(client, user, a);
      const replay = await client.query<{ attempt_id: string }>('SELECT attempt_id FROM test_attempt_requests WHERE assignment_id=$1 AND request_id=$2', [id, dto.requestId]);
      if (replay.rows[0]) return mutation(rows.rows.find(a => a.id === replay.rows[0]!.attempt_id)!);
      const active = rows.rows.find(a => a.status === 'started');
      if (active) {
        await client.query('INSERT INTO test_attempt_requests(assignment_id,request_id,attempt_id) VALUES($1,$2,$3)', [id, dto.requestId, active.id]);
        return mutation(active);
      }
      // Return errors after COMMIT so the lazy expiration above is never rolled back.
      if (assignment.enrollment_status !== 'active' || assignment.student_status !== 'active') return conflictTest('Новая попытка доступна только при активной записи на предмет.');
      if (rows.rows.length >= assignment.max_attempts) return new ApiError(409, 'attempt_limit', 'Все разрешённые попытки использованы.');
      const attemptId = randomUUID();
      const created = await client.query<AttemptRow>(`INSERT INTO test_attempts(id,assignment_id,student_id,number,started_at,expires_at,max_points)
        SELECT $1,$2,$3,$4,at,CASE WHEN $5::int IS NULL THEN NULL ELSE at+make_interval(mins=>$5) END,$6 FROM (SELECT clock_timestamp() AS at) t RETURNING *`,
      [attemptId, id, student, rows.rows.length + 1, assignment.time_limit_min, assignment.max_points]);
      await client.query('INSERT INTO test_attempt_requests(assignment_id,request_id,attempt_id) VALUES($1,$2,$3)', [id, dto.requestId, attemptId]);
      await attemptEvent(client, user, attemptId, 'started'); return mutation(created.rows[0]!);
    });
    if (result instanceof ApiError) throw result; return result;
  }
  async get(req: ApiRequest, id: string, query: AttemptQueryDto): Promise<AttemptView> {
    return this.db.transaction(async client => {
      if (query.role === 'parent') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const user = query.role === 'parent' ? req.userId! : await lockActiveSession(client, req); const profile = await testProfile(client, user, query.role);
      const { assignment, attempt } = await this.context(client, profile, query.role, id, query.role !== 'parent');
      if (query.role !== 'parent') await expireAttempt(client, user, attempt);
      const clock = (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
      const keys = query.role === 'teacher' || (query.role === 'student' && submitted.has(attempt.status) &&
        (assignment.answer_policy === 'after_submission' || assignment.answer_policy === 'after_teacher_publish' && attempt.status === 'published'
          || assignment.answer_policy === 'after_deadline' && assignment.due_at !== null && new Date(assignment.due_at) <= clock));
      return { ...attemptSummary(attempt, query.role, assignment.pass_points, assignment.questions, assignment.result_policy), assignmentId: assignment.id, title: assignment.title,
        instruction: assignment.instruction, ...(assignment.topic === null ? {} : { topic: assignment.topic }), studentName: assignment.student_name,
        subjectName: assignment.subject_name, teacherName: assignment.teacher_name, answerPolicy: assignment.answer_policy, resultPolicy: assignment.result_policy, serverNow: iso(clock),
        ...(query.role === 'parent' ? {} : { questions: assignment.questions.map(q => ({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, options: q.options,
          ...(keys ? { correctOptionIds: q.correctOptionIds, ...(q.explanation === undefined ? {} : { explanation: q.explanation }) } : {}) })), answers: attempt.answers,
        ...(query.role === 'teacher' || resultVisibility(attempt, query.role, assignment.result_policy) === 'visible' ? { grades: attempt.grades } : {}) }) };
    });
  }
  private async write(req: ApiRequest, id: string, role: 'teacher' | 'student', operation: (client: PoolClient, user: string, assignment: AssignmentRow, attempt: AttemptRow) => Promise<AttemptMutationView | ApiError>): Promise<AttemptMutationView> {
    const result = await this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const profile = await testProfile(client, user, role);
      const { assignment, attempt } = await this.context(client, profile, role, id, true);
      if (await expireAttempt(client, user, attempt)) return expiredError();
      return operation(client, user, assignment, attempt);
    });
    if (result instanceof ApiError) throw result; return result;
  }
  async save(req: ApiRequest, id: string, dto: SaveAnswersDto): Promise<AttemptMutationView> {
    return this.write(req, id, 'student', async (client, user, assignment, a) => {
      if (a.status !== 'started') throw conflictTest(); if (a.version !== dto.version) throw staleTest();
      const answers = validateAnswers(dto.answers, assignment.questions);
      const result = await client.query<AttemptRow>(`UPDATE test_attempts SET answers=$2::jsonb,version=version+1 WHERE id=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING *`, [id, JSON.stringify(answers)]);
      if (!result.rows[0]) { await expireAttempt(client, user, a); return expiredError(); }
      await attemptEvent(client, user, id, 'answers_saved', { answers: a.answers }, { answers });
      const clock = (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
      return { ...mutation(result.rows[0]), serverNow: iso(clock), ...(a.expires_at ? { expiresAt: iso(a.expires_at) } : {}) };
    });
  }
  async submit(req: ApiRequest, id: string, dto: AttemptVersionDto): Promise<AttemptMutationView> {
    return this.write(req, id, 'student', async (client, user, assignment, a) => {
      if (submitted.has(a.status)) return mutation(a);
      if (a.status !== 'started') throw conflictTest(); if (a.version !== dto.version) throw staleTest();
      const grades = closedGrades(assignment.questions, a.answers); const manual = assignment.questions.some(q => q.type === 'text');
      const score = grades.reduce((sum, g) => sum + g.points, 0); const status = manual ? 'waiting_review' : 'completed';
      const result = await client.query<AttemptRow>(`UPDATE test_attempts SET status=$2,grades=$3::jsonb,score=$4,submitted_at=clock_timestamp(),version=version+1 WHERE id=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING *`, [id, status, JSON.stringify(grades), score]);
      if (!result.rows[0]) { await expireAttempt(client, user, a); return expiredError(); }
      await attemptEvent(client, user, id, 'submitted', { status: a.status }, { status, grades, score }); return mutation(result.rows[0]);
    });
  }
  async abandon(req: ApiRequest, id: string, dto: AttemptVersionDto): Promise<AttemptMutationView> {
    return this.write(req, id, 'student', async (client, user, _assignment, a) => {
      if (a.status !== 'started') throw conflictTest(); if (a.version !== dto.version) throw staleTest();
      const result = await client.query<AttemptRow>(`UPDATE test_attempts SET status='abandoned',version=version+1 WHERE id=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING *`, [id]);
      if (!result.rows[0]) { await expireAttempt(client, user, a); return expiredError(); }
      await attemptEvent(client, user, id, 'abandoned'); return mutation(result.rows[0]);
    });
  }
  async review(req: ApiRequest, id: string, dto: ReviewAttemptDto): Promise<AttemptMutationView> {
    return this.write(req, id, 'teacher', async (client, user, assignment, a) => {
      if (!['waiting_review', 'completed'].includes(a.status)) throw conflictTest(); if (a.version !== dto.version) throw staleTest();
      const text = assignment.questions.filter(q => q.type === 'text'); const ids = new Set(dto.grades.map(g => g.questionId.toLowerCase()));
      if (ids.size !== dto.grades.length || ids.size !== text.length || text.some(q => !ids.has(q.id))) throw invalidTest('Оцените каждый текстовый вопрос, не меняя автоматические оценки.');
      const manual = dto.grades.map(g => {
        const q = text.find(q => q.id === g.questionId.toLowerCase())!;
        if (g.points > q.points) throw invalidTest('Оценка превышает балл вопроса.');
        return { questionId: q.id, points: g.points, ...(g.comment === undefined ? {} : { comment: g.comment }) };
      });
      const grades = [...closedGrades(assignment.questions, a.answers), ...manual]; const score = Math.round(grades.reduce((sum, g) => sum + g.points, 0) * 100) / 100;
      const result = await client.query<AttemptRow>("UPDATE test_attempts SET status='completed',grades=$2::jsonb,score=$3,comment=$4,version=version+1 WHERE id=$1 RETURNING *", [id, JSON.stringify(grades), score, dto.comment ?? null]);
      await attemptEvent(client, user, id, 'reviewed', { grades: a.grades, score: a.score, comment: a.comment }, { grades, score, comment: dto.comment ?? null }); return mutation(result.rows[0]!);
    });
  }
  async publish(req: ApiRequest, id: string, dto: AttemptVersionDto): Promise<AttemptMutationView> {
    return this.write(req, id, 'teacher', async (client, user, assignment, a) => {
      if (a.status === 'published') return mutation(a);
      if (a.status !== 'completed') throw conflictTest('Сначала проверьте все текстовые ответы.'); if (a.version !== dto.version) throw staleTest();
      if (assignment.questions.some(q => !a.grades.some(g => g.questionId === q.id))) throw conflictTest('Не все вопросы оценены.');
      const result = await client.query<AttemptRow>("UPDATE test_attempts SET status='published',published_at=clock_timestamp(),version=version+1 WHERE id=$1 RETURNING *", [id]);
      await attemptEvent(client, user, id, 'published'); await notifyResult(client, id); return mutation(result.rows[0]!);
    });
  }
}
