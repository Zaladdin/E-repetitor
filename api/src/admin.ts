import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Database } from './database';
import { ApiError, ApiRequest, lockActiveSession, unauthenticated } from './common';
import { AdminAuditPage, AdminAuditQueryDto, AdminOverviewView, AdminStatusDto, AdminUserDetail, AdminUsersPage, AdminUsersQueryDto, AdminUserView, UserStatus } from './admin.dto';

const userSelect = `SELECT u.id,u.name,u.email,u.status,u.status_version,u.created_at,u.updated_at,s.public_id,
  array_remove(ARRAY[CASE WHEN t.id IS NOT NULL THEN 'teacher' END,CASE WHEN s.id IS NOT NULL THEN 'student' END,
    CASE WHEN p.id IS NOT NULL THEN 'parent' END],NULL) AS roles,
  EXISTS(SELECT 1 FROM admin_memberships m WHERE m.user_id=u.id) AS is_admin
  FROM users u LEFT JOIN teacher_profiles t ON t.user_id=u.id
  LEFT JOIN student_profiles s ON s.user_id=u.id LEFT JOIN parent_profiles p ON p.user_id=u.id`;
const userJson = `jsonb_build_object('id',id,'name',name,'email',email,'status',status,'roles',roles,
  'isAdmin',is_admin,'publicId',public_id,'createdAt',created_at,'statusVersion',status_version)`;
const requiredAdmin = () => new ApiError(403, 'admin_required', 'Этот раздел доступен администратору.');
const missingUser = () => new ApiError(404, 'not_found', 'Пользователь не найден.');

async function requireMembership(client: PoolClient, userId: string): Promise<void> {
  if (!(await client.query('SELECT user_id FROM admin_memberships WHERE user_id=$1', [userId])).rows[0]) throw requiredAdmin();
}

/** Multi-user mutations must acquire their user locks in UUID order first. */
async function requireAdmin(client: PoolClient, req: ApiRequest): Promise<string> {
  const actor = await lockActiveSession(client, req);
  await requireMembership(client, actor);
  return actor;
}

@Injectable()
export class AdminService {
  constructor(private readonly db: Database) {}
  private async read<T>(req: ApiRequest, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async client => { await requireAdmin(client, req); return run(client); });
  }
  overview(req: ApiRequest): Promise<AdminOverviewView> {
    return this.read(req, async client => (await client.query<AdminOverviewView>(`SELECT
      (SELECT jsonb_build_object('total',count(*),'active',count(*) FILTER(WHERE status='active'),
        'suspended',count(*) FILTER(WHERE status='suspended'),'pendingVerification',count(*) FILTER(WHERE status='pending_verification'),
        'deactivated',count(*) FILTER(WHERE status='deactivated'),'deleted',count(*) FILTER(WHERE status='deleted')) FROM users) AS users,
      (SELECT jsonb_build_object('total',count(*),'active',count(*) FILTER(WHERE status='active')) FROM enrollments) AS enrollments,
      (SELECT jsonb_build_object('total',count(*),'scheduled',count(*) FILTER(WHERE status='scheduled')) FROM lessons) AS lessons,
      (SELECT jsonb_build_object('total',count(*),'published',count(*) FILTER(WHERE status='published')) FROM tests) AS tests,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "generatedAt"`)).rows[0]!);
  }
  users(req: ApiRequest, query: AdminUsersQueryDto): Promise<AdminUsersPage> {
    return this.read(req, async client => {
      const result = await client.query<{ items: AdminUserView[]; total: string }>(`WITH candidates AS (${userSelect}), filtered AS (
        SELECT * FROM candidates WHERE ($1::text IS NULL OR strpos(lower(email),$1)>0 OR strpos(lower(coalesce(public_id,'')),$1)>0)
        AND ($2::text IS NULL OR ($2='admin' AND is_admin) OR $2=ANY(roles)) AND ($3::text IS NULL OR status=$3)),
        page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5)
        SELECT coalesce((SELECT jsonb_agg(${userJson} ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb) AS items,
          (SELECT count(*) FROM filtered) AS total`, [query.query?.toLowerCase() || null, query.role ?? null, query.status ?? null, query.limit, query.offset]);
      return { items: result.rows[0]!.items, total: Number(result.rows[0]!.total), limit: query.limit, offset: query.offset };
    });
  }
  user(req: ApiRequest, id: string): Promise<AdminUserDetail> {
    return this.read(req, async client => {
      const result = await client.query<{ user: AdminUserView; updated_at: Date; active_sessions: string }>(`WITH selected AS (${userSelect} WHERE u.id=$1)
        SELECT ${userJson} AS "user",updated_at,(SELECT count(*) FROM sessions s WHERE s.user_id=selected.id
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) AS active_sessions FROM selected`, [id]);
      const row = result.rows[0]; if (!row) throw missingUser();
      return { user: row.user, updatedAt: row.updated_at.toISOString(), activeSessions: Number(row.active_sessions) };
    });
  }
  status(req: ApiRequest, id: string, dto: AdminStatusDto): Promise<AdminUserView> {
    return this.db.transaction(async client => {
      if (!req.userId || !req.sessionId) throw unauthenticated();
      // Reject ordinary accounts before touching another user's lock. Membership
      // and the live session are checked again under the locks below.
      await requireMembership(client, req.userId);
      // Matches logout's multi-account order and login/reset's user -> session/token order.
      // NO KEY UPDATE still serializes account changes but permits notifications'
      // recipient FK KEY SHARE locks, avoiding cross-user notification deadlocks.
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE', [[req.userId, id]]);
      const actor = await requireAdmin(client, req);
      const selected = await client.query<{ status: UserStatus; status_version: number; is_admin: boolean }>(`SELECT u.status,u.status_version,
        EXISTS(SELECT 1 FROM admin_memberships m WHERE m.user_id=u.id) AS is_admin FROM users u WHERE u.id=$1`, [id]);
      const target = selected.rows[0]; if (!target) throw missingUser();
      if (actor === id || target.is_admin) throw new ApiError(403, 'admin_protected', 'Статус администратора нельзя изменить в этом разделе.');
      if (target.status_version !== dto.version) throw new ApiError(409, 'version_conflict', 'Статус уже изменён. Обновите карточку пользователя.');
      const allowed = dto.status === 'active' ? target.status === 'suspended' : dto.status === 'suspended' ? target.status === 'active'
        : ['active', 'suspended', 'pending_verification'].includes(target.status);
      if (!allowed) throw new ApiError(409, 'invalid_status_transition', 'Этот переход статуса недоступен.');
      await client.query('UPDATE users SET status=$2,status_version=status_version+1,updated_at=clock_timestamp() WHERE id=$1', [id, dto.status]);
      if (dto.status !== 'active') {
        await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
        await client.query('UPDATE account_tokens SET used_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL', [id]);
      }
      await client.query(`INSERT INTO audit_events(id,actor_user_id,action,entity_id,reason,from_status,to_status)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), actor, `admin.user.${dto.status === 'active' ? 'unsuspended' : dto.status}`, id, dto.reason, target.status, dto.status]);
      return (await client.query<{ user: AdminUserView }>(`WITH selected AS (${userSelect} WHERE u.id=$1) SELECT ${userJson} AS "user" FROM selected`, [id])).rows[0]!.user;
    });
  }
  audit(req: ApiRequest, query: AdminAuditQueryDto): Promise<AdminAuditPage> {
    return this.read(req, async client => {
      const result = await client.query<{ items: AdminAuditPage['items']; total: string }>(`WITH filtered AS (
        SELECT a.id,a.action,a.actor_user_id,u.name AS actor_name,a.entity_id,a.created_at,a.reason,a.from_status,a.to_status
        FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id
        WHERE $1::uuid IS NULL OR a.actor_user_id=$1 OR a.entity_id=$1),
        page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3)
        SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'action',action,'actorId',actor_user_id,'actorName',actor_name,
          'entityId',entity_id,'createdAt',created_at,'reason',reason,'fromStatus',from_status,'toStatus',to_status)
          ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb) AS items,(SELECT count(*) FROM filtered) AS total`,
      [query.userId ?? null, query.limit, query.offset]);
      return { items: result.rows[0]!.items, total: Number(result.rows[0]!.total), limit: query.limit, offset: query.offset };
    });
  }
}
