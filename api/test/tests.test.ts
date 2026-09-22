import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import { AnswerPolicy, AssignmentPage, AssignmentView, AttemptMutationView, AttemptView, Question, TestDetail, TestPage, TestVersion, TestVersionPage } from '../src/tests.dto';

const origin = 'http://127.0.0.1:3000';
describe('PostgreSQL test constructor and attempts API', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string;
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl); assert.match(new URL(databaseUrl).pathname, /_test$/);
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), { send: async () => undefined });
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(async () => { await db.query('TRUNCATE users, rate_limits CASCADE'); });
  after(async () => { if (app) await app.close(); });
  class Client {
    constructor(readonly userId: string, readonly token: string) {}
    async request<T = { id: string; status: string; version: number; revision: number }>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
      const response = await fetch(`${base}${path}`, { method, headers: { Origin: origin, 'X-Requested-With': 'ERepetitor', 'X-Account-ID': this.userId, 'Content-Type': 'application/json', Cookie: `er_access=${this.token}`, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as T };
    }
  }
  async function account(role: Role) {
    const userId = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version) VALUES($1,$2,$3,'unused','active','test','test')`, [userId, role, `${userId}@example.test`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, `STU-${code.slice(0, 4)}-${code.slice(4)}`]);
    else await db.query(`INSERT INTO ${role === 'teacher' ? 'teacher_profiles' : 'parent_profiles'}(id,user_id) VALUES($1,$2)`, [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { userId, profileId, client: new Client(userId, token) };
  }
  async function context() {
    const teacher = await account('teacher'); const student = await account('student'); const subjectId = randomUUID(); const enrollmentId = randomUUID();
    await db.query('INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,$3)', [subjectId, teacher.profileId, 'Математика']);
    await db.query(`INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by) VALUES($1,$2,$3,$4,'active',now(),$5)`, [enrollmentId, teacher.profileId, student.profileId, subjectId, student.userId]);
    return { teacher, student, subjectId, enrollmentId };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  type Person = Awaited<ReturnType<typeof account>>;
  function questions(text = false): Question[] {
    const one = randomUUID(); const two = randomUUID(); const three = randomUUID(); const four = randomUUID();
    return [{ id: randomUUID(), type: 'single_choice', prompt: '2 + 2?', points: 2, options: [{ id: one, text: '4' }, { id: two, text: '5' }], correctOptionIds: [one], explanation: 'Два плюс два равно четыре.' },
      { id: randomUUID(), type: 'multiple_choice', prompt: 'Чётные числа', points: 3, options: [{ id: three, text: '2' }, { id: four, text: '4' }], correctOptionIds: [three, four] },
      ...(text ? [{ id: randomUUID(), type: 'text' as const, prompt: 'Объясните решение', points: 5, options: [], correctOptionIds: [] }] : [])];
  }
  async function draft(c: Context, qs = questions(), extra: Record<string, unknown> = {}) {
    const input = { requestId: randomUUID(), subjectId: c.subjectId, title: 'Арифметика', instruction: 'Решите задания', topic: 'Числа', passPoints: 4, questions: qs, ...extra };
    const result = await c.teacher.client.request<TestDetail>('/tests', input); assert.equal(result.status, 201, JSON.stringify(result.body)); return { ...result.body, input };
  }
  async function published(c: Context, qs = questions()) {
    const d = await draft(c, qs); const result = await c.teacher.client.request<TestVersion>(`/tests/${d.id}/publish`, { revision: d.revision });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function assigned(c: Context, v?: TestVersion, extra: Record<string, unknown> = {}) {
    const version = v ?? await published(c);
    const input = { requestId: randomUUID(), versionId: version.id, enrollmentId: c.enrollmentId, maxAttempts: 2, answerPolicy: 'never', ...extra };
    const result = await c.teacher.client.request<AssignmentView>('/test-assignments', input); assert.equal(result.status, 201, JSON.stringify(result.body)); return { ...result.body, input, snapshot: version };
  }
  async function started(c: Context, assignment: { id: string }) {
    const result = await c.student.client.request<AttemptMutationView>(`/test-assignments/${assignment.id}/attempts`, { requestId: randomUUID() });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function finish(c: Context, assignment: Awaited<ReturnType<typeof assigned>>) {
    const a = await started(c, assignment);
    const answers = assignment.snapshot.questions.filter(q => q.type !== 'text').map(q => ({ questionId: q.id, selectedOptionIds: q.correctOptionIds }));
    const saved = await c.student.client.request<AttemptMutationView>(`/attempts/${a.id}/answers`, { version: a.version, answers }, 'PATCH'); assert.equal(saved.status, 200);
    const sent = await c.student.client.request<AttemptMutationView>(`/attempts/${a.id}/submit`, { version: saved.body.version }); assert.equal(sent.status, 200); return sent.body;
  }
  async function parentLink(parent: Person, student: Person, status = 'active') {
    const id = randomUUID();
    await db.query(`INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by) VALUES($1,$2,$3,$4,CASE WHEN $4='active' THEN now() END,CASE WHEN $4='active' THEN $5::uuid END)`, [id, parent.profileId, student.profileId, status, student.userId]);
    return id;
  }
  async function expire(id: string) {
    await db.query("UPDATE test_attempts SET started_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [id]);
  }
  async function future() { return (await db.query<{ at: Date }>("SELECT clock_timestamp()+interval '1 day' AS at")).rows[0]!.at.toISOString(); }
  async function error(client: Client, path: string, body: unknown, code: string, method = 'POST') {
    const r = await client.request<{ error: { code: string } }>(path, body, method); assert.equal(r.status, 409); assert.equal(r.body.error.code, code);
  }
  test('a teacher can save a draft and foreign teachers cannot read it', async () => {
    const c = await context(); const other = await account('teacher');
    const created = await c.teacher.client.request('/tests', { requestId: randomUUID(), subjectId: c.subjectId, title: 'Первый тест', questions: [] });
    assert.equal(created.status, 201); assert.equal(created.body.status, 'draft'); assert.equal(created.body.revision, 1);
    assert.equal((await other.client.request(`/tests/${created.body.id}`)).status, 404);
    assert.equal((await c.student.client.request(`/tests/${created.body.id}`)).status, 403);
  });

  test('drafts validate structure, unique UUIDs and allowlists but allow unfinished questions', async () => {
    const c = await context(); const q = questions()[0]!;
    const d = await draft(c, [{ ...q, prompt: '', options: [], correctOptionIds: [] }]);
    assert.equal((await c.teacher.client.request(`/tests/${d.id}/publish`, { revision: 1 })).status, 400);
    const base = { requestId: randomUUID(), subjectId: c.subjectId, title: 'Тест', questions: [q] };
    for (const change of [{ questions: [q, q] }, { questions: [{ ...q, options: [q.options[0], q.options[0]] }] },
      { questions: [{ ...q, correctOptionIds: [randomUUID()] }] }, { questions: [{ ...q, correctOptionIds: q.options.map(o => o.id) }] },
      { questions: [{ ...q, type: 'text' }] }, { questions: [{ ...q, points: 0 }] }, { questions: [{ ...q, points: 1.5 }] },
      { questions: [{ ...q, type: 'file' }] }, { questions: [{ ...q, prompt: 'x'.repeat(1001) }] }, { questions: [{ ...q, hidden: true }] },
      { questions: [{ ...q, options: [{ ...q.options[0], correct: true }] }] }, { questions: null }, { title: ' ' }, { passPoints: null },
      { passPoints: 1.001 }, { teacherId: c.teacher.profileId }, { topic: 'x'.repeat(201) }]) {
      const result = await c.teacher.client.request('/tests', { ...base, ...change }); assert.equal(result.status, 400, JSON.stringify(change));
    }
    assert.equal((await c.teacher.client.request('/tests?offset=-1')).status, 400);
    assert.equal((await c.teacher.client.request('/tests?limit=101')).status, 400);
  });

  test('creation retries are idempotent, updates use revision CAS and published versions are immutable snapshots', async () => {
    const c = await context(); const d = await draft(c);
    assert.equal((await c.teacher.client.request<TestDetail>('/tests', d.input)).body.id, d.id);
    await error(c.teacher.client, '/tests', { ...d.input, title: 'Другое имя' }, 'idempotency_conflict');
    const [first, duplicate] = await Promise.all([1, 2].map(() => c.teacher.client.request<TestVersion>(`/tests/${d.id}/publish`, { revision: 1 })));
    assert.equal(first!.status, 200); assert.equal(duplicate!.body.id, first!.body.id);
    const a = await assigned(c, first!.body);
    const edited = await c.teacher.client.request<TestDetail>(`/tests/${d.id}`, { revision: 2, title: 'Новая версия', instruction: 'Новая инструкция', questions: [] }, 'PATCH');
    assert.equal(edited.status, 200); assert.equal(edited.body.status, 'draft'); assert.equal(edited.body.revision, 3);
    await error(c.teacher.client, `/tests/${d.id}`, { revision: 2, title: 'Потерянное обновление', questions: [] }, 'version_conflict', 'PATCH');
    const snapshot = await c.teacher.client.request<TestVersion>(`/test-versions/${first!.body.id}`);
    assert.equal(snapshot.body.title, d.title); assert.equal(snapshot.body.topic, 'Числа'); assert.equal(snapshot.body.passPoints, 4);
    const attempt = await started(c, a); const view = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`);
    assert.equal(view.body.title, d.title); assert.equal(view.body.questions!.length, 2); assert.equal(view.body.instruction, 'Решите задания');
    await assert.rejects(db.query("UPDATE test_versions SET title='changed' WHERE id=$1", [first!.body.id]), { code: '23514' });
    await assert.rejects(db.query('DELETE FROM test_versions WHERE id=$1', [first!.body.id]), { code: '23514' });
    const list = await c.teacher.client.request<TestVersionPage>(`/tests/${d.id}/versions`); assert.equal(list.body.total, 1);
    assert.equal((await c.teacher.client.request<TestPage>('/tests?limit=1&offset=1')).body.items.length, 0);
  });

  test('publishing validates finished content and pass threshold; archive blocks future edits and assignments', async () => {
    const c = await context(); const q = questions()[0]!;
    for (const qs of [[], [{ ...q, prompt: ' ' }], [{ ...q, options: [q.options[0]!] }], [{ ...q, correctOptionIds: [] }], [{ ...q, options: q.options.map(o => ({ ...o, text: ' ' })) }]]) {
      const d = await draft(c, qs, { passPoints: 0 }); assert.equal((await c.teacher.client.request(`/tests/${d.id}/publish`, { revision: 1 })).status, 400);
    }
    const tooHigh = await draft(c, questions(), { passPoints: 6 }); assert.equal((await c.teacher.client.request(`/tests/${tooHigh.id}/publish`, { revision: 1 })).status, 400);
    const v = await published(c); const a = await assigned(c, v);
    assert.equal((await c.teacher.client.request(`/tests/${v.testId}/archive`, { revision: 2 })).status, 200);
    assert.equal((await c.teacher.client.request(`/tests/${v.testId}`, { revision: 3, title: 'Новый', questions: [] }, 'PATCH')).status, 409);
    assert.equal((await c.teacher.client.request('/test-assignments', { ...a.input, requestId: randomUUID() })).status, 409);
    assert.equal((await started(c, a)).status, 'started');
  });

  test('assignments require owned matching subject, active enrollment, valid timer and explicit deadline policy', async () => {
    const c = await context(); const other = await context(); const v = await published(c); const a = await assigned(c, v);
    assert.equal((await c.teacher.client.request<AssignmentView>('/test-assignments', a.input)).body.id, a.id);
    await error(c.teacher.client, '/test-assignments', { ...a.input, maxAttempts: 3 }, 'idempotency_conflict');
    for (const change of [{ timeLimitMin: 0 }, { timeLimitMin: 181 }, { maxAttempts: 11 }, { maxAttempts: 0 }, { dueAt: '2030-02-30T12:00:00Z' },
      { dueAt: '2030-02-28T12:00:00' }, { dueAt: '2000-01-01T00:00:00Z' }, { answerPolicy: 'after_deadline' }, { answerPolicy: 'always' }, { score: 5 }]) {
      assert.equal((await c.teacher.client.request('/test-assignments', { ...a.input, requestId: randomUUID(), ...change })).status, 400, JSON.stringify(change));
    }
    assert.equal((await other.teacher.client.request('/test-assignments', { ...a.input, requestId: randomUUID() })).status, 404);
    assert.equal((await c.teacher.client.request('/test-assignments', { ...a.input, enrollmentId: other.enrollmentId, requestId: randomUUID() })).status, 404);
    const wrongSubject = randomUUID(); const wrongEnrollment = randomUUID();
    await db.query('INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,$3)', [wrongSubject, c.teacher.profileId, 'Физика']);
    await db.query("INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by) VALUES($1,$2,$3,$4,'active',now(),$5)", [wrongEnrollment, c.teacher.profileId, c.student.profileId, wrongSubject, c.student.userId]);
    assert.equal((await c.teacher.client.request('/test-assignments', { ...a.input, enrollmentId: wrongEnrollment, requestId: randomUUID() })).status, 404);
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [c.enrollmentId]);
    assert.equal((await c.teacher.client.request('/test-assignments', { ...a.input, requestId: randomUUID() })).status, 409);
    await db.query("UPDATE enrollments SET status='active' WHERE id=$1", [c.enrollmentId]); await db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.student.userId]);
    assert.equal((await c.teacher.client.request('/test-assignments', { ...a.input, requestId: randomUUID() })).status, 409);
  });

  test('concurrent starts resume one attempt and idempotency replay never spends another attempt', async () => {
    const c = await context(); const a = await assigned(c); const requestId = randomUUID();
    const results = await Promise.all([requestId, requestId, randomUUID()].map(key => c.student.client.request<AttemptMutationView>(`/test-assignments/${a.id}/attempts`, { requestId: key })));
    assert.ok(results.every(r => r.status === 201)); assert.equal(new Set(results.map(r => r.body.id)).size, 1);
    const id = results[0]!.body.id;
    assert.equal((await c.student.client.request(`/attempts/${id}/abandon`, { version: 1 })).status, 200);
    assert.equal((await c.student.client.request<AttemptMutationView>(`/test-assignments/${a.id}/attempts`, { requestId })).body.status, 'abandoned');
    const second = await started(c, a); assert.notEqual(second.id, id);
    assert.equal((await c.student.client.request(`/attempts/${second.id}/abandon`, { version: 1 })).status, 200);
    await error(c.student.client, `/test-assignments/${a.id}/attempts`, { requestId: randomUUID() }, 'attempt_limit');
    assert.equal((await db.query('SELECT id FROM test_attempts')).rowCount, 2);
  });

  test('answer saves validate immutable question IDs and formats, reject spoofed grades and use CAS', async () => {
    const c = await context(); const a = await assigned(c, await published(c, questions(true))); const attempt = await started(c, a);
    const [single, multiple, text] = a.snapshot.questions;
    const bad = [[{ questionId: randomUUID(), text: 'x' }], [{ questionId: single!.id, selectedOptionIds: [randomUUID()] }],
      [{ questionId: single!.id, selectedOptionIds: single!.options.map(o => o.id) }], [{ questionId: single!.id, text: 'x' }],
      [{ questionId: text!.id, selectedOptionIds: [] }], [{ questionId: text!.id, text: 'x'.repeat(4001) }],
      [{ questionId: single!.id }, { questionId: single!.id }], [{ questionId: multiple!.id, selectedOptionIds: [multiple!.options[0]!.id, multiple!.options[0]!.id] }],
      [{ questionId: text!.id, text: 'x', points: 5 }]];
    for (const answers of bad) assert.equal((await c.student.client.request(`/attempts/${attempt.id}/answers`, { version: 1, answers }, 'PATCH')).status, 400, JSON.stringify(answers));
    const saves = await Promise.all(['Первый ответ', 'Второй ответ'].map(value => c.student.client.request<AttemptMutationView>(`/attempts/${attempt.id}/answers`, { version: 1, answers: [{ questionId: text!.id, text: value }] }, 'PATCH')));
    assert.deepEqual(saves.map(r => r.status).sort(), [200, 409]);
    const view = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`);
    assert.equal(view.body.version, 2); assert.equal(view.body.answers!.length, 1); assert.equal(view.body.score, undefined); assert.equal(view.body.grades, undefined);
    assert.ok(view.body.questions!.every(q => !Object.hasOwn(q, 'correctOptionIds') && !Object.hasOwn(q, 'explanation')));
  });

  test('closed grading uses exact sets and skipped answers get zero; publication alone reveals results', async () => {
    const c = await context(); const a = await assigned(c); const attempt = await started(c, a); const q = a.snapshot.questions[1]!;
    const saved = await c.student.client.request<AttemptMutationView>(`/attempts/${attempt.id}/answers`, { version: 1, answers: [{ questionId: q.id, selectedOptionIds: [q.correctOptionIds[0]] }] }, 'PATCH');
    const results = await Promise.all([1, 2].map(() => c.student.client.request<AttemptMutationView>(`/attempts/${attempt.id}/submit`, { version: saved.body.version })));
    assert.ok(results.every(r => r.status === 200)); assert.equal(results[0]!.body.status, 'completed'); assert.equal(results[0]!.body.version, 3);
    const teacher = await c.teacher.client.request<AttemptView>(`/attempts/${attempt.id}?role=teacher`); assert.equal(teacher.body.score, 0); assert.equal(teacher.body.passed, false);
    let student = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`); assert.equal(student.body.score, undefined); assert.equal(student.body.passed, undefined);
    assert.equal((await db.query("SELECT id FROM test_attempt_history WHERE attempt_id=$1 AND type='submitted'", [attempt.id])).rowCount, 1);
    const pubs = await Promise.all([1, 2].map(() => c.teacher.client.request<AttemptMutationView>(`/attempts/${attempt.id}/publish-result`, { version: 3 })));
    assert.ok(pubs.every(r => r.status === 200)); assert.equal(pubs[0]!.body.version, 4);
    student = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`); assert.equal(student.body.score, 0); assert.equal(student.body.passed, false); assert.equal(student.body.percentage, 0);
    assert.ok(student.body.questions!.every(q => !Object.hasOwn(q, 'correctOptionIds')));
    assert.equal((await c.teacher.client.request(`/attempts/${attempt.id}/review`, { version: 4, grades: [] })).status, 409);
  });

  test('blank text still requires teacher review; exact text grades, bounded decimals and correction history are enforced', async () => {
    const c = await context(); const a = await assigned(c, await published(c, questions(true))); const done = await finish(c, a); const text = a.snapshot.questions[2]!;
    assert.equal(done.status, 'waiting_review');
    assert.equal((await c.teacher.client.request(`/attempts/${done.id}/publish-result`, { version: done.version })).status, 409);
    for (const grades of [[], [{ questionId: text.id, points: 6 }], [{ questionId: text.id, points: -1 }], [{ questionId: text.id, points: 1.001 }],
      [{ questionId: text.id, points: 1 }, { questionId: text.id, points: 2 }], [{ questionId: a.snapshot.questions[0]!.id, points: 1 }]]) {
      assert.equal((await c.teacher.client.request(`/attempts/${done.id}/review`, { version: done.version, grades })).status, 400);
    }
    const review = await c.teacher.client.request<AttemptMutationView>(`/attempts/${done.id}/review`, { version: done.version, grades: [{ questionId: text.id, points: 2.25, comment: 'Обоснование' }], comment: 'Комментарий ученику' });
    assert.equal(review.status, 200); assert.equal(review.body.status, 'completed');
    let student = await c.student.client.request<AttemptView>(`/attempts/${done.id}?role=student`); assert.equal(student.body.comment, undefined); assert.equal(student.body.grades, undefined);
    const correction = await c.teacher.client.request<AttemptMutationView>(`/attempts/${done.id}/review`, { version: review.body.version, grades: [{ questionId: text.id, points: 3.5 }], comment: 'Исправлено' }); assert.equal(correction.status, 200);
    const history = await db.query<{ before_value: { comment: string }; after_value: { comment: string } }>("SELECT before_value,after_value FROM test_attempt_history WHERE attempt_id=$1 AND type='reviewed' ORDER BY occurred_at DESC", [done.id]);
    assert.equal(history.rowCount, 2); assert.equal(history.rows[0]!.before_value.comment, 'Комментарий ученику'); assert.equal(history.rows[0]!.after_value.comment, 'Исправлено');
    assert.equal((await c.teacher.client.request(`/attempts/${done.id}/publish-result`, { version: correction.body.version })).status, 200);
    student = await c.student.client.request<AttemptView>(`/attempts/${done.id}?role=student`); assert.equal(student.body.score, 8.5); assert.equal(student.body.percentage, 85); assert.equal(student.body.comment, 'Исправлено');
  });

  test('all four answer policies gate keys and explanations independently of scores and parent visibility', async () => {
    const c = await context(); const v = await published(c); const policies: AnswerPolicy[] = ['never', 'after_submission', 'after_deadline', 'after_teacher_publish'];
    for (const policy of policies) {
      const a = await assigned(c, v, { answerPolicy: policy, dueAt: await future() }); const attempt = await started(c, a);
      let view = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`); assert.equal(view.body.questions![0]!.correctOptionIds, undefined);
      const sent = await c.student.client.request<AttemptMutationView>(`/attempts/${attempt.id}/submit`, { version: 1 }); assert.equal(sent.status, 200);
      view = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`); assert.equal(!!view.body.questions![0]!.correctOptionIds, policy === 'after_submission'); assert.equal(view.body.score, undefined);
      if (policy === 'after_deadline') await db.query("UPDATE test_assignments SET due_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [a.id]);
      assert.equal((await c.teacher.client.request(`/attempts/${attempt.id}/publish-result`, { version: sent.body.version })).status, 200);
      view = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`); assert.equal(!!view.body.questions![0]!.correctOptionIds, policy !== 'never'); assert.equal(!!view.body.questions![0]!.explanation, policy !== 'never');
    }
  });

  test('timer expiry commits on reads, late writes and failed next-start limits; answers are preserved and never auto-submitted', async () => {
    const c = await context(); const v = await published(c);
    for (const action of ['get', 'save', 'submit', 'abandon', 'start']) {
      const a = await assigned(c, v, { maxAttempts: 1, timeLimitMin: 1, answerPolicy: 'after_submission' }); const attempt = await started(c, a);
      await c.student.client.request(`/attempts/${attempt.id}/answers`, { version: 1, answers: [{ questionId: v.questions[0]!.id, selectedOptionIds: v.questions[0]!.correctOptionIds }] }, 'PATCH');
      await expire(attempt.id);
      if (action === 'get') assert.equal((await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`)).body.status, 'expired');
      else if (action === 'start') await error(c.student.client, `/test-assignments/${a.id}/attempts`, { requestId: randomUUID() }, 'attempt_limit');
      else await error(c.student.client, `/attempts/${attempt.id}/${action === 'save' ? 'answers' : action}`, { version: 2, ...(action === 'save' ? { answers: [] } : {}) }, 'attempt_expired', action === 'save' ? 'PATCH' : 'POST');
      const stored = (await db.query<{ status: string; answers: unknown[]; submitted_at: Date | null; version: number }>('SELECT status,answers,submitted_at,version FROM test_attempts WHERE id=$1', [attempt.id])).rows[0]!;
      assert.equal(stored.status, 'expired'); assert.equal(stored.answers.length, 1); assert.equal(stored.submitted_at, null); assert.equal(stored.version, 3);
      const view = await c.student.client.request<AttemptView>(`/attempts/${attempt.id}?role=student`); assert.equal(view.body.questions![0]!.correctOptionIds, undefined); assert.equal(view.body.score, undefined);
    }
  });

  test('late soft deadlines allow attempts, closure blocks new starts but preserves already started work', async () => {
    const c = await context(); const a = await assigned(c, undefined, { dueAt: await future(), timeLimitMin: 60 });
    await db.query("UPDATE test_assignments SET due_at=clock_timestamp()-interval '1 day' WHERE id=$1", [a.id]);
    const first = await started(c, a); const view = await c.student.client.request<AttemptView>(`/attempts/${first.id}?role=student`);
    assert.ok(Date.parse(view.body.expiresAt!) > Date.parse(view.body.serverNow));
    await db.query("UPDATE enrollments SET status='completed' WHERE id=$1", [c.enrollmentId]);
    assert.equal((await started(c, a)).id, first.id);
    assert.equal((await c.student.client.request(`/attempts/${first.id}/submit`, { version: 1 })).status, 200);
    assert.equal((await c.student.client.request(`/test-assignments/${a.id}/attempts`, { requestId: randomUUID() })).status, 409);
    const list = await c.student.client.request<AssignmentPage>('/test-assignments?role=student'); assert.equal(list.body.items[0]!.isLate, true); assert.equal(list.body.items[0]!.attempts[0]!.status, 'completed');
  });

  test('time expiring while a write waits for a row lock is rechecked with the database clock and committed', async () => {
    const c = await context(); const a = await assigned(c, undefined, { timeLimitMin: 1 }); const attempt = await started(c, a);
    const blocker = await db.pool.connect(); let pending: ReturnType<Client['request']> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM test_attempts WHERE id=$1 FOR UPDATE', [attempt.id]);
      pending = c.student.client.request(`/attempts/${attempt.id}/answers`, { version: 1, answers: [] }, 'PATCH');
      const deadline = Date.now() + 5000; let waiting = false;
      while (Date.now() < deadline) {
        const rows = await db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM test_attempts WHERE id=%'");
        if (rows.rowCount) { waiting = true; break; }
      }
      assert.ok(waiting, 'HTTP request reached the blocked attempt-row lock');
      await blocker.query("UPDATE test_attempts SET started_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [attempt.id]);
      await blocker.query('COMMIT'); const result = await pending; assert.equal(result.status, 409);
      const stored = await db.query<{ status: string; version: number }>('SELECT status,version FROM test_attempts WHERE id=$1', [attempt.id]);
      assert.equal(stored.rows[0]!.status, 'expired'); assert.equal(stored.rows[0]!.version, 2);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
  });

  test('nested null and arrays return validation errors rather than reaching normalization or grading', async () => {
    const c = await context(); const q = questions()[0]!;
    const input = { requestId: randomUUID(), subjectId: c.subjectId, title: 'Тест', questions: [q] };
    for (const qs of [[null], [[]], [{ ...q, options: [null] }], [{ ...q, options: [[]] }], [{ ...q, correctOptionIds: [null] }]]) {
      assert.equal((await c.teacher.client.request('/tests', { ...input, questions: qs })).status, 400);
    }
    const a = await assigned(c, await published(c, questions(true))); const attempt = await started(c, a);
    assert.equal((await c.student.client.request(`/attempts/${attempt.id}/answers`, { version: 1, answers: [null] }, 'PATCH')).status, 400);
    assert.equal((await c.student.client.request(`/attempts/${attempt.id}/answers`, { version: 1, answers: [[]] }, 'PATCH')).status, 400);
    const sent = await c.student.client.request<AttemptMutationView>(`/attempts/${attempt.id}/submit`, { version: 1 });
    assert.equal((await c.teacher.client.request(`/attempts/${attempt.id}/review`, { version: sent.body.version, grades: [null] })).status, 400);
    assert.equal((await c.teacher.client.request(`/attempts/${attempt.id}/review`, { version: sent.body.version, grades: [[]] })).status, 400);
  });

  test('parents see only published totals for active links and enrollments and never get answer content', async () => {
    const c = await context(); const a = await assigned(c); const done = await finish(c, a); const parent = await account('parent'); const pending = await account('parent');
    const link = await parentLink(parent, c.student); await parentLink(pending, c.student, 'pending');
    assert.equal((await parent.client.request<AssignmentPage>('/test-assignments?role=parent')).body.total, 0);
    assert.equal((await parent.client.request(`/attempts/${done.id}?role=parent`)).status, 404);
    await c.teacher.client.request(`/attempts/${done.id}/publish-result`, { version: done.version });
    const live = await started(c, a);
    const list = await parent.client.request<AssignmentPage>('/test-assignments?role=parent'); assert.equal(list.body.total, 1); assert.equal(list.body.items[0]!.attempts.length, 1); assert.equal(list.body.items[0]!.attempts[0]!.score, 5);
    const view = await parent.client.request<AttemptView>(`/attempts/${done.id}?role=parent`); assert.equal(view.status, 200); assert.equal(view.body.score, 5);
    for (const key of ['questions', 'answers', 'grades']) assert.equal(Object.hasOwn(view.body, key), false);
    assert.equal((await parent.client.request(`/attempts/${live.id}?role=parent`)).status, 404);
    assert.equal((await pending.client.request<AssignmentPage>('/test-assignments?role=parent')).body.total, 0);
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [c.enrollmentId]); assert.equal((await parent.client.request(`/attempts/${done.id}?role=parent`)).status, 404);
    await db.query("UPDATE enrollments SET status='active' WHERE id=$1", [c.enrollmentId]);
    await c.student.client.request(`/parent-connections/${link}/revoke`, {}); assert.equal((await parent.client.request<AssignmentPage>('/test-assignments?role=parent')).body.total, 0);
  });

  test('known UUIDs, mixed roles, stale accounts and anonymous sessions do not bypass ownership', async () => {
    const c = await context(); const other = await context(); const a = await assigned(c); const attempt = await started(c, a); const parent = await account('parent');
    for (const actor of [other.teacher, other.student, parent]) {
      for (const role of ['teacher', 'student', 'parent']) {
        const r = await actor.client.request(`/attempts/${attempt.id}?role=${role}`); assert.ok([403, 404].includes(r.status));
      }
    }
    assert.equal((await other.student.client.request(`/attempts/${attempt.id}/submit`, { version: 1 })).status, 404);
    assert.equal((await other.teacher.client.request(`/attempts/${attempt.id}/review`, { version: 1, grades: [] })).status, 404);
    assert.equal((await c.student.client.request(`/attempts/${attempt.id}/publish-result`, { version: 1 })).status, 403);
    await c.teacher.client.request('/me/roles', { role: 'student' });
    assert.equal((await c.teacher.client.request(`/attempts/${attempt.id}?role=student`)).status, 404);
    assert.equal((await c.teacher.client.request(`/attempts/${attempt.id}?role=teacher`, undefined, 'GET', { 'X-Account-ID': c.student.userId })).status, 409);
    assert.equal((await new Client(c.student.userId, newToken()).request(`/attempts/${attempt.id}?role=student`)).status, 401);
    assert.equal((await other.student.client.request<AssignmentPage>('/test-assignments?role=student')).body.total, 0);
  });

  test('database composite ownership, score and active-attempt constraints reject corrupted relationships', async () => {
    const c = await context(); const other = await context(); const a = await assigned(c); const attempt = await started(c, a);
    await assert.rejects(db.query('UPDATE test_assignments SET student_id=$2 WHERE id=$1', [a.id, other.student.profileId]), { code: '23503' });
    await assert.rejects(db.query('UPDATE test_assignments SET teacher_id=$2 WHERE id=$1', [a.id, other.teacher.profileId]), { code: '23503' });
    await assert.rejects(db.query('UPDATE test_attempts SET student_id=$2 WHERE id=$1', [attempt.id, other.student.profileId]), { code: '23503' });
    await assert.rejects(db.query('UPDATE test_attempts SET score=999 WHERE id=$1', [attempt.id]), { code: '23514' });
    await assert.rejects(db.query('INSERT INTO test_attempts(id,assignment_id,student_id,number,max_points) VALUES($1,$2,$3,2,5)', [randomUUID(), a.id, c.student.profileId]), { code: '23505' });
  });

  test('paged assignment lists expire only authorized page attempts once and retain correct totals', async () => {
    const c = await context(); const v = await published(c); const own: string[] = [];
    for (let index = 0; index < 3; index++) {
      const a = await assigned(c, v, { timeLimitMin: 1 }); const attempt = await started(c, a); await expire(attempt.id); own.push(attempt.id);
    }
    const foreign = await context(); const fa = await assigned(foreign, undefined, { timeLimitMin: 1 }); const ft = await started(foreign, fa); await expire(ft.id);
    const page = await c.teacher.client.request<AssignmentPage>('/test-assignments?role=teacher&limit=2&offset=0');
    assert.equal(page.status, 200); assert.equal(page.body.total, 3); assert.equal(page.body.items.length, 2);
    assert.ok(page.body.items.every(a => a.attempts[0]!.status === 'expired' && a.attempts[0]!.version === 2));
    assert.equal((await db.query("SELECT id FROM test_attempt_history WHERE type='expired'")).rowCount, 2);
    const rest = await c.student.client.request<AssignmentPage>('/test-assignments?role=student&limit=2&offset=2'); assert.equal(rest.body.total, 3); assert.equal(rest.body.items.length, 1); assert.equal(rest.body.items[0]!.attempts[0]!.status, 'expired');
    await c.teacher.client.request('/test-assignments?role=teacher');
    assert.equal((await db.query("SELECT id FROM test_attempt_history WHERE type='expired'")).rowCount, 3);
    assert.equal((await db.query<{ status: string }>('SELECT status FROM test_attempts WHERE id=$1', [ft.id])).rows[0]!.status, 'started');
    assert.equal((await c.teacher.client.request<AssignmentPage>('/test-assignments?role=teacher&offset=99')).body.total, 3);
    assert.equal((await db.query('SELECT id FROM test_attempts WHERE id=ANY($1::uuid[])', [own])).rowCount, 3);
  });

  test('test JSON payloads allow bounded long question content while ordinary API bodies keep the smaller limit; OpenAPI exposes module', async () => {
    const c = await context(); const qs = Array.from({ length: 25 }, () => ({ ...questions()[0]!, prompt: 'Ю'.repeat(900) }));
    const d = await draft(c, qs); assert.equal(d.questionCount, 25);
    assert.equal((await c.teacher.client.request('/subjects', { name: 'x'.repeat(17000) })).status, 413);
    assert.equal((await c.teacher.client.request('/tests', { ...d.input, instruction: 'x'.repeat(530000) })).status, 413);
    const response = await fetch(`${base}/openapi.json`); const doc = await response.json() as { paths: Record<string, unknown>; components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> } };
    for (const path of ['/api/v1/tests', '/api/v1/test-versions/{id}', '/api/v1/test-assignments', '/api/v1/attempts/{id}/answers', '/api/v1/attempts/{id}/publish-result']) assert.ok(doc.paths[path]);
    assert.ok(doc.components.schemas.AttemptView?.properties?.serverNow);
    assert.ok(doc.components.schemas.PublicQuestionView?.properties?.correctOptionIds);
    assert.ok(!doc.components.schemas.PublicQuestionView?.required?.includes('correctOptionIds'));
  });
});
