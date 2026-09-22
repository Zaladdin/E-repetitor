import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Database } from './database';
import { Account, ApiError, ApiRequest, Role, audit, lockActiveSession, unauthenticated } from './common';

interface AccountRow {
  id: string; name: string; email: string; status: string;
  teacher_id: string | null; timezone: string | null;
  student_id: string | null; public_id: string | null; parent_id: string | null; is_admin: boolean;
}
const accountQuery = `SELECT u.id,u.name,u.email,u.status,t.id AS teacher_id,t.timezone,
  s.id AS student_id,s.public_id,p.id AS parent_id,
  EXISTS(SELECT 1 FROM admin_memberships m WHERE m.user_id=u.id) AS is_admin FROM users u
  LEFT JOIN teacher_profiles t ON t.user_id=u.id LEFT JOIN student_profiles s ON s.user_id=u.id
  LEFT JOIN parent_profiles p ON p.user_id=u.id WHERE u.id=$1 AND u.status='active'`;

@Injectable()
export class AccountsService {
  constructor(private readonly db: Database) {}
  async account(userId: string, client?: PoolClient): Promise<Account> {
    const result = client ? await client.query<AccountRow>(accountQuery, [userId]) : await this.db.query<AccountRow>(accountQuery, [userId]);
    const row = result.rows[0];
    if (!row) throw unauthenticated();
    const profiles: Account['profiles'] = {}; const roles: Role[] = [];
    if (row.teacher_id) { roles.push('teacher'); profiles.teacher = { id: row.teacher_id, timezone: row.timezone! }; }
    if (row.student_id) { roles.push('student'); profiles.student = { id: row.student_id, publicId: row.public_id! }; }
    if (row.parent_id) { roles.push('parent'); profiles.parent = { id: row.parent_id }; }
    return { id: row.id, name: row.name, email: row.email, status: row.status, roles, profiles, isAdmin: row.is_admin };
  }
  async createProfile(client: PoolClient, userId: string, role: Role): Promise<void> {
    const id = randomUUID();
    if (role === 'teacher') {
      await client.query('INSERT INTO teacher_profiles(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING', [id, userId]);
    } else if (role === 'parent') {
      await client.query('INSERT INTO parent_profiles(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING', [id, userId]);
    } else {
      const existing = await client.query('SELECT id FROM student_profiles WHERE user_id=$1', [userId]);
      if (existing.rows[0]) return;
      // 40 random bits, case-insensitive uppercase format. ON CONFLICT + retry handles collisions atomically.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let attempt = 0; attempt < 10; attempt++) {
        // Rejection keeps selection unbiased even if the human-readable alphabet changes length.
        let code = '';
        while (code.length < 8) for (const byte of randomBytes(12)) {
          if (byte < Math.floor(256 / alphabet.length) * alphabet.length && code.length < 8) code += alphabet[byte % alphabet.length];
        }
        const publicId = `STU-${code.slice(0, 4)}-${code.slice(4)}`;
        const inserted = await client.query('INSERT INTO student_profiles(id,user_id,public_id) VALUES($1,$2,$3) ON CONFLICT(public_id) DO NOTHING RETURNING id', [id, userId, publicId]);
        if (inserted.rows[0]) return;
      }
      throw new ApiError(503, 'id_unavailable', 'Не удалось создать ID ученика. Попробуйте снова.');
    }
  }
  async addRole(req: ApiRequest, role: Role): Promise<Account> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      await this.createProfile(client, userId, role);
      await audit(client, userId, `profile.${role}.enabled`);
      return this.account(userId, client);
    });
  }
  async subjects(userId: string, limit: number, offset: number) {
    const teacher = await this.db.query<{ id: string }>('SELECT id FROM teacher_profiles WHERE user_id=$1', [userId]);
    if (!teacher.rows[0]) throw new ApiError(403, 'teacher_required', 'Добавьте роль преподавателя.');
    const teacherId = teacher.rows[0].id;
    const result = await this.db.query<{ id: string; name: string }>('SELECT id,name FROM subjects WHERE teacher_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3', [teacherId, limit, offset]);
    const count = await this.db.query<{ count: string }>('SELECT count(*) FROM subjects WHERE teacher_id=$1', [teacherId]);
    return { items: result.rows, total: Number(count.rows[0]!.count), limit, offset };
  }
  async createSubject(req: ApiRequest, name: string) {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      const teacher = await client.query<{ id: string }>('SELECT id FROM teacher_profiles WHERE user_id=$1', [userId]);
      if (!teacher.rows[0]) throw new ApiError(403, 'teacher_required', 'Добавьте роль преподавателя.');
      const result = await client.query<{ id: string; name: string }>(`INSERT INTO subjects(id,teacher_id,name) VALUES($1,$2,$3)
        ON CONFLICT(teacher_id,lower(name)) DO NOTHING RETURNING id,name`, [randomUUID(), teacher.rows[0].id, name]);
      if (!result.rows[0]) throw new ApiError(409, 'subject_exists', 'Такой предмет уже есть в вашем списке.');
      await audit(client, userId, 'subject.created', result.rows[0].id);
      return result.rows[0];
    });
  }
}
