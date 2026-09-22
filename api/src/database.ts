import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { CONFIG, Config } from './config';

@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;
  private readonly background = new Set<Promise<void>>();
  constructor(@Inject(CONFIG) config: Config) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000, statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 });
    this.pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
  }
  async onModuleInit() { await this.pool.query('SELECT 1'); }
  trackBackground(task: Promise<void>): void {
    this.background.add(task);
    void task.then(() => this.background.delete(task), () => this.background.delete(task));
  }
  async onModuleDestroy() {
    // Mail deliveries finish their status write before the pool begins shutting down.
    while (this.background.size) await Promise.allSettled([...this.background]);
    await this.pool.end();
  }
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, values);
  }
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
