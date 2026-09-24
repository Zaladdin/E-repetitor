import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, ApiRequest, Role, audit, lockActiveSession } from './common';
import { Database } from './database';
import { ArchiveGroupDto, CreateGroupDto, GroupCandidatesPage, GroupCandidatesQueryDto, GroupInputDto, GroupSchedulePage, GroupScheduleQueryDto, GroupsPage, GroupsQueryDto, GroupView, UpdateGroupDto } from './groups.dto';

const unavailable = () => new ApiError(404, 'not_found', 'Группа, предмет или ученик недоступны.');
const invalid = (message: string) => new ApiError(400, 'validation_error', message);
const tables = { teacher: 'teacher_profiles', student: 'student_profiles', parent: 'parent_profiles' } as const;
type GroupRow = { id: string; version: number; status: 'active' | 'archived' };

// Explicit teacher projection: family endpoints never reuse this roster-bearing shape.
const groupProjection = `jsonb_build_object('id',g.id,'name',g.name,'subjectId',g.subject_id,'subjectName',subject.name,
  'timezone',g.timezone,'version',g.version,'status',g.status,'members',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('enrollmentId',e.id,'studentName',u.name,'studentPublicId',s.public_id,
      'status',CASE WHEN u.status='active' THEN e.status ELSE u.status END) ORDER BY u.name,e.id)
    FROM student_group_members gm JOIN enrollments e ON e.id=gm.enrollment_id
    JOIN student_profiles s ON s.id=e.student_id JOIN users u ON u.id=s.user_id WHERE gm.group_id=g.id),'[]'::jsonb),
  'slots',COALESCE((SELECT jsonb_agg(jsonb_build_object('weekday',weekday,'startTime',to_char(start_time,'HH24:MI'),
    'endTime',to_char(end_time,'HH24:MI')) ORDER BY weekday,start_time) FROM student_group_slots WHERE group_id=g.id),'[]'::jsonb))`;

@Injectable()
export class GroupsService {
  constructor(private readonly db: Database) {}

  private async profile(userId: string, role: Role, client?: PoolClient): Promise<string> {
    const sql = `SELECT p.id FROM ${tables[role]} p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`;
    const result = client ? await client.query<{ id: string }>(sql, [userId]) : await this.db.query<{ id: string }>(sql, [userId]);
    if (!result.rows[0]) throw new ApiError(403, 'role_required', 'Выберите доступную роль аккаунта.');
    return result.rows[0].id;
  }

  async list(userId: string, query: GroupsQueryDto): Promise<GroupsPage> {
    const teacherId = await this.profile(userId, 'teacher');
    const result = await this.db.query<{ items: GroupView[]; total: number }>(`WITH owned AS (
      SELECT * FROM student_groups WHERE teacher_id=$1 AND status='active'
    ), page AS (SELECT * FROM owned ORDER BY created_at DESC,id LIMIT $2 OFFSET $3)
    SELECT COALESCE((SELECT jsonb_agg(${groupProjection} ORDER BY g.created_at DESC,g.id)
      FROM page g JOIN subjects subject ON subject.id=g.subject_id),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM owned) AS total`, [teacherId, query.limit, query.offset]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }

  async candidates(userId: string, query: GroupCandidatesQueryDto): Promise<GroupCandidatesPage> {
    const teacherId = await this.profile(userId, 'teacher');
    const result = await this.db.query<{ owned: boolean; items: GroupCandidatesPage['items']; total: number }>(`WITH owned AS (
      SELECT id FROM subjects WHERE id=$2 AND teacher_id=$1
    ), visible AS (
      SELECT e.id,u.name,s.public_id FROM enrollments e JOIN owned ON owned.id=e.subject_id
      JOIN student_profiles s ON s.id=e.student_id JOIN users u ON u.id=s.user_id
      WHERE e.teacher_id=$1 AND e.status='active' AND e.accepted_at IS NOT NULL AND u.status='active'
    ) SELECT EXISTS(SELECT 1 FROM owned) AS owned,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('enrollmentId',id,'studentName',name,'studentPublicId',public_id) ORDER BY name,id)
        FROM (SELECT * FROM visible ORDER BY name,id LIMIT $3 OFFSET $4) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [teacherId, query.subjectId, query.limit, query.offset]);
    if (!result.rows[0]!.owned) throw unavailable();
    return { items: result.rows[0]!.items, total: result.rows[0]!.total, limit: query.limit, offset: query.offset };
  }

  private normalize(dto: GroupInputDto): GroupInputDto {
    const slots = dto.slots.map(slot => ({ ...slot })).sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!; const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      const duration = minutes(slot.endTime) - minutes(slot.startTime);
      if (duration <= 0 || duration > 480) throw invalid('Время окончания должно быть позже начала. Занятие — не более 8 часов в пределах одного дня.');
      const previous = slots[i - 1];
      if (previous && previous.weekday === slot.weekday && previous.endTime > slot.startTime) throw invalid('Занятия группы в один день не должны пересекаться.');
    }
    try { new Intl.DateTimeFormat('en', { timeZone: dto.timezone }).format(); } catch { throw invalid('Выберите существующий часовой пояс.'); }
    return { name: dto.name, subjectId: dto.subjectId, timezone: dto.timezone, enrollmentIds: [...dto.enrollmentIds].sort(), slots };
  }

  /** Match connection writers: actor user -> sorted students -> sorted enrollments -> group. */
  private async lockMembers(client: PoolClient, teacherId: string, dto: GroupInputDto) {
    const subject = await client.query('SELECT id FROM subjects WHERE id=$1 AND teacher_id=$2', [dto.subjectId, teacherId]);
    if (!subject.rows[0]) throw unavailable();
    const timezone = await client.query('SELECT name FROM pg_timezone_names WHERE name=$1', [dto.timezone]);
    if (!timezone.rows[0]) throw invalid('Выберите существующий часовой пояс.');
    const candidates = await client.query<{ id: string; student_id: string }>(`SELECT id,student_id FROM enrollments
      WHERE id=ANY($1::uuid[]) AND teacher_id=$2 AND subject_id=$3`, [dto.enrollmentIds, teacherId, dto.subjectId]);
    if (candidates.rows.length !== dto.enrollmentIds.length) throw unavailable();
    const students = [...new Set(candidates.rows.map(row => row.student_id))].sort();
    await client.query('SELECT id FROM student_profiles WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [students]);
    const enrollments = await client.query<{ accepted_at: Date | null; status: string; student_status: string }>(`SELECT e.accepted_at,e.status,u.status AS student_status
      FROM enrollments e JOIN student_profiles s ON s.id=e.student_id JOIN users u ON u.id=s.user_id
      WHERE e.id=ANY($1::uuid[]) AND e.teacher_id=$2 AND e.subject_id=$3 ORDER BY e.id FOR UPDATE OF e`, [dto.enrollmentIds, teacherId, dto.subjectId]);
    if (enrollments.rows.length !== dto.enrollmentIds.length || enrollments.rows.some(row => !row.accepted_at)) throw unavailable();
    if (enrollments.rows.some(row => row.status !== 'active' || row.student_status !== 'active')) {
      throw new ApiError(409, 'enrollment_inactive', 'В группу можно добавить только активных учеников с подтверждённым обучением.');
    }
  }

  private async lockGroup(client: PoolClient, teacherId: string, id: string, version: number): Promise<GroupRow> {
    const result = await client.query<GroupRow>('SELECT id,version,status FROM student_groups WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [id, teacherId]);
    const row = result.rows[0]; if (!row) throw unavailable();
    if (row.version !== version) throw new ApiError(409, 'stale_version', 'Группа уже изменилась. Обновите список и повторите действие.');
    if (row.status !== 'active') throw new ApiError(409, 'invalid_transition', 'Архивную группу нельзя изменить.');
    return row;
  }

  private async replaceDetails(client: PoolClient, teacherId: string, id: string, dto: GroupInputDto) {
    await client.query(`INSERT INTO student_group_members(group_id,enrollment_id,teacher_id,subject_id)
      SELECT $1,enrollment_id,$2,$3 FROM unnest($4::uuid[]) AS enrollment_id`, [id, teacherId, dto.subjectId, dto.enrollmentIds]);
    await client.query(`INSERT INTO student_group_slots(group_id,weekday,start_time,end_time)
      SELECT $1,weekday,"startTime"::time,"endTime"::time FROM jsonb_to_recordset($2::jsonb) AS slot(weekday smallint,"startTime" text,"endTime" text)`, [id, JSON.stringify(dto.slots)]);
  }

  private async view(client: PoolClient, teacherId: string, id: string): Promise<GroupView> {
    const result = await client.query<{ item: GroupView }>(`SELECT ${groupProjection} AS item FROM student_groups g
      JOIN subjects subject ON subject.id=g.subject_id WHERE g.id=$1 AND g.teacher_id=$2`, [id, teacherId]);
    if (!result.rows[0]) throw unavailable(); return result.rows[0].item;
  }

  async create(req: ApiRequest, input: CreateGroupDto): Promise<GroupView> {
    const dto = this.normalize(input); const payload = JSON.stringify(dto);
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const existing = await client.query<{ id: string; same: boolean }>(`SELECT id,request_payload=$3::jsonb AS same FROM student_groups
        WHERE teacher_id=$1 AND request_id=$2`, [teacherId, input.requestId, payload]);
      if (existing.rows[0]) {
        if (!existing.rows[0].same) throw new ApiError(409, 'request_id_conflict', 'Этот запрос уже использован для другой группы.');
        return this.view(client, teacherId, existing.rows[0].id);
      }
      await this.lockMembers(client, teacherId, dto); const id = randomUUID();
      await client.query(`INSERT INTO student_groups(id,teacher_id,subject_id,name,timezone,request_id,request_payload)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [id, teacherId, dto.subjectId, dto.name, dto.timezone, input.requestId, payload]);
      await this.replaceDetails(client, teacherId, id, dto); await audit(client, userId, 'group.created', id);
      return this.view(client, teacherId, id);
    });
  }

  async update(req: ApiRequest, id: string, input: UpdateGroupDto): Promise<GroupView> {
    const dto = this.normalize(input);
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const owned = await client.query('SELECT id FROM student_groups WHERE id=$1 AND teacher_id=$2', [id, teacherId]);
      if (!owned.rows[0]) throw unavailable();
      await this.lockMembers(client, teacherId, dto); await this.lockGroup(client, teacherId, id, input.version);
      await client.query('DELETE FROM student_group_members WHERE group_id=$1', [id]);
      await client.query('DELETE FROM student_group_slots WHERE group_id=$1', [id]);
      await client.query(`UPDATE student_groups SET name=$2,subject_id=$3,timezone=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
        [id, dto.name, dto.subjectId, dto.timezone]);
      await this.replaceDetails(client, teacherId, id, dto); await audit(client, userId, 'group.updated', id);
      return this.view(client, teacherId, id);
    });
  }

  async archive(req: ApiRequest, id: string, dto: ArchiveGroupDto): Promise<GroupView> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      await this.lockGroup(client, teacherId, id, dto.version);
      await client.query("UPDATE student_groups SET status='archived',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [id]);
      await audit(client, userId, 'group.archived', id); return this.view(client, teacherId, id);
    });
  }

  async schedule(userId: string, query: GroupScheduleQueryDto): Promise<GroupSchedulePage> {
    const range = Date.parse(query.to) - Date.parse(query.from);
    if (range <= 0 || range > 93 * 86400000) throw invalid('Выберите период от одного момента до 93 дней.');
    const profileId = await this.profile(userId, query.role);
    const activeMembers = `SELECT e.student_id,u.name FROM student_group_members gm JOIN enrollments e ON e.id=gm.enrollment_id
      JOIN student_profiles s ON s.id=e.student_id JOIN users u ON u.id=s.user_id
      WHERE gm.group_id=g.id AND e.status='active' AND e.accepted_at IS NOT NULL AND u.status='active'`;
    const memberJoin = query.role === 'teacher' ? '' : `JOIN LATERAL (${activeMembers}) child ON true`;
    const scope = query.role === 'teacher' ? `g.teacher_id=$1 AND EXISTS(${activeMembers})`
      : query.role === 'student' ? 'child.student_id=$1'
        : `EXISTS(SELECT 1 FROM parent_connections pc WHERE pc.parent_id=$1 AND pc.student_id=child.student_id AND pc.status='active')`;
    const childFields = query.role === 'parent' ? 'child.student_id,child.name AS student_name' : 'NULL::uuid AS student_id,NULL::text AS student_name';
    const result = await this.db.query<{ items: GroupSchedulePage['items']; total: number }>(`WITH scoped AS (
      SELECT g.*,subject.name AS subject_name,tu.name AS teacher_name,${childFields}
      FROM student_groups g JOIN subjects subject ON subject.id=g.subject_id
      JOIN teacher_profiles teacher ON teacher.id=g.teacher_id JOIN users tu ON tu.id=teacher.user_id
      ${memberJoin} WHERE g.status='active' AND tu.status='active' AND ${scope}
    ), local_times AS (
      SELECT g.*,((($2::timestamptz AT TIME ZONE g.timezone)::date-1)+days.n)+slot.start_time AS local_start,
        ((($2::timestamptz AT TIME ZONE g.timezone)::date-1)+days.n)+slot.end_time AS local_end
      FROM scoped g JOIN student_group_slots slot ON slot.group_id=g.id
      CROSS JOIN generate_series(0,$6::integer) AS days(n)
      WHERE extract(isodow FROM (($2::timestamptz AT TIME ZONE g.timezone)::date-1)+days.n)=slot.weekday
    ), occurrences AS (
      SELECT *,local_start AT TIME ZONE timezone AS starts_at,local_end AT TIME ZONE timezone AS ends_at FROM local_times
    ), visible AS (
      SELECT id::text||':'||to_char(local_start,'YYYY-MM-DD"T"HH24:MI')||COALESCE(':'||student_id::text,'') AS occurrence_id,
        starts_at,jsonb_strip_nulls(jsonb_build_object(
          'id',id::text||':'||to_char(local_start,'YYYY-MM-DD"T"HH24:MI')||COALESCE(':'||student_id::text,''),
          'groupId',id,'groupName',name,'subjectName',subject_name,'teacherName',teacher_name,
          'startsAt',starts_at,'endsAt',ends_at,'timezone',timezone,'studentName',student_name)) AS item
      FROM occurrences WHERE starts_at<$3::timestamptz AND ends_at>$2::timestamptz AND starts_at>=created_at
        AND ends_at>starts_at AND starts_at AT TIME ZONE timezone=local_start AND ends_at AT TIME ZONE timezone=local_end
    ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY starts_at,occurrence_id)
      FROM (SELECT * FROM visible ORDER BY starts_at,occurrence_id LIMIT $4 OFFSET $5) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [profileId, query.from, query.to, query.limit, query.offset, Math.ceil(range / 86400000) + 2]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }
}
