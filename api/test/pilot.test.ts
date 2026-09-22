import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { Account, hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import { AccountMail } from '../src/mail';
import { ConnectionMutationView, EnrollmentPage, ParentChildrenPage } from '../src/connections.dto';
import { LessonMutationView, LessonPage } from '../src/lessons.dto';
import { OverviewView } from '../src/overview.dto';
import { PaymentRecordPage, PaymentRecordView } from '../src/payments.dto';
import { AssignmentPage, AssignmentView, AttemptMutationView, AttemptView, Question, TestDetail, TestVersion } from '../src/tests.dto';

const origin = 'http://127.0.0.1:3000';

describe('PostgreSQL pilot journey across independent tutors', { concurrency: false }, () => {
  let app: INestApplication;
  let db: Database;
  let base: string;
  const messages: AccountMail[] = [];

  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; the pilot test cannot be skipped');
    const testUrl = new URL(databaseUrl);
    assert.notEqual(process.env.NODE_ENV, 'production', 'The pilot test cannot run in production');
    assert.ok(['postgres:', 'postgresql:'].includes(testUrl.protocol));
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(testUrl.hostname), 'Only loopback PostgreSQL is permitted');
    assert.equal(testUrl.search, '', 'Connection overrides are not permitted');
    assert.equal(testUrl.hash, '', 'Connection fragments are not permitted');
    assert.match(testUrl.pathname, /_test$/, 'Only a dedicated test database may be truncated');
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test' }), {
      send: async message => { messages.push(message); },
    });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`;
    db = app.get(Database);
  });
  beforeEach(async () => { await db.query('TRUNCATE users, rate_limits CASCADE'); messages.length = 0; });
  after(async () => { if (app) await app.close(); });

  class Client {
    private readonly cookies: Record<string, string> = {};
    constructor(public userId?: string, token?: string) { if (token) this.cookies.er_access = token; }

    async request<T = unknown>(status: number, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Origin: origin, 'X-Requested-With': 'ERepetitor', ...(this.userId ? { 'X-Account-ID': this.userId } : {}),
          'Content-Type': 'application/json', Cookie: Object.entries(this.cookies).map(([key, value]) => `${key}=${value}`).join('; '),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json() as T;
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
      for (const set of response.headers.getSetCookie()) {
        const first = set.split(';')[0]!; const equals = first.indexOf('=');
        const key = first.slice(0, equals); const value = first.slice(equals + 1);
        if (value) this.cookies[key] = value; else delete this.cookies[key];
      }
      return result;
    }
  }

  async function register(role: Role, name: string) {
    const client = new Client(); const email = `${randomUUID()}@example.test`;
    const password = 'Pilot-fixture-password-2026';
    await client.request(202, '/auth/register', { name, email, password, role, acceptTerms: true, acceptPrivacy: true });
    await client.request(401, '/auth/login', { email, password });
    const verification = messages.find(message => message.email === email && message.purpose === 'verify');
    assert.ok(verification, 'Registration must deliver a verification email');
    await client.request(200, '/auth/verify-email', { token: verification.token });
    const { user } = await client.request<{ user: Account }>(200, '/auth/login', { email, password });
    assert.deepEqual(user.roles, [role]); assert.equal(user.status, 'active');
    client.userId = user.id;
    return { client, profileId: user.profiles[role]!.id, publicId: user.profiles.student?.publicId ?? '', name };
  }

  // Secondary actors use real PostgreSQL sessions through the production HTTP
  // guard. The principal teacher, student and parent register and log in above.
  async function account(role: Role, name: string) {
    const userId = randomUUID(); const profileId = randomUUID();
    const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    const publicId = `STU-${code.slice(0, 4)}-${code.slice(4)}`;
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,'unused-pilot-fixture','active','test','test')`, [userId, name, `${userId}@example.test`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, publicId]);
    else if (role === 'teacher') await db.query('INSERT INTO teacher_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    else await db.query('INSERT INTO parent_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { client: new Client(userId, token), profileId, publicId, name };
  }

  async function time(minutes: number) {
    return (await db.query<{ at: Date }>('SELECT clock_timestamp()+make_interval(mins=>$1) AS at', [minutes])).rows[0]!.at.toISOString();
  }

  async function lessonsPath(role: Role) {
    return `/lessons?${new URLSearchParams({ role, from: await time(-1440), to: await time(1440 * 7) })}`;
  }

  test('one Student ID joins two tutors; the confirmed parent sees published learning and manual payment records only until consent is revoked', async () => {
    const mathTeacher = await register('teacher', 'Репетитор математики');
    const physicsTeacher = await account('teacher', 'Репетитор физики');
    const student = await register('student', 'Ученик пилота');
    const stranger = await account('student', 'Ученик без подключения');
    const parent = await register('parent', 'Подтверждённый родитель');
    const otherParent = await account('parent', 'Неподтверждённый родитель');
    const courses = [];

    // The same ID requests both connections. Knowing it alone cannot approve them.
    for (const [teacher, subjectName] of [[mathTeacher, 'Математика'], [physicsTeacher, 'Физика']] as const) {
      const subject = await teacher.client.request<{ id: string }>(201, '/subjects', { name: subjectName });
      const enrollment = await teacher.client.request<ConnectionMutationView>(201, '/enrollments', {
        publicId: student.publicId.toLowerCase(), subjectId: subject.id,
      });
      assert.equal(enrollment.status, 'pending');
      await stranger.client.request(404, `/enrollments/${enrollment.id}/accept`, {});
      await parent.client.request(403, `/enrollments/${enrollment.id}/accept`, {});
      const accepted = await student.client.request<ConnectionMutationView>(200, `/enrollments/${enrollment.id}/accept`, {});
      assert.equal(accepted.status, 'active');
      courses.push({ teacher, subjectName, subjectId: subject.id, enrollmentId: enrollment.id });
    }
    const math = courses[0]!; const physics = courses[1]!;
    const studentEnrollments = await student.client.request<EnrollmentPage>(200, '/enrollments?role=student');
    assert.equal(studentEnrollments.total, 2);
    assert.ok(studentEnrollments.items.every(item => item.studentPublicId === student.publicId));
    for (const course of courses) {
      const isolated = await course.teacher.client.request<EnrollmentPage>(200, '/enrollments?role=teacher');
      assert.deepEqual(isolated.items.map(item => item.id), [course.enrollmentId]);
    }
    await physicsTeacher.client.request(404, `/enrollments/${math.enrollmentId}`, { status: 'paused' }, 'PATCH');

    const parentLink = await parent.client.request<ConnectionMutationView>(201, '/parent-connections', { publicId: student.publicId });
    await otherParent.client.request(201, '/parent-connections', { publicId: student.publicId });
    assert.equal((await parent.client.request<ParentChildrenPage>(200, '/parent-children')).total, 0);
    await parent.client.request(404, `/overview?role=parent&studentId=${student.profileId}`);
    await parent.client.request(403, `/parent-connections/${parentLink.id}/approve`, {});
    await student.client.request(200, `/parent-connections/${parentLink.id}/approve`, {});
    const children = await parent.client.request<ParentChildrenPage>(200, '/parent-children');
    assert.equal(children.total, 1);
    assert.equal(children.items[0]!.publicId, student.publicId);
    assert.deepEqual(children.items[0]!.enrollments.map(item => item.subjectName).sort(), ['Математика', 'Физика']);

    const lessonIds: string[] = [];
    const paymentIds: string[] = [];
    for (const [index, course] of courses.entries()) {
      const lesson = await course.teacher.client.request<LessonMutationView>(201, '/lessons', {
        requestId: randomUUID(), enrollmentId: course.enrollmentId,
        startsAt: await time(180 + index * 180), durationMin: 60, format: 'online',
        onlineUrl: 'https://example.test/pilot-lesson', privateNotes: 'PRIVATE lesson preparation',
      });
      assert.equal(lesson.status, 'scheduled'); lessonIds.push(lesson.id);
      const payment = await course.teacher.client.request<PaymentRecordView>(201, '/payment-records', {
        requestId: randomUUID(), enrollmentId: course.enrollmentId, title: 'Период пилота',
        amountMinor: 5000, currency: 'AZN',
      });
      assert.equal(payment.paid, false); paymentIds.push(payment.id);
      if (index === 0) {
        // Time passage is the only direct domain update: no sleep or fake app clock.
        await db.query("UPDATE lessons SET starts_at=clock_timestamp()-interval '120 minutes' WHERE id=$1", [lesson.id]);
        await physicsTeacher.client.request(404, `/lessons/${lesson.id}/attendance`, { version: lesson.version, status: 'present' });
        const attendance = await course.teacher.client.request<LessonMutationView>(200, `/lessons/${lesson.id}/attendance`, {
          version: lesson.version, status: 'present', comment: 'PRIVATE attendance comment',
        });
        assert.equal(attendance.status, 'completed');
        await physicsTeacher.client.request(404, `/payment-records/${payment.id}`, { version: payment.version, paid: true }, 'PATCH');
        await parent.client.request(403, `/payment-records/${payment.id}`, { version: payment.version, paid: true }, 'PATCH');
        await student.client.request(403, `/payment-records/${payment.id}`, { version: payment.version, paid: true }, 'PATCH');
        const marked = await course.teacher.client.request<PaymentRecordView>(200, `/payment-records/${payment.id}`, {
          version: payment.version, paid: true, reason: 'PRIVATE teacher payment note',
        }, 'PATCH');
        assert.equal(marked.paid, true); assert.ok(marked.paidMarkedAt);
      }
    }
    const calendar = await parent.client.request<LessonPage>(200, await lessonsPath('parent'));
    assert.equal(calendar.total, 2);
    assert.equal(calendar.items.find(item => item.id === lessonIds[0])!.attendance!.status, 'present');
    assert.ok(calendar.items.every(item => !Object.hasOwn(item, 'privateNotes') && !Object.hasOwn(item.attendance ?? {}, 'comment')));

    const attempts: { id: string; assignmentId: string }[] = [];
    for (const course of courses) {
      const foreignTeacher = course === math ? physicsTeacher : mathTeacher;
      const correct = randomUUID();
      const choice: Question = {
        id: randomUUID(), type: 'single_choice', prompt: 'Выберите верное утверждение', points: 2,
        options: [{ id: correct, text: 'Верно' }, { id: randomUUID(), text: 'Неверно' }],
        correctOptionIds: [correct], explanation: 'PRIVATE correct answer explanation',
      };
      const written: Question = {
        id: randomUUID(), type: 'text', prompt: 'Объясните решение', points: 3, options: [], correctOptionIds: [],
      };
      const draft = await course.teacher.client.request<TestDetail>(201, '/tests', {
        requestId: randomUUID(), subjectId: course.subjectId, title: `${course.subjectName}: проверка`,
        instruction: 'Ответьте на два вопроса', passPoints: 4, questions: [choice, written],
      });
      await foreignTeacher.client.request(404, `/tests/${draft.id}`);
      const version = await course.teacher.client.request<TestVersion>(200, `/tests/${draft.id}/publish`, { revision: draft.revision });
      const assignment = await course.teacher.client.request<AssignmentView>(201, '/test-assignments', {
        requestId: randomUUID(), versionId: version.id, enrollmentId: course.enrollmentId,
        maxAttempts: 1, answerPolicy: 'never',
      });
      assert.equal(assignment.studentPublicId, student.publicId);
      await stranger.client.request(404, `/test-assignments/${assignment.id}/attempts`, { requestId: randomUUID() });
      const started = await student.client.request<AttemptMutationView>(201, `/test-assignments/${assignment.id}/attempts`, { requestId: randomUUID() });
      const studentView = await student.client.request<AttemptView>(200, `/attempts/${started.id}?role=student`);
      assert.ok(studentView.questions!.every(question => !Object.hasOwn(question, 'correctOptionIds') && !Object.hasOwn(question, 'explanation')));
      const saved = await student.client.request<AttemptMutationView>(200, `/attempts/${started.id}/answers`, {
        version: started.version,
        answers: [{ questionId: choice.id, selectedOptionIds: [correct] }, { questionId: written.id, text: 'PRIVATE student reasoning' }],
      }, 'PATCH');
      const submitted = await student.client.request<AttemptMutationView>(200, `/attempts/${started.id}/submit`, { version: saved.version });
      assert.equal(submitted.status, 'waiting_review');
      await parent.client.request(404, `/attempts/${started.id}?role=parent`);
      await foreignTeacher.client.request(404, `/attempts/${started.id}?role=teacher`);
      await foreignTeacher.client.request(404, `/attempts/${started.id}/review`, {
        version: submitted.version, grades: [{ questionId: written.id, points: 3 }],
      });
      const reviewed = await course.teacher.client.request<AttemptMutationView>(200, `/attempts/${started.id}/review`, {
        version: submitted.version, grades: [{ questionId: written.id, points: 2.5, comment: 'PRIVATE detailed grading' }],
        comment: 'Хорошая работа, уточните обоснование',
      });
      assert.equal(reviewed.status, 'completed');
      await parent.client.request(404, `/attempts/${started.id}?role=parent`);
      const beforePublish = await parent.client.request<OverviewView>(200, '/overview?role=parent');
      assert.equal(beforePublish.latestResults.total, attempts.length, 'Unpublished results must not enter the family overview');
      await student.client.request(403, `/attempts/${started.id}/publish-result`, { version: reviewed.version });
      const published = await course.teacher.client.request<AttemptMutationView>(200, `/attempts/${started.id}/publish-result`, { version: reviewed.version });
      assert.equal(published.status, 'published');
      const result = await parent.client.request<AttemptView>(200, `/attempts/${started.id}?role=parent`);
      assert.equal(result.score, 4.5); assert.equal(result.maxPoints, 5); assert.equal(result.percentage, 90); assert.equal(result.passed, true);
      for (const field of ['questions', 'answers', 'grades']) assert.equal(Object.hasOwn(result, field), false);
      const studentResult = await student.client.request<AttemptView>(200, `/attempts/${started.id}?role=student`);
      assert.equal(studentResult.score, 4.5);
      assert.ok(studentResult.questions!.every(question => !Object.hasOwn(question, 'correctOptionIds') && !Object.hasOwn(question, 'explanation')));
      attempts.push({ id: started.id, assignmentId: assignment.id });
    }

    const family = await parent.client.request<OverviewView>(200, `/overview?role=parent&studentId=${student.profileId}`);
    assert.equal(family.counts.activeEnrollments, 2); assert.equal(family.latestResults.total, 2);
    assert.equal(family.upcomingLessons.total, 1); assert.deepEqual(family.payments, { paid: 1, unpaid: 1 });
    assert.deepEqual(family.subjects.items.map(item => item.subjectName).sort(), ['Математика', 'Физика']);
    for (const course of courses) {
      const summary = family.subjects.items.find(item => item.enrollmentId === course.enrollmentId)!;
      assert.equal(summary.studentPublicId, student.publicId);
      assert.equal(summary.latestResult!.score, 4.5);
      assert.deepEqual(summary.payment, course === math ? { paid: 1, unpaid: 0 } : { paid: 0, unpaid: 1 });
      assert.deepEqual(summary.attendance, { present: course === math ? 1 : 0, absent: 0, excused: 0 });
      const teacherOverview = await course.teacher.client.request<OverviewView>(200, '/overview?role=teacher');
      assert.equal(teacherOverview.subjects.total, 1); assert.equal(teacherOverview.latestResults.total, 1);
      assert.equal(teacherOverview.subjects.items[0]!.enrollmentId, course.enrollmentId);
    }
    const payments = await parent.client.request<PaymentRecordPage>(200, '/payment-records?role=parent');
    assert.equal(payments.total, 2);
    assert.equal(payments.items.find(item => item.id === paymentIds[0])!.paid, true);
    assert.equal(payments.items.find(item => item.id === paymentIds[1])!.paid, false);
    const results = await parent.client.request<AssignmentPage>(200, '/test-assignments?role=parent');
    assert.equal(results.total, 2);
    assert.ok(results.items.every(item => item.attempts.length === 1 && item.attempts[0]!.status === 'published'));
    assert.ok(!JSON.stringify({ family, calendar, payments, results }).includes('PRIVATE'));
    const me = await student.client.request<{ profiles: { student: { publicId: string } } }>(200, '/me');
    assert.equal(me.profiles.student.publicId, student.publicId, 'The profile keeps one ID across every tutor and module');

    // Both unapproved and revoked parent links must deny existing, known resource IDs.
    for (const client of [otherParent.client, parent.client]) {
      if (client === parent.client) await student.client.request(200, `/parent-connections/${parentLink.id}/revoke`, {});
      assert.equal((await client.request<ParentChildrenPage>(200, '/parent-children')).total, 0);
      await client.request(404, `/overview?role=parent&studentId=${student.profileId}`);
      const empty = await client.request<OverviewView>(200, '/overview?role=parent');
      assert.equal(empty.subjects.total, 0); assert.equal(empty.latestResults.total, 0);
      assert.equal(empty.upcomingLessons.total, 0); assert.deepEqual(empty.payments, { paid: 0, unpaid: 0 });
      assert.equal((await client.request<LessonPage>(200, await lessonsPath('parent'))).total, 0);
      assert.equal((await client.request<PaymentRecordPage>(200, `/payment-records?role=parent&enrollmentId=${math.enrollmentId}`)).total, 0);
      assert.equal((await client.request<AssignmentPage>(200, '/test-assignments?role=parent')).total, 0);
      for (const attempt of attempts) await client.request(404, `/attempts/${attempt.id}?role=parent`);
    }
    assert.equal((await stranger.client.request<OverviewView>(200, '/overview?role=student')).subjects.total, 0);
    assert.equal((await stranger.client.request<PaymentRecordPage>(200, `/payment-records?role=student&enrollmentId=${physics.enrollmentId}`)).total, 0);
    const retained = await student.client.request<OverviewView>(200, '/overview?role=student');
    assert.equal(retained.latestResults.total, 2); assert.deepEqual(retained.payments, { paid: 1, unpaid: 1 });
    assert.equal((await mathTeacher.client.request<OverviewView>(200, '/overview?role=teacher')).latestResults.total, 1);
  });
});
