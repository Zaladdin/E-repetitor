import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import { resetTestDatabase } from './reset-database';
import { NotificationMail, NotificationMailDelivery } from '../src/notifications.mail';
import { NotificationsWorker } from '../src/notifications.worker';
import { notifyLesson } from '../src/notifications.events';
import { NotificationPage } from '../src/notifications.dto';

const origin = 'http://127.0.0.1:3000';
class FakeMail implements NotificationMailDelivery {
  messages: NotificationMail[] = []; fail = false;
  async send(message: NotificationMail) { if (this.fail) throw new Error('PRIVATE SMTP credentials'); this.messages.push(message); }
}
describe('PostgreSQL notifications and durable email queue', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string; let worker: NotificationsWorker;
  const mail = new FakeMail();
  before(async () => {
    const url = process.env.TEST_DATABASE_URL; assert.ok(url); assert.match(new URL(url).pathname, /_test$/);
    await migrate(url);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: url, WEB_ORIGIN: origin, NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'false' }), { send: async () => undefined }, mail);
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database); worker = app.get(NotificationsWorker);
  });
  beforeEach(async () => { await resetTestDatabase(db); mail.messages = []; mail.fail = false; });
  after(async () => { if (app) await app.close(); });
  async function account(role: Role) {
    const userId = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version) VALUES($1,$2,$3,'unused','active','test','test')`, [userId, role, `${userId}@example.test`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, `STU-${code.slice(0, 4)}-${code.slice(4)}`]);
    else await db.query(`INSERT INTO ${role === 'teacher' ? 'teacher_profiles' : 'parent_profiles'}(id,user_id) VALUES($1,$2)`, [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { userId, profileId, sessionId, token };
  }
  type Person = Awaited<ReturnType<typeof account>>;
  async function request(p: Person, path: string, method = 'GET', body?: unknown) {
    return fetch(`${base}${path}`, { method, headers: { Cookie: `er_access=${p.token}`, 'X-Account-ID': p.userId,
      Origin: origin, 'X-Requested-With': 'ERepetitor', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function feed(p: Person, query = ''): Promise<NotificationPage> {
    const response = await request(p, `/notifications${query}`); assert.equal(response.status, 200, await response.clone().text()); return await response.json() as NotificationPage;
  }
  async function context() {
    const teacher = await account('teacher'); const student = await account('student'); const parent = await account('parent');
    const subject = randomUUID(); const enrollment = randomUUID(); const connection = randomUUID();
    await db.query('INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,$3)', [subject, teacher.profileId, 'Математика']);
    await db.query(`INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by) VALUES($1,$2,$3,$4,'active',now(),$5)`, [enrollment, teacher.profileId, student.profileId, subject, student.userId]);
    await db.query(`INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by) VALUES($1,$2,$3,'active',now(),$4)`, [connection, parent.profileId, student.profileId, student.userId]);
    return { teacher, student, parent, subject, enrollment, connection };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  async function lesson(c: Context, minutes = 30, status = 'scheduled') {
    const id = randomUUID();
    await db.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,request_id,request_payload,starts_at,duration_min,format,status,private_notes) VALUES($1,$2,$3,$4,$5,'{}',clock_timestamp()+make_interval(mins=>$6),30,'online',$7,'PRIVATE NOTES')`, [id, c.enrollment, c.teacher.profileId, c.student.profileId, randomUUID(), minutes, status]);
    return id;
  }
  async function emailOn(p: Person, type = 'lesson_reminder') {
    const response = await request(p, `/notification-preferences/${type}`, 'PATCH', { inApp: true, email: true, version: 0 });
    assert.equal(response.status, 200, await response.clone().text());
  }
  async function version(c: Context) {
    const testId = randomUUID(); const versionId = randomUUID(); const questionId = randomUUID();
    const questions = JSON.stringify([{ id: questionId, type: 'text', prompt: 'PRIVATE QUESTION', points: 10, options: [], correctOptionIds: [] }]);
    await db.query("INSERT INTO test_families(id,teacher_id,subject_id,title) VALUES($1,$2,$3,'Тест')", [testId, c.teacher.profileId, c.subject]);
    await db.query(`INSERT INTO tests(id,family_id,teacher_id,subject_id,request_id,request_payload,title,questions,status) VALUES($1,$1,$2,$3,$4,'{}','Тест',$5,'published')`, [testId, c.teacher.profileId, c.subject, randomUUID(), questions]);
    await db.query(`INSERT INTO test_versions(id,test_id,teacher_id,subject_id,number,draft_revision,title,instruction,questions,max_points) VALUES($1,$2,$3,$4,1,1,'Тест','PRIVATE INSTRUCTION',$5,10)`, [versionId, testId, c.teacher.profileId, c.subject, questions]);
    return { versionId, questionId };
  }
  test('worker is disabled by default and invalid flag values fail configuration', () => {
    const env = { DATABASE_URL: 'postgresql://unused@127.0.0.1/example_test' };
    assert.equal(readConfig(env).notificationWorkerEnabled, false);
    assert.equal(readConfig({ ...env, NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'true' }).notificationWorkerEnabled, false);
    assert.throws(() => readConfig({ ...env, NOTIFICATION_WORKER_ENABLED: 'yes' }));
    assert.equal(worker.isRunning(), false);
  });
  test('defaults, CAS preferences and strict validation prevent lost updates', async () => {
    const p = await account('student'); const response = await request(p, '/notification-preferences');
    assert.equal(response.status, 200); const prefs = await response.json(); assert.equal(prefs.items.length, 5);
    assert.ok(prefs.items.every((v: { inApp: boolean; email: boolean; version: number }) => v.inApp && !v.email && v.version === 0));
    const results = await Promise.all([true, false].map(inApp => request(p, '/notification-preferences/lesson_reminder', 'PATCH', { inApp, email: true, version: 0 })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    for (const body of [{ inApp: true, email: 'yes', version: 1 }, { inApp: true, email: false }, { inApp: true, email: false, version: -1 }, { inApp: true, email: false, version: 1, userId: p.userId }]) assert.equal((await request(p, '/notification-preferences/lesson_reminder', 'PATCH', body)).status, 400);
    assert.equal((await request(p, '/notification-preferences/invalid', 'PATCH', { inApp: true, email: false, version: 0 })).status, 400);
  });
  test('reminders are deduplicated, role-scoped and never generated for old or cancelled lessons', async () => {
    const c = await context(); await lesson(c); await lesson(c, -10); await lesson(c, 90); await lesson(c, 20, 'teacher_cancelled'); await lesson(c, 20, 'rescheduled');
    await worker.generateReminders(); await worker.generateReminders();
    for (const [role, person] of [['teacher', c.teacher], ['student', c.student], ['parent', c.parent]] as const) {
      const page = await feed(person); assert.equal(page.total, 1); assert.equal(page.unreadTotal, 1); assert.equal(page.items[0]!.recipientRole, role);
      assert.equal(page.items[0]!.type, 'lesson_reminder'); assert.doesNotMatch(JSON.stringify(page), /PRIVATE|password|answers|score|grades/);
    }
    assert.equal((await feed(await account('teacher'))).total, 0);
    assert.equal((await db.query('SELECT * FROM notification_email_deliveries')).rowCount, 0);
  });
  test('owner-only reads are idempotent and global unread count is independent of pagination', async () => {
    const c = await context(); for (let i = 0; i < 3; i++) await lesson(c, 10 + i);
    await worker.generateReminders(); const page = await feed(c.student, '?limit=1&offset=1'); assert.equal(page.items.length, 1); assert.equal(page.total, 3); assert.equal(page.unreadTotal, 3);
    const id = page.items[0]!.id; const first = await request(c.student, `/notifications/${id}/read`, 'POST'); const value = await first.json();
    assert.equal(first.status, 200); assert.deepEqual(await (await request(c.student, `/notifications/${id}/read`, 'POST')).json(), value);
    assert.equal((await request(c.teacher, `/notifications/${id}/read`, 'POST')).status, 404);
    assert.equal((await feed(c.student, '?unreadOnly=true')).total, 2); assert.equal((await feed(c.student, '?offset=100')).unreadTotal, 2);
    for (const query of ['?limit=101', '?offset=-1', '?unreadOnly=1', '?role=parent']) assert.equal((await request(c.student, `/notifications${query}`)).status, 400);
    assert.equal((await fetch(`${base}/notifications`)).status, 401);
    const mismatch = await fetch(`${base}/notifications`, { headers: { Cookie: `er_access=${c.student.token}`, 'X-Account-ID': c.parent.userId } }); assert.equal(mismatch.status, 409);
    assert.equal((await request(c.student, '/notifications/invalid/read', 'POST')).status, 400);
    assert.equal((await fetch(`${base}/notifications/${id}/read`, { method: 'POST', headers: { Cookie: `er_access=${c.student.token}` } })).status, 403);
    await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [c.student.sessionId]);
    assert.equal((await request(c.student, '/notification-preferences')).status, 401);
  });
  test('revocation and relinking cannot resurrect parent history or send queued mail', async () => {
    const c = await context(); await emailOn(c.parent); await lesson(c); await worker.generateReminders(); const id = (await feed(c.parent)).items[0]!.id;
    await db.query("UPDATE parent_connections SET status='revoked' WHERE id=$1", [c.connection]);
    await db.query(`INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by) VALUES($1,$2,$3,'active',now(),$4)`, [randomUUID(), c.parent.profileId, c.student.profileId, c.student.userId]);
    assert.equal((await feed(c.parent)).total, 0); assert.equal((await request(c.parent, `/notifications/${id}/read`, 'POST')).status, 404);
    await worker.deliverOne(); assert.equal(mail.messages.length, 0);
    assert.equal((await db.query('SELECT status FROM notification_email_deliveries WHERE notification_id=$1', [id])).rows[0]!.status, 'cancelled');
  });
  test('disabling in-app keeps history but suppresses future messages; email preference is rechecked', async () => {
    const c = await context(); await emailOn(c.student); await lesson(c); await worker.generateReminders();
    const response = await request(c.student, '/notification-preferences/lesson_reminder', 'PATCH', { inApp: false, email: false, version: 1 }); assert.equal(response.status, 200);
    await lesson(c, 40); await worker.generateReminders(); assert.equal((await feed(c.student)).total, 1);
    await worker.deliverOne(); assert.equal(mail.messages.length, 0);
  });
  test('concurrent workers claim once and generic messages contain no educational data', async () => {
    const c = await context(); await emailOn(c.student); await lesson(c); await worker.generateReminders();
    await Promise.all([worker.deliverOne(), worker.deliverOne()]); assert.equal(mail.messages.length, 1);
    const message = mail.messages[0]!; assert.equal(message.email, `${c.student.userId}@example.test`); assert.match(message.messageId, /^<notification-/);
    assert.doesNotMatch(JSON.stringify(message), /Математика|student|PRIVATE|score|grades/);
    assert.equal((await db.query('SELECT status,attempts FROM notification_email_deliveries')).rows[0]!.status, 'sent');
  });
  test('SMTP failures persist safe codes, retry with stable identity, and stop after five attempts', async () => {
    const c = await context(); await emailOn(c.student); await lesson(c); await worker.generateReminders(); mail.fail = true;
    for (let i = 0; i < 5; i++) {
      assert.equal(await worker.deliverOne(), true); await db.query("UPDATE notification_email_deliveries SET next_attempt_at=now()-interval '1 second'");
    }
    assert.equal(await worker.deliverOne(), false);
    const row = (await db.query('SELECT * FROM notification_email_deliveries')).rows[0]!; assert.equal(row.status, 'failed'); assert.equal(row.attempts, 5); assert.equal(row.last_error, 'smtp_unavailable'); assert.doesNotMatch(JSON.stringify(row), /PRIVATE/);
    assert.equal(mail.messages.length, 0);
  });
  test('expired claims recover; successful retry is persisted', async () => {
    const c = await context(); await emailOn(c.student); await lesson(c); await worker.generateReminders();
    await db.query("UPDATE notification_email_deliveries SET attempts=1,claim_token=$1,lease_until=now()-interval '1 second'", [randomUUID()]);
    assert.equal(await worker.deliverOne(), true); assert.equal(mail.messages.length, 1);
    const row = (await db.query('SELECT * FROM notification_email_deliveries')).rows[0]!; assert.equal(row.attempts, 2); assert.equal(row.status, 'sent'); assert.equal(row.claim_token, null);
  });
  test('past reminders and suspended children cannot deliver to parents', async () => {
    const c = await context(); await emailOn(c.parent); const id = await lesson(c); await worker.generateReminders();
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.student.userId]);
    assert.equal((await feed(c.parent)).total, 0); await worker.deliverOne(); assert.equal(mail.messages.length, 0);
    await db.query("UPDATE users SET status='active' WHERE id=$1", [c.student.userId]);
    await emailOn(c.student); await db.query('DELETE FROM notifications WHERE recipient_user_id=$1', [c.student.userId]);
    await worker.generateReminders(); await db.query("UPDATE lessons SET starts_at=now()-interval '2 hours' WHERE id=$1", [id]);
    await worker.deliverOne(); assert.equal(mail.messages.length, 0);
  });
  test('notification insertion participates in business rollback', async () => {
    const c = await context(); const id = await lesson(c); await emailOn(c.student, 'lesson_cancelled');
    await assert.rejects(db.transaction(async client => {
      await client.query("UPDATE lessons SET status='teacher_cancelled' WHERE id=$1", [id]);
      await notifyLesson(client, id, 'lesson_cancelled'); throw new Error('force rollback');
    }));
    assert.equal((await db.query('SELECT * FROM notifications')).rowCount, 0);
    assert.equal((await db.query('SELECT * FROM notification_email_deliveries')).rowCount, 0);
    assert.equal((await db.query('SELECT status FROM lessons WHERE id=$1', [id])).rows[0]!.status, 'scheduled');
  });
  test('assignment and result business retries produce one notification each and no unpublished parent metadata', async () => {
    const c = await context(); const v = await version(c); await emailOn(c.student, 'test_assigned'); await emailOn(c.parent, 'result_published');
    const dto = { versionId: v.versionId, enrollmentId: c.enrollment, requestId: randomUUID() };
    const responses = await Promise.all([request(c.teacher, '/test-assignments', 'POST', dto), request(c.teacher, '/test-assignments', 'POST', dto)]);
    for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
    const assignment = await responses[0]!.json(); assert.equal((await feed(c.student)).total, 1); assert.equal((await feed(c.parent)).total, 0);
    const attempt = randomUUID();
    await db.query(`INSERT INTO test_attempts(id,assignment_id,student_id,number,status,submitted_at,score,max_points,grades,answers,comment) VALUES($1,$2,$3,1,'completed',now(),7,10,$4,'[{"text":"PRIVATE ANSWER"}]','PRIVATE COMMENT')`, [attempt, assignment.id, c.student.profileId, JSON.stringify([{ questionId: v.questionId, points: 7 }])]);
    for (let i = 0; i < 2; i++) { const response = await request(c.teacher, `/attempts/${attempt}/publish-result`, 'POST', { version: 1 }); assert.equal(response.status, 200, await response.clone().text()); }
    const page = await feed(c.parent); assert.equal(page.total, 1); assert.equal(page.items[0]!.type, 'result_published'); assert.doesNotMatch(JSON.stringify(page), /PRIVATE|score|grades|answers/);
    assert.equal((await feed(c.student)).total, 2); assert.equal((await db.query('SELECT * FROM notification_email_deliveries')).rowCount, 2);
  });
  test('reschedule and cancellation hooks notify families, reject stale retries and invalidate reminder deliveries', async () => {
    const c = await context(); const id = await lesson(c); await emailOn(c.student); await worker.generateReminders();
    const dto = { startsAt: new Date(Date.now() + 2 * 3600000).toISOString(), durationMin: 30, version: 1, reason: 'Новое время' };
    const response = await request(c.teacher, `/lessons/${id}/reschedule`, 'POST', dto); assert.equal(response.status, 200, await response.clone().text()); const replacement = await response.json();
    assert.equal((await request(c.teacher, `/lessons/${id}/reschedule`, 'POST', dto)).status, 409);
    const cancel = { status: 'teacher_cancelled', version: 1, reason: 'Занятие отменено' };
    assert.equal((await request(c.teacher, `/lessons/${replacement.id}`, 'PATCH', cancel)).status, 200);
    assert.equal((await request(c.teacher, `/lessons/${replacement.id}`, 'PATCH', cancel)).status, 409);
    const types = (await feed(c.parent)).items.map(n => n.type).sort(); assert.deepEqual(types, ['lesson_cancelled', 'lesson_reminder', 'lesson_rescheduled']);
    await worker.deliverOne(); assert.equal(mail.messages.length, 0); assert.equal((await db.query('SELECT status FROM notification_email_deliveries')).rows[0]!.status, 'cancelled');
  });
  test('paused enrollment hides parent inbox and suppresses queued reminders for every role', async () => {
    const c = await context(); await emailOn(c.student); await emailOn(c.parent); await lesson(c); await worker.generateReminders();
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [c.enrollment]);
    assert.equal((await feed(c.parent)).total, 0); assert.equal((await feed(c.student)).total, 1);
    await worker.deliverOne(); await worker.deliverOne(); assert.equal(mail.messages.length, 0);
  });
  test('stale final lease fails closed and a nonexpired claim is not stolen', async () => {
    const c = await context(); await emailOn(c.student); await lesson(c); await worker.generateReminders();
    await db.query("UPDATE notification_email_deliveries SET attempts=4,claim_token=$1,lease_until=now()+interval '1 minute'", [randomUUID()]);
    assert.equal(await worker.deliverOne(), false);
    await db.query("UPDATE notification_email_deliveries SET attempts=5,lease_until=now()-interval '1 minute'");
    assert.equal(await worker.deliverOne(), false);
    const row = (await db.query('SELECT * FROM notification_email_deliveries')).rows[0]!; assert.equal(row.status, 'failed'); assert.equal(row.last_error, 'attempt_limit'); assert.equal(row.claim_token, null);
  });
  test('SMTP failure can retry successfully without changing message identity or duplicating notification', async () => {
    const c = await context(); await emailOn(c.student); await lesson(c); await worker.generateReminders(); mail.fail = true;
    await worker.deliverOne(); const failed = (await db.query('SELECT * FROM notification_email_deliveries')).rows[0]!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 1); assert.equal(failed.last_error, 'smtp_unavailable');
    assert.equal(await worker.deliverOne(), false);
    await db.query("UPDATE notification_email_deliveries SET next_attempt_at=now()-interval '1 second'"); mail.fail = false;
    await worker.deliverOne(); const sent = (await db.query('SELECT * FROM notification_email_deliveries')).rows[0]!;
    assert.equal(sent.status, 'sent'); assert.equal(sent.attempts, 2); assert.equal(sent.last_error, null);
    assert.equal(mail.messages[0]!.messageId, `<notification-${failed.notification_id}@e-repetitor.local>`); assert.equal((await feed(c.student)).total, 1);
  });
});
