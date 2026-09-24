import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import type { Server } from 'node:http';
import { createWebMiddleware } from '../src/web';
import { readConfig } from '../src/config';

describe('exported frontend on the API origin', () => {
  let directory: string;
  let server: Server;
  let base: string;
  const inlineScript = 'self.__next_f.push([1,"local preview"]);';
  const page = `<html><body>Account<script>${inlineScript}</script><script src="/_next/static/app.js"></script></body></html>`;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'e-repetitor-web-'));
    await mkdir(join(directory, 'account'));
    await mkdir(join(directory, '_next', 'static'), { recursive: true });
    await writeFile(join(directory, 'index.html'), page);
    await writeFile(join(directory, 'account', 'index.html'), page);
    await writeFile(join(directory, 'account', 'index.txt'), 'Flight payload');
    await writeFile(join(directory, '404.html'), '<html>Страница не найдена</html>');
    await writeFile(join(directory, '_next', 'static', 'app.js'), 'self.app = true;');
    await writeFile(join(directory, '.env'), 'PRIVATE_TEST_VALUE');
    // Even an accidentally exported API path must never shadow the actual API.
    await mkdir(join(directory, 'api', 'v1', 'health'), { recursive: true });
    await writeFile(join(directory, 'api', 'v1', 'health', 'index.html'), 'Wrong health');
    const app = express();
    app.use(helmet());
    app.use(await createWebMiddleware(directory, false));
    app.get('/api/v1/health', (_req, res) => { res.json({ status: 'ok' }); });
    app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
    server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (directory) {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.match(basename(directory), /^e-repetitor-web-/);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('serves direct account links, scripts, Flight data and HEAD from one origin', async () => {
    for (const path of ['/', '/account/', '/account/?from=email']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200); assert.equal(await response.text(), page);
      assert.match(response.headers.get('content-type')!, /text\/html/);
      assert.match(response.headers.get('cache-control')!, /no-cache|no-store/);
    }
    const redirect = await fetch(`${base}/account`, { redirect: 'manual' });
    assert.equal(redirect.status, 301); assert.equal(redirect.headers.get('location'), '/account/');
    assert.equal(await (await fetch(`${base}/account/index.txt`)).text(), 'Flight payload');
    const script = await fetch(`${base}/_next/static/app.js`);
    assert.equal(script.status, 200); assert.match(script.headers.get('content-type')!, /javascript/);
    const head = await fetch(`${base}/account/`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  });

  test('permits only build-time inline scripts in CSP without forcing local HTTPS', async () => {
    const response = await fetch(`${base}/account/`);
    const policy = response.headers.get('content-security-policy')!;
    const digest = createHash('sha256').update(inlineScript).digest('base64');
    assert.ok(policy.includes(`'sha256-${digest}'`));
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy.split('script-src ')[1]!.split(';')[0]!, /unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(policy, /upgrade-insecure-requests/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  test('leaves API routing and API errors untouched', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/v1/health`)).json(), { status: 'ok' });
    const unknown = await fetch(`${base}/api/v1/unknown`);
    assert.equal(unknown.status, 404); assert.deepEqual(await unknown.json(), { error: 'not_found' });
  });

  test('returns real 404s and does not expose dotfiles, traversal or write routes', async () => {
    for (const path of ['/unknown/', '/.env', '/%2eenv', '/..%5c.env', '/%2e%2e%2f.env', '/_next/static/missing.js']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path); assert.doesNotMatch(await response.text(), /PRIVATE_TEST_VALUE/);
    }
    const post = await fetch(`${base}/account/`, { method: 'POST' });
    assert.equal(post.status, 404); assert.doesNotMatch(await post.text(), /local preview/);
  });

  test('fails early on missing export and validates the opt-in flag', async () => {
    await assert.rejects(createWebMiddleware(join(directory, 'absent'), false), /local:build/);
    const env = { DATABASE_URL: 'postgresql://local:example@127.0.0.1/example' };
    assert.equal(readConfig(env).serveWeb, false);
    assert.equal(readConfig({ ...env, SERVE_WEB: 'true' }).serveWeb, true);
    assert.throws(() => readConfig({ ...env, SERVE_WEB: 'yes' }), /SERVE_WEB/);
  });
});
