import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import { TemporaryStudentPage } from '../src/invitations.dto';
import type { AccountMail, MailDelivery } from '../src/mail';

const origin = 'http://127.0.0.1:3000';
const password = 'Local-Invitation-Test-2026';
type Mutation = { id: string; status: string };
type ErrorBody = { error: { code: string; message: string } };
const activation = (token: string) => ({ token, name: 'Имя ученика', password, acceptTerms: true, acceptPrivacy: true, acceptEnrollment: true });

describe('PostgreSQL student activation invitations API', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string;
  class Mail implements MailDelivery {
    messages: AccountMail[] = []; fail = false;
    async send(message: AccountMail) {
      if (this.fail) throw new Error('private SMTP detail and recipient must never be logged');
      this.messages.push(message);
    }
  }
  const mail = new Mail();
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; integration tests cannot be skipped');
    assert.match(new URL(databaseUrl).pathname, /_test$/, 'Only a dedicated test database may be truncated');
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), mail);
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(async () => { await settled(); await db.query('TRUNCATE users,rate_limits CASCADE'); mail.messages = []; mail.fail = false; });
  after(async () => { if (app) await app.close(); });
  async function request<T = Mutation>(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'X-Requested-With': 'ERepetitor', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  async function settled() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const count = await db.query<{ count: string }>("SELECT count(*) FROM invitations WHERE delivery_status='queued'");
      if (count.rows[0]!.count === '0') return;
      await delay(10);
    }
    assert.fail('Invitation deliveries did not settle');
  }
  async function account(role: Role, name = 'Преподаватель') {
    const id = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const email = `${id}@example.test`; const raw = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    const publicId = `STU-${raw.slice(0, 4)}-${raw.slice(4)}`;
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,'unchanged-test-password','active','test','test')`, [id, name, email]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, id, publicId]);
    else await db.query(`INSERT INTO ${role === 'teacher' ? 'teacher_profiles' : 'parent_profiles'}(id,user_id) VALUES($1,$2)`, [profileId, id]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, id]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    const headers = { Cookie: `er_access=${token}`, 'X-Account-ID': id };
    return { id, email, profileId, publicId, headers, request: <T = Mutation>(path: string, body?: unknown) => request<T>(path, body, headers) };
  }
  async function setup() {
    const teacher = await account('teacher'); const response = await teacher.request<{ id: string }>('/subjects', { name: 'Математика' });
    assert.equal(response.status, 201); return { teacher, subjectId: response.body.id };
  }
  async function invite(teacher: Awaited<ReturnType<typeof account>>, subjectId: string, email = `${randomUUID()}@example.test`) {
    const dto = { name: 'Имя от учителя', email, subjectId, noAccountConfirmed: true };
    const response = await teacher.request('/temporary-students', dto); assert.equal(response.status, 201);
    await settled();
    const token = [...mail.messages].reverse().find(item => item.email === email.toLowerCase())?.token;
    assert.ok(token); return { id: response.body.id, token, email: email.toLowerCase(), dto };
  }
  async function permitResend(id: string) {
    await db.query("UPDATE invitations SET created_at=clock_timestamp()-interval '61 seconds' WHERE temporary_student_id=$1", [id]);
  }

  test('teacher staging is isolated, does not allocate accounts or IDs, deduplicates commands and hides tokens', async () => {
    const { teacher, subjectId } = await setup(); const other = await account('teacher'); const parent = await account('parent');
    const dto = { name: '  Новый  Ученик  ', email: '  INVITED@example.test ', subjectId, noAccountConfirmed: true };
    assert.equal((await request('/temporary-students', dto)).status, 401);
    assert.equal((await parent.request('/temporary-students', dto)).status, 403);
    assert.equal((await other.request('/temporary-students', dto)).status, 404);
    assert.equal((await teacher.request('/temporary-students', { ...dto, noAccountConfirmed: false })).status, 400);
    assert.equal((await teacher.request('/temporary-students', { ...dto, teacherId: other.profileId })).status, 400);
    assert.equal((await request('/temporary-students', dto, { ...teacher.headers, 'X-Account-ID': other.id })).status, 409);
    const results = await Promise.all([1, 2, 3].map(() => teacher.request('/temporary-students', dto)));
    assert.ok(results.every(result => result.status === 201)); assert.equal(new Set(results.map(result => result.body.id)).size, 1);
    await settled(); assert.equal(mail.messages.length, 1);
    assert.equal((await db.query('SELECT id FROM users WHERE email=$1', ['invited@example.test'])).rowCount, 0);
    assert.equal((await db.query('SELECT id FROM student_profiles')).rowCount, 0);
    const list = await teacher.request<TemporaryStudentPage>('/temporary-students?limit=1');
    assert.equal(list.body.total, 1); assert.equal(list.body.items[0]!.name, 'Новый Ученик');
    assert.equal(list.body.items[0]!.studentPublicId, undefined); assert.equal(list.body.items[0]!.invitation.deliveryStatus, 'sent');
    assert.equal(list.body.items[0]!.invitation.deliveryAttempts, 1);
    assert.ok(!JSON.stringify(list.body).includes(mail.messages[0]!.token)); assert.ok(!JSON.stringify(list.body).includes('token_hash'));
    assert.equal((await other.request<TemporaryStudentPage>('/temporary-students')).body.total, 0);
    assert.equal((await other.request(`/temporary-students/${results[0]!.body.id}/revoke`, {})).status, 404);
    assert.equal((await teacher.request('/temporary-students?limit=101')).status, 400);
    const stored = (await db.query<{ token_hash: string }>('SELECT token_hash FROM invitations')).rows[0]!;
    assert.equal(stored.token_hash, hashToken(mail.messages[0]!.token));
  });

  test('recipient previews teacher and subject then explicitly activates new account and enrollment once', async () => {
    const { teacher, subjectId } = await setup(); const draft = await invite(teacher, subjectId);
    const preview = await request<Record<string, unknown>>('/invitations/preview', { token: draft.token });
    assert.equal(preview.status, 200); assert.deepEqual(Object.keys(preview.body).sort(), ['expiresAt', 'subjectName', 'teacherName']);
    for (const field of ['acceptTerms', 'acceptPrivacy', 'acceptEnrollment']) {
      assert.equal((await request('/invitations/activate', { ...activation(draft.token), [field]: false })).status, 400);
    }
    assert.equal((await request('/invitations/activate', { ...activation(draft.token), email: 'changed@example.test' })).status, 400);
    const results = await Promise.all([1, 2].map(() => request('/invitations/activate', activation(draft.token))));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
    const user = (await db.query<{ id: string; name: string; status: string; password_hash: string; terms_version: string }>('SELECT * FROM users WHERE email=$1', [draft.email])).rows[0]!;
    assert.equal(user.status, 'active'); assert.equal(user.name, 'Имя ученика'); assert.equal(user.terms_version, 'local-preview-v1');
    assert.match(user.password_hash, /^\$argon2id\$/); assert.ok(!user.password_hash.includes(password));
    const enrollment = (await db.query<{ status: string; accepted_by: string }>('SELECT status,accepted_by FROM enrollments')).rows[0]!;
    assert.equal(enrollment.status, 'active'); assert.equal(enrollment.accepted_by, user.id);
    const list = await teacher.request<TemporaryStudentPage>('/temporary-students');
    assert.equal(list.body.items[0]!.status, 'activated'); assert.equal(list.body.items[0]!.invitation.status, 'accepted');
    assert.match(list.body.items[0]!.studentPublicId!, /^STU-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal((await request('/auth/login', { email: draft.email, password })).status, 200);
    assert.equal((await request('/invitations/preview', { token: draft.token })).status, 410);
    assert.equal((await teacher.request(`/temporary-students/${draft.id}/revoke`, {})).status, 409);
    assert.equal((await teacher.request(`/temporary-students/${draft.id}/resend`, {})).status, 409);
    assert.equal((await teacher.request('/temporary-students', draft.dto)).status, 409);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE action='invitation.accepted'")).rowCount, 1);
  });

  test('existing emails in every account state are not disclosed to teachers, merged, altered or assigned new profiles', async () => {
    const { teacher, subjectId } = await setup();
    for (const status of ['active', 'pending_verification', 'suspended', 'deactivated', 'deleted']) {
      const existing = await account(status === 'active' ? 'student' : 'parent', `Аккаунт ${status}`);
      await db.query('UPDATE users SET status=$2 WHERE id=$1', [existing.id, status]);
      const before = (await db.query('SELECT * FROM users WHERE id=$1', [existing.id])).rows[0];
      const draft = await invite(teacher, subjectId, existing.email.toUpperCase());
      assert.equal((await request('/invitations/preview', { token: draft.token })).status, 200);
      const result = await request<ErrorBody>('/invitations/activate', activation(draft.token));
      assert.equal(result.status, 409); assert.equal(result.body.error.code, 'account_exists');
      assert.deepEqual((await db.query('SELECT * FROM users WHERE id=$1', [existing.id])).rows[0], before);
      const profile = (await db.query<{ public_id: string }>('SELECT public_id FROM student_profiles WHERE user_id=$1', [existing.id])).rows[0];
      assert.equal(profile?.public_id, status === 'active' ? existing.publicId : undefined);
      const list = await teacher.request<TemporaryStudentPage>('/temporary-students');
      const item = list.body.items.find(item => item.id === draft.id)!;
      assert.equal(item.status, 'pending'); assert.equal(item.name, 'Имя от учителя'); assert.equal(item.studentPublicId, undefined);
    }
    assert.equal((await db.query('SELECT id FROM enrollments')).rowCount, 0);
  });

  test('resend rotates once under concurrency and revoke makes every delivered link unusable', async () => {
    const { teacher, subjectId } = await setup(); const draft = await invite(teacher, subjectId);
    assert.equal((await teacher.request(`/temporary-students/${draft.id}/resend`, {})).status, 409);
    await permitResend(draft.id);
    const results = await Promise.all([1, 2].map(() => teacher.request(`/temporary-students/${draft.id}/resend`, {})));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]); await settled();
    assert.equal(mail.messages.length, 2); const second = mail.messages[1]!.token; assert.notEqual(second, draft.token);
    assert.equal((await request('/invitations/preview', { token: draft.token })).status, 410);
    assert.equal((await request('/invitations/preview', { token: second })).status, 200);
    const revoked = await Promise.all([1, 2].map(() => teacher.request(`/temporary-students/${draft.id}/revoke`, {})));
    assert.ok(revoked.every(result => result.status === 200));
    assert.equal((await request('/invitations/activate', activation(second))).status, 410);
    assert.equal((await teacher.request(`/temporary-students/${draft.id}/resend`, {})).status, 409);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE action='invitation.revoked'")).rowCount, 1);
    const replacement = await invite(teacher, subjectId, draft.email); assert.notEqual(replacement.id, draft.id);
  });

  test('expired token is committed as expired; clock is checked after a teacher lock wait and resend permits recovery', async () => {
    const { teacher, subjectId } = await setup(); const draft = await invite(teacher, subjectId);
    const blocker = await db.pool.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [teacher.id]);
      await blocker.query("UPDATE invitations SET created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()+interval '120 milliseconds' WHERE temporary_student_id=$1", [draft.id]);
      const response = request<ErrorBody>('/invitations/activate', activation(draft.token));
      await delay(220); await blocker.query('COMMIT');
      const result = await response; assert.equal(result.status, 410); assert.equal(result.body.error.code, 'invitation_unavailable');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    assert.equal((await db.query<{ status: string }>('SELECT status FROM invitations WHERE temporary_student_id=$1', [draft.id])).rows[0]!.status, 'expired');
    assert.equal((await db.query("SELECT id FROM audit_events WHERE action='invitation.expired' AND actor_user_id IS NULL")).rowCount, 1);
    assert.equal((await db.query('SELECT id FROM users WHERE email=$1', [draft.email])).rowCount, 0);
    assert.equal((await teacher.request<TemporaryStudentPage>('/temporary-students')).body.items[0]!.status, 'expired');
    assert.equal((await teacher.request(`/temporary-students/${draft.id}/revoke`, {})).status, 409);
    assert.equal((await db.query<{ status: string }>('SELECT status FROM invitations WHERE temporary_student_id=$1', [draft.id])).rows[0]!.status, 'expired');
    assert.equal((await teacher.request(`/temporary-students/${draft.id}/resend`, {})).status, 200); await settled();
    assert.equal((await request('/invitations/activate', activation(mail.messages[1]!.token))).status, 200);
  });

  test('expiry during enrollment persistence rolls back the new identity and still commits terminal invitation expiry', async () => {
    const { teacher, subjectId } = await setup(); const draft = await invite(teacher, subjectId);
    await db.query(`CREATE SEQUENCE invitation_delay_marker;
      CREATE FUNCTION delay_invitation_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('invitation_delay_marker'); PERFORM pg_sleep(1.2); RETURN NEW; END $$;
      CREATE TRIGGER delay_invitation_enrollment BEFORE INSERT ON enrollments FOR EACH ROW EXECUTE FUNCTION delay_invitation_enrollment()`);
    try {
      await db.query("UPDATE invitations SET expires_at=clock_timestamp()+interval '1 second' WHERE temporary_student_id=$1", [draft.id]);
      assert.equal((await request('/invitations/activate', activation(draft.token))).status, 410);
      assert.equal((await db.query<{ is_called: boolean }>('SELECT is_called FROM invitation_delay_marker')).rows[0]!.is_called, true);
      assert.equal((await db.query('SELECT id FROM users WHERE email=$1', [draft.email])).rowCount, 0);
      assert.equal((await db.query('SELECT id FROM student_profiles')).rowCount, 0);
      assert.equal((await db.query('SELECT id FROM enrollments')).rowCount, 0);
      assert.equal((await db.query<{ status: string }>('SELECT status FROM invitations WHERE temporary_student_id=$1', [draft.id])).rows[0]!.status, 'expired');
      assert.equal((await db.query("SELECT id FROM audit_events WHERE action='invitation.expired'")).rowCount, 1);
    } finally {
      await db.query('DROP TRIGGER delay_invitation_enrollment ON enrollments; DROP FUNCTION delay_invitation_enrollment(); DROP SEQUENCE invitation_delay_marker');
    }
  });

  test('activation races with revoke/resend and other-teacher same-email invitations never create duplicate identities', async () => {
    const { teacher, subjectId } = await setup();
    for (const action of ['revoke', 'resend']) {
      const draft = await invite(teacher, subjectId); await permitResend(draft.id);
      const results = await Promise.all([request('/invitations/activate', activation(draft.token)), teacher.request(`/temporary-students/${draft.id}/${action}`, {})]);
      assert.ok((results[0]!.status === 200 && results[1]!.status === 409) || (results[0]!.status === 410 && results[1]!.status === 200));
      await settled();
    }
    const other = await setup(); const email = `${randomUUID()}@example.test`;
    const first = await invite(teacher, subjectId, email); const second = await invite(other.teacher, other.subjectId, email);
    const results = await Promise.all([first, second].map(draft => request('/invitations/activate', activation(draft.token))));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await db.query('SELECT id FROM users WHERE email=$1', [email])).rowCount, 1);
    assert.equal((await db.query('SELECT s.id FROM student_profiles s JOIN users u ON u.id=s.user_id WHERE u.email=$1', [email])).rowCount, 1);
  });

  test('suspended teacher cannot activate or be previewed; errors and rollback leave no partial account', async () => {
    const { teacher, subjectId } = await setup(); const draft = await invite(teacher, subjectId);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [teacher.id]);
    assert.equal((await request('/invitations/preview', { token: draft.token })).status, 410);
    assert.equal((await request('/invitations/activate', activation(draft.token))).status, 410);
    await db.query("UPDATE users SET status='active' WHERE id=$1", [teacher.id]);
    await db.query(`CREATE FUNCTION fail_invitation_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced test failure'; END $$;
      CREATE TRIGGER fail_invitation_enrollment BEFORE INSERT ON enrollments FOR EACH ROW EXECUTE FUNCTION fail_invitation_enrollment()`);
    try {
      const response = await request<ErrorBody>('/invitations/activate', activation(draft.token));
      assert.equal(response.status, 500); assert.equal(response.body.error.code, 'internal_error');
      assert.ok(!JSON.stringify(response.body).includes('forced test failure'));
      assert.equal((await db.query('SELECT id FROM users WHERE email=$1', [draft.email])).rowCount, 0);
      assert.equal((await db.query('SELECT id FROM student_profiles')).rowCount, 0);
      assert.equal((await db.query<{ status: string }>('SELECT status FROM invitations WHERE temporary_student_id=$1', [draft.id])).rows[0]!.status, 'pending');
    } finally { await db.query('DROP TRIGGER fail_invitation_enrollment ON enrollments; DROP FUNCTION fail_invitation_enrollment()'); }
    assert.equal((await request('/invitations/activate', activation(draft.token))).status, 200);
  });

  test('SMTP failure is tracked without raw token/error leakage and retries require explicit rotation', async () => {
    const { teacher, subjectId } = await setup(); mail.fail = true;
    const logs: string[] = []; const previous = console.error; console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      const dto = { name: 'Приглашённый ученик', email: 'smtp-failure@example.test', subjectId, noAccountConfirmed: true };
      const response = await teacher.request('/temporary-students', dto); assert.equal(response.status, 201); await settled();
      const item = (await teacher.request<TemporaryStudentPage>('/temporary-students')).body.items[0]!;
      assert.equal(item.status, 'pending'); assert.equal(item.invitation.deliveryStatus, 'failed'); assert.equal(item.invitation.deliveryAttempts, 1);
      assert.deepEqual(logs, ['{"event":"invitation_mail_delivery_failed"}']);
      assert.equal((await teacher.request('/temporary-students', dto)).body.id, response.body.id); assert.equal(mail.messages.length, 0);
      mail.fail = false; await permitResend(response.body.id);
      assert.equal((await teacher.request(`/temporary-students/${response.body.id}/resend`, {})).status, 200); await settled();
      assert.equal(mail.messages.length, 1);
    } finally { console.error = previous; }
  });

  test('account-based invitation mail limits ignore spoofed headers and public token operations are limited', async () => {
    const { teacher, subjectId } = await setup(); const draft = await invite(teacher, subjectId);
    for (let index = 0; index < 14; index++) assert.equal((await teacher.request('/temporary-students', draft.dto)).status, 201);
    const limited = await request<ErrorBody>('/TeMpOrArY-StUdEnTs/', draft.dto, { ...teacher.headers, 'X-Account-ID': randomUUID() });
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '3600');
    assert.equal((await teacher.request(`/temporary-students/${draft.id}/resend`, {})).status, 429);
    for (let index = 0; index < 30; index++) assert.equal((await request('/invitations/preview', { token: newToken() })).status, 410);
    assert.equal((await request('/INVITATIONS/PREVIEW/', { token: newToken() })).status, 429);
  });

  test('recipient delivery limit is shared across teachers, create and resend without invalidating the current link', async () => {
    const { teacher, subjectId } = await setup(); const first = await invite(teacher, subjectId);
    for (let attempt = 0; attempt < 3; attempt++) {
      await permitResend(first.id); assert.equal((await teacher.request(`/temporary-students/${first.id}/resend`, {})).status, 200); await settled();
    }
    const secondTeacher = await setup(); const second = await invite(secondTeacher.teacher, secondTeacher.subjectId, first.email);
    assert.equal(mail.messages.length, 5); await permitResend(second.id);
    assert.equal((await secondTeacher.teacher.request(`/temporary-students/${second.id}/resend`, {})).status, 429);
    assert.equal((await request('/invitations/preview', { token: second.token })).status, 200);
    const thirdTeacher = await setup();
    assert.equal((await thirdTeacher.teacher.request('/temporary-students', { ...first.dto, subjectId: thirdTeacher.subjectId })).status, 429);
    assert.equal((await thirdTeacher.teacher.request<TemporaryStudentPage>('/temporary-students')).body.total, 0);
    assert.equal(mail.messages.length, 5);
  });

  test('OpenAPI documents the invitation contract and database shutdown drains delivery status work', async () => {
    const openapi = await request<{ paths: Record<string, unknown> }>('/openapi.json');
    for (const path of ['/api/v1/temporary-students', '/api/v1/temporary-students/{id}/resend', '/api/v1/temporary-students/{id}/revoke', '/api/v1/invitations/preview', '/api/v1/invitations/activate']) {
      assert.ok(openapi.body.paths[path], path);
    }
    const separate = new Database(readConfig({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'test' }));
    await separate.onModuleInit();
    let release!: () => void; let written = false; let closed = false;
    const wait = new Promise<void>(resolve => { release = resolve; });
    separate.trackBackground(wait.then(async () => { await separate.query('SELECT 1'); written = true; }));
    const closing = separate.onModuleDestroy().then(() => { closed = true; });
    await delay(20); assert.equal(closed, false); release(); await closing; assert.equal(written, true);
  });
});
