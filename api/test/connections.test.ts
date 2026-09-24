import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import { EnrollmentPage, ParentChildrenPage, ParentConnectionPage } from '../src/connections.dto';

const origin = 'http://127.0.0.1:3000';
type Mutation = { id: string; status: string };
type ErrorBody = { error: { code: string; message: string } };

describe('PostgreSQL connections API', { concurrency: false }, () => {
  let app: INestApplication;
  let db: Database;
  let base: string;
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; PostgreSQL integration tests cannot be skipped');
    assert.match(new URL(databaseUrl).pathname, /_test$/, 'Only a dedicated test database may be truncated');
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), { send: async () => undefined });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(async () => { await db.query('TRUNCATE users, rate_limits CASCADE'); });
  after(async () => { if (app) await app.close(); });

  class Client {
    constructor(readonly userId: string, readonly token: string) {}
    async request<T = Mutation>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
      const response = await fetch(`${base}${path}`, { method, headers: {
        Origin: origin, 'X-Requested-With': 'ERepetitor', 'X-Account-ID': this.userId,
        'Content-Type': 'application/json', Cookie: `er_access=${this.token}`, ...extra,
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as T, headers: response.headers };
    }
  }
  // Authentication itself is exercised in accounts.test.ts. These fixtures provide
  // real active accounts and hashed access sessions for the production HTTP guard.
  async function account(role: Role, name: string) {
    const userId = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    const publicId = `STU-${code.slice(0, 4)}-${code.slice(4)}`;
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,'unused-test-fixture','active','test','test')`, [userId, name, `${userId}@example.com`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, publicId]);
    else if (role === 'teacher') await db.query('INSERT INTO teacher_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    else await db.query('INSERT INTO parent_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { client: new Client(userId, token), userId, profileId, publicId, name };
  }
  async function subject(teacher: Awaited<ReturnType<typeof account>>, name = 'Математика') {
    const response = await teacher.client.request<{ id: string }>('/subjects', { name }); assert.equal(response.status, 201); return response.body.id;
  }
  async function enrollment(teacher: Awaited<ReturnType<typeof account>>, student: Awaited<ReturnType<typeof account>>, subjectId: string) {
    const result = await teacher.client.request('/enrollments', { publicId: student.publicId.toLowerCase(), subjectId });
    assert.equal(result.status, 201); return result.body.id;
  }
  async function parentConnection(parent: Awaited<ReturnType<typeof account>>, student: Awaited<ReturnType<typeof account>>) {
    const result = await parent.client.request('/parent-connections', { publicId: student.publicId.toLowerCase() });
    assert.equal(result.status, 201); return result.body.id;
  }

  test('one child joins two isolated tutors; parent sees subjects only after student approval', async () => {
    const anna = await account('teacher', 'Анна Смирнова'); const murad = await account('teacher', 'Мурад Гасанов');
    const ali = await account('student', 'Али Мамедов'); const other = await account('student', 'Другой ученик');
    const leyla = await account('parent', 'Лейла Мамедова');
    await db.query("UPDATE teacher_profiles SET phone='+994501234567',birth_date='1992-02-29' WHERE id=$1", [anna.profileId]);
    const math = await subject(anna); const physics = await subject(murad, 'Физика');
    const mathId = await enrollment(anna, ali, math); const physicsId = await enrollment(murad, ali, physics);
    const pending = await anna.client.request<EnrollmentPage>('/enrollments?role=teacher');
    assert.equal(pending.body.total, 1); assert.equal(pending.body.items[0]!.studentName, undefined);
    assert.equal((await anna.client.request('/enrollments', { publicId: ali.publicId, subjectId: physics })).status, 404);
    assert.equal((await murad.client.request(`/enrollments/${mathId}`, { status: 'paused' }, 'PATCH')).status, 404);
    assert.equal((await other.client.request(`/enrollments/${mathId}/accept`, {})).status, 404);
    assert.equal((await leyla.client.request(`/enrollments/${mathId}/accept`, {})).status, 403);
    for (const id of [mathId, physicsId]) assert.equal((await ali.client.request(`/enrollments/${id}/accept`, {})).status, 200);
    const confirmed = await anna.client.request<EnrollmentPage>('/enrollments?role=teacher');
    assert.equal(confirmed.body.items[0]!.studentName, ali.name); assert.equal(confirmed.body.total, 1);
    const connectionId = await parentConnection(leyla, ali);
    const before = await leyla.client.request<ParentChildrenPage>('/parent-children'); assert.deepEqual(before.body.items, []);
    const outgoing = await leyla.client.request<ParentConnectionPage>('/parent-connections?role=parent');
    assert.equal(outgoing.body.items[0]!.studentName, undefined); assert.equal(outgoing.body.items[0]!.parentName, undefined);
    const incoming = await ali.client.request<ParentConnectionPage>('/parent-connections?role=student');
    assert.equal(incoming.body.items[0]!.parentName, leyla.name);
    assert.equal((await other.client.request(`/parent-connections/${connectionId}/approve`, {})).status, 404);
    assert.equal((await leyla.client.request(`/parent-connections/${connectionId}/approve`, {})).status, 403);
    assert.equal((await ali.client.request(`/parent-connections/${connectionId}/approve`, {})).status, 200);
    const children = await leyla.client.request<ParentChildrenPage>('/parent-children');
    assert.equal(children.body.total, 1); assert.equal(children.body.items[0]!.publicId, ali.publicId);
    assert.deepEqual(children.body.items[0]!.enrollments.map(item => item.subjectName).sort(), ['Математика', 'Физика']);
    assert.ok(!JSON.stringify(children.body).includes('email')); assert.ok(!JSON.stringify(children.body).includes('notes'));
    for (const response of [children.body, confirmed.body]) {
      const serialized = JSON.stringify(response);
      assert.ok(!serialized.includes('phone')); assert.ok(!serialized.includes('birthDate'));
      assert.ok(!serialized.includes('+994501234567')); assert.ok(!serialized.includes('1992-02-29'));
    }
    assert.equal((await anna.client.request('/parent-children')).status, 403);
  });

  test('duplicate concurrent requests and decisions are idempotent and audited once', async () => {
    const teacher = await account('teacher', 'Первый преподаватель'); const student = await account('student', 'Ученик');
    const parent = await account('parent', 'Родитель'); const subjectId = await subject(teacher);
    const enrollments = await Promise.all([1, 2, 3].map(() => teacher.client.request('/enrollments', { publicId: student.publicId, subjectId })));
    assert.ok(enrollments.every(item => item.status === 201)); assert.equal(new Set(enrollments.map(item => item.body.id)).size, 1);
    const id = enrollments[0]!.body.id;
    const accepted = await Promise.all([1, 2].map(() => student.client.request(`/enrollments/${id}/accept`, {})));
    assert.ok(accepted.every(item => item.status === 200));
    assert.equal((await teacher.client.request('/enrollments', { publicId: student.publicId, subjectId })).status, 409);
    const connections = await Promise.all([1, 2, 3].map(() => parent.client.request('/parent-connections', { publicId: student.publicId })));
    assert.ok(connections.every(item => item.status === 201)); assert.equal(new Set(connections.map(item => item.body.id)).size, 1);
    const parentId = connections[0]!.body.id;
    const approved = await Promise.all([1, 2].map(() => student.client.request(`/parent-connections/${parentId}/approve`, {})));
    assert.ok(approved.every(item => item.status === 200));
    for (const [entityId, action] of [[id, 'enrollment.requested'], [id, 'enrollment.pending.active'], [parentId, 'parent_connection.requested'], [parentId, 'parent_connection.pending.active']]) {
      assert.equal((await db.query('SELECT id FROM audit_events WHERE entity_id=$1 AND action=$2', [entityId, action])).rowCount, 1);
    }
    const approval = (await db.query<{ approved_by: string }>('SELECT approved_by FROM parent_connections WHERE id=$1', [parentId])).rows[0]!;
    assert.equal(approval.approved_by, student.userId);
  });

  test('expired requests use database time, commit expiry audit on failed accept and permit a fresh request', async () => {
    const teacher = await account('teacher', 'Преподаватель'); const student = await account('student', 'Ученик'); const subjectId = await subject(teacher);
    const id = await enrollment(teacher, student, subjectId);
    await db.query("UPDATE enrollments SET created_at=now()-interval '8 days',expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    const list = await student.client.request<EnrollmentPage>('/enrollments?role=student'); assert.equal(list.body.items[0]!.status, 'expired');
    const late = await student.client.request<ErrorBody>(`/enrollments/${id}/accept`, {});
    assert.equal(late.status, 409); assert.equal(late.body.error.code, 'invalid_transition');
    assert.equal((await db.query<{ status: string }>('SELECT status FROM enrollments WHERE id=$1', [id])).rows[0]!.status, 'expired');
    assert.equal((await db.query("SELECT id FROM audit_events WHERE entity_id=$1 AND action='enrollment.pending.expired' AND actor_user_id IS NULL", [id])).rowCount, 1);
    const next = await enrollment(teacher, student, subjectId); assert.notEqual(next, id);
    assert.equal((await student.client.request(`/enrollments/${id}/accept`, {})).status, 409);
    assert.equal((await student.client.request(`/enrollments/${next}/reject`, {})).status, 200);
    assert.equal((await student.client.request(`/enrollments/${next}/accept`, {})).status, 409);
    assert.notEqual(await enrollment(teacher, student, subjectId), next);
  });

  test('teacher transitions are restricted and parent aggregation follows active enrollment status', async () => {
    const teacher = await account('teacher', 'Преподаватель'); const student = await account('student', 'Ученик'); const parent = await account('parent', 'Родитель');
    const subjectId = await subject(teacher); const id = await enrollment(teacher, student, subjectId);
    assert.equal((await teacher.client.request(`/enrollments/${id}`, { status: 'active' }, 'PATCH')).status, 409);
    assert.equal((await student.client.request(`/enrollments/${id}/accept`, {})).status, 200);
    const connection = await parentConnection(parent, student); await student.client.request(`/parent-connections/${connection}/approve`, {});
    for (const status of ['paused', 'active', 'completed']) {
      const updated = await teacher.client.request(`/enrollments/${id}`, { status }, 'PATCH'); assert.equal(updated.status, 200); assert.equal(updated.body.status, status);
      const children = await parent.client.request<ParentChildrenPage>('/parent-children');
      assert.equal(children.body.items[0]!.enrollments.length, status === 'active' ? 1 : 0);
    }
    assert.equal((await teacher.client.request(`/enrollments/${id}`, { status: 'active' }, 'PATCH')).status, 409);
    assert.equal((await student.client.request(`/enrollments/${id}`, { status: 'cancelled' }, 'PATCH')).status, 403);
    const replacement = await enrollment(teacher, student, subjectId); await student.client.request(`/enrollments/${replacement}/accept`, {});
    assert.equal((await teacher.client.request(`/enrollments/${replacement}`, { status: 'cancelled' }, 'PATCH')).status, 200);
    assert.equal((await teacher.client.request(`/enrollments/${replacement}`, { status: 'active' }, 'PATCH')).status, 409);
  });

  test('multiple children and parents remain independent; owner revocation immediately removes access', async () => {
    const first = await account('student', 'Первый ребёнок'); const second = await account('student', 'Второй ребёнок');
    const parent = await account('parent', 'Первый родитель'); const otherParent = await account('parent', 'Другой родитель');
    const links: string[] = [];
    for (const child of [first, second]) {
      const id = await parentConnection(parent, child); await child.client.request(`/parent-connections/${id}/approve`, {}); links.push(id);
    }
    const otherLink = await parentConnection(otherParent, first); await first.client.request(`/parent-connections/${otherLink}/approve`, {});
    assert.equal((await parent.client.request<ParentChildrenPage>('/parent-children')).body.total, 2);
    assert.equal((await otherParent.client.request(`/parent-connections/${links[0]}/revoke`, {})).status, 404);
    assert.equal((await second.client.request(`/parent-connections/${links[0]}/revoke`, {})).status, 404);
    assert.equal((await first.client.request(`/parent-connections/${links[0]}/revoke`, {})).status, 200);
    const remaining = await parent.client.request<ParentChildrenPage>('/parent-children'); assert.equal(remaining.body.total, 1); assert.equal(remaining.body.items[0]!.publicId, second.publicId);
    assert.equal((await otherParent.client.request<ParentChildrenPage>('/parent-children')).body.total, 1);
    const revoked = await parent.client.request<ParentConnectionPage>('/parent-connections?role=parent');
    assert.equal(revoked.body.items.find(item => item.id === links[0])!.studentName, undefined);
    assert.equal((await first.client.request(`/parent-connections/${links[0]}/approve`, {})).status, 409);
    const renewed = await parentConnection(parent, first); assert.notEqual(renewed, links[0]);
    assert.equal((await parent.client.request<ParentChildrenPage>('/parent-children')).body.total, 1);
    await first.client.request(`/parent-connections/${renewed}/reject`, {});
    assert.equal((await parent.client.request(`/parent-connections/${links[1]}/revoke`, {})).status, 200);
    assert.equal((await parent.client.request<ParentChildrenPage>('/parent-children')).body.total, 0);
  });

  test('role context, expected account, DTO validation, pagination, and inactive targets cannot bypass scope', async () => {
    const teacher = await account('teacher', 'Преподаватель'); const student = await account('student', 'Ученик'); const subjectId = await subject(teacher);
    assert.equal((await teacher.client.request('/enrollments?role=student')).status, 403);
    assert.equal((await teacher.client.request('/parent-connections?role=parent')).status, 403);
    await teacher.client.request('/me/roles', { role: 'parent' }); await teacher.client.request('/me/roles', { role: 'student' });
    assert.equal((await teacher.client.request<EnrollmentPage>('/enrollments?role=student')).body.total, 0);
    const self = (await db.query<{ public_id: string }>('SELECT public_id FROM student_profiles WHERE user_id=$1', [teacher.userId])).rows[0]!;
    assert.equal((await teacher.client.request('/parent-connections', { publicId: self.public_id })).status, 409);
    const wrongAccount = await teacher.client.request<ErrorBody>('/enrollments', { publicId: student.publicId, subjectId }, 'POST', { 'X-Account-ID': student.userId });
    assert.equal(wrongAccount.status, 409); assert.equal(wrongAccount.body.error.code, 'account_changed');
    for (const path of ['/enrollments', '/enrollments?role=parent', '/enrollments?role=teacher&limit=101', '/enrollments?role=teacher&offset=-1', '/enrollments?role=teacher&limit=1.5', '/enrollments?role=teacher&limit=1&limit=2', `/enrollments?role=teacher&teacherId=${teacher.profileId}`, '/parent-connections?role=parent&extra=x', '/parent-children?studentId=x']) {
      assert.equal((await teacher.client.request(path)).status, 400, path);
    }
    assert.equal((await teacher.client.request('/enrollments', { publicId: student.publicId, subjectId, teacherId: teacher.profileId })).status, 400);
    assert.equal((await teacher.client.request('/enrollments', { publicId: student.publicId, subjectId: 'bad-id' })).status, 400);
    assert.equal((await teacher.client.request('/parent-connections', { publicId: student.publicId, parentId: teacher.profileId })).status, 400);
    const id = await enrollment(teacher, student, subjectId);
    assert.equal((await student.client.request(`/enrollments/${id}/accept`, { status: 'active' })).status, 400);
    assert.equal((await teacher.client.request(`/enrollments/${id}`, { status: 'rejected' }, 'PATCH')).status, 400);
    const page = await teacher.client.request<EnrollmentPage>('/enrollments?role=teacher&limit=1&offset=1');
    assert.equal(page.body.total, 1); assert.deepEqual(page.body.items, []);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
    const inactive = await teacher.client.request<ErrorBody>('/parent-connections', { publicId: student.publicId });
    const missing = await teacher.client.request<ErrorBody>('/parent-connections', { publicId: 'STU-ZZZZ-ZZZZ' });
    assert.equal(inactive.status, 404); assert.equal(missing.status, 404); assert.deepEqual(inactive.body.error.message, missing.body.error.message);
    const anonymous = new Client(teacher.userId, newToken()); assert.equal((await anonymous.request('/enrollments?role=teacher')).status, 401);
  });

  test('database constraints reject foreign subject ownership, foreign approvers and duplicate live pairs', async () => {
    const teacher = await account('teacher', 'Первый преподаватель'); const foreign = await account('teacher', 'Другой преподаватель');
    const student = await account('student', 'Ученик'); const stranger = await account('student', 'Чужой ученик'); const parent = await account('parent', 'Родитель');
    const subjectId = await subject(teacher);
    await assert.rejects(db.query('INSERT INTO enrollments(id,teacher_id,student_id,subject_id) VALUES($1,$2,$3,$4)', [randomUUID(), foreign.profileId, student.profileId, subjectId]), { code: '23503' });
    const id = await enrollment(teacher, student, subjectId);
    await assert.rejects(db.query('INSERT INTO enrollments(id,teacher_id,student_id,subject_id) VALUES($1,$2,$3,$4)', [randomUUID(), teacher.profileId, student.profileId, subjectId]), { code: '23505' });
    await assert.rejects(db.query("UPDATE enrollments SET status='active',accepted_at=now(),accepted_by=$2 WHERE id=$1", [id, stranger.userId]), { code: '23503' });
    const link = await parentConnection(parent, student);
    await assert.rejects(db.query("UPDATE parent_connections SET status='active' WHERE id=$1", [link]), { code: '23514' });
    await assert.rejects(db.query("UPDATE parent_connections SET status='active',approved_at=now(),approved_by=$2 WHERE id=$1", [link, parent.userId]), { code: '23503' });
    await assert.rejects(db.query('INSERT INTO parent_connections(id,parent_id,student_id) VALUES($1,$2,$3)', [randomUUID(), parent.profileId, student.profileId]), { code: '23505' });
  });

  test('request throttling shares account bucket across casing and caller-supplied account headers', async () => {
    const parent = await account('parent', 'Родитель');
    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await parent.client.request(attempt % 2 ? '/PARENT-CONNECTIONS/' : '/parent-connections', { publicId: 'STU-ZZZZ-ZZZZ' });
      assert.equal(result.status, 404);
    }
    const limited = await parent.client.request<ErrorBody>('/Parent-Connections/', { publicId: 'STU-ZZZZ-ZZZZ' }, 'POST', { 'X-Account-ID': randomUUID() });
    assert.equal(limited.status, 429); assert.equal(limited.body.error.code, 'rate_limited'); assert.ok(limited.headers.get('retry-after'));
  });

  test('teacher can complete enrollment and parent can revoke after student suspension', async () => {
    const teacher = await account('teacher', 'Преподаватель'); const student = await account('student', 'Ученик'); const parent = await account('parent', 'Родитель');
    const id = await enrollment(teacher, student, await subject(teacher)); await student.client.request(`/enrollments/${id}/accept`, {});
    const link = await parentConnection(parent, student); await student.client.request(`/parent-connections/${link}/approve`, {});
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
    assert.equal((await parent.client.request<ParentChildrenPage>('/parent-children')).body.total, 0);
    assert.equal((await teacher.client.request(`/enrollments/${id}`, { status: 'completed' }, 'PATCH')).status, 200);
    assert.equal((await parent.client.request(`/parent-connections/${link}/revoke`, {})).status, 200);
  });

  test('list requests cannot shorten the connection creation IP throttle window', async () => {
    const parent = await account('parent', 'Родитель');
    assert.equal((await parent.client.request('/parent-connections?role=parent')).status, 200);
    assert.equal((await parent.client.request('/parent-connections', { publicId: 'STU-ZZZZ-ZZZZ' })).status, 404);
    const buckets = (await db.query<{ seconds: number }>(`SELECT extract(epoch FROM expires_at-now())::integer AS seconds
      FROM rate_limits WHERE bucket_hash IN ($1,$2) ORDER BY seconds`, [hashToken('ip:127.0.0.1:/api/v1/parent-connections'), hashToken('ip:127.0.0.1:connection-create:/api/v1/parent-connections')])).rows;
    assert.equal(buckets.length, 2); assert.ok(buckets[0]!.seconds <= 60); assert.ok(buckets[1]!.seconds > 850);
  });

  test('OpenAPI includes connection schemas and CORS accepts PATCH preflight', async () => {
    const response = await fetch(`${base}/openapi.json`); const spec = await response.json() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    for (const path of ['/enrollments', '/enrollments/{id}', '/enrollments/{id}/accept', '/enrollments/{id}/reject', '/parent-connections', '/parent-connections/{id}/approve', '/parent-connections/{id}/reject', '/parent-connections/{id}/revoke', '/parent-children']) assert.ok(spec.paths[`/api/v1${path}`], path);
    assert.ok(spec.components.schemas.ParentChildrenPage); assert.ok(spec.components.schemas.EnrollmentView);
    const preflight = await fetch(`${base}/enrollments/${randomUUID()}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'X-Account-ID,X-Requested-With,Content-Type' } });
    assert.equal(preflight.status, 204); assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/);
  });
});
