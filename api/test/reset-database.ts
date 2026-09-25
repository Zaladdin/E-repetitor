import type { Database } from '../src/database';

/** Fixture cleanup only; runtime requests retain their normal query timeout. */
export async function resetTestDatabase(db: Database): Promise<void> {
  await db.transaction(async client => {
    const result = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (!result.rows[0]?.name.endsWith('_test')) throw new Error('Fixture cleanup requires a dedicated _test database.');
    // Recreating many relation files can be slow on Windows. SET LOCAL restores
    // the pooled connection's application timeout at either commit or rollback.
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query('TRUNCATE users, rate_limits CASCADE');
  });
}
