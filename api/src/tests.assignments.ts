import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, ApiRequest, Role, audit, lockActiveSession } from './common';
import { Database } from './database';
import { isOffsetDateTime } from './lessons.dto';
import { notifyAssignment } from './notifications.events';
import { AnswerPolicy, AssignmentPage, AssignmentQueryDto, AssignmentView, CreateAssignmentDto, Question } from './tests.dto';
import { AttemptRow, attemptSummary, conflictTest, invalidTest, iso, missingTest, testProfile } from './tests.shared';

export type AssignmentRow = { id: string; test_id: string; version_id: string; teacher_id: string; student_id: string; subject_id: string; enrollment_id: string;
  max_attempts: number; time_limit_min: number | null; due_at: Date | null; answer_policy: AnswerPolicy; created_at: Date;
  title: string; instruction: string; topic: string | null; pass_points: string | null; questions: Question[]; max_points: number; version_number: number;
  subject_name: string; student_name: string; student_public_id: string; teacher_name: string; enrollment_status: string; student_status: string; server_now: Date };
const select = `SELECT a.*,v.title,v.instruction,v.topic,v.pass_points,v.questions,v.max_points,v.number AS version_number,
  sub.name AS subject_name,su.name AS student_name,s.public_id AS student_public_id,tu.name AS teacher_name,
  e.status AS enrollment_status,su.status AS student_status,clock_timestamp() AS server_now
  FROM test_assignments a JOIN test_versions v ON v.id=a.version_id JOIN enrollments e ON e.id=a.enrollment_id
  JOIN student_profiles s ON s.id=a.student_id JOIN users su ON su.id=s.user_id
  JOIN teacher_profiles t ON t.id=a.teacher_id JOIN users tu ON tu.id=t.user_id JOIN subjects sub ON sub.id=a.subject_id`;
export function assignmentScope(role: Role, index = 1) {
  return role === 'teacher' ? `a.teacher_id=$${index}` : role === 'student' ? `a.student_id=$${index} AND e.accepted_at IS NOT NULL`
    : `e.status='active' AND su.status='active' AND EXISTS(SELECT 1 FROM parent_connections pc WHERE pc.parent_id=$${index} AND pc.student_id=a.student_id AND pc.status='active')
       AND EXISTS(SELECT 1 FROM test_attempts p WHERE p.assignment_id=a.id AND p.status='published')`;
}
@Injectable()
export class TestAssignmentsService {
  constructor(private readonly db: Database) {}
  async row(client: PoolClient, profile: string, role: Role, id: string): Promise<AssignmentRow> {
    const result = await client.query<AssignmentRow>(`${select} WHERE ${assignmentScope(role)} AND a.id=$2`, [profile, id]);
    if (!result.rows[0]) throw missingTest(); return result.rows[0];
  }
  /** Actor is locked first by callers; these locks also serialize parent revocation and enrollment closure. */
  async lock(client: PoolClient, profile: string, role: 'teacher' | 'student', id: string) {
    const initial = await this.row(client, profile, role, id);
    await client.query('SELECT id FROM student_profiles WHERE id=$1 FOR UPDATE', [initial.student_id]);
    await client.query('SELECT id FROM enrollments WHERE id=$1 FOR UPDATE', [initial.enrollment_id]);
    await client.query('SELECT id FROM test_assignments WHERE id=$1 FOR UPDATE', [id]);
    return this.row(client, profile, role, id);
  }
  async view(client: PoolClient, row: AssignmentRow, role: Role, loaded?: AttemptRow[]): Promise<AssignmentView> {
    const attempts = loaded ?? (await client.query<AttemptRow>(`SELECT * FROM test_attempts WHERE assignment_id=$1 ${role === 'parent' ? "AND status='published'" : ''} ORDER BY number`, [row.id])).rows;
    return { id: row.id, testId: row.test_id, versionId: row.version_id, versionNumber: row.version_number, title: row.title,
      subjectName: row.subject_name, studentName: row.student_name, studentPublicId: row.student_public_id, teacherName: row.teacher_name,
      enrollmentId: row.enrollment_id, maxAttempts: row.max_attempts, ...(row.time_limit_min === null ? {} : { timeLimitMin: row.time_limit_min }),
      ...(row.due_at === null ? {} : { dueAt: iso(row.due_at) }), answerPolicy: row.answer_policy, createdAt: iso(row.created_at),
      isLate: row.due_at !== null && new Date(row.due_at).getTime() < new Date(row.server_now).getTime(),
      attempts: attempts.map(a => attemptSummary(a, role, row.pass_points)) };
  }
  async list(req: ApiRequest, query: AssignmentQueryDto): Promise<AssignmentPage> {
    return this.db.transaction(async client => {
      if (query.role === 'parent') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const user = query.role === 'parent' ? req.userId! : await lockActiveSession(client, req);
      const profile = await testProfile(client, user, query.role);
      const scope = `${assignmentScope(query.role)} AND ($2::uuid IS NULL OR a.test_id=$2)`;
      const rows = await client.query<AssignmentRow>(`${select} WHERE ${scope} ORDER BY a.created_at DESC,a.id LIMIT $3 OFFSET $4`, [profile, query.testId ?? null, query.limit, query.offset]);
      const assignmentIds = rows.rows.map(row => row.id);
      if (query.role !== 'parent' && assignmentIds.length) {
        // Lock each layer as one ordered batch before expiring attempts. This keeps
        // the writer order without holding hundreds of per-row round trips.
        await client.query('SELECT id FROM student_profiles WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...new Set(rows.rows.map(row => row.student_id))]]);
        await client.query('SELECT id FROM enrollments WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...new Set(rows.rows.map(row => row.enrollment_id))]]);
        await client.query('SELECT id FROM test_assignments WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [assignmentIds]);
        const expired = await client.query<{ id: string }>(`UPDATE test_attempts SET status='expired',version=version+1 WHERE assignment_id=ANY($1::uuid[]) AND status='started' AND expires_at<=clock_timestamp() RETURNING id`, [assignmentIds]);
        if (expired.rows.length) {
          const ids = expired.rows.map(row => row.id);
          await client.query(`INSERT INTO test_attempt_history(id,attempt_id,actor_user_id,type,before_value,after_value)
            SELECT id,attempt_id,$3,'expired','{"status":"started"}'::jsonb,'{"status":"expired"}'::jsonb FROM unnest($1::uuid[],$2::uuid[]) AS events(id,attempt_id)`, [ids.map(() => randomUUID()), ids, user]);
          await client.query(`INSERT INTO audit_events(id,actor_user_id,action,entity_id)
            SELECT id,$3,'test_attempt.expired',attempt_id FROM unnest($1::uuid[],$2::uuid[]) AS events(id,attempt_id)`, [ids.map(() => randomUUID()), ids, user]);
        }
      }
      const attempts = await client.query<AttemptRow>(`SELECT * FROM test_attempts WHERE assignment_id=ANY($1::uuid[]) ${query.role === 'parent' ? "AND status='published'" : ''} ORDER BY number`, [assignmentIds]);
      const byAssignment = new Map<string, AttemptRow[]>();
      for (const attempt of attempts.rows) { const group = byAssignment.get(attempt.assignment_id) ?? []; group.push(attempt); byAssignment.set(attempt.assignment_id, group); }
      const items: AssignmentView[] = [];
      for (const row of rows.rows) items.push(await this.view(client, row, query.role, byAssignment.get(row.id) ?? []));
      const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM test_assignments a JOIN enrollments e ON e.id=a.enrollment_id JOIN student_profiles s ON s.id=a.student_id JOIN users su ON su.id=s.user_id WHERE ${scope}`, [profile, query.testId ?? null]);
      return { items, total: count.rows[0]!.total, limit: query.limit, offset: query.offset };
    });
  }
  async create(req: ApiRequest, dto: CreateAssignmentDto): Promise<AssignmentView> {
    if (dto.dueAt !== undefined && !isOffsetDateTime(dto.dueAt)) throw invalidTest('Укажите существующий срок с часовым поясом.');
    if (dto.answerPolicy === 'after_deadline' && !dto.dueAt) throw invalidTest('Для показа ответов после срока укажите срок сдачи.');
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const teacher = await testProfile(client, user, 'teacher');
      const payload = JSON.stringify({ versionId: dto.versionId.toLowerCase(), enrollmentId: dto.enrollmentId.toLowerCase(), maxAttempts: dto.maxAttempts,
        timeLimitMin: dto.timeLimitMin ?? null, dueAt: dto.dueAt ? iso(dto.dueAt) : null, answerPolicy: dto.answerPolicy });
      const previous = await client.query<{ id: string; same: boolean }>('SELECT id,request_payload=$3::jsonb AS same FROM test_assignments WHERE teacher_id=$1 AND request_id=$2', [teacher, dto.requestId, payload]);
      if (previous.rows[0]) {
        if (!previous.rows[0].same) throw new ApiError(409, 'idempotency_conflict', 'Этот ключ запроса уже использован с другими данными.');
        return this.view(client, await this.row(client, teacher, 'teacher', previous.rows[0].id), 'teacher');
      }
      const initial = await client.query<{ student_id: string }>('SELECT student_id FROM enrollments WHERE id=$1 AND teacher_id=$2', [dto.enrollmentId, teacher]);
      if (!initial.rows[0]) throw missingTest();
      await client.query('SELECT id FROM student_profiles WHERE id=$1 FOR UPDATE', [initial.rows[0].student_id]);
      const enrollment = await client.query<{ student_id: string; subject_id: string; status: string; student_status: string }>(`SELECT e.student_id,e.subject_id,e.status,u.status AS student_status FROM enrollments e JOIN student_profiles s ON s.id=e.student_id JOIN users u ON u.id=s.user_id WHERE e.id=$1 AND e.teacher_id=$2 FOR UPDATE OF e`, [dto.enrollmentId, teacher]);
      const e = enrollment.rows[0]; if (!e) throw missingTest();
      if (e.status !== 'active' || e.student_status !== 'active') throw conflictTest('Назначить тест можно активному ученику с подтверждённой записью.');
      const version = await client.query<{ test_id: string; subject_id: string; status: string }>('SELECT v.test_id,v.subject_id,t.status FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=$1 AND v.teacher_id=$2 FOR UPDATE OF t', [dto.versionId, teacher]);
      const v = version.rows[0]; if (!v || v.subject_id !== e.subject_id) throw missingTest();
      if (v.status === 'archived') throw conflictTest('Архивный тест нельзя назначить заново.');
      const id = randomUUID();
      const inserted = await client.query(`INSERT INTO test_assignments(id,test_id,version_id,teacher_id,student_id,subject_id,enrollment_id,request_id,request_payload,max_attempts,time_limit_min,due_at,answer_policy)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::timestamptz,$13 WHERE $12::timestamptz IS NULL OR $12::timestamptz>clock_timestamp() RETURNING id`,
      [id, v.test_id, dto.versionId, teacher, e.student_id, e.subject_id, dto.enrollmentId, dto.requestId, payload, dto.maxAttempts, dto.timeLimitMin ?? null, dto.dueAt ?? null, dto.answerPolicy]);
      if (!inserted.rows[0]) throw invalidTest('Срок сдачи должен быть в будущем.');
      await audit(client, user, 'test.assigned', id); await notifyAssignment(client, id);
      return this.view(client, await this.row(client, teacher, 'teacher', id), 'teacher');
    });
  }
}
