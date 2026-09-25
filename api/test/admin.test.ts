import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hash, Algorithm } from '@node-rs/argon2';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { migrate } from '../src/migrate';
import { Account, ApiError, ApiRequest, hashToken, newToken, Role } from '../src/common';
import { AdminAuditPage, AdminOverviewView, AdminUserDetail, AdminUsersPage, AdminUserView, UserStatus } from '../src/admin.dto';
import { AdminService } from '../src/admin';
import { AccountsService } from '../src/accounts';
import { assertLocalAdminDatabase, changeAdminMembership } from '../src/admin.bootstrap';
import { notifyLesson } from '../src/notifications.events';

const origin = 'http://127.0.0.1:3000';
const password = 'Admin-test-password-123';
type ErrorBody = { error: { code: string } };
describe('PostgreSQL administrative access API', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string; let passwordHash: string; let databaseUrl: string;
  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required'); databaseUrl = process.env.TEST_DATABASE_URL;
    const url = new URL(databaseUrl);
    assert.match(url.pathname, /_test$/, 'Only a dedicated test database may be truncated');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Admin tests require local PostgreSQL');
    await migrate(databaseUrl);
    passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), { send: async () => undefined });
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(async () => { await db.query('TRUNCATE users, rate_limits CASCADE'); });
  after(async () => { if (app) await app.close(); });

  class Client {
    constructor(readonly userId: string, readonly token: string) {}
    async request<T = AdminUserView>(path: string, body?: unknown, extra: Record<string, string> = {}) {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
        Origin: origin, 'X-Requested-With': 'ERepetitor', 'X-Account-ID': this.userId,
        'Content-Type': 'application/json', Cookie: `er_access=${this.token}`, ...extra,
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as T };
    }
  }
  async function account(role: Role = 'teacher', admin = false, status: UserStatus = 'active', email?: string, userId: string = randomUUID()) {
    const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken(); const refresh = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase(); const publicId = `STU-${code.slice(0, 4)}-${code.slice(4)}`;
    const address = email ?? `${userId}@example.test`;
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,$4,$5,'private-terms-version','private-privacy-version')`, [userId, role, address, passwordHash, status]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, publicId]);
    else await db.query(`INSERT INTO ${role === 'teacher' ? 'teacher_profiles' : 'parent_profiles'}(id,user_id) VALUES($1,$2)`, [profileId, userId]);
    if (admin) await db.query("INSERT INTO admin_memberships(user_id,grant_reason) VALUES($1,'Test administrative access')", [userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    await db.query("INSERT INTO refresh_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(refresh), sessionId]);
    return { client: new Client(userId, token), userId, profileId, publicId, sessionId, token, refresh, email: address };
  }
  type Person = Awaited<ReturnType<typeof account>>;
  const path = (person: Person) => `/admin/users/${person.userId}/status`;
  const change = (status: 'active' | 'suspended' | 'deactivated', version = 1) => ({ status, version, reason: 'Проверенная причина изменения' });
  const bootstrapConfig = () => ({ databaseUrl, production: false });
  async function error(client: Client, route: string, body: unknown | undefined, status: number, code: string) {
    const response = await client.request<ErrorBody>(route, body);
    assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.error.code, code);
  }
  async function accountToken(person: Person, purpose = 'reset') {
    const token = newToken(); await db.query("INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [hashToken(token), person.userId, purpose]); return token;
  }
  async function waitForLock(fragment: string) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if ((await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND strpos(query,$1)>0", [fragment])).rows[0]) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Expected the request to wait for its user lock');
  }

  test('administrative routes require a live authenticated session', async () => {
    for (const path of ['/admin/overview', '/admin/users', '/admin/audit']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401);
    }
  });

  test('ordinary roles cannot access admin routes and cannot grant themselves administrative capability', async () => {
    for (const role of ['teacher', 'student', 'parent'] as const) {
      const person = await account(role);
      for (const route of ['/admin/overview', '/admin/users', '/admin/audit', `/admin/users/${person.userId}`]) await error(person.client, route, undefined, 403, 'admin_required');
      await error(person.client, path(person), change('suspended'), 403, 'admin_required');
      await error(person.client, '/me/roles', { role: 'admin' }, 400, 'validation_error');
      await error(person.client, '/me/roles', { role: 'teacher', isAdmin: true }, 400, 'validation_error');
      assert.equal((await person.client.request<Account>('/me')).body.isAdmin, false);
    }
    const admin = await account('parent', true);
    const me = (await admin.client.request<Account>('/me')).body;
    assert.equal(me.isAdmin, true); assert.deepEqual(me.roles, ['parent']);
  });

  test('an ordinary account is rejected before waiting for a target account lock', async () => {
    const ordinary = await account('student'); const target = await account('teacher'); const blocker = await db.pool.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [target.userId]);
      await assert.rejects(app.get(AdminService).status({ userId: ordinary.userId, sessionId: ordinary.sessionId } as ApiRequest,
        target.userId, change('suspended')), error => error instanceof ApiError && error.getStatus() === 403);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });

  test('user search is literal and case-insensitive, roles compose, and pagination has stable safe projections', async () => {
    const admin = await account('teacher', true); const student = await account('student');
    const literal = await account('parent', false, 'active', 'literal_%@example.test');
    await account('parent', false, 'active', 'literal-ab@example.test');
    await student.client.request('/me/roles', { role: 'parent' });
    const all = (await admin.client.request<AdminUsersPage>('/admin/users?limit=2')).body;
    const second = (await admin.client.request<AdminUsersPage>('/admin/users?limit=2&offset=2')).body;
    assert.equal(all.total, 4); assert.equal(all.limit, 2); assert.equal(new Set([...all.items, ...second.items].map(user => user.id)).size, 4);
    assert.deepEqual(Object.keys(all.items[0]!).sort(), ['id', 'name', 'email', 'status', 'roles', 'isAdmin', 'publicId', 'createdAt', 'statusVersion'].sort());
    const byId = (await admin.client.request<AdminUsersPage>(`/admin/users?query=${student.publicId.toLowerCase()}`)).body;
    assert.equal(byId.total, 1); assert.deepEqual(byId.items[0]!.roles, ['student', 'parent']);
    const wildcard = (await admin.client.request<AdminUsersPage>('/admin/users?query=_%25')).body;
    assert.equal(wildcard.total, 1); assert.equal(wildcard.items[0]!.id, literal.userId);
    assert.equal((await admin.client.request<AdminUsersPage>('/admin/users?query=LITERAL&role=parent&status=active')).body.total, 2);
    assert.equal((await admin.client.request<AdminUsersPage>('/admin/users?role=admin')).body.items[0]!.id, admin.userId);
    assert.equal((await admin.client.request<AdminUsersPage>('/admin/users?offset=10000')).body.items.length, 0);
    assert.ok(!JSON.stringify(all).includes(passwordHash)); assert.ok(!JSON.stringify(all).includes('private-terms'));
  });

  test('overview counts cover all account states and domain totals without educational content', async () => {
    const admin = await account('parent', true); const teacher = await account('teacher'); const student = await account('student');
    for (const status of ['pending_verification', 'suspended', 'deactivated', 'deleted'] as const) await account('student', false, status);
    const subject = randomUUID(); const enrollment = randomUUID();
    await db.query("INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,'PRIVATE SUBJECT')", [subject, teacher.profileId]);
    await db.query("INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by) VALUES($1,$2,$3,$4,'active',now(),$5)", [enrollment, teacher.profileId, student.profileId, subject, student.userId]);
    for (const status of ['scheduled', 'completed']) await db.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,request_id,request_payload,starts_at,duration_min,format,status,private_notes)
      VALUES($1,$2,$3,$4,$5,'{}',now(),30,'online',$6,'PRIVATE NOTES')`, [randomUUID(), enrollment, teacher.profileId, student.profileId, randomUUID(), status]);
    for (const status of ['draft', 'published']) {
      const testId = randomUUID();
      await db.query("INSERT INTO test_families(id,teacher_id,subject_id,title) VALUES($1,$2,$3,'PRIVATE TEST')", [testId, teacher.profileId, subject]);
      await db.query("INSERT INTO tests(id,family_id,teacher_id,subject_id,request_id,request_payload,title,questions,status) VALUES($1,$1,$2,$3,$4,'{}','PRIVATE TEST','[]',$5)", [testId, teacher.profileId, subject, randomUUID(), status]);
    }
    const response = await admin.client.request<AdminOverviewView>('/admin/overview'); assert.equal(response.status, 200);
    assert.deepEqual(response.body.users, { total: 7, active: 3, suspended: 1, pendingVerification: 1, deactivated: 1, deleted: 1 });
    assert.deepEqual(response.body.enrollments, { total: 1, active: 1 }); assert.deepEqual(response.body.lessons, { total: 2, scheduled: 1 });
    assert.deepEqual(response.body.tests, { total: 2, published: 1 }); assert.ok(Number.isFinite(Date.parse(response.body.generatedAt)));
    assert.ok(!JSON.stringify(response.body).includes('PRIVATE'));
    for (const status of ['pending_verification', 'suspended', 'deactivated', 'deleted']) assert.equal((await admin.client.request<AdminUsersPage>(`/admin/users?status=${status}`)).body.total, 1);
  });

  test('technical detail exposes only metadata and counts active sessions', async () => {
    const admin = await account('teacher', true); const target = await account('student');
    await db.query("INSERT INTO sessions(id,user_id,expires_at,revoked_at) VALUES($1,$3,now()-interval '1 day',NULL),($2,$3,now()+interval '1 day',now())", [randomUUID(), randomUUID(), target.userId]);
    const detail = await admin.client.request<AdminUserDetail>(`/admin/users/${target.userId}`);
    assert.equal(detail.status, 200); assert.equal(detail.body.activeSessions, 1); assert.equal(detail.body.user.publicId, target.publicId);
    assert.deepEqual(Object.keys(detail.body).sort(), ['user', 'updatedAt', 'activeSessions'].sort());
    assert.ok(!JSON.stringify(detail.body).includes(target.token)); assert.ok(!JSON.stringify(detail.body).includes(passwordHash));
    await error(admin.client, `/admin/users/${randomUUID()}`, undefined, 404, 'not_found');
  });

  test('suspension atomically revokes all sessions and tokens and records its exact reason', async () => {
    const admin = await account('teacher', true); const target = await account('student'); const reset = await accountToken(target);
    await accountToken(target, 'verify');
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [randomUUID(), target.userId]);
    const suspended = await admin.client.request(path(target), { ...change('suspended'), reason: '  Проверка\nобращения  ' });
    assert.equal(suspended.status, 200); assert.equal(suspended.body.status, 'suspended'); assert.equal(suspended.body.statusVersion, 2);
    assert.equal((await db.query('SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [target.userId])).rowCount, 0);
    assert.equal((await db.query('SELECT token_hash FROM account_tokens WHERE user_id=$1 AND used_at IS NULL', [target.userId])).rowCount, 0);
    await error(target.client, '/me', undefined, 401, 'unauthenticated');
    assert.equal((await target.client.request('/auth/refresh', {}, { Cookie: `er_refresh=${target.refresh}` })).status, 401);
    assert.equal((await target.client.request('/auth/login', { email: target.email, password })).status, 401);
    assert.equal((await target.client.request('/auth/reset-password', { token: reset, password })).status, 400);
    const audit = (await admin.client.request<AdminAuditPage>(`/admin/audit?userId=${target.userId}`)).body;
    assert.equal(audit.total, 1); assert.equal(audit.items[0]!.action, 'admin.user.suspended'); assert.equal(audit.items[0]!.actorId, admin.userId);
    assert.equal(audit.items[0]!.reason, 'Проверка обращения'); assert.equal(audit.items[0]!.fromStatus, 'active'); assert.equal(audit.items[0]!.toStatus, 'suspended');
  });

  test('unsuspending requires the current version and never restores old sessions or reset links', async () => {
    const admin = await account('teacher', true); const target = await account('student'); const reset = await accountToken(target);
    await admin.client.request(path(target), change('suspended'));
    await error(admin.client, path(target), change('active'), 409, 'version_conflict');
    const restored = await admin.client.request(path(target), change('active', 2)); assert.equal(restored.status, 200); assert.equal(restored.body.statusVersion, 3);
    await error(target.client, '/me', undefined, 401, 'unauthenticated');
    assert.equal((await target.client.request('/auth/refresh', {}, { Cookie: `er_refresh=${target.refresh}` })).status, 401);
    assert.equal((await target.client.request('/auth/reset-password', { token: reset, password })).status, 400);
    assert.equal((await target.client.request<{ user: Account }>('/auth/login', { email: target.email, password })).status, 200);
    assert.equal((await admin.client.request<AdminAuditPage>(`/admin/audit?userId=${target.userId}`)).body.total, 3); // Two status events and the new session.
  });

  test('pending accounts cannot bypass verification and may be deactivated without later resurrection', async () => {
    const admin = await account('teacher', true); const pending = await account('student', false, 'pending_verification'); const token = await accountToken(pending, 'verify');
    await error(admin.client, path(pending), change('active'), 409, 'invalid_status_transition');
    await error(admin.client, path(pending), change('suspended'), 409, 'invalid_status_transition');
    const response = await admin.client.request(path(pending), change('deactivated')); assert.equal(response.status, 200);
    await error(admin.client, path(pending), change('active', 2), 409, 'invalid_status_transition');
    assert.equal((await pending.client.request('/auth/verify-email', { token })).status, 400);
  });

  test('email verification advances the status version so stale pending-account decisions conflict', async () => {
    const admin = await account('teacher', true); const pending = await account('student', false, 'pending_verification'); const token = await accountToken(pending, 'verify');
    assert.equal((await pending.client.request('/auth/verify-email', { token })).status, 200);
    await error(admin.client, path(pending), change('deactivated'), 409, 'version_conflict');
    assert.equal((await admin.client.request<AdminUserDetail>(`/admin/users/${pending.userId}`)).body.user.statusVersion, 2);
  });

  test('deactivation is terminal for active and suspended accounts and preserves profiles', async () => {
    const admin = await account('teacher', true);
    for (const suspended of [false, true]) {
      const target = await account('student'); if (suspended) await admin.client.request(path(target), change('suspended'));
      const response = await admin.client.request(path(target), change('deactivated', suspended ? 2 : 1)); assert.equal(response.status, 200);
      assert.equal(response.body.status, 'deactivated');
      for (const status of ['active', 'suspended', 'deactivated'] as const) await error(admin.client, path(target), change(status, response.body.statusVersion), 409, 'invalid_status_transition');
      assert.equal((await db.query('SELECT id FROM student_profiles WHERE user_id=$1', [target.userId])).rowCount, 1);
      await error(target.client, '/me', undefined, 401, 'unauthenticated');
    }
  });

  test('self and all administrator accounts are protected from status changes including uppercase UUIDs', async () => {
    const admin = await account('teacher', true); const other = await account('parent', true);
    for (const target of [admin, other]) for (const status of ['active', 'suspended', 'deactivated'] as const) {
      await error(admin.client, `/admin/users/${target.userId.toUpperCase()}/status`, change(status), 403, 'admin_protected');
    }
    assert.equal((await db.query('SELECT id FROM audit_events')).rowCount, 0);
  });

  test('strict validation rejects forged payload fields, malformed pagination, invalid status and weak reasons', async () => {
    const admin = await account('teacher', true); const target = await account('student');
    for (const payload of [{ status: 'deleted' }, { status: null }, { version: 0 }, { version: '1' }, { version: 1.5 }, { version: null }, { version: 2147483647 },
      { reason: '  ' }, { reason: null }, { reason: 'aa' }, { reason: 'x'.repeat(501) }, { reason: 'bad\u0000control' }, { isAdmin: true }, { userId: admin.userId }]) {
      await error(admin.client, path(target), { ...change('suspended'), ...payload }, 400, 'validation_error');
    }
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=10001', 'role=owner', 'status=unknown', 'query=a&query=b', 'unknown=true']) {
      await error(admin.client, `/admin/users?${query}`, undefined, 400, 'validation_error');
    }
    await error(admin.client, '/admin/overview?unknown=true', undefined, 400, 'validation_error');
    await error(admin.client, '/admin/audit?userId=bad', undefined, 400, 'validation_error');
    assert.equal((await db.query('SELECT id FROM audit_events')).rowCount, 0);
  });

  test('concurrent administrators use CAS so exactly one state change and audit record wins', async () => {
    const first = await account('teacher', true); const second = await account('parent', true); const target = await account('student');
    const responses = await Promise.all([first.client.request(path(target), change('suspended')), second.client.request(path(target), change('deactivated'))]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const events = await db.query('SELECT id FROM audit_events WHERE entity_id=$1', [target.userId]); assert.equal(events.rowCount, 1);
    assert.equal((await db.query('SELECT status_version FROM users WHERE id=$1', [target.userId])).rows[0]!.status_version, 2);
  });

  test('CSRF and stale-account contexts reject administration before any mutation', async () => {
    const admin = await account('teacher', true); const target = await account('student');
    const csrf = await admin.client.request<ErrorBody>(path(target), change('suspended'), { Origin: 'http://malicious.invalid' });
    assert.equal(csrf.status, 403); assert.equal(csrf.body.error.code, 'csrf_rejected');
    const stale = await admin.client.request<ErrorBody>(path(target), change('suspended'), { 'X-Account-ID': target.userId });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'account_changed');
    assert.equal((await db.query('SELECT id FROM audit_events')).rowCount, 0);
  });

  test('membership is rechecked after waiting for the actor lock on every administrative read', async () => {
    for (const route of ['overview', 'users', 'user', 'audit'] as const) {
      const admin = await account('teacher', true); const tx = await db.pool.connect();
      const service = app.get(AdminService); const req = { userId: admin.userId, sessionId: admin.sessionId } as ApiRequest;
      let pending: Promise<unknown> | undefined;
      try {
        await tx.query('BEGIN'); await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [admin.userId]);
        pending = route === 'overview' ? service.overview(req) : route === 'users' ? service.users(req, { limit: 20, offset: 0 })
          : route === 'user' ? service.user(req, admin.userId) : service.audit(req, { limit: 20, offset: 0 });
        const denied = assert.rejects(pending, error => error instanceof ApiError && error.getStatus() === 403);
        await waitForLock('SELECT u.id FROM users u');
        await tx.query('DELETE FROM admin_memberships WHERE user_id=$1', [admin.userId]); await tx.query('COMMIT'); await denied;
      } finally { await tx.query('ROLLBACK'); tx.release(); await pending?.catch(() => undefined); }
    }
  });

  test('a user mutation queued behind suspension cannot commit with the pre-suspension session', async () => {
    const admin = await account('parent', true); const target = await account('teacher'); const blocker = await db.pool.connect();
    let suspended: Promise<AdminUserView> | undefined; let mutation: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [target.userId]);
      suspended = app.get(AdminService).status({ userId: admin.userId, sessionId: admin.sessionId } as ApiRequest, target.userId, change('suspended'));
      await waitForLock('SELECT id FROM users WHERE id=ANY');
      mutation = app.get(AccountsService).createSubject({ userId: target.userId, sessionId: target.sessionId } as ApiRequest, 'Must not be created');
      const rejected = assert.rejects(mutation, error => error instanceof ApiError && error.getStatus() === 401);
      await waitForLock('SELECT u.id FROM users u'); await blocker.query('COMMIT');
      assert.equal((await suspended).status, 'suspended'); await rejected;
      assert.equal((await db.query('SELECT id FROM subjects WHERE teacher_id=$1', [target.profileId])).rowCount, 0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await suspended?.catch(() => undefined); await mutation?.catch(() => undefined); }
  });

  test('an audit storage failure rolls back the status update and session revocation together', async () => {
    const admin = await account('parent', true); const target = await account('teacher');
    // Bypass the HTTP DTO only to force the database audit reason constraint to fail.
    await assert.rejects(app.get(AdminService).status({ userId: admin.userId, sessionId: admin.sessionId } as ApiRequest,
      target.userId, { ...change('suspended'), reason: '' }));
    assert.equal((await db.query('SELECT status FROM users WHERE id=$1', [target.userId])).rows[0]!.status, 'active');
    assert.equal((await target.client.request('/me')).status, 200);
    assert.equal((await db.query('SELECT id FROM audit_events')).rowCount, 0);
  });

  test('suspending a teacher does not deadlock a notification addressed to the administrator', async () => {
    // Fixed ordering makes admin lock the actor before waiting for the teacher.
    const admin = await account('parent', true, 'active', undefined, '00000000-0000-4000-8000-000000000001');
    const teacher = await account('teacher', false, 'active', undefined, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    const student = await account('student'); const subject = randomUUID(); const enrollment = randomUUID(); const lesson = randomUUID();
    await db.query("INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,'Race test')", [subject, teacher.profileId]);
    await db.query("INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by) VALUES($1,$2,$3,$4,'active',now(),$5)", [enrollment, teacher.profileId, student.profileId, subject, student.userId]);
    await db.query("INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by) VALUES($1,$2,$3,'active',now(),$4)", [randomUUID(), admin.profileId, student.profileId, student.userId]);
    await db.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,request_id,request_payload,starts_at,duration_min,format,status)
      VALUES($1,$2,$3,$4,$5,'{}',now()+interval '1 hour',30,'online','teacher_cancelled')`, [lesson, enrollment, teacher.profileId, student.profileId, randomUUID()]);
    const teacherTransaction = await db.pool.connect(); let suspended: Promise<AdminUserView | Error> | undefined;
    try {
      await teacherTransaction.query('BEGIN'); await teacherTransaction.query('SET LOCAL statement_timeout=5000');
      await teacherTransaction.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [teacher.userId]);
      suspended = app.get(AdminService).status({ userId: admin.userId, sessionId: admin.sessionId } as ApiRequest, teacher.userId, change('suspended')).catch(error => error as Error);
      await waitForLock('SELECT id FROM users WHERE id=ANY');
      await notifyLesson(teacherTransaction, lesson, 'lesson_cancelled');
      await teacherTransaction.query('COMMIT');
      const result = await suspended; assert.ok(!(result instanceof Error), String(result)); assert.equal(result.status, 'suspended');
      assert.equal((await db.query("SELECT id FROM notifications WHERE recipient_user_id=$1 AND type='lesson_cancelled'", [admin.userId])).rowCount, 1);
    } finally { await teacherTransaction.query('ROLLBACK'); teacherTransaction.release(); await suspended; }
  });

  test('local bootstrap guards, grants and revokes are audited and protect the last active administrator', async () => {
    for (const config of [{ databaseUrl: 'postgresql://user@example.com/data', production: false }, { databaseUrl: 'postgresql://user@127.0.0.1/data', production: true },
      { databaseUrl: 'postgresql://user@127.0.0.1/data?host=example.com', production: false }]) {
      assert.throws(() => assertLocalAdminDatabase(config));
    }
    const first = await account('teacher'); const second = await account('parent'); const pending = await account('student', false, 'pending_verification');
    await assert.rejects(changeAdminMembership(bootstrapConfig(), 'grant', pending.userId, 'Local setup'), /active/);
    await assert.rejects(changeAdminMembership(bootstrapConfig(), 'grant', first.userId, 'a'), /3–500/);
    const reset = await accountToken(first);
    assert.deepEqual(await changeAdminMembership(bootstrapConfig(), 'grant', first.userId, 'Local\nsetup'), { changed: true });
    assert.ok((await db.query('SELECT used_at FROM account_tokens WHERE token_hash=$1', [hashToken(reset)])).rows[0]!.used_at);
    assert.deepEqual(await changeAdminMembership(bootstrapConfig(), 'grant', first.userId, 'Retry setup'), { changed: false });
    await assert.rejects(changeAdminMembership(bootstrapConfig(), 'revoke', first.userId, 'Remove access'), /last active/);
    await changeAdminMembership(bootstrapConfig(), 'grant', second.userId, 'Second administrator');
    await changeAdminMembership(bootstrapConfig(), 'revoke', first.userId, 'Remove access');
    assert.equal((await db.query('SELECT user_id FROM admin_memberships')).rowCount, 1);
    await error(first.client, '/admin/overview', undefined, 401, 'unauthenticated');
    const audit = await db.query('SELECT actor_user_id,action,reason FROM audit_events ORDER BY created_at,id');
    assert.equal(audit.rowCount, 3); assert.ok(audit.rows.every(row => row.actor_user_id === null && typeof row.reason === 'string'));
    assert.ok(audit.rows.some(row => row.action === 'admin.membership.revoked'));
  });

  test('simultaneous local revocations cannot remove both administrators', async () => {
    const first = await account('teacher', true); const second = await account('parent', true);
    const results = await Promise.allSettled([first, second].map(person => changeAdminMembership(bootstrapConfig(), 'revoke', person.userId, 'Concurrent access removal')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await db.query('SELECT user_id FROM admin_memberships')).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE action='admin.membership.revoked'")).rowCount, 1);
  });

  test('audit includes safe generic metadata and supports account filtering and bounded pagination', async () => {
    const admin = await account('teacher', true); const target = await account('student'); const unrelated = await account('parent');
    await admin.client.request(path(target), change('suspended'));
    await db.query("INSERT INTO audit_events(id,actor_user_id,action,entity_id) VALUES($1,$2,'profile.parent.enabled',$2),($3,$4,'profile.parent.enabled',$4)", [randomUUID(), target.userId, randomUUID(), unrelated.userId]);
    const filtered = (await admin.client.request<AdminAuditPage>(`/admin/audit?userId=${target.userId}&limit=1&offset=1`)).body;
    assert.equal(filtered.total, 2); assert.equal(filtered.items.length, 1);
    assert.deepEqual(Object.keys(filtered.items[0]!).sort(), ['id', 'action', 'actorId', 'actorName', 'entityId', 'createdAt', 'reason', 'fromStatus', 'toStatus'].sort());
    assert.equal((await admin.client.request<AdminAuditPage>('/admin/audit')).body.total, 3);
    assert.ok(!JSON.stringify(filtered).includes(passwordHash)); assert.ok(!JSON.stringify(filtered).includes('@example'));
  });
});
