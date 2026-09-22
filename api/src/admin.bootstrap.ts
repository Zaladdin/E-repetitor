import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import type { Config } from './config';

export function assertLocalAdminDatabase(config: Pick<Config, 'databaseUrl' | 'production'>): void {
  const url = new URL(config.databaseUrl);
  if (config.production || !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname.length < 2 || url.search !== '') {
    throw new Error('Administrative bootstrap requires a local nonproduction PostgreSQL URL without query overrides.');
  }
}

/** Local operator capability; intentionally has no HTTP endpoint or public role DTO. */
export async function changeAdminMembership(config: Pick<Config, 'databaseUrl' | 'production'>,
  action: 'grant' | 'revoke', userId: string, rawReason: string): Promise<{ changed: boolean }> {
  assertLocalAdminDatabase(config);
  const reason = rawReason.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!['grant', 'revoke'].includes(action) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)
    || reason.length < 3 || reason.length > 500 || /[\u0000-\u001F\u007F]/.test(reason)) throw new Error('Specify grant or revoke, an existing user UUID and a reason of 3–500 characters.');
  const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, max: 1, statement_timeout: 10000 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Serialize membership changes to protect the last active administrator.
    // Routes never acquire this advisory lock; all membership writers then lock users first.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('e-repetitor-admin-memberships'))");
    const user = (await client.query<{ status: string }>('SELECT status FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!user || user.status !== 'active') throw new Error('An existing active, email-verified account is required.');
    const exists = Boolean((await client.query('SELECT user_id FROM admin_memberships WHERE user_id=$1', [userId])).rows[0]);
    if (exists === (action === 'grant')) { await client.query('COMMIT'); return { changed: false }; }
    if (action === 'grant') {
      await client.query('INSERT INTO admin_memberships(user_id,grant_reason) VALUES($1,$2)', [userId, reason]);
    } else {
      const count = (await client.query<{ total: string }>("SELECT count(*) AS total FROM admin_memberships m JOIN users u ON u.id=m.user_id WHERE u.status='active'")).rows[0]!;
      if (Number(count.total) <= 1) throw new Error('Cannot revoke the last active administrator.');
      await client.query('DELETE FROM admin_memberships WHERE user_id=$1', [userId]);
    }
    await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    await client.query('UPDATE account_tokens SET used_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL', [userId]);
    await client.query('INSERT INTO audit_events(id,actor_user_id,action,entity_id,reason) VALUES($1,NULL,$2,$3,$4)',
      [randomUUID(), action === 'grant' ? 'admin.membership.granted' : 'admin.membership.revoked', userId, reason]);
    await client.query('COMMIT'); return { changed: true };
  } catch (error) { await client?.query('ROLLBACK'); throw error; }
  finally { client?.release(); await pool.end(); }
}
