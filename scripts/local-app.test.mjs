import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { frontendEnvironment, localEnvironment, markLocalBuild, verifyLocalBuild } from './local-app.mjs';

const localDatabase = 'postgresql://local:secret@127.0.0.1:55432/e_repetitor';

test('local runtime fixes the listener and origin even when shell contains deployment settings', () => {
  const actual = localEnvironment({ DATABASE_URL: localDatabase, NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '80', WEB_ORIGIN: 'https://example.com', SMTP_HOST: 'localhost' });
  assert.equal(actual.NODE_ENV, 'development');
  assert.equal(actual.HOST, '127.0.0.1');
  assert.equal(actual.PORT, '3100');
  assert.equal(actual.WEB_ORIGIN, 'http://127.0.0.1:3100');
  assert.equal(actual.SERVE_WEB, 'true');
  assert.equal(actual.SMTP_HOST, '127.0.0.1');
});

test('remote databases, URL routing overrides and remote SMTP are refused without leaking credentials', () => {
  for (const DATABASE_URL of [
    'postgresql://user:secret@database.example/db',
    `${localDatabase}?host=database.example`,
    'postgresql:///db?host=database.example',
    'not-a-url-with-secret',
    'https://127.0.0.1/db',
  ]) {
    assert.throws(() => localEnvironment({ DATABASE_URL }), error => !error.message.includes('secret'));
  }
  assert.throws(() => localEnvironment({ DATABASE_URL: localDatabase, SMTP_HOST: 'smtp.example.com' }), /SMTP_HOST/);
  assert.throws(() => localEnvironment({ DATABASE_URL: localDatabase, SMTP_PORT: '0' }), /SMTP_PORT/);
});

test('numeric IPv6 loopback works and localhost is pinned to numeric loopback', () => {
  assert.match(localEnvironment({ DATABASE_URL: 'postgresql://local@localhost/db' }).DATABASE_URL, /@127\.0\.0\.1/);
  assert.match(localEnvironment({ DATABASE_URL: 'postgresql://local@[::1]:55432/db', SMTP_HOST: '::1' }).DATABASE_URL, /\[::1\]/);
});

test('frontend always uses same-origin API and drops inherited public deployment settings', () => {
  const actual = frontendEnvironment({ PATH: 'system-path', NEXT_PUBLIC_API_URL: 'https://api.example', NEXT_PUBLIC_BASE_PATH: '/repo', NEXT_PUBLIC_DEMO_ONLY: 'true', NEXT_PUBLIC_OTHER: 'cloud-value' });
  assert.equal(actual.PATH, 'system-path');
  assert.equal(actual.NEXT_PUBLIC_API_URL, '/api/v1');
  assert.equal(actual.NEXT_PUBLIC_BASE_PATH, '');
  assert.equal(actual.NEXT_PUBLIC_DEMO_ONLY, 'false');
  assert.equal(actual.NEXT_PUBLIC_OTHER, undefined);
  assert.equal(actual.NEXT_LOCAL_BUILD, 'true');
});

test('start accepts a complete local export and rejects missing or replaced exported pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e-repetitor-local-build-'));
  try {
    await assert.rejects(verifyLocalBuild(root), /local:build/);
    await mkdir(join(root, 'account'), { recursive: true });
    await mkdir(join(root, '_next/static'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<h1>Account</h1>');
    await writeFile(join(root, 'account/index.html'), '<h1>Account</h1>');
    await markLocalBuild(root);
    await verifyLocalBuild(root);
    await writeFile(join(root, 'account/index.html'), '<h1>Replaced build</h1>');
    await assert.rejects(verifyLocalBuild(root), /local:build/);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(basename(root), /^e-repetitor-local-build-/);
    await rm(root, { recursive: true, force: true });
  }
});
