import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { assertInside, assertSameBackup, backupConnection, backupOperator, quoteRestoreDatabase, restoreDatabaseName, type BackupFingerprint } from '../src/backup';

test('backup accepts only explicitly selected local development source', () => {
  const parsed = backupConnection({ databaseUrl: 'postgresql://tester:fictional@127.0.0.1:55432/e_repetitor', production: false }, 'e_repetitor');
  assert.equal(parsed.database, 'e_repetitor'); assert.equal(parsed.port, 55432); assert.equal(parsed.host, '127.0.0.1');
  assert.equal(backupConnection({ databaseUrl: 'postgresql://tester:fictional@[::1]/e_repetitor', production: false }, 'e_repetitor').host, '::1');
});
test('backup refuses production, other databases and URI overrides before connecting', () => {
  const base = 'postgresql://tester:fictional@127.0.0.1:55432/e_repetitor';
  for (const databaseUrl of [base.replace('127.0.0.1', 'example.com'), `${base}?host=example.com`, `${base}#extra`,
    `${base}_test`, `${base}_restore_123`, base.replace('e_repetitor', 'postgres'), base.replace('postgresql:', 'https:')]) {
    assert.throws(() => backupConnection({ databaseUrl, production: false }, 'e_repetitor'));
  }
  assert.throws(() => backupConnection({ databaseUrl: base, production: true }, 'e_repetitor'));
  assert.throws(() => backupConnection({ databaseUrl: base, production: false }, 'other'));
});
test('restore destinations are generated fresh and cannot name an existing application or test database', () => {
  const first = restoreDatabaseName(); const second = restoreDatabaseName();
  assert.notEqual(first, second); assert.ok(first.length <= 63); assert.equal(quoteRestoreDatabase(first), `"${first}"`);
  for (const name of ['e_repetitor', 'e_repetitor_test', 'postgres', 'e_repetitor_restore_123', 'name"; DROP DATABASE e_repetitor;--']) {
    assert.throws(() => quoteRestoreDatabase(name));
  }
});
test('operator credentials cannot redirect restore to a different server or database', () => {
  const source = backupConnection({ databaseUrl: 'postgresql://tester:fictional@127.0.0.1:55432/e_repetitor', production: false }, 'e_repetitor');
  assert.equal(backupOperator(source).user, source.user);
  const operator = 'postgresql://postgres:fictional@127.0.0.1:55432/postgres';
  assert.equal(backupOperator(source, operator).database, 'postgres');
  for (const url of [operator.replace('127.0.0.1', 'example.com'), operator.replace('55432', '5432'), `${operator}?host=example.com`, `${operator}#extra`, operator.replace(/\/postgres$/, '/e_repetitor')]) {
    assert.throws(() => backupOperator(source, url));
  }
});
test('artifact paths cannot escape the verified project root', () => {
  const root = resolve('workspace'); assert.doesNotThrow(() => assertInside(root, resolve(root, '.local/backups/pilot-123')));
  for (const path of [root, resolve(root, '..'), resolve(root, '../workspace-copy/backup')]) assert.throws(() => assertInside(root, path));
});
test('restore verification rejects missing rows, changed content, schema and migration drift', () => {
  const source: BackupFingerprint = { schema: 'schema-hash', tables: { users: { rows: 3, sha256: 'data-hash' } }, migrations: [{ name: '001_accounts.sql', checksum: 'migration-hash' }] };
  assert.doesNotThrow(() => assertSameBackup(source, structuredClone(source)));
  for (const restored of [
    { ...source, tables: { users: { rows: 2, sha256: 'data-hash' } } },
    { ...source, tables: { users: { rows: 3, sha256: 'changed' } } },
    { ...source, tables: {} }, { ...source, schema: 'changed' }, { ...source, migrations: [] },
  ]) assert.throws(() => assertSameBackup(source, restored));
});
