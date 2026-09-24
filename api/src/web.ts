import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Router, static as serveStatic } from 'express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

/** Read only the trusted export, never the source tree or environment files. */
async function scriptHashes(directory: string): Promise<string[]> {
  const hashes = new Set<string>();
  async function visit(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new Error('The web export must not contain symbolic links. Run npm run local:build.');
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        const html = await readFile(path, 'utf8');
        // Next's generated HTML contains inline hydration scripts. Hash their exact
        // bytes at startup so CSP permits the build without allowing arbitrary inline JS.
        for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
          if (match[1]) hashes.add(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
        }
      }
    }
  }
  await visit(directory);
  return [...hashes];
}

export async function createWebMiddleware(directory: string, production: boolean): Promise<RequestHandler> {
  try {
    for (const file of ['index.html', 'account/index.html', '404.html']) {
      if (!(await stat(join(directory, file))).isFile()) throw new Error('Missing page');
    }
    if (!(await stat(join(directory, '_next/static'))).isDirectory()) throw new Error('Missing assets');
  } catch {
    throw new Error('Web export is missing or incomplete. Run npm run local:build.');
  }
  const hashes = await scriptHashes(directory);
  const router = Router();
  router.use(helmet.contentSecurityPolicy({ directives: {
    'script-src': ["'self'", ...hashes],
    'connect-src': ["'self'"],
    'upgrade-insecure-requests': production ? [] : null,
  } }));
  router.use(serveStatic(directory, {
    dotfiles: 'ignore', index: 'index.html', redirect: true,
    setHeaders: response => { response.setHeader('Cache-Control', 'no-cache'); },
  }));
  router.use((_request, response) => {
    response.status(404).sendFile(join(directory, '404.html'), { headers: { 'Cache-Control': 'no-cache' } });
  });
  return (request, response, next) => {
    // API requests retain Nest's guards, error envelopes and routes, including 404s.
    if (/^\/api(?:\/|$)/i.test(request.path) || !['GET', 'HEAD'].includes(request.method)) {
      next(); return;
    }
    router(request, response, next);
  };
}
