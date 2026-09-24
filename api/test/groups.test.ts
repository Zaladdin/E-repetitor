import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { Database } from '../src/database';
import { hashToken, newToken, Role } from '../src/common';
import { migrate } from '../src/migrate';
import { CreateGroupDto, GroupCandidatesPage, GroupSchedulePage, GroupsPage, GroupView } from '../src/groups.dto';

const origin = 'http://127.0.0.1:3000';
type ErrorBody = { error: { code: string } };

describe('PostgreSQL student groups API', { concurrency: false }, () => {
  let app: INestApplication; let db: Database; let base: string;
  before(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'TEST_DATABASE_URL is required');
    assert.match(new URL(databaseUrl).pathname, /_test$/, 'Only a dedicated test database may be truncated');
    await migrate(databaseUrl);
    app = await createApp(readConfig({ ...process.env, DATABASE_URL: databaseUrl, WEB_ORIGIN: origin, NODE_ENV: 'test', SERVE_WEB: 'false' }), { send: async () => undefined });
    await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  });
  beforeEach(async () => { await db.query('TRUNCATE users, rate_limits CASCADE'); });
  after(async () => { if (app) await app.close(); });
  class Client {
    constructor(readonly userId: string, readonly token: string) {}
    async request<T = GroupView>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
      const response = await fetch(`${base}${path}`, { method, headers: { Origin: origin, 'X-Requested-With': 'ERepetitor', 'X-Account-ID': this.userId,
        'Content-Type': 'application/json', Cookie: `er_access=${this.token}`, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as T };
    }
  }
  async function account(role: Role, name: string = role) {
    const userId = randomUUID(); const profileId = randomUUID(); const sessionId = randomUUID(); const token = newToken();
    const code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase(); const publicId = `STU-${code.slice(0, 4)}-${code.slice(4)}`;
    await db.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
      VALUES($1,$2,$3,'unused-test-fixture','active','test','test')`, [userId, name, `${userId}@example.test`]);
    if (role === 'student') await db.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3)', [profileId, userId, publicId]);
    else await db.query(`INSERT INTO ${role === 'teacher' ? 'teacher_profiles' : 'parent_profiles'}(id,user_id) VALUES($1,$2)`, [profileId, userId]);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [sessionId, userId]);
    await db.query("INSERT INTO access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), sessionId]);
    return { client: new Client(userId, token), userId, profileId, name, publicId };
  }
  type Person = Awaited<ReturnType<typeof account>>;
  async function subject(teacher: Person, name = 'Математика') {
    const id = randomUUID(); await db.query('INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,$3)', [id, teacher.profileId, name]); return id;
  }
  async function enrollment(teacher: Person, student: Person, subjectId: string, status = 'active') {
    const id = randomUUID();
    await db.query(`INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $5='pending' THEN NULL ELSE now() END,CASE WHEN $5='pending' THEN NULL ELSE $6::uuid END)`,
    [id, teacher.profileId, student.profileId, subjectId, status, student.userId]); return id;
  }
  async function link(parent: Person, student: Person) {
    const id = randomUUID(); await db.query(`INSERT INTO parent_connections(id,parent_id,student_id,status,approved_at,approved_by)
      VALUES($1,$2,$3,'active',now(),$4)`, [id, parent.profileId, student.profileId, student.userId]); return id;
  }
  async function context() {
    const teacher = await account('teacher'); const student = await account('student', 'Алия'); const subjectId = await subject(teacher);
    const enrollmentId = await enrollment(teacher, student, subjectId);
    const dto: CreateGroupDto = { requestId: randomUUID(), name: 'Группа 8 класса', subjectId, timezone: 'Asia/Baku', enrollmentIds: [enrollmentId],
      slots: [{ weekday: 1, startTime: '16:00', endTime: '17:00' }, { weekday: 3, startTime: '16:00', endTime: '17:00' }] };
    return { teacher, student, subjectId, enrollmentId, dto };
  }
  function update(dto: CreateGroupDto, version = 1) {
    return { name: dto.name, subjectId: dto.subjectId, timezone: dto.timezone, enrollmentIds: dto.enrollmentIds, slots: dto.slots, version };
  }
  async function create(teacher: Person, dto: CreateGroupDto) {
    const result = await teacher.client.request('/groups', dto); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function range(role: Role, extra: Record<string, string> = {}) {
    return `/groups/schedule?${new URLSearchParams({ role, from: '2030-01-07T00:00:00Z', to: '2030-01-14T00:00:00Z', ...extra })}`;
  }
  async function error(client: Client, path: string, body: unknown, status: number, code: string, method = 'POST') {
    const result = await client.request<ErrorBody>(path, body, method); assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.error.code, code);
  }

  test('creates persistent groups with sorted weekly slots and own candidates', async () => {
    const { teacher, student, dto, subjectId, enrollmentId } = await context(); const second = await account('student', 'Борис');
    const secondId = await enrollment(teacher, second, subjectId); const pending = await account('student'); await enrollment(teacher, pending, subjectId, 'pending');
    const candidates = await teacher.client.request<GroupCandidatesPage>(`/groups/candidates?subjectId=${subjectId}&limit=1&offset=1`);
    assert.equal(candidates.status, 200); assert.equal(candidates.body.total, 2); assert.equal(candidates.body.items.length, 1);
    const group = await create(teacher, { ...dto, enrollmentIds: [secondId, enrollmentId], slots: [...dto.slots].reverse() });
    assert.deepEqual(group.slots, dto.slots); assert.deepEqual(group.members.map(member => member.studentName), [student.name, second.name]);
    const page = await teacher.client.request<GroupsPage>('/groups'); assert.equal(page.body.total, 1); assert.deepEqual(page.body.items[0], group);
    assert.equal((await db.query('SELECT id FROM lessons')).rowCount, 0);
  });
  test('validates nested times, overlap, sizes, timezone and required values', async () => {
    const { teacher, dto } = await context();
    const invalid: unknown[] = [
      { name: ' ' }, { timezone: 'No/Such_Zone' }, { enrollmentIds: [] }, { enrollmentIds: [dto.enrollmentIds[0], dto.enrollmentIds[0]] }, { slots: [] },
      { slots: [null] }, { slots: [[]] }, { slots: [[{ weekday: 1, startTime: '16:00', endTime: '17:00' }]] },
      { slots: [{ weekday: 0, startTime: '12:00', endTime: '13:00' }] }, { slots: [{ weekday: 1, startTime: '24:00', endTime: '25:00' }] },
      { slots: [{ weekday: 1, startTime: '12:00', endTime: '12:00' }] }, { slots: [{ weekday: 1, startTime: '18:00', endTime: '08:00' }] },
      { slots: [{ weekday: 1, startTime: '08:00', endTime: '17:00' }] }, { slots: [dto.slots[0], dto.slots[0]] },
      { slots: [dto.slots[0], { weekday: 1, startTime: '16:30', endTime: '17:30' }] },
      { slots: [{ weekday: 1, startTime: '12:00', endTime: '13:00', unexpected: true }] },
    ];
    for (const patch of invalid) await error(teacher.client, '/groups', { ...dto, ...(patch as object) }, 400, 'validation_error');
    assert.equal((await db.query('SELECT id FROM student_groups')).rowCount, 0);
    const group = await create(teacher, { ...dto, slots: [dto.slots[0]!, { weekday: 1, startTime: '17:00', endTime: '18:00' }] });
    assert.equal(group.slots.length, 2);
  });
  test('isolates teachers and rejects family administration, stale account and anonymous sessions', async () => {
    const { teacher, student, dto, subjectId } = await context(); const other = await account('teacher'); const parent = await account('parent');
    const group = await create(teacher, dto);
    for (const actor of [student, parent]) {
      assert.equal((await actor.client.request('/groups')).status, 403);
      assert.equal((await actor.client.request(`/groups/candidates?subjectId=${subjectId}`)).status, 403);
      assert.equal((await actor.client.request('/groups', dto)).status, 403);
      assert.equal((await actor.client.request(`/groups/${group.id}/archive`, { version: 1 })).status, 403);
    }
    assert.equal((await other.client.request<GroupsPage>('/groups')).body.total, 0);
    await error(other.client, '/groups', dto, 404, 'not_found');
    await error(other.client, `/groups/${group.id}`, update(dto), 404, 'not_found', 'PATCH');
    await error(other.client, `/groups/${group.id}/archive`, { version: 1 }, 404, 'not_found');
    assert.equal((await teacher.client.request('/groups', { ...dto, requestId: randomUUID() }, 'POST', { 'X-Account-ID': other.userId })).status, 409);
    assert.equal((await fetch(`${base}/groups`)).status, 401);
  });
  test('rejects foreign, wrong-subject, pending, paused and suspended membership', async () => {
    const { teacher, student, dto } = await context(); const other = await account('teacher'); const foreignSubject = await subject(other);
    const foreign = await enrollment(other, student, foreignSubject); const ownOtherSubject = await subject(teacher, 'Физика');
    const wrongSubject = await enrollment(teacher, student, ownOtherSubject);
    for (const enrollmentId of [foreign, wrongSubject]) await error(teacher.client, '/groups', { ...dto, enrollmentIds: [enrollmentId] }, 404, 'not_found');
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [dto.enrollmentIds[0]]);
    await error(teacher.client, '/groups', dto, 409, 'enrollment_inactive');
    await db.query("UPDATE enrollments SET status='active' WHERE id=$1", [dto.enrollmentIds[0]]);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
    await error(teacher.client, '/groups', dto, 409, 'enrollment_inactive');
    const pending = await account('student'); const pendingId = await enrollment(teacher, pending, dto.subjectId, 'pending');
    await error(teacher.client, '/groups', { ...dto, enrollmentIds: [pendingId] }, 404, 'not_found');
  });
  test('creation retries serialize without duplicates and changed payload conflicts', async () => {
    const { teacher, dto } = await context(); const results = await Promise.all([1, 2, 3].map(() => teacher.client.request('/groups', dto)));
    assert.ok(results.every(result => result.status === 201)); assert.equal(new Set(results.map(result => result.body.id)).size, 1);
    const reordered = await teacher.client.request('/groups', { ...dto, slots: [...dto.slots].reverse() });
    assert.equal(reordered.status, 201); assert.equal(reordered.body.id, results[0]!.body.id);
    await error(teacher.client, '/groups', { ...dto, name: 'Другая' }, 409, 'request_id_conflict');
    assert.equal((await db.query("SELECT id FROM audit_events WHERE action='group.created'")).rowCount, 1);
  });
  test('replaces members, subject and schedule together and rolls all changes back on audit failure', async () => {
    const { teacher, student, dto } = await context(); const group = await create(teacher, dto);
    const second = await account('student', 'Другой ученик'); const nextSubject = await subject(teacher, 'Физика');
    const nextEnrollment = await enrollment(teacher, second, nextSubject);
    const replacement = { ...update(dto), subjectId: nextSubject, enrollmentIds: [nextEnrollment],
      slots: [{ weekday: 5, startTime: '18:00', endTime: '19:30' }] };
    await db.query(`CREATE FUNCTION test_reject_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='group.updated' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER test_reject_group_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_reject_group_audit()');
    try {
      await error(teacher.client, `/groups/${group.id}`, replacement, 500, 'internal_error', 'PATCH');
      const page = await teacher.client.request<GroupsPage>('/groups?limit=1'); assert.deepEqual(page.body.items[0], group);
    } finally {
      await db.query('DROP TRIGGER test_reject_group_audit ON audit_events'); await db.query('DROP FUNCTION test_reject_group_audit()');
    }
    const result = await teacher.client.request(`/groups/${group.id}`, replacement, 'PATCH'); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.subjectName, 'Физика'); assert.equal(result.body.version, 2); assert.deepEqual(result.body.slots, replacement.slots);
    assert.deepEqual(result.body.members.map(member => member.enrollmentId), [nextEnrollment]);
    assert.equal((await student.client.request<GroupSchedulePage>(await range('student'))).body.total, 0);
    assert.equal((await second.client.request<GroupSchedulePage>(await range('student'))).body.total, 1);
  });
  test('edits atomically, rejects stale versions and archives from lists and schedule', async () => {
    const { teacher, dto } = await context(); const group = await create(teacher, dto);
    const updates = await Promise.all(['Первая', 'Вторая'].map(name => teacher.client.request(`/groups/${group.id}`, { ...update(dto), name }, 'PATCH')));
    assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
    await error(teacher.client, `/groups/${group.id}/archive`, { version: 1 }, 409, 'stale_version');
    const archived = await teacher.client.request(`/groups/${group.id}/archive`, { version: 2 });
    assert.equal(archived.status, 200); assert.equal(archived.body.status, 'archived'); assert.equal(archived.body.version, 3);
    assert.equal((await teacher.client.request<GroupsPage>('/groups')).body.total, 0);
    assert.equal((await teacher.client.request<GroupSchedulePage>(await range('teacher'))).body.total, 0);
    await error(teacher.client, `/groups/${group.id}`, update(dto, 3), 409, 'invalid_transition', 'PATCH');
  });
  test('weekly timezone schedule gives teacher one row and families only their own children without roster', async () => {
    const { teacher, student, dto, subjectId } = await context(); const sibling = await account('student', 'Самира');
    const siblingId = await enrollment(teacher, sibling, subjectId); const outsider = await account('student', 'Секретный ученик'); const outsiderId = await enrollment(teacher, outsider, subjectId);
    await create(teacher, { ...dto, enrollmentIds: [...dto.enrollmentIds, siblingId, outsiderId] });
    const parent = await account('parent'); await link(parent, student); const siblingLink = await link(parent, sibling);
    const teacherPage = await teacher.client.request<GroupSchedulePage>(await range('teacher'));
    assert.equal(teacherPage.status, 200, JSON.stringify(teacherPage.body)); assert.equal(teacherPage.body.total, 2);
    assert.equal(Date.parse(teacherPage.body.items[0]!.startsAt), Date.parse('2030-01-07T12:00:00Z'));
    const studentPage = await student.client.request<GroupSchedulePage>(await range('student')); assert.equal(studentPage.body.total, 2);
    const parentPage = await parent.client.request<GroupSchedulePage>(await range('parent')); assert.equal(parentPage.body.total, 4);
    assert.deepEqual([...new Set(parentPage.body.items.map(item => item.studentName))].sort(), [student.name, sibling.name].sort());
    assert.equal(new Set(parentPage.body.items.map(item => item.id)).size, 4);
    for (const page of [parentPage, studentPage]) {
      assert.ok(!JSON.stringify(page.body).includes(outsider.name)); assert.ok(!JSON.stringify(page.body).includes('members')); assert.ok(!JSON.stringify(page.body).includes(outsider.publicId));
    }
    await db.query("UPDATE parent_connections SET status='revoked' WHERE id=$1", [siblingLink]);
    assert.equal((await parent.client.request<GroupSchedulePage>(await range('parent'))).body.total, 2);
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [dto.enrollmentIds[0]]);
    assert.equal((await parent.client.request<GroupSchedulePage>(await range('parent'))).body.total, 0);
    assert.equal((await student.client.request<GroupSchedulePage>(await range('student'))).body.total, 0);
    await db.query("UPDATE enrollments SET status='active' WHERE id=$1", [dto.enrollmentIds[0]]);
    assert.equal((await student.client.request<GroupSchedulePage>(await range('student'))).body.total, 2);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
    assert.equal((await parent.client.request<GroupSchedulePage>(await range('parent'))).body.total, 0);
  });
  test('omits nonexistent spring wall times and uses PostgreSQL standard time for ambiguous autumn times', async () => {
    const { teacher, dto } = await context();
    await create(teacher, { ...dto, timezone: 'Europe/Berlin', slots: [{ weekday: 7, startTime: '02:30', endTime: '03:30' }] });
    const spring = await teacher.client.request<GroupSchedulePage>(await range('teacher', { from: '2030-03-31T00:00:00Z', to: '2030-04-01T00:00:00Z' }));
    assert.equal(spring.status, 200); assert.equal(spring.body.total, 0);
    const autumn = await teacher.client.request<GroupSchedulePage>(await range('teacher', { from: '2030-10-27T00:00:00Z', to: '2030-10-28T00:00:00Z' }));
    assert.equal(autumn.body.total, 1); assert.equal(Date.parse(autumn.body.items[0]!.startsAt), Date.parse('2030-10-27T01:30:00Z'));
    assert.equal(Date.parse(autumn.body.items[0]!.endsAt), Date.parse('2030-10-27T02:30:00Z'));
  });
  test('schedule limits dates, pages stably, observes group creation and timezone DST', async () => {
    const { teacher, dto } = await context(); const group = await create(teacher, { ...dto, timezone: 'Europe/Berlin', slots: [{ weekday: 1, startTime: '16:00', endTime: '17:00' }] });
    const page = await teacher.client.request<GroupSchedulePage>(await range('teacher', { limit: '1', offset: '1', to: '2030-01-21T00:00:00Z' }));
    assert.equal(page.body.total, 2); assert.equal(page.body.items.length, 1); assert.equal(Date.parse(page.body.items[0]!.startsAt), Date.parse('2030-01-14T15:00:00Z'));
    const summer = await teacher.client.request<GroupSchedulePage>(await range('teacher', { from: '2030-07-01T00:00:00Z', to: '2030-07-02T00:00:00Z' }));
    assert.equal(Date.parse(summer.body.items[0]!.startsAt), Date.parse('2030-07-01T14:00:00Z'));
    await db.query("UPDATE student_groups SET created_at='2030-01-08T00:00:00Z' WHERE id=$1", [group.id]);
    assert.equal((await teacher.client.request<GroupSchedulePage>(await range('teacher'))).body.total, 0);
    for (const extra of [{ to: '2031-01-01T00:00:00Z' }, { from: '2030-02-30T00:00:00Z' }, { to: '2030-01-07T00:00:00Z' }] as Record<string, string>[]) {
      assert.equal((await teacher.client.request(await range('teacher', extra))).status, 400);
    }
  });
  test('database ownership constraints reject cross-teacher and subject membership', async () => {
    const { teacher, student, dto } = await context(); const group = await create(teacher, dto); const otherSubject = await subject(teacher, 'Физика');
    const wrongEnrollment = await enrollment(teacher, student, otherSubject);
    await assert.rejects(db.query(`INSERT INTO student_group_members(group_id,enrollment_id,teacher_id,subject_id) VALUES($1,$2,$3,$4)`,
      [group.id, wrongEnrollment, teacher.profileId, dto.subjectId]), { code: '23503' });
    await assert.rejects(db.query('UPDATE student_group_slots SET end_time=start_time WHERE group_id=$1', [group.id]), { code: '23514' });
  });
});
