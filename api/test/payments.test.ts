import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';

const origin = 'http://127.0.0.1:3000';
type RecordView = { id: string; enrollmentId: string; studentName: string; studentPublicId: string; teacherName: string; subjectName: string; title: string; amountMinor?: number; currency?: string; paid: boolean; cancelled: boolean; version: number; paidMarkedAt?: string; createdAt: string; updatedAt: string };
type Page = { items: RecordView[]; total: number; limit: number; offset: number };
type History = { items: { id: string; type: string; occurredAt: string; actorName: string; beforePaid?: boolean; afterPaid?: boolean; reason?: string; previousPaidMarkedAt?: string }[]; total: number; limit: number; offset: number };
type ErrorBody = { error: { code: string; message: string } };

describe('PostgreSQL manual payment journal API', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string;
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; PostgreSQL integration tests cannot be skipped');
    assert.match(new URL(databaseUrl).pathname, /_test$/, 'Only a dedicated test database may be truncated');
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), { send: async () => undefined });
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(async () => { await db.query('TRUNCATE users, rate_limits CASCADE'); });
  after(async () => { if (app) await app.close(); });

  class Client {
    constructor(readonly userId: string, readonly token: string) {}
    async request<T = RecordView>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
      const response = await fetch(`${base}${path}`, { method, headers: {
        Origin: origin, 'X-Requested-With': 'ERepetitor', 'X-Account-ID': this.userId,
        'Content-Type': 'application/json', Cookie: `er_access=${this.token}`, ...extra,
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as T };
    }
  }
  async function account(role: Role) {
    const userId = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase(); const publicId = `STU-${code.slice(0, 4)}-${code.slice(4)}`;
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,'unused-test-fixture','active','test','test')`, [userId, role, `${userId}@example.test`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, publicId]);
    else if (role === 'teacher') await db.query('INSERT INTO teacher_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    else await db.query('INSERT INTO parent_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { client: new Client(userId, token), userId, profileId, publicId, sessionId };
  }
  type Person = Awaited<ReturnType<typeof account>>;
  async function enrollment(teacher: Person, student: Person, status = 'active', name = 'Математика') {
    const id = randomUUID(); const subjectId = randomUUID();
    await db.query('INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,$3)', [subjectId, teacher.profileId, name]);
    await db.query(`INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $5='pending' THEN NULL ELSE now() END,CASE WHEN $5='pending' THEN NULL ELSE $6::uuid END)`,
    [id, teacher.profileId, student.profileId, subjectId, status, student.userId]);
    return id;
  }
  async function parentConnection(parent: Person, student: Person, active = true) {
    const id = randomUUID();
    await db.query(`INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by)
      VALUES($1,$2,$3,$4,CASE WHEN $4='active' THEN now() END,CASE WHEN $4='active' THEN $5::uuid END)`,
    [id, parent.profileId, student.profileId, active ? 'active' : 'pending', student.userId]); return id;
  }
  async function context() { const teacher = await account('teacher'); const student = await account('student'); return { teacher, student, enrollmentId: await enrollment(teacher, student) }; }
  const payload = (enrollmentId: string, extra: Record<string, unknown> = {}) => ({ enrollmentId, requestId: randomUUID(), title: 'Сентябрь 2026', ...extra });
  async function create(teacher: Person, enrollmentId: string, extra: Record<string, unknown> = {}) {
    const input = payload(enrollmentId, extra); const r = await teacher.client.request('/payment-records', input);
    assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body, input };
  }
  async function error(client: Client, path: string, body: unknown, status: number, code: string, method = 'POST') {
    const r = await client.request<ErrorBody>(path, body, method); assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error.code, code);
  }

  test('teacher creates an unpaid record and reads it only within owned enrollments', async () => {
    const c = await context(); const other = await account('teacher');
    const record = await create(c.teacher, c.enrollmentId, { title: '  Сентябрь 2026  ', amountMinor: 12345, currency: 'AZN' });
    assert.equal(record.title, 'Сентябрь 2026'); assert.equal(record.paid, false); assert.equal(record.cancelled, false); assert.equal(record.version, 1);
    assert.equal(record.amountMinor, 12345); assert.equal(record.currency, 'AZN'); assert.equal(record.paidMarkedAt, undefined);
    assert.equal(record.studentPublicId, c.student.publicId); assert.equal(record.subjectName, 'Математика');
    assert.equal((await c.teacher.client.request<Page>('/payment-records?role=teacher')).body.total, 1);
    assert.equal((await other.client.request<Page>('/payment-records?role=teacher')).body.total, 0);
    assert.equal((await other.client.request('/payment-records', payload(c.enrollmentId))).status, 404);
  });

  test('students and approved parents aggregate subjects without private reasons; revocation removes access', async () => {
    const c = await context(); const other = await account('teacher'); const parent = await account('parent'); const stranger = await account('student');
    const secondEnrollment = await enrollment(other, c.student, 'active', 'Физика');
    const first = await create(c.teacher, c.enrollmentId); await create(other, secondEnrollment);
    await c.teacher.client.request(`/payment-records/${first.id}`, { version: 1, paid: true, reason: 'Скрытая причина преподавателя' }, 'PATCH');
    const list = await c.student.client.request<Page>('/payment-records?role=student'); assert.equal(list.body.total, 2);
    assert.deepEqual(list.body.items.map(item => item.subjectName).sort(), ['Математика', 'Физика']);
    assert.equal((await stranger.client.request<Page>(`/payment-records?role=student&enrollmentId=${c.enrollmentId}`)).body.total, 0);
    const link = await parentConnection(parent, c.student, false);
    assert.equal((await parent.client.request<Page>('/payment-records?role=parent')).body.total, 0);
    await c.student.client.request(`/parent-connections/${link}/approve`, {});
    const visible = await parent.client.request<Page>('/payment-records?role=parent'); assert.equal(visible.body.total, 2);
    assert.ok(!JSON.stringify(visible.body).includes('Скрытая')); assert.ok(!JSON.stringify(visible.body).includes('email'));
    for (const person of [parent, c.student]) {
      assert.equal((await person.client.request(`/payment-records/${first.id}/history`)).status, 403);
      assert.equal((await person.client.request(`/payment-records/${first.id}`, { version: 2, paid: false, reason: 'Изменение' }, 'PATCH')).status, 403);
      assert.equal((await person.client.request(`/payment-records/${first.id}/cancel`, { version: 2, reason: 'Отмена' })).status, 403);
      assert.equal((await person.client.request('/payment-records', payload(c.enrollmentId))).status, 403);
    }
    await c.student.client.request(`/parent-connections/${link}/revoke`, {});
    assert.equal((await parent.client.request<Page>('/payment-records?role=parent')).body.total, 0);
  });

  test('known UUIDs and mixed roles cannot expose another teacher history or change it', async () => {
    const c = await context(); const other = await account('teacher'); const record = await create(c.teacher, c.enrollmentId);
    await c.student.client.request('/me/roles', { role: 'teacher' });
    for (const actor of [other, c.student]) {
      assert.equal((await actor.client.request(`/payment-records/${record.id}/history`)).status, 404);
      assert.equal((await actor.client.request(`/payment-records/${record.id}`, { version: 1, paid: true }, 'PATCH')).status, 404);
      assert.equal((await actor.client.request(`/payment-records/${record.id}/cancel`, { version: 1, reason: 'Отмена' })).status, 404);
    }
    assert.equal((await c.teacher.client.request('/payment-records?role=parent')).status, 403);
    await c.teacher.client.request('/me/roles', { role: 'parent' });
    assert.equal((await c.teacher.client.request<Page>('/payment-records?role=parent')).body.total, 0);
    await error(c.teacher.client, `/payment-records/${randomUUID()}`, { version: 1, paid: true }, 404, 'not_found', 'PATCH');
  });

  test('strict DTO validation rejects nulls, inexact money, partial currency pairs and forged immutable fields', async () => {
    const c = await context(); const input = payload(c.enrollmentId);
    for (const change of [{ amountMinor: null }, { currency: null }, { amountMinor: 12 }, { currency: 'AZN' },
      { amountMinor: 0, currency: 'AZN' }, { amountMinor: -1, currency: 'AZN' }, { amountMinor: 1.01, currency: 'AZN' },
      { amountMinor: '100', currency: 'AZN' }, { amountMinor: 1000000000, currency: 'AZN' }, { amountMinor: 100, currency: 'GBP' },
      { title: '' }, { title: '  ' }, { title: null }, { title: 'x'.repeat(201) }, { requestId: 'invalid' }, { enrollmentId: null },
      { paid: true }, { teacherId: c.teacher.profileId }, { studentId: c.student.profileId }, { cancelled: true }, { paidMarkedAt: new Date().toISOString() }]) {
      assert.equal((await c.teacher.client.request('/payment-records', { ...input, ...change })).status, 400, JSON.stringify(change));
    }
    const record = await create(c.teacher, c.enrollmentId);
    for (const change of [{ paid: null }, { paid: 'true' }, { paid: 1 }, { version: 0 }, { version: null }, { version: '1' },
      { version: 2147483647 }, { reason: null }, { reason: '  ' }, { reason: 'x'.repeat(1001) }, { title: 'Changed' }, { amountMinor: 100 }, { currency: 'AZN' }]) {
      assert.equal((await c.teacher.client.request(`/payment-records/${record.id}`, { version: 1, paid: true, ...change }, 'PATCH')).status, 400, JSON.stringify(change));
    }
    for (const reason of [undefined, null, '', 'aa', 'x'.repeat(1001)]) assert.equal((await c.teacher.client.request(`/payment-records/${record.id}/cancel`, { version: 1, reason })).status, 400);
    assert.equal((await create(c.teacher, c.enrollmentId, { amountMinor: 999999999, currency: 'EUR' })).amountMinor, 999999999);
  });

  test('idempotent concurrent creation normalizes input and returns current state without duplicate events', async () => {
    const c = await context(); const input = payload(c.enrollmentId, { title: '  За урок  ', amountMinor: 1, currency: 'RUB' });
    const results = await Promise.all([1, 2, 3].map(() => c.teacher.client.request('/payment-records', input)));
    assert.ok(results.every(r => r.status === 201)); assert.equal(new Set(results.map(r => r.body.id)).size, 1);
    const record = results[0]!.body;
    await error(c.teacher.client, '/payment-records', { ...input, title: 'Другая запись' }, 409, 'request_id_conflict');
    await c.teacher.client.request(`/payment-records/${record.id}`, { version: 1, paid: true }, 'PATCH');
    await c.teacher.client.request(`/enrollments/${c.enrollmentId}`, { status: 'completed' }, 'PATCH');
    const retry = await c.teacher.client.request('/payment-records', { ...input, title: 'За урок', requestId: input.requestId.toUpperCase(), enrollmentId: c.enrollmentId.toUpperCase() });
    assert.equal(retry.status, 201); assert.equal(retry.body.id, record.id); assert.equal(retry.body.paid, true); assert.equal(retry.body.version, 2);
    assert.equal((await db.query("SELECT id FROM payment_record_history WHERE payment_record_id=$1 AND type='created'", [record.id])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE entity_id=$1 AND action='payment_record.created'", [record.id])).rowCount, 1);
  });

  test('paid status uses strict CAS, desired state noops, private corrections and DB timestamps', async () => {
    const c = await context(); const record = await create(c.teacher, c.enrollmentId); const path = `/payment-records/${record.id}`;
    const noop = await c.teacher.client.request(path, { version: 1, paid: false }, 'PATCH'); assert.equal(noop.body.version, 1);
    const paid = await c.teacher.client.request(path, { version: 1, paid: true }, 'PATCH');
    assert.equal(paid.status, 200); assert.equal(paid.body.version, 2); assert.ok(paid.body.paidMarkedAt);
    assert.ok(Date.parse(paid.body.paidMarkedAt!) >= Date.parse(record.createdAt));
    await error(c.teacher.client, path, { version: 1, paid: true }, 409, 'stale_version', 'PATCH');
    assert.equal((await c.teacher.client.request(path, { version: 2, paid: true }, 'PATCH')).body.version, 2);
    await error(c.teacher.client, path, { version: 2, paid: false }, 400, 'correction_reason_required', 'PATCH');
    const unpaid = await c.teacher.client.request(path, { version: 2, paid: false, reason: '  Ошибка отметки  ' }, 'PATCH');
    assert.equal(unpaid.status, 200); assert.equal(unpaid.body.paidMarkedAt, undefined); assert.equal(unpaid.body.version, 3);
    const history = await c.teacher.client.request<History>(`${path}/history`);
    assert.deepEqual(history.body.items.map(h => h.type), ['created', 'marked_paid', 'marked_unpaid']);
    assert.equal(history.body.items[2]!.reason, 'Ошибка отметки'); assert.equal(history.body.items[2]!.beforePaid, true);
    assert.equal(history.body.items[2]!.afterPaid, false); assert.equal(history.body.items[2]!.actorName, 'teacher');
    assert.equal(Date.parse(history.body.items[2]!.previousPaidMarkedAt!), Date.parse(paid.body.paidMarkedAt!));
    assert.equal((await db.query('SELECT id FROM audit_events WHERE entity_id=$1', [record.id])).rowCount, 3);
  });

  test('concurrent writes have one CAS winner, including payment versus cancellation', async () => {
    const c = await context(); const record = await create(c.teacher, c.enrollmentId); const path = `/payment-records/${record.id}`;
    const results = await Promise.all([c.teacher.client.request(path, { version: 1, paid: true }, 'PATCH'),
      c.teacher.client.request(`${path}/cancel`, { version: 1, reason: 'Ошибочная запись' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal((await db.query('SELECT id FROM payment_record_history WHERE payment_record_id=$1', [record.id])).rowCount, 2);
    const next = await create(c.teacher, c.enrollmentId);
    const duplicate = await Promise.all([1, 2].map(() => c.teacher.client.request(`/payment-records/${next.id}`, { version: 1, paid: true }, 'PATCH')));
    assert.deepEqual(duplicate.map(r => r.status).sort(), [200, 409]);
  });

  test('cancellation preserves history, requires unpaid state and prevents every further status change', async () => {
    const c = await context(); const record = await create(c.teacher, c.enrollmentId); const path = `/payment-records/${record.id}`;
    await c.teacher.client.request(path, { version: 1, paid: true }, 'PATCH');
    await error(c.teacher.client, `${path}/cancel`, { version: 2, reason: 'Ошибочная запись' }, 409, 'record_paid');
    await c.teacher.client.request(path, { version: 2, paid: false, reason: 'Исправление отметки' }, 'PATCH');
    const cancelled = await c.teacher.client.request(`${path}/cancel`, { version: 3, reason: 'Дубликат записи' });
    assert.equal(cancelled.status, 200); assert.equal(cancelled.body.cancelled, true); assert.equal(cancelled.body.paid, false); assert.equal(cancelled.body.version, 4);
    assert.equal((await c.teacher.client.request(`${path}/cancel`, { version: 4, reason: 'Повторное действие' })).body.version, 4);
    await error(c.teacher.client, `${path}/cancel`, { version: 3, reason: 'Старый запрос' }, 409, 'stale_version');
    for (const paid of [true, false]) await error(c.teacher.client, path, { version: 4, paid }, 409, 'record_cancelled', 'PATCH');
    assert.equal((await c.teacher.client.request<History>(`${path}/history`)).body.total, 4);
    assert.equal((await c.student.client.request<Page>('/payment-records?role=student&status=cancelled')).body.items[0]!.cancelled, true);
    assert.equal((await c.teacher.client.request(path, undefined, 'DELETE')).status, 404);
  });

  test('closed enrollment permits corrections and student history while blocking new entries and parent visibility', async () => {
    const c = await context(); const parent = await account('parent'); await parentConnection(parent, c.student);
    const record = await create(c.teacher, c.enrollmentId);
    assert.equal((await parent.client.request<Page>('/payment-records?role=parent')).body.total, 1);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.student.userId]);
    assert.equal((await parent.client.request<Page>('/payment-records?role=parent')).body.total, 0);
    assert.equal((await c.student.client.request('/payment-records?role=student')).status, 401);
    assert.equal((await c.teacher.client.request<Page>('/payment-records?role=teacher')).body.total, 1);
    await error(c.teacher.client, '/payment-records', payload(c.enrollmentId), 409, 'enrollment_inactive');
    await db.query("UPDATE users SET status='active' WHERE id=$1", [c.student.userId]);
    const pending = await enrollment(c.teacher, c.student, 'pending', 'Ожидает');
    assert.equal((await c.teacher.client.request('/payment-records', payload(pending))).status, 404);
    for (const status of ['paused', 'completed']) {
      await c.teacher.client.request(`/enrollments/${c.enrollmentId}`, { status }, 'PATCH');
      await error(c.teacher.client, '/payment-records', payload(c.enrollmentId), 409, 'enrollment_inactive');
      assert.equal((await parent.client.request<Page>('/payment-records?role=parent')).body.total, 0);
      assert.equal((await c.student.client.request<Page>('/payment-records?role=student')).body.total, 1);
    }
    assert.equal((await c.teacher.client.request(`/payment-records/${record.id}`, { version: 1, paid: true }, 'PATCH')).status, 200);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.student.userId]);
    assert.equal((await c.teacher.client.request(`/payment-records/${record.id}`, { version: 2, paid: false, reason: 'Ошибка отметки' }, 'PATCH')).status, 200);
    const active = await enrollment(c.teacher, c.student, 'active', 'Новый предмет');
    await error(c.teacher.client, '/payment-records', payload(active), 409, 'enrollment_inactive');
    assert.equal((await parent.client.request<Page>('/payment-records?role=parent')).body.total, 0);
  });

  test('status and enrollment filters, pagination and typed history are bounded and scoped', async () => {
    const c = await context(); const first = await create(c.teacher, c.enrollmentId); const second = await create(c.teacher, c.enrollmentId); const third = await create(c.teacher, c.enrollmentId);
    assert.equal((await c.teacher.client.request<Page>('/payment-records?role=teacher&limit=1')).body.items[0]!.id, third.id);
    await c.teacher.client.request(`/payment-records/${second.id}`, { version: 1, paid: true }, 'PATCH');
    await c.teacher.client.request(`/payment-records/${third.id}/cancel`, { version: 1, reason: 'Дубликат' });
    for (const [status, id] of [['unpaid', first.id], ['paid', second.id], ['cancelled', third.id]]) {
      const page = await c.teacher.client.request<Page>(`/payment-records?role=teacher&status=${status}`); assert.equal(page.body.total, 1); assert.equal(page.body.items[0]!.id, id);
    }
    const page = await c.teacher.client.request<Page>(`/payment-records?role=teacher&enrollmentId=${c.enrollmentId}&limit=1&offset=1`);
    assert.equal(page.body.total, 3); assert.equal(page.body.items[0]!.id, second.id); assert.equal(page.body.limit, 1); assert.equal(page.body.offset, 1);
    assert.equal((await c.teacher.client.request<Page>(`/payment-records?role=teacher&enrollmentId=${randomUUID()}`)).body.total, 0);
    const history = await c.teacher.client.request<History>(`/payment-records/${second.id}/history?limit=1&offset=1`); assert.equal(history.body.total, 2); assert.equal(history.body.items[0]!.type, 'marked_paid');
    for (const query of ['', '?role=admin', '?role=teacher&limit=101', '?role=teacher&offset=10001', '?role=teacher&offset=-1',
      '?role=teacher&status=partial', '?role=teacher&enrollmentId=invalid', '?role=teacher&role=student', '?role=teacher&paid=true']) {
      assert.equal((await c.teacher.client.request(`/payment-records${query}`)).status, 400, query);
    }
  });

  test('CSRF, expected-account and revoked sessions prevent journal changes', async () => {
    const c = await context(); const record = await create(c.teacher, c.enrollmentId); const path = `/payment-records/${record.id}`;
    const rejectedHeaders: Record<string, string>[] = [{ Origin: 'https://other.example' }, { 'X-Requested-With': '' }];
    for (const extra of rejectedHeaders) assert.equal((await c.teacher.client.request(path, { version: 1, paid: true }, 'PATCH', extra)).status, 403);
    const mismatch = await c.teacher.client.request<ErrorBody>(path, { version: 1, paid: true }, 'PATCH', { 'X-Account-ID': c.student.userId });
    assert.equal(mismatch.status, 409); assert.equal(mismatch.body.error.code, 'account_changed');
    await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [c.teacher.sessionId]);
    assert.equal((await c.teacher.client.request(path, { version: 1, paid: true }, 'PATCH')).status, 401);
    assert.equal((await new Client(c.teacher.userId, newToken()).request('/payment-records?role=teacher')).status, 401);
    assert.equal((await db.query<{ paid: boolean }>('SELECT paid FROM payment_records WHERE id=$1', [record.id])).rows[0]!.paid, false);
  });

  test('session revoked after the HTTP guard but while waiting for the actor lock cannot write', async () => {
    const c = await context(); const record = await create(c.teacher, c.enrollmentId);
    const blocker = await db.pool.connect(); let pending: ReturnType<Client['request']> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [c.teacher.userId]);
      pending = c.teacher.client.request(`/payment-records/${record.id}`, { version: 1, paid: true }, 'PATCH');
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks = await db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT u.id FROM users u%' AND pid<>pg_backend_pid()");
        if (locks.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting, 'Mutation must pass its HTTP guard and wait for the actor row lock');
      await blocker.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [c.teacher.sessionId]); await blocker.query('COMMIT');
      assert.equal((await pending).status, 401);
      assert.equal((await db.query<{ paid: boolean }>('SELECT paid FROM payment_records WHERE id=$1', [record.id])).rows[0]!.paid, false);
      assert.equal((await db.query('SELECT id FROM payment_record_history WHERE payment_record_id=$1', [record.id])).rowCount, 1);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
  });

  test('database ownership, optional money and paid timestamp constraints hold without HTTP validation', async () => {
    const c = await context(); const other = await account('teacher'); const student = await account('student'); const record = await create(c.teacher, c.enrollmentId);
    await assert.rejects(db.query('UPDATE payment_records SET teacher_id=$2 WHERE id=$1', [record.id, other.profileId]), { code: '23503' });
    await assert.rejects(db.query('UPDATE payment_records SET student_id=$2 WHERE id=$1', [record.id, student.profileId]), { code: '23503' });
    for (const change of ["amount_minor=0,currency='AZN'", 'amount_minor=10', "currency='AZN'", "amount_minor=100,currency='GBP'", 'paid=true', 'paid_marked_at=clock_timestamp()', 'paid=true,paid_marked_at=clock_timestamp(),cancelled=true']) {
      await assert.rejects(db.query(`UPDATE payment_records SET ${change} WHERE id=$1`, [record.id]), { code: '23514' });
    }
    await assert.rejects(db.query(`INSERT INTO payment_record_history(id,payment_record_id,actor_user_id,type,before_paid,after_paid)
      VALUES($1,$2,$3,'marked_paid',NULL,true)`, [randomUUID(), record.id, c.teacher.userId]), { code: '23514' });
  });

  test('audit failure rolls back both status mutation and its detailed history', async () => {
    const c = await context(); const record = await create(c.teacher, c.enrollmentId);
    await db.query(`CREATE FUNCTION test_payment_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='payment_record.marked_paid' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER test_payment_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_payment_audit_failure()');
    try {
      assert.equal((await c.teacher.client.request(`/payment-records/${record.id}`, { version: 1, paid: true }, 'PATCH')).status, 500);
      const stored = (await db.query<{ paid: boolean; version: number }>('SELECT paid,version FROM payment_records WHERE id=$1', [record.id])).rows[0]!;
      assert.deepEqual(stored, { paid: false, version: 1 }); assert.equal((await c.teacher.client.request<History>(`/payment-records/${record.id}/history`)).body.total, 1);
    } finally {
      await db.query('DROP TRIGGER test_payment_audit_failure ON audit_events'); await db.query('DROP FUNCTION test_payment_audit_failure()');
    }
  });

  test('OpenAPI documents the manual journal and typed role-safe projections', async () => {
    const response = await fetch(`${base}/openapi.json`); const spec = await response.json() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    for (const path of ['/payment-records', '/payment-records/{id}', '/payment-records/{id}/cancel', '/payment-records/{id}/history']) assert.ok(spec.paths[`/api/v1${path}`], path);
    for (const name of ['PaymentRecordView', 'PaymentRecordPage', 'PaymentHistoryView', 'PaymentHistoryPage', 'CreatePaymentRecordDto', 'MarkPaymentDto', 'CancelPaymentDto']) assert.ok(spec.components.schemas[name], name);
  });
});
