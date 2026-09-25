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
import { OverviewView } from '../src/overview.dto';

const origin = 'http://127.0.0.1:3000';
describe('PostgreSQL unified account overview', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string;
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl); assert.match(new URL(databaseUrl).pathname, /_test$/);
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), { send: async () => undefined });
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(() => resetTestDatabase(db));
  after(async () => { if (app) await app.close(); });

  async function account(role: Role) {
    const userId = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,'unused','active','test','test')`, [userId, role, `${userId}@example.test`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, `STU-${code.slice(0, 4)}-${code.slice(4)}`]);
    else await db.query(`INSERT INTO ${role === 'teacher' ? 'teacher_profiles' : 'parent_profiles'}(id,user_id) VALUES($1,$2)`, [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { userId, profileId, sessionId, token };
  }
  type Person = Awaited<ReturnType<typeof account>>;
  async function request(person: Person, query = 'role=teacher', expectedAccount = person.userId) {
    return fetch(`${base}/overview?${query}`, { headers: { Cookie: `er_access=${person.token}`, 'X-Account-ID': expectedAccount } });
  }
  async function overview(person: Person, role: Role, studentId?: string): Promise<OverviewView> {
    const response = await request(person, `role=${role}${studentId ? `&studentId=${studentId}` : ''}`);
    assert.equal(response.status, 200, await response.clone().text()); return await response.json() as OverviewView;
  }
  async function enrollment(teacher: Person, student: Person, status = 'active', name = 'Математика') {
    const id = randomUUID(); const subjectId = randomUUID();
    await db.query('INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,$3)', [subjectId, teacher.profileId, name]);
    await db.query(`INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $5='pending' THEN NULL ELSE now() END,CASE WHEN $5='pending' THEN NULL ELSE $6::uuid END)`,
    [id, teacher.profileId, student.profileId, subjectId, status, student.userId]);
    return { id, subjectId, teacher, student };
  }
  type Enrollment = Awaited<ReturnType<typeof enrollment>>;
  async function context() { return enrollment(await account('teacher'), await account('student')); }
  async function parentLink(parent: Person, student: Person, status = 'active') {
    const id = randomUUID();
    await db.query(`INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by)
      VALUES($1,$2,$3,$4,CASE WHEN $4='active' THEN now() END,CASE WHEN $4='active' THEN $5::uuid END)`, [id, parent.profileId, student.profileId, status, student.userId]);
    return id;
  }
  async function lesson(c: Enrollment, minutes: number, status = 'scheduled', attendance?: string) {
    const id = randomUUID();
    await db.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,request_id,request_payload,starts_at,duration_min,format,status,private_notes)
      VALUES($1,$2,$3,$4,$5,'{}',clock_timestamp()+make_interval(mins=>$6),60,'online',$7,'PRIVATE LESSON NOTE')`,
    [id, c.id, c.teacher.profileId, c.student.profileId, randomUUID(), minutes, status]);
    if (attendance) await db.query(`INSERT INTO lesson_attendance(lesson_id,student_id,status,comment,marked_by)
      VALUES($1,$2,$3,'PRIVATE ATTENDANCE COMMENT',$4)`, [id, c.student.profileId, attendance, c.teacher.userId]);
    return id;
  }
  async function payment(c: Enrollment, paid = false, cancelled = false) {
    await db.query(`INSERT INTO payment_records(id,enrollment_id,teacher_id,student_id,request_id,request_payload,title,paid,cancelled,paid_marked_at)
      VALUES($1,$2,$3,$4,$5,'{}','Период',$6,$7,CASE WHEN $6 THEN clock_timestamp() END)`,
    [randomUUID(), c.id, c.teacher.profileId, c.student.profileId, randomUUID(), paid, cancelled]);
  }
  async function assignment(c: Enrollment, maxAttempts = 3, dueDays: number | null = null) {
    const testId = randomUUID(); const versionId = randomUUID(); const id = randomUUID();
    const questions = JSON.stringify([{ id: randomUUID(), type: 'text', prompt: 'PRIVATE QUESTION', points: 10, options: [], correctOptionIds: [] }]);
    await db.query("INSERT INTO test_families(id,teacher_id,subject_id,title) VALUES($1,$2,$3,'Тест')", [testId, c.teacher.profileId, c.subjectId]);
    await db.query(`INSERT INTO tests(id,family_id,teacher_id,subject_id,request_id,request_payload,title,questions,status)
      VALUES($1,$1,$2,$3,$4,'{}','Тест',$5,'published')`, [testId, c.teacher.profileId, c.subjectId, randomUUID(), questions]);
    await db.query(`INSERT INTO test_versions(id,test_id,teacher_id,subject_id,number,draft_revision,title,instruction,questions,max_points)
      VALUES($1,$2,$3,$4,1,1,'Тест','PRIVATE INSTRUCTION',$5,10)`, [versionId, testId, c.teacher.profileId, c.subjectId, questions]);
    await db.query(`INSERT INTO test_assignments(id,test_id,version_id,teacher_id,student_id,subject_id,enrollment_id,request_id,request_payload,max_attempts,due_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,CASE WHEN $10::integer IS NULL THEN NULL ELSE clock_timestamp()+make_interval(days=>$10) END)`,
    [id, testId, versionId, c.teacher.profileId, c.student.profileId, c.subjectId, c.id, randomUUID(), maxAttempts, dueDays]);
    return { id, c };
  }
  async function attempt(a: Awaited<ReturnType<typeof assignment>>, status: string, number = 1, expiredTimer = false) {
    const id = randomUUID();
    await db.query(`INSERT INTO test_attempts(id,assignment_id,student_id,number,status,started_at,expires_at,submitted_at,published_at,score,max_points,answers,grades,comment)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '2 hours',CASE WHEN $6 THEN clock_timestamp()-interval '1 hour' END,
      CASE WHEN $5 IN ('submitted','waiting_review','completed','published') THEN clock_timestamp()-interval '1 hour' END,
      CASE WHEN $5='published' THEN clock_timestamp() END,CASE WHEN $5 IN ('completed','published') THEN 7.5 END,10,
      '[{"text":"PRIVATE ANSWER"}]','[]','PRIVATE COMMENT')`, [id, a.id, a.c.student.profileId, number, status, expiredTimer]);
    return id;
  }

  test('empty accounts receive role-specific zero summaries and one captured time window', async () => {
    for (const role of ['teacher', 'student', 'parent'] as const) {
      const person = await account(role); const response = await request(person, `role=${role}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.role, role); assert.equal(body.counts.activeEnrollments, 0);
      assert.equal(body.upcomingLessons.total, 0); assert.equal(body.subjects.total, 0);
      assert.deepEqual(body.payments, { paid: 0, unpaid: 0 });
      assert.equal(Date.parse(body.lessonUntil) - Date.parse(body.asOf), 7 * 86400000);
      assert.equal(Date.parse(body.asOf) - Date.parse(body.attendanceSince), 30 * 86400000);
      assert.equal('testAttention' in body, role !== 'parent');
      assert.equal('waitingReview' in body.counts, role === 'teacher');
      assert.equal('availableTests' in body.counts, role === 'student');
    }
  });

  test('role and child filters reject invalid or unowned contexts', async () => {
    const c = await context(); const parent = await account('parent');
    assert.equal((await fetch(`${base}/overview?role=teacher`)).status, 401);
    for (const query of ['', 'role=admin', 'role=teacher&role=student', 'role=teacher&extra=1', 'role=parent&studentId=invalid', `role=teacher&studentId=${c.student.profileId}`]) {
      assert.equal((await request(c.teacher, query)).status, 400, query);
    }
    assert.equal((await request(c.student, 'role=teacher')).status, 403);
    assert.equal((await request(parent, `role=parent&studentId=${c.student.profileId}`)).status, 404);
    assert.equal((await request(c.teacher, 'role=teacher', c.student.userId)).status, 409);
    await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [c.teacher.sessionId]);
    assert.equal((await request(c.teacher)).status, 401);
  });

  test('teacher isolation and approved parent aggregation expose only published result summaries', async () => {
    const first = await context(); const otherTeacher = await account('teacher');
    const second = await enrollment(otherTeacher, first.student, 'active', 'Физика');
    const stranger = await account('student'); const parent = await account('parent'); await parentLink(parent, first.student);
    for (const c of [first, second]) {
      await lesson(c, 60); await payment(c); const a = await assignment(c);
      await attempt(a, 'published'); await attempt(a, 'waiting_review', 2);
    }
    const teacher = await overview(first.teacher, 'teacher');
    assert.equal(teacher.counts.activeStudents, 1); assert.equal(teacher.counts.activeEnrollments, 1);
    assert.equal(teacher.latestResults.total, 1); assert.equal(teacher.counts.waitingReview, 1);
    assert.ok(teacher.subjects.items.every(item => item.subjectName === 'Математика'));
    const student = await overview(first.student, 'student'); const family = await overview(parent, 'parent');
    for (const body of [student, family]) {
      assert.equal(body.counts.activeEnrollments, 2); assert.equal(body.latestResults.total, 2);
      assert.equal(body.upcomingLessons.total, 2); assert.deepEqual(body.payments, { paid: 0, unpaid: 2 });
      assert.ok(!JSON.stringify(body).includes('PRIVATE')); assert.ok(!JSON.stringify(body).includes('correctOptionIds'));
      assert.equal(body.latestResults.items[0]!.score, 7.5); assert.equal(body.latestResults.items[0]!.percentage, 75);
    }
    assert.equal(family.testAttention, undefined); assert.equal(family.counts.waitingReview, undefined);
    assert.equal((await overview(stranger, 'student')).latestResults.total, 0);
    await db.query('INSERT INTO parent_profiles(id,user_id) VALUES($1,$2)', [randomUUID(), first.teacher.userId]);
    assert.equal((await overview(first.teacher, 'parent')).subjects.total, 0);
  });

  test('parent selection validates active consent even for children without subjects and normalizes UUIDs', async () => {
    const c = await context(); const parent = await account('parent'); const secondChild = await account('student');
    const link = await parentLink(parent, c.student, 'pending'); await parentLink(parent, secondChild);
    assert.equal((await request(parent, `role=parent&studentId=${c.student.profileId}`)).status, 404);
    const empty = await overview(parent, 'parent', secondChild.profileId.toUpperCase());
    assert.equal(empty.selectedStudentId, secondChild.profileId); assert.equal(empty.subjects.total, 0);
    await db.query("UPDATE parent_connections SET status='active',approved_at=clock_timestamp(),approved_by=$2 WHERE id=$1", [link, c.student.userId]);
    assert.equal((await overview(parent, 'parent', c.student.profileId)).subjects.total, 1);
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [c.id]);
    assert.equal((await overview(parent, 'parent', c.student.profileId)).subjects.total, 0);
    await db.query("UPDATE enrollments SET status='active' WHERE id=$1", [c.id]);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.student.userId]);
    assert.equal((await request(parent, `role=parent&studentId=${c.student.profileId}`)).status, 404);
    assert.equal((await overview(parent, 'parent')).subjects.total, 0);
    await db.query("UPDATE users SET status='active' WHERE id=$1", [c.student.userId]);
    await db.query("UPDATE parent_connections SET status='revoked' WHERE id=$1", [link]);
    assert.equal((await request(parent, `role=parent&studentId=${c.student.profileId}`)).status, 404);
  });

  test('manual payment counts exclude cancelled entries and retain teacher/student history after closure', async () => {
    const c = await context(); const parent = await account('parent'); await parentLink(parent, c.student);
    await payment(c, false); await payment(c, true); await payment(c, false, true);
    for (const [person, role] of [[c.teacher, 'teacher'], [c.student, 'student'], [parent, 'parent']] as const) {
      const body = await overview(person, role); assert.deepEqual(body.payments, { paid: 1, unpaid: 1 });
      assert.equal(body.counts.unmarkedPayments, 1); assert.deepEqual(body.subjects.items[0]!.payment, { paid: 1, unpaid: 1 });
    }
    await db.query("UPDATE enrollments SET status='completed' WHERE id=$1", [c.id]);
    for (const [person, role] of [[c.teacher, 'teacher'], [c.student, 'student']] as const) {
      const body = await overview(person, role); assert.deepEqual(body.payments, { paid: 1, unpaid: 1 }); assert.equal(body.subjects.total, 0);
    }
    assert.deepEqual((await overview(parent, 'parent')).payments, { paid: 0, unpaid: 0 });
  });

  test('upcoming lessons include ongoing scheduled lessons and exclude ended, cancelled, rescheduled and distant ones', async () => {
    const c = await context(); const ongoing = await lesson(c, -30); const next = await lesson(c, 120);
    await lesson(c, -120); await lesson(c, 300, 'teacher_cancelled'); await lesson(c, 350, 'rescheduled'); await lesson(c, 15 * 1440);
    const body = await overview(c.student, 'student');
    assert.equal(body.upcomingLessons.total, 2); assert.deepEqual(body.upcomingLessons.items.map(item => item.id), [ongoing, next]);
    assert.equal(body.subjects.items[0]!.nextLesson!.id, ongoing);
    await db.query("UPDATE lessons SET status='teacher_cancelled' WHERE id=ANY($1::uuid[])", [[ongoing, next]]);
    const distant = await overview(c.student, 'student');
    assert.equal(distant.upcomingLessons.total, 0); assert.ok(distant.subjects.items[0]!.nextLesson);
  });

  test('attendance counts only recorded completed or absent lessons ended within the last 30 days', async () => {
    const c = await context(); await lesson(c, -1440, 'completed', 'present'); await lesson(c, -2880, 'student_absent', 'absent');
    await lesson(c, -4320, 'student_absent', 'excused'); await lesson(c, -5760, 'completed');
    await lesson(c, -31 * 1440, 'completed', 'present'); await lesson(c, 1440, 'completed', 'present');
    await lesson(c, -200, 'scheduled', 'present'); await lesson(c, -210, 'teacher_cancelled', 'cancelled');
    const body = await overview(c.student, 'student'); assert.deepEqual(body.subjects.items[0]!.attendance, { present: 1, absent: 1, excused: 1 });
  });

  test('student actions respect soft deadlines, remaining attempts and live attempts after enrollment closure', async () => {
    const c = await context(); const due = await assignment(c, 2, -1); const unused = await assignment(c);
    const exhausted = await assignment(c, 1); const exhaustedAttempt = await attempt(exhausted, 'started', 1, true);
    const retry = await assignment(c, 2); await attempt(retry, 'started', 1, true);
    const abandoned = await assignment(c, 1); await attempt(abandoned, 'abandoned');
    const closed = await enrollment(c.teacher, c.student, 'completed', 'История'); const live = await assignment(closed); const liveId = await attempt(live, 'started');
    await assignment(closed);
    const body = await overview(c.student, 'student');
    assert.equal(body.counts.availableTests, 3); assert.equal(body.counts.inProgressTests, 1); assert.equal(body.testAttention!.total, 4);
    const actions = body.testAttention!.items;
    assert.equal(actions.find(item => item.assignmentId === due.id)!.action, 'start');
    assert.equal(actions.find(item => item.assignmentId === unused.id)!.dueAt, null);
    assert.equal(actions.find(item => item.assignmentId === live.id)!.attemptId, liveId);
    assert.equal(actions.find(item => item.assignmentId === live.id)!.action, 'continue');
    assert.deepEqual((await db.query('SELECT status,version FROM test_attempts WHERE id=$1', [exhaustedAttempt])).rows[0], { status: 'started', version: 1 });
    assert.equal((await db.query('SELECT count(*)::integer AS total FROM test_attempt_history')).rows[0]!.total, 0);
    assert.equal((await db.query('SELECT count(*)::integer AS total FROM audit_events')).rows[0]!.total, 0);
  });

  test('teacher review/publication tasks preserve historical scope while parents see only published results', async () => {
    const c = await context(); const parent = await account('parent'); await parentLink(parent, c.student);
    const a = await assignment(c); const review = await attempt(a, 'waiting_review'); const publish = await attempt(a, 'completed', 2); await attempt(a, 'published', 3);
    const teacher = await overview(c.teacher, 'teacher');
    assert.equal(teacher.counts.waitingReview, 1); assert.equal(teacher.counts.readyToPublish, 1);
    assert.deepEqual(teacher.testAttention!.items.map(item => [item.attemptId, item.action]), [[review, 'review'], [publish, 'publish']]);
    assert.equal((await overview(parent, 'parent')).latestResults.total, 1);
    await db.query("UPDATE enrollments SET status='completed' WHERE id=$1", [c.id]);
    assert.equal((await overview(c.teacher, 'teacher')).testAttention!.total, 2);
    assert.equal((await overview(c.student, 'student')).latestResults.total, 1);
    assert.equal((await overview(parent, 'parent')).latestResults.total, 0);
  });

  test('bounded previews retain complete totals and count distinct students rather than enrollment rows', async () => {
    const c = await context();
    for (let index = 0; index < 22; index++) {
      const row = index === 0 ? c : await enrollment(c.teacher, c.student, 'active', `Предмет ${index}`);
      if (index < 7) { await lesson(row, 100 + index); const a = await assignment(row); await attempt(a, 'published'); await attempt(a, 'waiting_review', 2); }
    }
    const body = await overview(c.teacher, 'teacher');
    assert.equal(body.counts.activeEnrollments, 22); assert.equal(body.counts.activeStudents, 1);
    assert.equal(body.subjects.total, 22); assert.equal(body.subjects.items.length, 20);
    for (const preview of [body.upcomingLessons, body.testAttention!, body.latestResults]) { assert.equal(preview.total, 7); assert.equal(preview.items.length, 5); }
    assert.equal(body.counts.waitingReview, 7); assert.equal(body.counts.upcomingLessons, 7);
  });

  test('unaccepted enrollments cannot reveal seeded lesson, payment or test data to any overview role', async () => {
    const teacher = await account('teacher'); const student = await account('student'); const parent = await account('parent');
    const c = await enrollment(teacher, student, 'pending'); await parentLink(parent, student);
    // Domain writers refuse this setup. Fixtures prove the read boundary independently.
    await lesson(c, 60); await payment(c); const a = await assignment(c); await attempt(a, 'published'); await attempt(a, 'waiting_review', 2);
    for (const [person, role] of [[teacher, 'teacher'], [student, 'student'], [parent, 'parent']] as const) {
      const body = await overview(person, role);
      assert.equal(body.counts.activeEnrollments, 0); assert.equal(body.counts.upcomingLessons, 0); assert.equal(body.counts.unmarkedPayments, 0);
      assert.equal(body.subjects.total, 0); assert.equal(body.upcomingLessons.total, 0); assert.equal(body.latestResults.total, 0);
      assert.deepEqual(body.subjects.items, []); assert.deepEqual(body.upcomingLessons.items, []); assert.deepEqual(body.latestResults.items, []);
      assert.deepEqual(body.payments, { paid: 0, unpaid: 0 });
      if (body.testAttention) assert.deepEqual(body.testAttention, { items: [], total: 0 });
    }
  });

  test('suspended students leave active teacher counts while accepted historical resources remain available', async () => {
    const c = await context(); await lesson(c, 60); await payment(c); const a = await assignment(c);
    await attempt(a, 'published'); await attempt(a, 'waiting_review', 2);
    const parent = await account('parent'); await parentLink(parent, c.student);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.student.userId]);
    const teacher = await overview(c.teacher, 'teacher');
    assert.equal(teacher.counts.activeStudents, 0); assert.equal(teacher.counts.activeEnrollments, 0); assert.equal(teacher.subjects.total, 0);
    assert.equal(teacher.upcomingLessons.total, 1); assert.equal(teacher.latestResults.total, 1); assert.equal(teacher.counts.waitingReview, 1);
    assert.deepEqual(teacher.payments, { paid: 0, unpaid: 1 });
    const family = await overview(parent, 'parent');
    assert.equal(family.upcomingLessons.total, 0); assert.equal(family.latestResults.total, 0); assert.deepEqual(family.payments, { paid: 0, unpaid: 0 });
    assert.equal((await request(c.student, 'role=student')).status, 401);
  });

  test('child filtering scopes every aggregate independently of the selector list', async () => {
    const c = await context(); const parent = await account('parent'); const second = await enrollment(c.teacher, await account('student'), 'active', 'Физика');
    for (const row of [c, second]) { await parentLink(parent, row.student); await payment(row); await lesson(row, 60); await attempt(await assignment(row), 'published'); }
    assert.equal((await overview(parent, 'parent')).counts.activeEnrollments, 2);
    const body = await overview(parent, 'parent', second.student.profileId);
    assert.equal(body.counts.activeEnrollments, 1); assert.equal(body.counts.upcomingLessons, 1); assert.equal(body.counts.unmarkedPayments, 1);
    assert.equal(body.latestResults.total, 1); assert.ok(JSON.stringify(body).includes('Физика')); assert.ok(!JSON.stringify(body).includes('Математика'));
  });

  test('OpenAPI documents typed role-safe bounded summaries', async () => {
    const response = await fetch(`${base}/openapi.json`); const spec = await response.json() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    assert.ok(spec.paths['/api/v1/overview']);
    for (const name of ['OverviewView', 'OverviewCounts', 'OverviewSubject', 'OverviewTestAction', 'OverviewLesson', 'OverviewResult']) assert.ok(spec.components.schemas[name], name);
  });
});
