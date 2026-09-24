import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_ORIGIN = 'http://127.0.0.1:3100';
const exportedPages = ['index.html', 'account/index.html'];
const markerName = 'local-build.json';

function loopbackHost(value, name) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value)) {
    throw new Error(`${name}: разрешён только локальный адрес 127.0.0.1, localhost или ::1.`);
  }
  return value === 'localhost' ? '127.0.0.1' : value.replace(/^\[|\]$/g, '');
}

function port(value, fallback, name) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1 || result > 65535) {
    throw new Error(`${name}: нужен порт от 1 до 65535.`);
  }
  return result;
}

export function localEnvironment(source) {
  let database;
  try { database = new URL(source.DATABASE_URL); } catch {
    throw new Error('Задайте DATABASE_URL в api/.env по примеру api/.env.example.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.pathname.slice(1)) {
    throw new Error('DATABASE_URL должен указывать на локальную базу PostgreSQL.');
  }
  // pg can use query parameters to override the URL host. This launcher accepts no overrides.
  if (database.search || database.hash) {
    throw new Error('Для локального запуска DATABASE_URL не должен содержать query-параметры или фрагмент.');
  }
  const databaseHost = loopbackHost(database.hostname, 'DATABASE_URL');
  if (database.hostname === 'localhost') database.hostname = databaseHost;
  const smtpHost = loopbackHost(source.SMTP_HOST ?? '127.0.0.1', 'SMTP_HOST');
  const smtpPort = port(source.SMTP_PORT, 1025, 'SMTP_PORT');
  return {
    ...source,
    DATABASE_URL: database.href,
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3100', WEB_ORIGIN: LOCAL_ORIGIN,
    SERVE_WEB: 'true', SMTP_HOST: smtpHost, SMTP_PORT: String(smtpPort),
  };
}

export function frontendEnvironment(source) {
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('NEXT_PUBLIC_')));
  return {
    ...environment, NODE_ENV: 'production', NEXT_LOCAL_BUILD: 'true',
    NEXT_PUBLIC_API_URL: '/api/v1', NEXT_PUBLIC_BASE_PATH: '', NEXT_PUBLIC_DEMO_ONLY: 'false',
  };
}

async function requireFile(path, message) {
  try { await access(path); } catch { throw new Error(message); }
}

async function loadRuntimeEnvironment() {
  const require = createRequire(join(projectRoot, 'api/package.json'));
  let parse;
  try { ({ parse } = require('dotenv')); } catch {
    throw new Error('Не установлены зависимости API. Выполните npm --prefix api ci --ignore-scripts.');
  }
  let values = {};
  try { values = parse(await readFile(join(projectRoot, 'api/.env'))); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Не удалось прочитать api/.env.');
  }
  return localEnvironment({ ...values, ...process.env });
}

async function pageHashes(webRoot) {
  return Object.fromEntries(await Promise.all(exportedPages.map(async page => {
    const contents = await readFile(join(webRoot, page));
    return [page, createHash('sha256').update(contents).digest('hex')];
  })));
}

export async function markLocalBuild(webRoot) {
  await writeFile(join(webRoot, markerName), `${JSON.stringify({
    version: 1, api: '/api/v1', origin: LOCAL_ORIGIN, pages: await pageHashes(webRoot),
  }, null, 2)}\n`);
}

export async function verifyLocalBuild(webRoot) {
  try {
    const marker = JSON.parse(await readFile(join(webRoot, markerName), 'utf8'));
    const actual = await pageHashes(webRoot);
    if (marker.version !== 1 || marker.api !== '/api/v1' || marker.origin !== LOCAL_ORIGIN ||
      exportedPages.some(page => marker.pages?.[page] !== actual[page])) throw new Error('Invalid marker');
    await access(join(webRoot, '_next/static'));
  } catch {
    throw new Error('Нет готовой локальной сборки или она изменилась. Выполните npm run local:build.');
  }
}

function checkConnection(host, servicePort, label) {
  return new Promise((resolveCheck, reject) => {
    const socket = createConnection({ host, port: servicePort });
    const failed = () => {
      socket.destroy();
      reject(new Error(`${label} недоступен локально. Запустите ./scripts/start-local-infra.ps1 (подготовленный Windows) или npm run infra:up (Docker). См. docs/LOCAL-RUN.md.`));
    };
    socket.setTimeout(2000, failed);
    socket.once('error', failed);
    socket.once('connect', () => { socket.destroy(); resolveCheck(); });
  });
}

async function checkInfrastructure(environment) {
  const database = new URL(environment.DATABASE_URL);
  await Promise.all([
    checkConnection(loopbackHost(database.hostname, 'DATABASE_URL'), port(database.port || undefined, 5432, 'DATABASE_URL'), 'PostgreSQL'),
    checkConnection(environment.SMTP_HOST, Number(environment.SMTP_PORT), 'SMTP/Mailpit'),
  ]);
  await new Promise((resolveCheck, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('Порт 3100 занят. Остановите предыдущий локальный запуск в его терминале (Ctrl+C).')));
    probe.listen({ host: '127.0.0.1', port: 3100, exclusive: true }, () => probe.close(resolveCheck));
  });
}

export async function main(mode = 'run') {
  if (!['run', 'build', 'start'].includes(mode)) throw new Error('Допустимые команды: npm run local, local:build, local:start.');
  const webRoot = join(projectRoot, '.local/web');
  const apiMain = join(projectRoot, 'api/dist/src/main.js');
  const runtime = mode === 'build' ? undefined : await loadRuntimeEnvironment();
  if (runtime) await checkInfrastructure(runtime);
  let activeChild;
  let stopped = false;
  const stop = () => {
    stopped = true;
    // Only the process created by this launcher is stopped; existing services stay running.
    activeChild?.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const execute = (entrypoint, args, cwd, environment) => new Promise((resolveChild, reject) => {
    if (stopped) { resolveChild(); return; }
    activeChild = spawn(process.execPath, [entrypoint, ...args], { cwd, env: environment, stdio: 'inherit', windowsHide: true });
    activeChild.once('error', () => reject(new Error('Не удалось запустить дочерний процесс Node.js.')));
    activeChild.once('exit', code => {
      activeChild = undefined;
      if (stopped || code === 0) resolveChild();
      else reject(new Error(`Команда завершилась с кодом ${code ?? 'signal'}. Проверьте сообщение выше.`));
    });
  });
  try {
    if (mode !== 'start') {
      const next = join(projectRoot, 'node_modules/next/dist/bin/next');
      const tsc = join(projectRoot, 'api/node_modules/typescript/bin/tsc');
      await requireFile(next, 'Выполните npm ci --ignore-scripts из корня проекта.');
      await requireFile(tsc, 'Выполните npm --prefix api ci --ignore-scripts.');
      console.log('Собираем сайт и API для единого локального адреса…');
      await execute(next, ['build'], projectRoot, frontendEnvironment(process.env));
      if (stopped) return;
      await execute(tsc, ['-p', 'tsconfig.json'], join(projectRoot, 'api'), process.env);
      if (stopped) return;
      await markLocalBuild(webRoot);
    }
    if (mode === 'build') { console.log('Локальная сборка готова. Запуск: npm run local:start.'); return; }
    await verifyLocalBuild(webRoot);
    await requireFile(apiMain, 'API не собран. Выполните npm run local:build.');
    console.log(`Запускаем ${LOCAL_ORIGIN}/. Дождитесь сообщения сервера. Остановка: Ctrl+C.`);
    console.log('Локальная почта: http://127.0.0.1:8025/. Миграции автоматически не выполняются.');
    await execute(apiMain, [], join(projectRoot, 'api'), runtime);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => {
    console.error(`Локальный запуск: ${error.message}`);
    process.exitCode = 1;
  });
}
