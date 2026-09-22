import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true });

export const CONFIG = Symbol('CONFIG');
export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  webOrigin: string;
  production: boolean;
  notificationWorkerEnabled: boolean;
  smtp: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string };
}

function port(value: string | undefined, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid port configuration');
  return result;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const database = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const production = env.NODE_ENV === 'production';
  const web = new URL(env.WEB_ORIGIN ?? 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(web.protocol) || web.origin !== (env.WEB_ORIGIN ?? 'http://127.0.0.1:3000')) {
    throw new Error('WEB_ORIGIN must be an exact HTTP(S) origin without a path');
  }
  if (production && web.protocol !== 'https:') throw new Error('Production WEB_ORIGIN must use HTTPS');
  if (env.SMTP_SECURE !== undefined && !['true', 'false'].includes(env.SMTP_SECURE)) throw new Error('SMTP_SECURE must be true or false');
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error('Both SMTP credentials are required');
  if (production && (!env.SMTP_HOST || !env.MAIL_FROM)) throw new Error('Production SMTP configuration is required');
  if (env.NOTIFICATION_WORKER_ENABLED !== undefined && !['true', 'false'].includes(env.NOTIFICATION_WORKER_ENABLED)) throw new Error('NOTIFICATION_WORKER_ENABLED must be true or false');
  return {
    databaseUrl: env.DATABASE_URL, host: env.HOST ?? '127.0.0.1', port: port(env.PORT, 4000),
    webOrigin: web.origin, production, notificationWorkerEnabled: env.NOTIFICATION_WORKER_ENABLED === 'true' && env.NODE_ENV !== 'test',
    smtp: { host: env.SMTP_HOST ?? '127.0.0.1', port: port(env.SMTP_PORT, 1025), secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.MAIL_FROM ?? 'E-Repetitor <noreply@e-repetitor.local>' },
  };
}
