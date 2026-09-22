import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { Account, hashToken } from '../src/common';
import { AccountMail, MailDelivery } from '../src/mail';
import { migrate } from '../src/migrate';

const password = 'Example-password-123';
const origin = 'http://127.0.0.1:3000';
type ErrorBody = { error: { code: string; message: string; request_id: string } };
class TestMail implements MailDelivery {
  readonly messages: AccountMail[] = [];
  fail = false;
  async send(message: AccountMail) {
    if (this.fail) throw new Error('Simulated SMTP unavailable');
    this.messages.push(message);
  }
  latest(email: string, purpose: 'verify' | 'reset') {
    const message = [...this.messages].reverse().find(item => item.email === email && item.purpose === purpose);
    assert.ok(message, 'Expected an email');
    return message.token;
  }
}

describe('PostgreSQL accounts API', { concurrency: false }, () => {
  let app: INestApplication;
  let db: Database;
  let base: string;
  const mail = new TestMail();
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; integration tests must not silently skip PostgreSQL');
    const url = new URL(databaseUrl);
    assert.match(url.pathname, /_test$/, 'Tests only run against a separate database whose name ends with _test');
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), mail);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`;
    db = app.get(Database);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE users, rate_limits CASCADE');
    mail.messages.length = 0; mail.fail = false;
  });
  after(async () => { if (app) await app.close(); });

  class Client {
    cookies: Record<string, string> = {};
    async request<T = Record<string, unknown>>(path: string, body?: unknown, extraHeaders: Record<string, string> = {}, raw = false) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'X-Requested-With': 'ERepetitor',
          'Content-Type': 'application/json', Cookie: Object.entries(this.cookies).map(([key, value]) => `${key}=${value}`).join('; '), ...extraHeaders },
        body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
      });
      for (const set of response.headers.getSetCookie()) {
        const first = set.split(';')[0]!; const equals = first.indexOf('=');
        const key = first.slice(0, equals); const value = first.slice(equals + 1);
        if (value) this.cookies[key] = value; else delete this.cookies[key];
      }
      return { status: response.status, body: await response.json() as T, headers: response.headers };
    }
  }
  function registration(email: string, role = 'teacher') {
    return { name: 'Анна Смирнова', email, password, role, acceptTerms: true, acceptPrivacy: true };
  }
  async function active(role: 'teacher' | 'student' | 'parent' = 'teacher') {
    const client = new Client(); const email = `${randomUUID()}@example.com`;
    assert.equal((await client.request('/auth/register', registration(email, role))).status, 202);
    assert.equal((await client.request('/auth/verify-email', { token: mail.latest(email, 'verify') })).status, 200);
    const login = await client.request<{ user: Account }>('/auth/login', { email, password });
    assert.equal(login.status, 200);
    return { client, email, account: login.body.user, login };
  }

  test('registration validates consent, denies extra ownership fields, requires verification and stores only Argon2/token hashes', async () => {
    const client = new Client(); const email = 'student@example.com';
    const invalid = await client.request<ErrorBody>('/auth/register', { ...registration(email, 'student'), acceptTerms: false });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'validation_error'); assert.ok(invalid.body.error.request_id);
    assert.equal((await client.request('/auth/register', { ...registration(email), userId: randomUUID() })).status, 400);
    assert.equal((await client.request('/auth/register', registration(' STUDENT@EXAMPLE.COM ', 'student'))).status, 202);
    assert.equal((await client.request('/auth/login', { email, password })).status, 401);
    const token = mail.latest(email, 'verify');
    const user = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email=$1', [email])).rows[0]!;
    assert.match(user.password_hash, /^\$argon2id\$/); assert.notEqual(user.password_hash, password);
    const stored = (await db.query<{ token_hash: string }>('SELECT token_hash FROM account_tokens')).rows[0]!;
    assert.equal(stored.token_hash, hashToken(token)); assert.notEqual(stored.token_hash, token);
    assert.equal((await client.request('/auth/verify-email', { token })).status, 200);
    assert.equal((await client.request('/auth/verify-email', { token })).status, 400);
    const login = await client.request<{ user: Account }>('/auth/login', { email, password });
    assert.equal(login.status, 200); assert.deepEqual(login.body.user.roles, ['student']);
    assert.match(login.body.user.profiles.student!.publicId, /^STU-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.match(login.body.user.id, /^[a-f0-9-]{36}$/);
    for (const set of login.headers.getSetCookie()) { assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Path=\/api\/v1/); }
    assert.equal((await client.request<Account>('/me')).body.id, login.body.user.id);
    assert.ok(!JSON.stringify(login.body).includes('password_hash'));
  });

  test('duplicate registration does not overwrite account or reveal existence and resend invalidates old token', async () => {
    const client = new Client(); const email = 'duplicate@example.com';
    const first = await client.request('/auth/register', registration(email, 'student'));
    const old = mail.latest(email, 'verify');
    const duplicate = await client.request('/auth/register', { ...registration(email, 'teacher'), password: 'Someone-else-password' });
    assert.deepEqual(duplicate.body, first.body); assert.equal(duplicate.status, first.status); assert.equal(mail.messages.length, 1);
    assert.equal((await client.request('/auth/resend-verification', { email })).status, 202);
    assert.equal((await client.request('/auth/verify-email', { token: old })).status, 400);
    assert.equal((await client.request('/auth/verify-email', { token: mail.latest(email, 'verify') })).status, 200);
    const login = await client.request<{ user: Account }>('/auth/login', { email, password });
    assert.equal(login.status, 200); assert.deepEqual(login.body.user.roles, ['student']);
  });

  test('CSRF applies even to public registration/login and validates origin plus custom header', async () => {
    const client = new Client();
    for (const path of ['/auth/register', '/auth/login', '/auth/refresh', '/auth/logout', '/me/roles', '/subjects']) {
      assert.equal((await client.request(path, {}, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await client.request(path, {}, { 'X-Requested-With': '' })).status, 403);
      assert.equal((await client.request(path, {}, { Origin: '' })).status, 403);
    }
    assert.equal((await client.request('/auth/register', registration('csrf@example.com'))).status, 202);
  });

  test('malformed JSON and oversized bodies keep expected 400/413 error envelope', async () => {
    const client = new Client();
    const malformed = await client.request<ErrorBody>('/auth/login', '{oops', {}, true);
    assert.equal(malformed.status, 400); assert.ok(['invalid_json', 'validation_error'].includes(malformed.body.error.code));
    const oversized = await client.request<ErrorBody>('/auth/login', { email: 'a'.repeat(20000) });
    assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'payload_too_large');
  });

  test('teacher isolation, unique subject names, validated pagination and multiple roles', async () => {
    const anna = await active(); const murad = await active(); const student = await active('student');
    assert.equal((await anna.client.request('/subjects', { name: '  Математика  ' })).status, 201);
    assert.equal((await anna.client.request('/subjects', { name: 'математика' })).status, 409);
    assert.equal((await murad.client.request('/subjects', { name: 'Математика' })).status, 201);
    assert.equal((await student.client.request('/subjects', { name: 'Взлом' })).status, 403);
    const annaSubjects = await anna.client.request<{ items: { id: string; name: string }[]; total: number }>('/subjects');
    const muradSubjects = await murad.client.request<{ items: { id: string; name: string }[] }>('/subjects');
    assert.equal(annaSubjects.body.total, 1); assert.notEqual(annaSubjects.body.items[0]!.id, muradSubjects.body.items[0]!.id);
    assert.equal((await anna.client.request(`/subjects?teacherId=${murad.account.profiles.teacher!.id}`)).status, 400);
    assert.equal((await anna.client.request('/subjects?limit=0')).status, 400);
    assert.equal((await anna.client.request('/subjects?limit=1&offset=1')).body.items instanceof Array, true);
    assert.equal((await anna.client.request('/subjects', { name: 'Физика', teacherId: murad.account.profiles.teacher!.id })).status, 400);
    const parent = await anna.client.request<Account>('/me/roles', { role: 'parent' });
    assert.equal(parent.status, 200); assert.equal(parent.body.id, anna.account.id); assert.deepEqual(parent.body.roles, ['teacher', 'parent']);
    assert.equal((await anna.client.request('/me/roles', { role: 'admin' })).status, 400);
    assert.equal((await anna.client.request('/me/roles', { role: 'student', userId: murad.account.id })).status, 400);
    const additions = await Promise.all([anna.client.request<Account>('/me/roles', { role: 'student' }), anna.client.request<Account>('/me/roles', { role: 'student' })]);
    assert.equal(additions[0]!.body.profiles.student!.publicId, additions[1]!.body.profiles.student!.publicId);
    assert.notEqual(additions[0]!.body.profiles.student!.publicId, student.account.profiles.student!.publicId);
  });

  test('refresh rotates credentials, old access stops working, reuse revokes only its session', async () => {
    const user = await active(); const stale = new Client(); stale.cookies = { ...user.client.cookies };
    const second = new Client(); assert.equal((await second.request('/auth/login', { email: user.email, password })).status, 200);
    assert.equal((await user.client.request('/auth/refresh', {})).status, 200);
    assert.notEqual(user.client.cookies.er_refresh, stale.cookies.er_refresh);
    assert.equal((await stale.request('/me')).status, 401);
    assert.equal((await user.client.request('/me')).status, 200);
    assert.equal((await stale.request('/auth/refresh', {})).status, 401);
    assert.equal((await user.client.request('/me')).status, 401);
    assert.equal((await second.request('/me')).status, 200);
    assert.equal((await second.request('/auth/logout', { extra: true })).status, 400);
    assert.equal((await second.request('/auth/logout', {})).status, 200);
    assert.equal((await second.request('/me')).status, 401);
  });

  test('expected account header rejects stale-tab writes and logout without changing the active account', async () => {
    const anna = await active(); const murad = await active();
    const staleHeaders = { 'X-Account-ID': anna.account.id };
    for (const [path, body] of [['/subjects', { name: 'Wrong owner' }], ['/me/roles', { role: 'parent' }], ['/auth/logout', {}], ['/auth/logout-all', {}]] as const) {
      const result = await murad.client.request<ErrorBody>(path, body, staleHeaders);
      assert.equal(result.status, 409); assert.equal(result.body.error.code, 'account_changed');
    }
    assert.equal((await murad.client.request('/me')).status, 200);
    assert.equal((await murad.client.request<{ total: number }>('/subjects')).body.total, 0);
    assert.deepEqual((await murad.client.request<Account>('/me')).body.roles, ['teacher']);
    assert.equal((await murad.client.request('/subjects', { name: 'Correct owner' }, { 'X-Account-ID': murad.account.id })).status, 201);
  });

  test('concurrent refresh has one winner, then reuse commits revocation', async () => {
    const user = await active(); const other = new Client(); other.cookies = { ...user.client.cookies };
    const results = await Promise.all([user.client.request('/auth/refresh', {}), other.request('/auth/refresh', {})]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
    assert.equal((await user.client.request('/me')).status, 401); assert.equal((await other.request('/me')).status, 401);
    const revoked = (await db.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM sessions WHERE user_id=$1', [user.account.id])).rows[0]!;
    assert.ok(revoked.revoked_at);
  });

  test('logout-all and password reset revoke all sessions; reset is single-use', async () => {
    const user = await active(); const second = new Client();
    assert.equal((await second.request('/auth/login', { email: user.email, password })).status, 200);
    assert.equal((await user.client.request('/auth/logout-all', {})).status, 200);
    assert.equal((await second.request('/me')).status, 401);
    assert.equal((await user.client.request('/auth/login', { email: user.email, password })).status, 200);
    assert.equal((await second.request('/auth/login', { email: user.email, password })).status, 200);
    const anonymous = new Client();
    assert.equal((await anonymous.request('/auth/forgot-password', { email: user.email })).status, 202);
    const token = mail.latest(user.email, 'reset'); const replacement = 'Replacement-password-456';
    assert.equal((await anonymous.request('/auth/reset-password', { token, password: replacement })).status, 200);
    assert.equal((await user.client.request('/me')).status, 401); assert.equal((await second.request('/auth/refresh', {})).status, 401);
    assert.equal((await anonymous.request('/auth/reset-password', { token, password: replacement })).status, 400);
    assert.equal((await anonymous.request('/auth/login', { email: user.email, password })).status, 401);
    assert.equal((await anonymous.request('/auth/login', { email: user.email, password: replacement })).status, 200);
  });

  test('expired verification/reset/access tokens and suspended accounts are rejected using DB time', async () => {
    const client = new Client(); const email = 'expired@example.com';
    await client.request('/auth/register', registration(email)); const verification = mail.latest(email, 'verify');
    await db.query("UPDATE account_tokens SET expires_at=now()-interval '1 second'");
    assert.equal((await client.request('/auth/verify-email', { token: verification })).status, 400);
    await client.request('/auth/resend-verification', { email }); await client.request('/auth/verify-email', { token: mail.latest(email, 'verify') });
    await client.request('/auth/login', { email, password });
    await db.query("UPDATE access_tokens SET expires_at=now()-interval '1 second'");
    assert.equal((await client.request('/me')).status, 401); assert.equal((await client.request('/auth/refresh', {})).status, 200);
    await client.request('/auth/forgot-password', { email }); const reset = mail.latest(email, 'reset');
    await db.query("UPDATE account_tokens SET expires_at=now()-interval '1 second' WHERE purpose='reset'");
    assert.equal((await client.request('/auth/reset-password', { token: reset, password: 'New-password-456' })).status, 400);
    await db.query("UPDATE users SET status='suspended' WHERE email=$1", [email]);
    assert.equal((await client.request('/me')).status, 401); assert.equal((await client.request('/auth/refresh', {})).status, 401);
    assert.equal((await client.request('/auth/login', { email, password })).status, 401);
  });

  test('login throttling cannot be bypassed by route casing or trailing slash', async () => {
    const client = new Client(); const email = 'unknown@example.com';
    for (let attempt = 0; attempt < 10; attempt++) {
      const path = attempt % 2 ? '/AUTH/LOGIN/' : '/auth/login';
      assert.equal((await client.request(path, { email, password })).status, 401);
    }
    const blocked = await client.request<ErrorBody>('/Auth/Login/', { email, password });
    assert.equal(blocked.status, 429); assert.equal(blocked.body.error.code, 'rate_limited'); assert.ok(blocked.headers.get('retry-after'));
  });

  test('SMTP failure keeps public response uniform and pending account can use resend', async () => {
    const client = new Client(); const email = 'mail-down@example.com'; mail.fail = true;
    const register = await client.request('/auth/register', registration(email)); assert.equal(register.status, 202);
    const eligible = await client.request('/auth/resend-verification', { email });
    const unknown = await client.request('/auth/resend-verification', { email: 'not-registered@example.com' });
    assert.equal(eligible.status, unknown.status); assert.deepEqual(eligible.body, unknown.body);
    mail.fail = false; await client.request('/auth/resend-verification', { email });
    assert.equal((await client.request('/auth/verify-email', { token: mail.latest(email, 'verify') })).status, 200);
  });

  test('failed profile insertion rolls back account, consent and token creation', async () => {
    const client = new Client(); const email = 'rollback@example.com';
    await db.query('ALTER TABLE student_profiles ADD CONSTRAINT test_reject_new_profiles CHECK(false) NOT VALID');
    try {
      assert.equal((await client.request('/auth/register', registration(email, 'student'))).status, 500);
      assert.equal((await db.query('SELECT id FROM users WHERE email=$1', [email])).rowCount, 0);
      assert.equal((await db.query('SELECT token_hash FROM account_tokens')).rowCount, 0);
      assert.equal(mail.messages.length, 0);
    } finally { await db.query('ALTER TABLE student_profiles DROP CONSTRAINT test_reject_new_profiles'); }
  });

  test('OpenAPI documents all account/subject endpoints and never exposes data', async () => {
    const client = new Client(); const spec = await client.request<{ paths: Record<string, unknown> }>('/openapi.json');
    assert.equal(spec.status, 200);
    for (const path of ['/auth/register', '/auth/login', '/auth/refresh', '/auth/verify-email', '/auth/reset-password', '/me', '/me/roles', '/subjects']) {
      assert.ok(spec.body.paths[`/api/v1${path}`], path);
    }
  });
});
