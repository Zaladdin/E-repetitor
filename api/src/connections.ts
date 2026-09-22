import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Database } from './database';
import { ApiError, ApiRequest, Role, audit, lockActiveSession } from './common';
import {
  ConnectionPageDto, EnrollmentPage, EnrollmentQueryDto, EnrollmentRequestDto, EnrollmentStatus,
  EnrollmentStatusDto, ParentChildrenPage, ParentConnectionPage, ParentConnectionQueryDto, ParentConnectionStatus,
} from './connections.dto';

const unavailable = () => new ApiError(404, 'not_found', 'Запрос или запись недоступны.');
const invalidTransition = () => new ApiError(409, 'invalid_transition', 'Этот переход недоступен: запрос уже обработан или срок его действия истёк.');
const profileTables = { teacher: 'teacher_profiles', student: 'student_profiles', parent: 'parent_profiles' } as const;
type EnrollmentRow = { id: string; student_id: string; status: EnrollmentStatus };
type ParentRow = { id: string; student_id: string; status: ParentConnectionStatus };

@Injectable()
export class ConnectionsService {
  constructor(private readonly db: Database) {}

  private async profile(userId: string, role: Role, client?: PoolClient): Promise<string> {
    // The table name is a closed server-side enum, never a request identifier.
    const sql = `SELECT p.id FROM ${profileTables[role]} p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`;
    const result = client ? await client.query<{ id: string }>(sql, [userId]) : await this.db.query<{ id: string }>(sql, [userId]);
    if (!result.rows[0]) throw new ApiError(403, 'role_required', 'Выберите доступную роль аккаунта.');
    return result.rows[0].id;
  }

  private async lockStudent(client: PoolClient, value: string, byPublicId = false, allowInactive = false) {
    const result = await client.query<{ id: string; user_id: string }>(`SELECT s.id,s.user_id FROM student_profiles s
      JOIN users u ON u.id=s.user_id WHERE ${byPublicId ? 's.public_id' : 's.id'}=$1 ${allowInactive ? '' : "AND u.status='active'"} FOR UPDATE OF s`, [value]);
    if (!result.rows[0]) throw unavailable();
    return result.rows[0];
  }

  /** Called only after the student lock. Audit and status are committed together. */
  private async expireForStudent(client: PoolClient, studentId: string) {
    const expired = await client.query<{ id: string }>(`UPDATE enrollments SET status='expired',updated_at=clock_timestamp()
      WHERE student_id=$1 AND status='pending' AND expires_at<=clock_timestamp() RETURNING id`, [studentId]);
    for (const row of expired.rows) {
      await client.query('INSERT INTO audit_events(id,actor_user_id,action,entity_id) VALUES($1,NULL,$2,$3)',
        [randomUUID(), 'enrollment.pending.expired', row.id]);
    }
  }

  async enrollments(userId: string, query: EnrollmentQueryDto): Promise<EnrollmentPage> {
    const profileId = await this.profile(userId, query.role);
    const owner = query.role === 'teacher' ? 'e.teacher_id' : 'e.student_id';
    const result = await this.db.query<{ items: EnrollmentPage['items']; total: number }>(`WITH visible AS (
      SELECT e.created_at,e.id,jsonb_strip_nulls(jsonb_build_object(
        'id',e.id,'studentPublicId',s.public_id,
        'studentName',CASE WHEN $4='teacher' AND e.status IN ('active','paused','completed','cancelled') THEN su.name END,
        'subjectName',subject.name,'teacherName',tu.name,
        'status',CASE WHEN e.status='pending' AND e.expires_at<=clock_timestamp() THEN 'expired' ELSE e.status END,
        'expiresAt',e.expires_at,'createdAt',e.created_at)) AS item
      FROM enrollments e JOIN student_profiles s ON s.id=e.student_id JOIN users su ON su.id=s.user_id
      JOIN subjects subject ON subject.id=e.subject_id JOIN teacher_profiles t ON t.id=e.teacher_id JOIN users tu ON tu.id=t.user_id
      WHERE ${owner}=$1
    ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY created_at,id) FROM
        (SELECT * FROM visible ORDER BY created_at,id LIMIT $2 OFFSET $3) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [profileId, query.limit, query.offset, query.role]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }

  async requestEnrollment(req: ApiRequest, dto: EnrollmentRequestDto) {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      const teacherId = await this.profile(userId, 'teacher', client);
      const subject = await client.query('SELECT id FROM subjects WHERE id=$1 AND teacher_id=$2', [dto.subjectId, teacherId]);
      if (!subject.rows[0]) throw unavailable();
      const student = await this.lockStudent(client, dto.publicId, true);
      await this.expireForStudent(client, student.id);
      const existing = await client.query<EnrollmentRow>(`SELECT id,student_id,status FROM enrollments
        WHERE teacher_id=$1 AND student_id=$2 AND subject_id=$3 AND status IN ('pending','active','paused') FOR UPDATE`,
      [teacherId, student.id, dto.subjectId]);
      if (existing.rows[0]?.status === 'pending') return { id: existing.rows[0].id, status: 'pending' as const };
      if (existing.rows[0]) throw new ApiError(409, 'enrollment_exists', 'Ученик уже подключён к этому предмету.');
      const id = randomUUID();
      await client.query(`WITH moment AS (SELECT clock_timestamp() AS at)
        INSERT INTO enrollments(id,teacher_id,student_id,subject_id,created_at,expires_at,updated_at)
        SELECT $1,$2,$3,$4,at,at+interval '7 days',at FROM moment`, [id, teacherId, student.id, dto.subjectId]);
      await audit(client, userId, 'enrollment.requested', id);
      return { id, status: 'pending' as const };
    });
  }

  async decideEnrollment(req: ApiRequest, id: string, accept: boolean) {
    const result = await this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      const studentId = await this.profile(userId, 'student', client);
      await this.lockStudent(client, studentId);
      await this.expireForStudent(client, studentId);
      const found = await client.query<EnrollmentRow>('SELECT id,student_id,status FROM enrollments WHERE id=$1 AND student_id=$2 FOR UPDATE', [id, studentId]);
      const row = found.rows[0];
      if (!row) return unavailable();
      const status = accept ? 'active' : 'rejected';
      if (row.status === status) return { id, status };
      // Return the error through the transaction so expiry and its audit are not rolled back.
      if (row.status !== 'pending') return invalidTransition();
      const changed = await client.query(`UPDATE enrollments SET status=$2,updated_at=clock_timestamp(),
        accepted_at=CASE WHEN $2='active' THEN clock_timestamp() END,accepted_by=CASE WHEN $2='active' THEN $3::uuid END
        WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp() RETURNING id`, [id, status, userId]);
      if (!changed.rows[0]) { await this.expireForStudent(client, studentId); return invalidTransition(); }
      await audit(client, userId, `enrollment.pending.${status}`, id);
      return { id, status };
    });
    if (result instanceof ApiError) throw result;
    return result;
  }

  async updateEnrollment(req: ApiRequest, id: string, dto: EnrollmentStatusDto) {
    const result = await this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      const teacherId = await this.profile(userId, 'teacher', client);
      const candidate = await client.query<{ student_id: string }>('SELECT student_id FROM enrollments WHERE id=$1 AND teacher_id=$2', [id, teacherId]);
      if (!candidate.rows[0]) throw unavailable();
      await this.lockStudent(client, candidate.rows[0].student_id, false, true);
      await this.expireForStudent(client, candidate.rows[0].student_id);
      const found = await client.query<EnrollmentRow>('SELECT id,student_id,status FROM enrollments WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [id, teacherId]);
      const row = found.rows[0];
      if (!row) return unavailable();
      if (row.status === dto.status) return { id, status: dto.status };
      const allowed = row.status === 'active' ? ['paused','completed','cancelled'] : row.status === 'paused' ? ['active','completed','cancelled'] : [];
      if (!allowed.includes(dto.status)) return invalidTransition();
      await client.query('UPDATE enrollments SET status=$2,updated_at=clock_timestamp() WHERE id=$1', [id, dto.status]);
      await audit(client, userId, `enrollment.${row.status}.${dto.status}`, id);
      return { id, status: dto.status };
    });
    if (result instanceof ApiError) throw result;
    return result;
  }

  async parentConnections(userId: string, query: ParentConnectionQueryDto): Promise<ParentConnectionPage> {
    const profileId = await this.profile(userId, query.role);
    const owner = query.role === 'parent' ? 'pc.parent_id' : 'pc.student_id';
    const result = await this.db.query<{ items: ParentConnectionPage['items']; total: number }>(`WITH visible AS (
      SELECT pc.created_at,pc.id,jsonb_strip_nulls(jsonb_build_object('id',pc.id,'studentPublicId',s.public_id,
        'studentName',CASE WHEN $4='parent' AND pc.status='active' AND su.status='active' THEN su.name END,
        'parentName',CASE WHEN $4='student' THEN pu.name END,'status',pc.status,'createdAt',pc.created_at)) AS item
      FROM parent_connections pc JOIN student_profiles s ON s.id=pc.student_id JOIN users su ON su.id=s.user_id
      JOIN parent_profiles p ON p.id=pc.parent_id JOIN users pu ON pu.id=p.user_id WHERE ${owner}=$1
    ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY created_at,id) FROM
        (SELECT * FROM visible ORDER BY created_at,id LIMIT $2 OFFSET $3) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [profileId, query.limit, query.offset, query.role]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }

  async requestParentConnection(req: ApiRequest, publicId: string) {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      const parentId = await this.profile(userId, 'parent', client);
      const student = await this.lockStudent(client, publicId, true);
      if (student.user_id === userId) throw new ApiError(409, 'self_connection', 'Нельзя добавить собственный профиль в качестве ребёнка.');
      const found = await client.query<ParentRow>(`SELECT id,student_id,status FROM parent_connections
        WHERE parent_id=$1 AND student_id=$2 AND status IN ('pending','active') FOR UPDATE`, [parentId, student.id]);
      if (found.rows[0]?.status === 'pending') return { id: found.rows[0].id, status: 'pending' as const };
      if (found.rows[0]) throw new ApiError(409, 'parent_connection_exists', 'Ребёнок уже добавлен в ваш кабинет.');
      const id = randomUUID();
      await client.query('INSERT INTO parent_connections(id,parent_id,student_id) VALUES($1,$2,$3)', [id, parentId, student.id]);
      await audit(client, userId, 'parent_connection.requested', id);
      return { id, status: 'pending' as const };
    });
  }

  async decideParentConnection(req: ApiRequest, id: string, accept: boolean) {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      const studentId = await this.profile(userId, 'student', client);
      await this.lockStudent(client, studentId);
      const found = await client.query<ParentRow>('SELECT id,student_id,status FROM parent_connections WHERE id=$1 AND student_id=$2 FOR UPDATE', [id, studentId]);
      const row = found.rows[0];
      if (!row) throw unavailable();
      const status = accept ? 'active' : 'rejected';
      if (row.status === status) return { id, status };
      if (row.status !== 'pending') throw invalidTransition();
      await client.query(`UPDATE parent_connections SET status=$2,updated_at=clock_timestamp(),
        approved_at=CASE WHEN $2='active' THEN clock_timestamp() END,approved_by=CASE WHEN $2='active' THEN $3::uuid END WHERE id=$1`, [id, status, userId]);
      await audit(client, userId, `parent_connection.pending.${status}`, id);
      return { id, status };
    });
  }

  async revokeParentConnection(req: ApiRequest, id: string) {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      // Either owning role may revoke; other profiles on the same account add no access.
      const predicate = `pc.id=$1 AND (EXISTS(SELECT 1 FROM parent_profiles p WHERE p.id=pc.parent_id AND p.user_id=$2)
        OR EXISTS(SELECT 1 FROM student_profiles s WHERE s.id=pc.student_id AND s.user_id=$2))`;
      const candidate = await client.query<{ student_id: string }>(`SELECT pc.student_id FROM parent_connections pc WHERE ${predicate}`, [id, userId]);
      if (!candidate.rows[0]) throw unavailable();
      // Parent revocation remains possible when the student's account is inactive.
      await client.query('SELECT id FROM student_profiles WHERE id=$1 FOR UPDATE', [candidate.rows[0].student_id]);
      const found = await client.query<ParentRow>(`SELECT pc.id,pc.student_id,pc.status FROM parent_connections pc WHERE ${predicate} FOR UPDATE OF pc`, [id, userId]);
      const row = found.rows[0];
      if (!row) throw unavailable();
      if (row.status === 'revoked') return { id, status: 'revoked' as const };
      if (row.status !== 'active') throw invalidTransition();
      await client.query("UPDATE parent_connections SET status='revoked',updated_at=clock_timestamp() WHERE id=$1", [id]);
      await audit(client, userId, 'parent_connection.active.revoked', id);
      return { id, status: 'revoked' as const };
    });
  }

  async parentChildren(userId: string, query: ConnectionPageDto): Promise<ParentChildrenPage> {
    const parentId = await this.profile(userId, 'parent');
    // All authorization and child projections share a single statement snapshot.
    const result = await this.db.query<{ items: ParentChildrenPage['items']; total: number }>(`WITH visible AS (
      SELECT s.id,pc.created_at,u.name,s.public_id FROM parent_connections pc
      JOIN student_profiles s ON s.id=pc.student_id JOIN users u ON u.id=s.user_id
      WHERE pc.parent_id=$1 AND pc.status='active' AND u.status='active'
    ), page AS (SELECT * FROM visible ORDER BY created_at,id LIMIT $2 OFFSET $3)
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'publicId',p.public_id,
      'enrollments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'subjectName',subject.name,'teacherName',tu.name,'status',e.status)
          ORDER BY e.created_at,e.id)
        FROM enrollments e JOIN subjects subject ON subject.id=e.subject_id
        JOIN teacher_profiles teacher ON teacher.id=e.teacher_id JOIN users tu ON tu.id=teacher.user_id
        WHERE e.student_id=p.id AND e.status='active'),'[]'::jsonb)) ORDER BY p.created_at,p.id) FROM page p),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [parentId, query.limit, query.offset]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }
}
