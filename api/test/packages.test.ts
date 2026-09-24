import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import type { PackageHistoryPage, PackageLessonPage, PackagePage, PackageView } from '../src/packages.dto';

const origin = 'http://127.0.0.1:3000';
type ErrorBody = { error: { code: string; message: string } };

describe('PostgreSQL lesson package ledger API', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string;
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; PostgreSQL integration tests cannot be skipped');
    assert.match(new URL(databaseUrl).pathname, /_test$/, 'Only a dedicated test database may be truncated');
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test', SERVE_WEB: 'false' }), { send: async () => undefined });
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(async () => { await db.query('TRUNCATE users, rate_limits CASCADE'); });
  after(async () => { if (app) await app.close(); });

  class Client {
    constructor(readonly userId: string, readonly token: string) {}
    async request<T = PackageView>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
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
  const payload = (enrollmentId: string, extra: Record<string, unknown> = {}) => ({ enrollmentId, requestId: randomUUID(), title: 'Восемь занятий', lessonCount: 8, amountMinor: 20000, currency: 'AZN', ...extra });
  async function create(teacher: Person, enrollmentId: string, extra: Record<string, unknown> = {}) {
    const input = payload(enrollmentId, extra); const r = await teacher.client.request('/packages', input);
    assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body, input };
  }
  async function lesson(c: Awaited<ReturnType<typeof context>>, status = 'completed', future = false) {
    const id = randomUUID();
    await db.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,request_id,request_payload,starts_at,duration_min,format,status)
      VALUES($1,$2,$3,$4,$5,'{}'::jsonb,now()+CASE WHEN $6 THEN interval '2 days' ELSE interval '-2 days' END,60,'offline',$7)`,
    [id, c.enrollmentId, c.teacher.profileId, c.student.profileId, randomUUID(), future, status]);
    return id;
  }
  const chargePayload = (lessonId: string, version = 1, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), version, lessonId, lessonVersion: 1, ...extra });
  async function error(client: Client, path: string, body: unknown, status: number, code: string, method = 'POST') {
    const r = await client.request<ErrorBody>(path, body, method); assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error.code, code);
  }
  async function history(teacher: Person, id: string) {
    const response = await teacher.client.request<PackageHistoryPage>(`/packages/${id}/history?role=teacher`);
    assert.equal(response.status, 200); return response.body;
  }

  test('creation credits the ledger and reuses exactly one existing payment record and paid checkbox', async () => {
    const c = await context(); const p = await create(c.teacher, c.enrollmentId, { title: '  Восемь занятий  ' });
    assert.equal(p.title, 'Восемь занятий'); assert.equal(p.lessonCount, 8); assert.equal(p.balance, 8);
    assert.equal(p.paid, false); assert.equal(p.closed, false); assert.equal(p.cancelled, false);
    assert.equal(p.version, 1); assert.equal(p.paymentVersion, 1); assert.equal(p.studentPublicId, c.student.publicId);
    const journal = await c.teacher.client.request<{ items: { id: string }[]; total: number }>('/payment-records?role=teacher');
    assert.equal(journal.body.total, 1); assert.equal(journal.body.items[0]!.id, p.id);
    assert.equal((await c.teacher.client.request(`/payment-records/${p.id}`, { version: 1, paid: true }, 'PATCH')).status, 200);
    const view = (await c.teacher.client.request<PackagePage>('/packages?role=teacher')).body.items[0]!;
    assert.equal(view.paid, true); assert.ok(view.paidMarkedAt); assert.equal(view.balance, 8); assert.equal(view.version, 1); assert.equal(view.paymentVersion, 2);
    const ledger = await history(c.teacher, p.id);
    assert.deepEqual(ledger.items.map(item => [item.type, item.delta]), [['created', 8]]);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE entity_id=$1 AND action='lesson_package.created'", [p.id])).rowCount, 1);
  });

  test('create retries normalize values and distinguish ordinary payment requests', async () => {
    const c = await context(); const input = payload(c.enrollmentId, { title: '  Пакет  ' });
    const results = await Promise.all([1, 2, 3].map(() => c.teacher.client.request('/packages', input)));
    assert.ok(results.every(r => r.status === 201)); assert.equal(new Set(results.map(r => r.body.id)).size, 1);
    const p = results[0]!.body;
    assert.equal((await c.teacher.client.request('/packages', { ...input, title: 'Пакет', requestId: input.requestId.toUpperCase() })).body.id, p.id);
    await error(c.teacher.client, '/packages', { ...input, lessonCount: 7 }, 409, 'request_id_conflict');
    const ordinary = { enrollmentId: c.enrollmentId, requestId: input.requestId, title: 'Пакет', amountMinor: 20000, currency: 'AZN' };
    await error(c.teacher.client, '/payment-records', ordinary, 409, 'request_id_conflict');
    const paymentId = randomUUID();
    assert.equal((await c.teacher.client.request('/payment-records', { ...ordinary, requestId: paymentId })).status, 201);
    await error(c.teacher.client, '/packages', { ...input, requestId: paymentId }, 409, 'request_id_conflict');
    assert.equal((await history(c.teacher, p.id)).total, 1);
  });

  test('family scopes aggregate subjects, redact private reasons and immediately remove revoked consent', async () => {
    const c = await context(); const other = await account('teacher'); const parent = await account('parent'); const stranger = await account('student');
    const p = await create(c.teacher, c.enrollmentId); const otherEnrollment = await enrollment(other, c.student, 'active', 'Физика');
    await create(other, otherEnrollment); const l = await lesson(c, 'student_absent');
    await c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(l, 1, { reason: 'Секретная причина преподавателя' }));
    const connection = await parentConnection(parent, c.student, false);
    assert.equal((await parent.client.request<PackagePage>('/packages?role=parent')).body.total, 0);
    assert.equal((await parent.client.request(`/packages/${p.id}/history?role=parent`)).status, 404);
    assert.equal((await c.student.client.request(`/parent-connections/${connection}/approve`, {})).status, 200);
    for (const [person, role] of [[c.student, 'student'], [parent, 'parent']] as const) {
      const page = await person.client.request<PackagePage>(`/packages?role=${role}`); assert.equal(page.body.total, 2);
      assert.deepEqual(page.body.items.map(item => item.subjectName).sort(), ['Математика', 'Физика']);
      const family = await person.client.request<PackageHistoryPage>(`/packages/${p.id}/history?role=${role}`);
      assert.equal(family.status, 200); assert.equal(family.body.total, 2);
      assert.ok(family.body.items.every(item => !('reason' in item) && !('actorName' in item)));
      assert.ok(!JSON.stringify(family.body).includes('Секретная')); assert.ok(!JSON.stringify(page.body).includes('requestPayload'));
    }
    assert.equal((await history(c.teacher, p.id)).items[1]!.reason, 'Секретная причина преподавателя');
    assert.equal((await stranger.client.request<PackagePage>('/packages?role=student')).body.total, 0);
    assert.equal((await stranger.client.request(`/packages/${p.id}/history?role=student`)).status, 404);
    await c.student.client.request(`/parent-connections/${connection}/revoke`, {});
    assert.equal((await parent.client.request<PackagePage>('/packages?role=parent')).body.total, 0);
    assert.equal((await parent.client.request(`/packages/${p.id}/history?role=parent`)).status, 404);
  });

  test('teacher ownership and role boundaries protect every write, candidate list and history', async () => {
    const c = await context(); const p = await create(c.teacher, c.enrollmentId); const l = await lesson(c);
    const other = await account('teacher'); const parent = await account('parent');
    for (const person of [c.student, parent, other]) {
      const expected = person === other ? 404 : 403;
      assert.equal((await person.client.request('/packages', payload(c.enrollmentId))).status, expected);
      assert.equal((await person.client.request(`/packages/${p.id}/charges`, chargePayload(l))).status, expected);
      assert.equal((await person.client.request(`/packages/${p.id}/reversals`, { requestId: randomUUID(), version: 1, entryId: randomUUID(), reason: 'Ошибка' })).status, expected);
      assert.equal((await person.client.request(`/packages/${p.id}/close`, { version: 1, reason: 'Закрытие' })).status, expected);
      assert.equal((await person.client.request(`/packages/${p.id}/lessons`)).status, expected);
    }
    assert.equal((await other.client.request(`/packages/${p.id}/history?role=teacher`)).status, 404);
    await c.student.client.request('/me/roles', { role: 'teacher', phone: '+994501234567', birthDate: '1990-01-01', subject: 'Другой предмет' });
    assert.equal((await c.student.client.request(`/packages/${p.id}/charges`, chargePayload(l))).status, 404);
    assert.equal((await c.student.client.request<PackagePage>('/packages?role=teacher')).body.total, 0);
    assert.equal((await c.teacher.client.request<PackagePage>('/packages?role=teacher')).body.items[0]!.balance, 8);
  });

  test('strict DTOs reject forged state, invalid money, nulls and unbounded pagination', async () => {
    const c = await context(); const input = payload(c.enrollmentId);
    for (const changes of [{ lessonCount: 0 }, { lessonCount: 1001 }, { lessonCount: 1.5 }, { lessonCount: '8' }, { lessonCount: null },
      { amountMinor: 0 }, { amountMinor: 1000000000 }, { amountMinor: 1.1 }, { amountMinor: '20' }, { amountMinor: null },
      { currency: 'GBP' }, { currency: null }, { currency: undefined }, { title: '  ' }, { title: null }, { title: 'x'.repeat(201) },
      { enrollmentId: 'invalid' }, { requestId: null }, { paid: true }, { balance: 8 }, { closed: false }, { teacherId: c.teacher.profileId }]) {
      assert.equal((await c.teacher.client.request('/packages', { ...input, ...changes })).status, 400, JSON.stringify(changes));
    }
    const p = await create(c.teacher, c.enrollmentId); const l = await lesson(c);
    for (const changes of [{ version: null }, { version: '1' }, { lessonVersion: 0 }, { lessonVersion: 2147483647 }, { lessonId: null },
      { reason: null }, { reason: '  ' }, { reason: 'x'.repeat(1001) }, { delta: -1 }, { requestId: 'not-a-uuid' }]) {
      assert.equal((await c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(l, 1, changes))).status, 400);
    }
    for (const query of ['', '?role=admin', '?role=teacher&limit=101', '?role=teacher&offset=-1', '?role=teacher&offset=10001',
      '?role=teacher&role=student', '?role=teacher&paid=true', '?role=teacher&enrollmentId=invalid']) {
      assert.equal((await c.teacher.client.request(`/packages${query}`)).status, 400, query);
    }
    for (const endpoint of ['close', 'reversals']) {
      const extra = endpoint === 'reversals' ? { requestId: randomUUID(), entryId: randomUUID() } : {};
      for (const reason of [undefined, null, '', 'aa']) assert.equal((await c.teacher.client.request(`/packages/${p.id}/${endpoint}`, { version: 1, ...extra, reason })).status, 400);
    }
  });

  test('only ended completed or absent lessons in the same enrollment can be charged, with lesson and package CAS', async () => {
    const c = await context(); const p = await create(c.teacher, c.enrollmentId); const path = `/packages/${p.id}/charges`;
    const anotherEnrollment = await enrollment(c.teacher, c.student, 'active', 'Другой предмет');
    const wrongLesson = await lesson({ ...c, enrollmentId: anotherEnrollment });
    await error(c.teacher.client, path, chargePayload(wrongLesson), 404, 'not_found');
    for (const status of ['scheduled', 'student_cancelled', 'teacher_cancelled', 'rescheduled']) {
      await error(c.teacher.client, path, chargePayload(await lesson(c, status)), 409, 'lesson_not_chargeable');
    }
    await error(c.teacher.client, path, chargePayload(await lesson(c, 'completed', true)), 409, 'lesson_not_ended');
    const absent = await lesson(c, 'student_absent');
    await error(c.teacher.client, path, chargePayload(absent), 400, 'absence_reason_required');
    await error(c.teacher.client, path, chargePayload(absent, 2, { reason: 'Пропуск' }), 409, 'stale_version');
    await error(c.teacher.client, path, chargePayload(absent, 1, { lessonVersion: 2, reason: 'Пропуск' }), 409, 'stale_version');
    const charged = await c.teacher.client.request(path, chargePayload(absent, 1, { reason: 'Пропуск по договорённости' }));
    assert.equal(charged.status, 200); assert.equal(charged.body.balance, 7); assert.equal(charged.body.paid, false);
    assert.equal(charged.body.version, 2); assert.equal(charged.body.paymentVersion, 1);
  });

  test('double clicks return current state once and the same request cannot target a different operation', async () => {
    const c = await context(); const p = await create(c.teacher, c.enrollmentId); const l = await lesson(c); const input = chargePayload(l);
    const path = `/packages/${p.id}/charges`; const results = await Promise.all([1, 2, 3].map(() => c.teacher.client.request(path, input)));
    assert.ok(results.every(r => r.status === 200)); assert.ok(results.every(r => r.body.balance === 7));
    const ledger = await history(c.teacher, p.id); assert.equal(ledger.total, 2);
    await error(c.teacher.client, path, { ...input, reason: 'Другая причина' }, 409, 'request_id_conflict');
    await error(c.teacher.client, `/packages/${p.id}/reversals`, { requestId: input.requestId, version: 2, entryId: ledger.items[1]!.id, reason: 'Ошибка' }, 409, 'request_id_conflict');
    const other = await create(c.teacher, c.enrollmentId);
    await error(c.teacher.client, `/packages/${other.id}/charges`, input, 409, 'request_id_conflict');
    assert.equal((await db.query("SELECT id FROM audit_events WHERE entity_id=$1 AND action='lesson_package.charged'", [p.id])).rowCount, 1);
  });

  test('competing package charges serialize on the lesson and cannot charge it twice', async () => {
    const c = await context(); const first = await create(c.teacher, c.enrollmentId); const second = await create(c.teacher, c.enrollmentId); const l = await lesson(c);
    const results = await Promise.all([first, second].map(p => c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(l))));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const failed = results.find(r => r.status === 409)!; assert.equal((failed.body as unknown as ErrorBody).error.code, 'lesson_already_charged');
    const visible = await c.teacher.client.request<PackagePage>('/packages?role=teacher'); assert.equal(visible.body.items.reduce((sum, p) => sum + p.balance, 0), 15);
    assert.equal((await db.query("SELECT id FROM lesson_package_ledger WHERE lesson_id=$1 AND type='charged'", [l])).rowCount, 1);
  });

  test('concurrent charges cannot spend the last lesson twice or create a negative balance', async () => {
    const c = await context(); const p = await create(c.teacher, c.enrollmentId, { lessonCount: 1 }); const lessons = [await lesson(c), await lesson(c)];
    const results = await Promise.all(lessons.map(id => c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(id))));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const unused = lessons[results.findIndex(r => r.status === 409)]!;
    await error(c.teacher.client, `/packages/${p.id}/charges`, chargePayload(unused, 2), 409, 'package_empty');
    assert.equal((await c.teacher.client.request<PackagePage>('/packages?role=teacher')).body.items[0]!.balance, 0);
  });

  test('reversal returns credit once, preserves original history and permits charging the lesson again', async () => {
    const c = await context(); const p = await create(c.teacher, c.enrollmentId); const l = await lesson(c);
    await c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(l));
    const entryId = (await history(c.teacher, p.id)).items[1]!.id;
    const input = { requestId: randomUUID(), version: 2, entryId, reason: 'Ошибочно выбрано занятие' };
    const results = await Promise.all([1, 2].map(() => c.teacher.client.request(`/packages/${p.id}/reversals`, input)));
    assert.ok(results.every(r => r.status === 200 && r.body.balance === 8 && r.body.version === 3));
    await error(c.teacher.client, `/packages/${p.id}/reversals`, { ...input, requestId: randomUUID(), version: 3 }, 409, 'charge_already_reversed');
    const ledger = await history(c.teacher, p.id); assert.equal(ledger.items[1]!.reversed, true);
    assert.equal(ledger.items[2]!.reversesEntryId, entryId); assert.equal(ledger.items[2]!.delta, 1);
    const recharge = await c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(l, 3));
    assert.equal(recharge.status, 200); assert.equal(recharge.body.balance, 7);
    assert.equal((await history(c.teacher, p.id)).items[3]!.reversed, false);
    const other = await create(c.teacher, c.enrollmentId);
    await error(c.teacher.client, `/packages/${other.id}/reversals`, { ...input, requestId: randomUUID(), version: 1 }, 404, 'not_found');
  });

  test('closure and payment cancellation stop new debits while preserving and correcting historical charges', async () => {
    const c = await context();
    for (const mode of ['closed', 'cancelled']) {
      const p = await create(c.teacher, c.enrollmentId); const firstLesson = await lesson(c); const nextLesson = await lesson(c);
      await c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(firstLesson));
      const entryId = (await history(c.teacher, p.id)).items[1]!.id;
      let version = 2;
      if (mode === 'closed') {
        await error(c.teacher.client, `/packages/${p.id}/close`, { version: 1, reason: 'Завершили обучение' }, 409, 'stale_version');
        const closed = await c.teacher.client.request(`/packages/${p.id}/close`, { version: 2, reason: 'Завершили обучение' });
        assert.equal(closed.status, 200); assert.equal(closed.body.closed, true); assert.equal(closed.body.balance, 7); version = 3;
        assert.equal((await c.teacher.client.request(`/packages/${p.id}/close`, { version: 2, reason: 'Завершили обучение' })).status, 200);
      } else {
        assert.equal((await c.teacher.client.request(`/payment-records/${p.id}/cancel`, { version: 1, reason: 'Ошибочная запись' })).status, 200);
      }
      await error(c.teacher.client, `/packages/${p.id}/charges`, chargePayload(nextLesson, version), 409, 'package_closed');
      assert.equal((await c.teacher.client.request<PackageLessonPage>(`/packages/${p.id}/lessons`)).body.total, 0);
      const reversed = await c.teacher.client.request(`/packages/${p.id}/reversals`, { requestId: randomUUID(), version, entryId, reason: 'Исправление старого списания' });
      assert.equal(reversed.status, 200); assert.equal(reversed.body.balance, 8);
      assert.equal(reversed.body[mode === 'closed' ? 'closed' : 'cancelled'], true);
      const expected = mode === 'closed' ? ['created', 'charged', 'closed', 'reversed'] : ['created', 'charged', 'reversed'];
      assert.deepEqual((await history(c.teacher, p.id)).items.map(item => item.type), expected);
      assert.equal((await c.teacher.client.request(`/packages/${p.id}`, undefined, 'DELETE')).status, 404);
    }
  });

  test('candidate and history pagination retain totals and omit lessons charged by another package', async () => {
    const c = await context(); const first = await create(c.teacher, c.enrollmentId); const second = await create(c.teacher, c.enrollmentId);
    const attended = await lesson(c); const absent = await lesson(c, 'student_absent'); await lesson(c, 'scheduled'); await lesson(c, 'completed', true);
    const initial = await c.teacher.client.request<PackageLessonPage>(`/packages/${first.id}/lessons?limit=1`);
    assert.equal(initial.body.total, 2); assert.equal(initial.body.items.length, 1); assert.equal(initial.body.limit, 1);
    await c.teacher.client.request(`/packages/${second.id}/charges`, chargePayload(attended));
    const candidates = await c.teacher.client.request<PackageLessonPage>(`/packages/${first.id}/lessons`);
    assert.deepEqual(candidates.body.items.map(item => item.id), [absent]);
    const page = await c.teacher.client.request<PackagePage>(`/packages?role=teacher&enrollmentId=${c.enrollmentId}&limit=1&offset=1`);
    assert.equal(page.body.total, 2); assert.equal(page.body.items[0]!.id, first.id); assert.equal(page.body.offset, 1);
    const entries = await c.teacher.client.request<PackageHistoryPage>(`/packages/${second.id}/history?role=teacher&limit=1&offset=1`);
    assert.equal(entries.body.total, 2); assert.equal(entries.body.items[0]!.type, 'charged'); assert.equal(entries.body.items[0]!.lessonId, attended);
    assert.equal((await c.teacher.client.request<PackagePage>(`/packages?role=teacher&enrollmentId=${randomUUID()}`)).body.total, 0);
  });

  test('inactive enrollments or students prevent creation and parent access but retain student history and teacher corrections', async () => {
    const c = await context(); const parent = await account('parent'); await parentConnection(parent, c.student);
    const p = await create(c.teacher, c.enrollmentId); const l = await lesson(c);
    await c.teacher.client.request(`/packages/${p.id}/charges`, chargePayload(l)); const entryId = (await history(c.teacher, p.id)).items[1]!.id;
    const pending = await enrollment(c.teacher, c.student, 'pending', 'Ожидает');
    await error(c.teacher.client, '/packages', payload(pending), 404, 'not_found');
    for (const status of ['paused', 'completed']) {
      await c.teacher.client.request(`/enrollments/${c.enrollmentId}`, { status }, 'PATCH');
      await error(c.teacher.client, '/packages', payload(c.enrollmentId), 409, 'enrollment_inactive');
      assert.equal((await parent.client.request<PackagePage>('/packages?role=parent')).body.total, 0);
      assert.equal((await parent.client.request(`/packages/${p.id}/history?role=parent`)).status, 404);
      assert.equal((await c.student.client.request(`/packages/${p.id}/history?role=student`)).status, 200);
    }
    assert.equal((await c.teacher.client.request(`/packages/${p.id}/reversals`, { requestId: randomUUID(), version: 2, entryId, reason: 'Корректировка после обучения' })).status, 200);
    const active = await enrollment(c.teacher, c.student, 'active', 'Новый предмет');
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.student.userId]);
    await error(c.teacher.client, '/packages', payload(active), 409, 'enrollment_inactive');
    assert.equal((await c.student.client.request('/packages?role=student')).status, 401);
  });

  test('CSRF, account changes and revoked sessions prevent package writes', async () => {
    const c = await context(); const p = await create(c.teacher, c.enrollmentId); const l = await lesson(c); const path = `/packages/${p.id}/charges`;
    for (const extra of [{ Origin: 'https://other.example' }, { 'X-Requested-With': '' }] as Record<string, string>[]) {
      assert.equal((await c.teacher.client.request(path, chargePayload(l), 'POST', extra)).status, 403);
    }
    const mismatch = await c.teacher.client.request<ErrorBody>(path, chargePayload(l), 'POST', { 'X-Account-ID': c.student.userId });
    assert.equal(mismatch.status, 409); assert.equal(mismatch.body.error.code, 'account_changed');
    await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [c.teacher.sessionId]);
    assert.equal((await c.teacher.client.request(path, chargePayload(l))).status, 401);
    assert.equal((await new Client(c.teacher.userId, newToken()).request('/packages?role=teacher')).status, 401);
    assert.equal((await db.query<{ balance: number }>('SELECT sum(delta)::integer AS balance FROM lesson_package_ledger WHERE package_id=$1', [p.id])).rows[0]!.balance, 8);
  });
});
