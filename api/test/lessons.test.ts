import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import { CreateLessonDto, LessonHistoryPage, LessonMutationView, LessonPage } from '../src/lessons.dto';

const origin = 'http://127.0.0.1:3000';
type ErrorBody = { error: { code: string; message: string } };

describe('PostgreSQL individual lessons API', { concurrency: false }, () => {
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
    async request<T = LessonMutationView>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
      const response = await fetch(`${base}${path}`, { method, headers: {
        Origin: origin, 'X-Requested-With': 'ERepetitor', 'X-Account-ID': this.userId,
        'Content-Type': 'application/json', Cookie: `er_access=${this.token}`, ...extra,
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as T };
    }
  }
  // Real session guards are used; authentication and connection workflows have
  // their own HTTP suites. Fixtures keep this suite focused on lesson behavior.
  async function account(role: Role, name = role) {
    const userId = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    const publicId = `STU-${code.slice(0, 4)}-${code.slice(4)}`;
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,'unused-test-fixture','active','test','test')`, [userId, name, `${userId}@example.test`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, publicId]);
    else if (role === 'teacher') await db.query('INSERT INTO teacher_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    else await db.query('INSERT INTO parent_profiles(id,user_id) VALUES($1,$2)', [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { client: new Client(userId, token), userId, profileId, publicId, name };
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
  async function parentConnection(parent: Person, student: Person, active = false) {
    const id = randomUUID();
    await db.query(`INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by)
      VALUES($1,$2,$3,$4,CASE WHEN $4='active' THEN now() END,CASE WHEN $4='active' THEN $5::uuid END)`,
    [id, parent.profileId, student.profileId, active ? 'active' : 'pending', student.userId]);
    return id;
  }
  async function time(minutes: number) {
    const result = await db.query<{ at: Date }>('SELECT clock_timestamp()+make_interval(mins=>$1) AS at', [minutes]);
    return result.rows[0]!.at.toISOString();
  }
  async function range(role: Role, extra: Record<string, string> = {}) {
    return `/lessons?${new URLSearchParams({ role, from: await time(-1440), to: await time(1440 * 7), ...extra })}`;
  }
  async function context() {
    const teacher = await account('teacher'); const student = await account('student');
    return { teacher, student, enrollmentId: await enrollment(teacher, student) };
  }
  async function payload(enrollmentId: string, extra: Partial<CreateLessonDto> = {}): Promise<CreateLessonDto> {
    return { enrollmentId, requestId: randomUUID(), startsAt: await time(180), durationMin: 60, format: 'online', onlineUrl: 'https://example.test/lesson', privateNotes: 'Только преподавателю', ...extra };
  }
  async function book(teacher: Person, enrollmentId: string, extra: Partial<CreateLessonDto> = {}) {
    const dto = await payload(enrollmentId, extra); const response = await teacher.client.request('/lessons', dto);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return { ...response.body, dto };
  }
  async function past(id: string) { await db.query("UPDATE lessons SET starts_at=clock_timestamp()-interval '120 minutes' WHERE id=$1", [id]); }
  async function error(client: Client, path: string, body: unknown, status: number, code: string, method = 'POST') {
    const result = await client.request<ErrorBody>(path, body, method); assert.equal(result.status, status); assert.equal(result.body.error.code, code);
  }

  test('teacher isolates bookings; student and approved parent see both tutors without private notes or attendance comments', async () => {
    const { teacher, student, enrollmentId } = await context(); const other = await account('teacher');
    const secondEnrollment = await enrollment(other, student, 'active', 'Физика');
    const parent = await account('parent'); const stranger = await account('student');
    const lesson = await book(teacher, enrollmentId); await book(other, secondEnrollment);
    await past(lesson.id);
    assert.equal((await teacher.client.request(`/lessons/${lesson.id}/attendance`, { status: 'present', comment: 'Приватная заметка посещаемости', version: 1 })).status, 200);
    const teacherList = await teacher.client.request<LessonPage>(await range('teacher'));
    assert.equal(teacherList.body.total, 1); assert.equal(teacherList.body.items[0]!.privateNotes, lesson.dto.privateNotes);
    assert.equal(teacherList.body.items[0]!.attendance?.comment, 'Приватная заметка посещаемости');
    const studentList = await student.client.request<LessonPage>(await range('student'));
    assert.equal(studentList.body.total, 2);
    assert.ok(studentList.body.items.every(item => !Object.hasOwn(item, 'privateNotes') && !Object.hasOwn(item.attendance ?? {}, 'comment')));
    assert.equal((await stranger.client.request<LessonPage>(await range('student', { enrollmentId }))).body.total, 0);
    const connectionId = await parentConnection(parent, student);
    assert.equal((await parent.client.request<LessonPage>(await range('parent'))).body.total, 0);
    assert.equal((await student.client.request(`/parent-connections/${connectionId}/approve`, {})).status, 200);
    const parentList = await parent.client.request<LessonPage>(await range('parent', { studentId: student.profileId }));
    assert.equal(parentList.body.total, 2); assert.deepEqual(parentList.body.items.map(item => item.subjectName).sort(), ['Математика', 'Физика']);
    assert.ok(parentList.body.items.every(item => !Object.hasOwn(item, 'privateNotes') && !Object.hasOwn(item.attendance ?? {}, 'comment')));
    assert.ok(!JSON.stringify(parentList.body).includes('email'));
    await student.client.request(`/parent-connections/${connectionId}/revoke`, {});
    assert.equal((await parent.client.request<LessonPage>(await range('parent'))).body.total, 0);
    assert.equal((await other.client.request(`/lessons/${lesson.id}/history`)).status, 404);
    assert.equal((await student.client.request(`/lessons/${lesson.id}/history`)).status, 403);
    assert.equal((await parent.client.request(`/lessons/${lesson.id}/history`)).status, 403);
  });

  test('known foreign UUIDs and roles do not authorize mutation; stale account headers and anonymous requests fail', async () => {
    const { teacher, student, enrollmentId } = await context(); const other = await account('teacher'); const parent = await account('parent');
    const lesson = await book(teacher, enrollmentId); const dto = await payload(enrollmentId);
    assert.equal((await other.client.request('/lessons', dto)).status, 404);
    for (const actor of [student, parent, other]) {
      const expected = actor === other ? 404 : 403;
      assert.equal((await actor.client.request(`/lessons/${lesson.id}`, { status: 'teacher_cancelled', reason: 'Причина', version: 1 }, 'PATCH')).status, expected);
      assert.equal((await actor.client.request(`/lessons/${lesson.id}/reschedule`, { startsAt: await time(500), durationMin: 60, reason: 'Перенос', version: 1 })).status, expected);
      assert.equal((await actor.client.request(`/lessons/${lesson.id}/attendance`, { status: 'present', version: 1 })).status, expected);
    }
    assert.equal((await teacher.client.request(await range('student'))).status, 403);
    await teacher.client.request('/me/roles', { role: 'student' });
    assert.equal((await teacher.client.request<LessonPage>(await range('student'))).body.total, 0);
    const changed = await teacher.client.request<ErrorBody>('/lessons', dto, 'POST', { 'X-Account-ID': student.userId });
    assert.equal(changed.status, 409); assert.equal(changed.body.error.code, 'account_changed');
    assert.equal((await new Client(teacher.userId, newToken()).request(await range('teacher'))).status, 401);
    assert.equal((await db.query('SELECT id FROM lessons')).rowCount, 1);
  });

  test('strict calendar, offset, duration, URL, note and allowlist validation rejects malformed requests', async () => {
    const { teacher, enrollmentId } = await context(); const dto = await payload(enrollmentId);
    for (const startsAt of ['2031-02-29T12:00:00Z', '2032-02-30T12:00:00Z', '2030-04-31T12:00:00Z', '2030-00-01T12:00:00Z', '2030-01-00T12:00:00Z', '2030-01-01T24:00:00Z', '2030-01-01T12:00:00', '2030-01-01T12:00:00+24:00', '2030-01-01T12:00:00+16:00', '2030-01-01T12:00:00-23:59', '2030-01-01T12:00:60Z', null]) {
      assert.equal((await teacher.client.request('/lessons', { ...dto, startsAt })).status, 400, String(startsAt));
    }
    for (const change of [{ durationMin: 4 }, { durationMin: 481 }, { durationMin: 30.5 }, { durationMin: '60' }, { onlineUrl: 'http://example.test' },
      { onlineUrl: 'https://user:pass@example.test' }, { onlineUrl: 'https:\\example.test' }, { onlineUrl: null }, { onlineUrl: 'javascript:alert(1)' },
      { onlineUrl: 'https://example.test/a b' }, { locationText: 'Лишнее место' }, { format: 'offline' }, { privateNotes: 'x'.repeat(2001) }, { privateNotes: null },
      { requestId: 'invalid' }, { teacherId: randomUUID() }, { studentId: randomUUID() }, { version: 1 }]) {
      assert.equal((await teacher.client.request('/lessons', { ...dto, ...change })).status, 400, JSON.stringify(change));
    }
    await error(teacher.client, '/lessons', { ...dto, startsAt: await time(-1) }, 409, 'lesson_in_past');
    const offsetDate = new Date(Date.parse(dto.startsAt) + 4 * 3600000).toISOString().replace('Z', '+04:00');
    const result = await teacher.client.request('/lessons', { ...dto, startsAt: offsetDate }); assert.equal(result.status, 201);
    const list = await teacher.client.request<LessonPage>(await range('teacher'));
    assert.equal(Date.parse(list.body.items[0]!.startsAt), Date.parse(dto.startsAt));
  });

  test('range limits, filters, overlapping intervals and stable pagination use explicit role scope', async () => {
    const { teacher, student, enrollmentId } = await context();
    const start = await time(100); const secondStart = new Date(Date.parse(start) + 60 * 60000).toISOString();
    const first = await book(teacher, enrollmentId, { startsAt: start }); const second = await book(teacher, enrollmentId, { startsAt: secondStart });
    const from = new Date(Date.parse(start) + 30 * 60000).toISOString(); const to = new Date(Date.parse(start) + 60 * 60000).toISOString();
    const overlap = await teacher.client.request<LessonPage>(await range('teacher', { from, to }));
    assert.deepEqual(overlap.body.items.map(item => item.id), [first.id]);
    const page = await teacher.client.request<LessonPage>(await range('teacher', { enrollmentId, studentId: student.profileId, limit: '1', offset: '1' }));
    assert.equal(page.body.total, 2); assert.equal(page.body.limit, 1); assert.equal(page.body.offset, 1); assert.equal(page.body.items[0]!.id, second.id);
    assert.equal((await teacher.client.request<LessonPage>(await range('teacher', { studentId: randomUUID() }))).body.total, 0);
    for (const path of ['/lessons', `/lessons?${new URLSearchParams({ from, to })}`, await range('teacher', { to: from, from }),
      await range('teacher', { from: to, to: from }), await range('teacher', { from: '2030-01-01T00:00:00Z', to: '2030-06-01T00:00:00Z' }),
      await range('teacher', { from: '2030-02-30T00:00:00Z' }), await range('teacher', { from: '2030-01-01T00:00:00+16:00' }),
      await range('teacher', { to: '2030-01-01T00:00:00-23:59' }), await range('teacher', { role: 'admin' }), await range('teacher', { limit: '101' }),
      await range('teacher', { offset: '-1' }), await range('teacher', { limit: '1.5' }), await range('teacher', { teacherId: teacher.profileId }),
      `${await range('teacher')}&role=student`, await range('teacher', { enrollmentId: 'bad-id' })]) {
      assert.equal((await teacher.client.request(path)).status, 400, path);
    }
  });

  test('concurrent overlaps have one winner, adjacent lessons and another teacher are allowed', async () => {
    const { teacher, student, enrollmentId } = await context(); const other = await account('teacher'); const otherEnrollment = await enrollment(other, student);
    const dto = await payload(enrollmentId); const next = { ...dto, requestId: randomUUID() };
    const results = await Promise.all([teacher.client.request('/lessons', dto), teacher.client.request('/lessons', next)]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    await book(teacher, enrollmentId, { startsAt: new Date(Date.parse(dto.startsAt) + dto.durationMin * 60000).toISOString() });
    await book(other, otherEnrollment, { startsAt: dto.startsAt });
    assert.equal((await db.query('SELECT id FROM lessons')).rowCount, 3);
  });

  test('creation retries return the same row without duplicate history and changed payload conflicts', async () => {
    const { teacher, enrollmentId } = await context(); const dto = await payload(enrollmentId);
    const results = await Promise.all([1, 2, 3].map(() => teacher.client.request('/lessons', dto)));
    assert.ok(results.every(result => result.status === 201)); assert.equal(new Set(results.map(result => result.body.id)).size, 1);
    const id = results[0]!.body.id;
    await error(teacher.client, '/lessons', { ...dto, durationMin: 30 }, 409, 'request_id_conflict');
    assert.equal((await db.query('SELECT id FROM lesson_history WHERE lesson_id=$1', [id])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE entity_id=$1 AND action='lesson.created'", [id])).rowCount, 1);
    await past(id);
    // Retry acknowledgements are still valid after the original booking time has passed.
    assert.equal((await teacher.client.request('/lessons', dto)).body.id, id);
  });

  test('concurrent creation and reschedule for different students cannot reserve the same teacher interval', async () => {
    const { teacher, enrollmentId } = await context(); const secondStudent = await account('student');
    const secondEnrollment = await enrollment(teacher, secondStudent, 'active', 'Физика');
    const original = await book(teacher, enrollmentId); const target = await time(700);
    const results = await Promise.all([
      teacher.client.request('/lessons', await payload(secondEnrollment, { startsAt: target })),
      teacher.client.request(`/lessons/${original.id}/reschedule`, { startsAt: target, durationMin: 60, reason: 'Новое время', version: 1 }),
    ]);
    assert.equal(results.filter(result => result.status === 200 || result.status === 201).length, 1);
    assert.equal(results.filter(result => result.status === 409).length, 1);
    assert.equal((await db.query("SELECT id FROM lessons WHERE teacher_id=$1 AND starts_at=$2 AND status='scheduled'", [teacher.profileId, target])).rowCount, 1);
  });

  test('reschedule preserves original time, links history in both records and rejects stale or repeated replacements', async () => {
    const { teacher, enrollmentId } = await context(); const original = await book(teacher, enrollmentId);
    const startsAt = await time(400);
    const moved = await teacher.client.request(`/lessons/${original.id}/reschedule`, { startsAt, durationMin: 45, reason: 'По просьбе ученика', version: 1 });
    assert.equal(moved.status, 200); assert.notEqual(moved.body.id, original.id); assert.equal(moved.body.rescheduledFromId, original.id);
    assert.equal(moved.body.version, 1);
    const list = await teacher.client.request<LessonPage>(await range('teacher'));
    const old = list.body.items.find(item => item.id === original.id)!; const replacement = list.body.items.find(item => item.id === moved.body.id)!;
    assert.equal(old.status, 'rescheduled'); assert.equal(old.version, 2); assert.equal(Date.parse(old.startsAt), Date.parse(original.dto.startsAt));
    assert.equal(old.replacementId, replacement.id); assert.equal(Date.parse(old.replacementStartsAt!), Date.parse(startsAt));
    assert.equal(replacement.rescheduledFromId, original.id); assert.equal(Date.parse(replacement.rescheduledFromStartsAt!), Date.parse(original.dto.startsAt));
    assert.equal(replacement.privateNotes, original.dto.privateNotes); assert.equal(replacement.durationMin, 45);
    for (const id of [original.id, replacement.id]) {
      const history = await teacher.client.request<LessonHistoryPage>(`/lessons/${id}/history`);
      const event = history.body.items.find(item => item.type === 'rescheduled')!;
      assert.equal(event.reason, 'По просьбе ученика'); assert.equal(Date.parse(event.fromStartsAt!), Date.parse(original.dto.startsAt));
      assert.equal(Date.parse(event.toStartsAt!), Date.parse(startsAt)); assert.ok(!Object.hasOwn(event, 'actor_user_id'));
    }
    await error(teacher.client, `/lessons/${original.id}/reschedule`, { startsAt: await time(600), durationMin: 60, reason: 'Повтор', version: 1 }, 409, 'stale_version');
    await error(teacher.client, `/lessons/${original.id}/reschedule`, { startsAt: await time(600), durationMin: 60, reason: 'Повтор', version: 2 }, 409, 'invalid_transition');
    const again = await teacher.client.request(`/lessons/${replacement.id}/reschedule`, { startsAt: await time(600), durationMin: 60, reason: 'Второй перенос', version: 1 });
    assert.equal(again.status, 200); assert.equal(again.body.rescheduledFromId, replacement.id);
  });

  test('failed overlapping reschedule rolls back state, version, history and replacement atomically', async () => {
    const { teacher, enrollmentId } = await context(); const original = await book(teacher, enrollmentId);
    const blocked = await book(teacher, enrollmentId, { startsAt: await time(400) });
    await error(teacher.client, `/lessons/${original.id}/reschedule`, { startsAt: blocked.dto.startsAt, durationMin: 60, reason: 'Конфликт', version: 1 }, 409, 'lesson_overlap');
    const row = (await db.query<{ status: string; version: number }>('SELECT status,version FROM lessons WHERE id=$1', [original.id])).rows[0]!;
    assert.equal(row.status, 'scheduled'); assert.equal(row.version, 1);
    assert.equal((await db.query('SELECT id FROM lessons WHERE rescheduled_from_id=$1', [original.id])).rowCount, 0);
    assert.equal((await db.query('SELECT id FROM lesson_history WHERE lesson_id=$1', [original.id])).rowCount, 1);
    await error(teacher.client, `/lessons/${original.id}/reschedule`, { startsAt: await time(-60), durationMin: 60, reason: 'Прошлое', version: 1 }, 409, 'lesson_in_past');
  });

  test('history failure after replacement insertion rolls back the entire reschedule transaction', async () => {
    const { teacher, enrollmentId } = await context(); const original = await book(teacher, enrollmentId);
    await db.query(`CREATE FUNCTION test_reject_lesson_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type='rescheduled' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER test_reject_lesson_history BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION test_reject_lesson_history()');
    try {
      const response = await teacher.client.request<ErrorBody>(`/lessons/${original.id}/reschedule`, { startsAt: await time(400), durationMin: 60, reason: 'Проверка отката', version: 1 });
      assert.equal(response.status, 500); assert.equal(response.body.error.code, 'internal_error');
      const row = (await db.query<{ status: string; version: number }>('SELECT status,version FROM lessons WHERE id=$1', [original.id])).rows[0]!;
      assert.equal(row.status, 'scheduled'); assert.equal(row.version, 1);
      assert.equal((await db.query('SELECT id FROM lessons WHERE rescheduled_from_id=$1', [original.id])).rowCount, 0);
      assert.equal((await db.query('SELECT id FROM lesson_history WHERE lesson_id=$1', [original.id])).rowCount, 1);
      assert.equal((await db.query("SELECT id FROM audit_events WHERE action='lesson.rescheduled'", [])).rowCount, 0);
    } finally {
      await db.query('DROP TRIGGER test_reject_lesson_history ON lesson_history');
      await db.query('DROP FUNCTION test_reject_lesson_history()');
    }
  });

  test('attendance is guarded by lesson end and corrections preserve prior values plus reason', async () => {
    const { teacher, student, enrollmentId } = await context(); const lesson = await book(teacher, enrollmentId);
    await error(teacher.client, `/lessons/${lesson.id}/attendance`, { status: 'present', version: 1 }, 409, 'lesson_not_ended');
    await db.query("UPDATE lessons SET starts_at=clock_timestamp()-interval '30 minutes' WHERE id=$1", [lesson.id]);
    await error(teacher.client, `/lessons/${lesson.id}/attendance`, { status: 'present', version: 1 }, 409, 'lesson_not_ended');
    await past(lesson.id);
    const first = await teacher.client.request(`/lessons/${lesson.id}/attendance`, { status: 'absent', comment: 'Не пришёл', version: 1 });
    assert.equal(first.status, 200); assert.equal(first.body.status, 'student_absent'); assert.equal(first.body.version, 2);
    await error(teacher.client, `/lessons/${lesson.id}/attendance`, { status: 'present', version: 2 }, 400, 'correction_reason_required');
    const corrected = await teacher.client.request(`/lessons/${lesson.id}/attendance`, { status: 'present', comment: 'Был на уроке', correctionReason: 'Ошибка отметки', version: 2 });
    assert.equal(corrected.status, 200); assert.equal(corrected.body.status, 'completed'); assert.equal(corrected.body.version, 3);
    await error(teacher.client, `/lessons/${lesson.id}/attendance`, { status: 'excused', correctionReason: 'Старая форма', version: 2 }, 409, 'stale_version');
    const history = await teacher.client.request<LessonHistoryPage>(`/lessons/${lesson.id}/history?limit=1&offset=2`);
    assert.equal(history.body.total, 3); assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0]!.type, 'attendance_corrected'); assert.equal(history.body.items[0]!.fromAttendance, 'absent');
    assert.equal(history.body.items[0]!.toAttendance, 'present'); assert.equal(history.body.items[0]!.reason, 'Ошибка отметки');
    const stored = (await db.query<{ previous_comment: string }>("SELECT previous_comment FROM lesson_history WHERE lesson_id=$1 AND type='attendance_corrected'", [lesson.id])).rows[0]!;
    assert.equal(stored.previous_comment, 'Не пришёл');
    const publicList = await student.client.request<LessonPage>(await range('student'));
    assert.equal(publicList.body.items[0]!.attendance?.status, 'present'); assert.ok(!Object.hasOwn(publicList.body.items[0]!.attendance!, 'comment'));
    assert.equal((await db.query("SELECT id FROM audit_events WHERE entity_id=$1 AND action='lesson.attendance_corrected'", [lesson.id])).rowCount, 1);
    await error(teacher.client, `/lessons/${lesson.id}`, { status: 'teacher_cancelled', reason: 'Нельзя', version: 3 }, 409, 'invalid_transition', 'PATCH');
    await error(teacher.client, `/lessons/${lesson.id}/reschedule`, { startsAt: await time(600), durationMin: 60, reason: 'Нельзя', version: 3 }, 409, 'invalid_transition');
  });

  test('cancellations record attendance, release the interval, reject terminal changes and never charge money', async () => {
    const { teacher, enrollmentId } = await context(); const original = await book(teacher, enrollmentId);
    const cancelled = await teacher.client.request(`/lessons/${original.id}`, { status: 'student_cancelled', reason: 'Ученик заболел', version: 1 }, 'PATCH');
    assert.equal(cancelled.status, 200); assert.equal(cancelled.body.status, 'student_cancelled'); assert.equal(cancelled.body.version, 2);
    const stored = (await db.query<{ status: string; billing_effect: string; charge_applied: boolean }>(`SELECT a.status,l.billing_effect,l.charge_applied
      FROM lessons l JOIN lesson_attendance a ON a.lesson_id=l.id WHERE l.id=$1`, [original.id])).rows[0]!;
    assert.deepEqual(stored, { status: 'cancelled', billing_effect: 'manual', charge_applied: false });
    const history = await teacher.client.request<LessonHistoryPage>(`/lessons/${original.id}/history`);
    assert.equal(history.body.items[1]!.reason, 'Ученик заболел'); assert.equal(history.body.items[1]!.toAttendance, 'cancelled');
    await error(teacher.client, `/lessons/${original.id}/attendance`, { status: 'present', version: 2 }, 409, 'invalid_transition');
    await error(teacher.client, `/lessons/${original.id}`, { status: 'teacher_cancelled', reason: 'Повтор', version: 2 }, 409, 'invalid_transition', 'PATCH');
    const second = await book(teacher, enrollmentId, { startsAt: original.dto.startsAt });
    await past(second.id);
    assert.equal((await teacher.client.request(`/lessons/${second.id}`, { status: 'teacher_cancelled', reason: 'Не состоялось', version: 1 }, 'PATCH')).status, 200);
    assert.equal((await teacher.client.request(`/lessons/${second.id}`, { status: 'scheduled', reason: 'Недопустимо', version: 2 }, 'PATCH')).status, 400);
  });

  test('pending enrollment cannot book; paused or closed contexts forbid new times but permit attendance and cancellation', async () => {
    const { teacher, student, enrollmentId } = await context(); const parent = await account('parent'); await parentConnection(parent, student, true);
    const lesson = await book(teacher, enrollmentId); const later = await book(teacher, enrollmentId, { startsAt: await time(500) });
    const pending = await enrollment(teacher, student, 'pending', 'Не подтверждён');
    assert.equal((await teacher.client.request('/lessons', await payload(pending))).status, 404);
    await teacher.client.request(`/enrollments/${enrollmentId}`, { status: 'paused' }, 'PATCH');
    await error(teacher.client, '/lessons', await payload(enrollmentId, { startsAt: await time(800) }), 409, 'enrollment_inactive');
    await error(teacher.client, `/lessons/${lesson.id}/reschedule`, { startsAt: await time(800), durationMin: 60, reason: 'Пауза', version: 1 }, 409, 'enrollment_inactive');
    assert.equal((await parent.client.request<LessonPage>(await range('parent'))).body.total, 0);
    assert.equal((await student.client.request<LessonPage>(await range('student'))).body.total, 2);
    await teacher.client.request(`/enrollments/${enrollmentId}`, { status: 'completed' }, 'PATCH');
    await past(lesson.id);
    assert.equal((await teacher.client.request(`/lessons/${lesson.id}/attendance`, { status: 'excused', version: 1 })).status, 200);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
    assert.equal((await teacher.client.request(`/lessons/${later.id}`, { status: 'teacher_cancelled', reason: 'Отмена', version: 1 }, 'PATCH')).status, 200);
    assert.equal((await teacher.client.request<LessonPage>(await range('teacher'))).body.total, 2);
  });

  test('inactive student prevents bookings and parent access, while teacher can finish historical attendance', async () => {
    const { teacher, student, enrollmentId } = await context(); const parent = await account('parent'); await parentConnection(parent, student, true);
    const lesson = await book(teacher, enrollmentId);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
    await error(teacher.client, '/lessons', await payload(enrollmentId, { startsAt: await time(800) }), 409, 'enrollment_inactive');
    await error(teacher.client, `/lessons/${lesson.id}/reschedule`, { startsAt: await time(800), durationMin: 60, reason: 'Перенос', version: 1 }, 409, 'enrollment_inactive');
    assert.equal((await parent.client.request<LessonPage>(await range('parent'))).body.total, 0);
    await past(lesson.id);
    assert.equal((await teacher.client.request(`/lessons/${lesson.id}/attendance`, { status: 'present', version: 1 })).status, 200);
  });

  test('concurrent updates with the same version have one winner and one history event', async () => {
    const { teacher, enrollmentId } = await context(); const lesson = await book(teacher, enrollmentId); await past(lesson.id);
    const results = await Promise.all(['present', 'absent'].map(status => teacher.client.request(`/lessons/${lesson.id}/attendance`, { status, version: 1 })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await db.query('SELECT id FROM lesson_history WHERE lesson_id=$1', [lesson.id])).rowCount, 2);
    assert.equal((await db.query('SELECT lesson_id FROM lesson_attendance WHERE lesson_id=$1', [lesson.id])).rowCount, 1);
  });

  test('database constraints reject mismatched ownership, child attendance and replacement context', async () => {
    const { teacher, student, enrollmentId } = await context(); const other = await account('teacher'); const stranger = await account('student');
    const foreignEnrollment = await enrollment(other, stranger); const original = await book(teacher, enrollmentId); const foreign = await book(other, foreignEnrollment);
    await assert.rejects(db.query('UPDATE lessons SET teacher_id=$2 WHERE id=$1', [original.id, other.profileId]), { code: '23503' });
    await assert.rejects(db.query('UPDATE lessons SET student_id=$2 WHERE id=$1', [original.id, stranger.profileId]), { code: '23503' });
    await assert.rejects(db.query("INSERT INTO lesson_attendance(lesson_id,student_id,status,marked_by) VALUES($1,$2,'present',$3)", [original.id, stranger.profileId, teacher.userId]), { code: '23503' });
    await assert.rejects(db.query('UPDATE lessons SET request_id=NULL,request_payload=NULL,rescheduled_from_id=$2 WHERE id=$1', [foreign.id, original.id]), { code: '23503' });
    await assert.rejects(db.query('UPDATE lessons SET charge_applied=true WHERE id=$1', [original.id]), { code: '23514' });
    await assert.rejects(db.query('UPDATE lessons SET duration_min=1 WHERE id=$1', [original.id]), { code: '23514' });
    const moved = await teacher.client.request(`/lessons/${original.id}/reschedule`, { startsAt: await time(400), durationMin: 60, reason: 'Перенос', version: 1 });
    assert.equal(moved.status, 200);
    await assert.rejects(db.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,starts_at,duration_min,format,rescheduled_from_id)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 day',60,'online',$5)`, [randomUUID(), enrollmentId, teacher.profileId, student.profileId, original.id]), { code: '23505' });
  });

  test('OpenAPI documents all lesson endpoints and typed projections', async () => {
    const response = await fetch(`${base}/openapi.json`); const spec = await response.json() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    for (const path of ['/lessons', '/lessons/{id}', '/lessons/{id}/reschedule', '/lessons/{id}/attendance', '/lessons/{id}/history']) assert.ok(spec.paths[`/api/v1${path}`], path);
    for (const name of ['LessonView', 'LessonPage', 'LessonHistoryView', 'LessonHistoryPage', 'CreateLessonDto', 'AttendanceDto']) assert.ok(spec.components.schemas[name], name);
  });
});
