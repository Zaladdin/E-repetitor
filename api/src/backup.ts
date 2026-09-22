import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import type { Config } from './config';

const execute = promisify(execFile);
const projectRoot = resolve(__dirname, '../../..');
type LocalConnection = { host: string; port: number; user: string; password: string; database: string };
export type BackupFingerprint = { schema: string; tables: Record<string, { rows: number; sha256: string }>; migrations: { name: string; checksum: string }[] };

export function backupConnection(config: Pick<Config, 'databaseUrl' | 'production'>, expectedSource: string): LocalConnection {
  const url = new URL(config.databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (config.production || !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash
    || database !== 'e_repetitor' || database !== expectedSource || !url.username) {
    throw new Error('Rehearsal requires the explicit e_repetitor source on local nonproduction PostgreSQL, without URI overrides.');
  }
  return { host: url.hostname === '[::1]' ? '::1' : url.hostname, port: Number(url.port || 5432),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database };
}

export function backupOperator(source: LocalConnection, operatorUrl?: string): LocalConnection {
  if (!operatorUrl) return { ...source, database: 'postgres' };
  const url = new URL(operatorUrl);
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || host !== source.host
    || Number(url.port || 5432) !== source.port || url.pathname !== '/postgres' || !url.username) {
    throw new Error('Rehearsal requires operator credentials on the same local PostgreSQL server and postgres database.');
  }
  return { host, port: source.port, database: 'postgres', user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

export function restoreDatabaseName(): string {
  return `e_repetitor_restore_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
export function quoteRestoreDatabase(name: string): string {
  if (!/^e_repetitor_restore_\d{14}_[a-f0-9]{12}$/.test(name)) throw new Error('Invalid isolated restore database name.');
  return `"${name}"`;
}
export function assertInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) {
    throw new Error('Backup artifacts must stay inside the project directory.');
  }
}
export function assertSameBackup(source: BackupFingerprint, restored: BackupFingerprint): void {
  if (JSON.stringify(source) !== JSON.stringify(restored)) throw new Error('Restored database differs from the source snapshot.');
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function validateMigrations(client: PoolClient): Promise<BackupFingerprint['migrations']> {
  const applied = (await client.query<{ name: string; checksum: string }>('SELECT name,checksum FROM public.schema_migrations ORDER BY name')).rows;
  const folder = resolve(__dirname, '../../migrations');
  const names = (await readdir(folder)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  const expected = await Promise.all(names.map(async name => ({ name,
    checksum: createHash('sha256').update((await readFile(join(folder, name), 'utf8')).replace(/\r\n/g, '\n')).digest('hex') })));
  if (JSON.stringify(applied) !== JSON.stringify(expected)) throw new Error('Database migrations do not match this checkout.');
  return applied;
}

async function fingerprint(client: PoolClient): Promise<BackupFingerprint> {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const schema = (await client.query(`SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM
      (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,
        character_maximum_length,numeric_precision,numeric_scale,is_identity,is_generated,generation_expression
        FROM information_schema.columns WHERE table_schema='public') c),
    'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY tablename,conname) FROM
      (SELECT r.relname AS tablename,c.conname,pg_get_constraintdef(c.oid) AS definition,c.convalidated
        FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public') c),
    'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY tablename,indexname) FROM
      (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') i),
    'functions',(SELECT jsonb_agg(to_jsonb(f) ORDER BY name,arguments) FROM
      (SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')) f),
    'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY tablename,tgname) FROM
      (SELECT r.relname AS tablename,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal) t),
    'enums',(SELECT jsonb_agg(to_jsonb(e) ORDER BY typname,enumsortorder) FROM
      (SELECT t.typname,e.enumsortorder,e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
        JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') e)) AS value`)).rows[0].value;
  const names = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const tables: BackupFingerprint['tables'] = {};
  for (const { tablename } of names) {
    const hash = createHash('sha256'); let rows = 0;
    await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM public.${identifier(tablename)} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
    try {
      for (;;) {
        const batch = await client.query<{ row: string }>('FETCH 512 FROM backup_rows');
        for (const row of batch.rows) { hash.update(row.row).update('\n'); rows++; }
        if (batch.rows.length < 512) break;
      }
    } finally { await client.query('CLOSE backup_rows'); }
    tables[tablename] = { rows, sha256: hash.digest('hex') };
  }
  return { schema: digest(schema), tables, migrations: await validateMigrations(client) };
}

async function privateArtifacts(): Promise<string> {
  const root = await realpath(projectRoot);
  const local = join(root, '.local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  assertInside(root, await realpath(local));
  const backups = join(local, 'backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  assertInside(root, await realpath(backups));
  const directory = await mkdtemp(join(backups, 'pilot-'));
  assertInside(root, await realpath(directory));
  if (process.platform === 'win32') {
    const { stdout } = await execute('whoami.exe', [], { windowsHide: true });
    await execute('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${stdout.trim()}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  }
  return directory;
}

async function pgTool(name: 'pg_dump' | 'pg_restore', connection: LocalConnection, args: string[], readOnly: boolean): Promise<void> {
  const executable = join(projectRoot, '.local', 'pgsql', 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  await access(executable);
  // Do not inherit libpq service/host/options overrides. Password stays out of argv and output.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key) && !/DATABASE_URL/i.test(key)));
  Object.assign(env, { PGPASSWORD: connection.password, PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable',
    PGOPTIONS: readOnly ? '-c default_transaction_read_only=on' : '' });
  try {
    await execute(executable, ['--host', connection.host, '--port', String(connection.port), '--username', connection.user,
      '--no-password', ...args], { env, windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error(`${name} did not complete; command output is withheld to protect database contents.`); }
}

/** Creates a fresh database only. No DROP, clean, truncate, or overwrite path exists. */
export async function rehearseBackup(config: Pick<Config, 'databaseUrl' | 'production'>, expectedSource: string, operatorUrl?: string): Promise<object> {
  const connection = backupConnection(config, expectedSource);
  const operator = backupOperator(connection, operatorUrl);
  const target = restoreDatabaseName();
  const targetSql = quoteRestoreDatabase(target);
  let stage = 'prepare'; let directory: string | undefined; let targetCreated = false;
  const started = Date.now();
  const pool = (database: string) => new Pool({ ...connection, database, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 180_000, idle_in_transaction_session_timeout: 240_000 });
  try {
    stage = 'operator privilege check';
    const operatorCheck = new Pool({ ...operator, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    try {
      const rights = (await operatorCheck.query<{ allowed: boolean }>('SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname=current_user')).rows[0];
      if (!rights?.allowed) throw new Error('An operator with database creation permission is required.');
    } finally { await operatorCheck.end(); }
    directory = await privateArtifacts();
    const dump = join(directory, 'database.dump');
    stage = 'source snapshot';
    const sourcePool = pool(connection.database); let sourceClient: PoolClient | undefined;
    let source: BackupFingerprint;
    try {
      sourceClient = await sourcePool.connect();
      await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = (await sourceClient.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')).rows[0]!.snapshot;
      source = await fingerprint(sourceClient);
      stage = 'dump';
      await pgTool('pg_dump', connection, ['--dbname', connection.database, '--format=custom', '--no-owner', '--no-privileges',
        '--snapshot', snapshot, '--file', dump], true);
      await sourceClient.query('COMMIT');
    } finally { sourceClient?.release(); await sourcePool.end(); }
    stage = 'create isolated database';
    const control = new Pool({ ...operator, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
    try { await control.query(`CREATE DATABASE ${targetSql} OWNER ${identifier(connection.user)} TEMPLATE template0`); targetCreated = true; }
    finally { await control.end(); }
    stage = 'restore'; const restoreStarted = Date.now();
    await pgTool('pg_restore', connection, ['--dbname', target, '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', dump], false);
    const restoreMs = Date.now() - restoreStarted;
    stage = 'verify restored data';
    const restoredPool = pool(target); let restoredClient: PoolClient | undefined;
    try {
      restoredClient = await restoredPool.connect();
      await restoredClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      assertSameBackup(source, await fingerprint(restoredClient));
      await restoredClient.query('COMMIT');
    } finally { restoredClient?.release(); await restoredPool.end(); }
    const report = { status: 'verified', source: connection.database, restoredDatabase: target, createdAt: new Date().toISOString(),
      dumpSha256: await fileDigest(dump), restoreMs, totalMs: Date.now() - started,
      tables: Object.keys(source.tables).length, rows: Object.values(source.tables).reduce((sum, table) => sum + table.rows, 0),
      migrations: source.migrations.length, fingerprint: source };
    await writeFile(join(directory, 'verification.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return { status: report.status, directory, restoredDatabase: target, tables: report.tables, rows: report.rows,
      migrations: report.migrations, restoreMs, totalMs: report.totalMs };
  } catch {
    // SQL and native errors may embed data. Retain artifacts/isolated DB for investigation without cleanup.
    throw new Error(`Backup rehearsal failed at ${stage}. Artifacts: ${directory ?? 'not created'}. Isolated database: ${targetCreated ? target : 'not created'}. Existing databases were not overwritten.`);
  }
}
