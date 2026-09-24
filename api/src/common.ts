import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { Database } from './database';

export type Role = 'teacher' | 'student' | 'parent';
export interface Account {
  id: string; name: string; email: string; status: string; roles: Role[]; isAdmin: boolean;
  profiles: { teacher?: { id: string; timezone: string; phone: string | null; birthDate: string | null }; student?: { id: string; publicId: string }; parent?: { id: string } };
}
export interface ApiRequest extends Request { requestId: string; userId?: string; sessionId?: string }
export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string) { super({ code, message }, status); }
}
export const unauthenticated = () => new ApiError(401, 'unauthenticated', 'Войдите в аккаунт.');
export const accountChanged = () => new ApiError(409, 'account_changed', 'Аккаунт изменился в другой вкладке. Обновите страницу перед действием.');
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const ACCESS_SECONDS = 15 * 60;
export const REFRESH_SECONDS = 30 * 24 * 60 * 60;

export function cookie(req: Request, name: string): string | undefined {
  const matches = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0]!.slice(name.length + 1);
  return tokenPattern.test(token) ? token : undefined;
}
export async function audit(client: PoolClient, userId: string, action: string, entityId = userId): Promise<void> {
  await client.query('INSERT INTO audit_events(id, actor_user_id, action, entity_id) VALUES($1,$2,$3,$4)', [randomUUID(), userId, action, entityId]);
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<ApiRequest>();
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500; let code = 'internal_error'; let message = 'Не удалось выполнить запрос. Попробуйте ещё раз.';
    if (error instanceof ApiError) {
      status = error.getStatus();
      const body = error.getResponse() as { code: string; message: string };
      code = body.code; message = body.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 400 ? 'validation_error' : status === 404 ? 'not_found' : 'request_error';
      message = status === 400 ? 'Проверьте формат и обязательные поля запроса.' : status === 404 ? 'Страница не найдена.' : 'Не удалось выполнить запрос.';
    } else if (typeof error === 'object' && error !== null && 'type' in error && 'status' in error) {
      if (error.type === 'entity.parse.failed' && error.status === 400) {
        status = 400; code = 'invalid_json'; message = 'Не удалось прочитать JSON запроса.';
      } else if (error.type === 'entity.too.large' && error.status === 413) {
        status = 413; code = 'payload_too_large'; message = 'Слишком большой запрос.';
      }
    }
    if (status >= 500) console.error(JSON.stringify({ event: 'request_failed', requestId: req.requestId, status }));
    res.status(status).json({ error: { code, message, request_id: req.requestId } });
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const access = cookie(req, 'er_access');
    if (!access) throw unauthenticated();
    const result = await this.db.query<{ user_id: string; id: string }>(`SELECT s.user_id, s.id FROM access_tokens a
      JOIN sessions s ON s.id = a.session_id JOIN users u ON u.id = s.user_id
      WHERE a.token_hash = $1 AND a.expires_at > now() AND s.expires_at > now()
        AND s.revoked_at IS NULL AND u.status = 'active'`, [hashToken(access)]);
    const session = result.rows[0];
    if (!session) throw unauthenticated();
    const expectedUser = req.headers['x-account-id'];
    if (expectedUser !== undefined && expectedUser !== session.user_id) throw accountChanged();
    req.userId = session.user_id; req.sessionId = session.id;
    return true;
  }
}

/** Re-check the guard's session under a user lock for mutations, including reset/logout races.
 * NO KEY UPDATE serializes account changes but permits recipient FK KEY SHARE
 * locks, avoiding the administrator/notification cross-user lock cycle.
 */
export async function lockActiveSession(client: PoolClient, req: ApiRequest): Promise<string> {
  if (!req.userId || !req.sessionId) throw unauthenticated();
  const result = await client.query<{ id: string }>(`SELECT u.id FROM users u
    WHERE u.id = $1 AND u.status = 'active' FOR NO KEY UPDATE`, [req.userId]);
  if (!result.rows[0]) throw unauthenticated();
  const session = await client.query(`SELECT id FROM sessions WHERE id=$1 AND user_id=$2
    AND revoked_at IS NULL AND expires_at > now()`, [req.sessionId, req.userId]);
  if (!session.rows[0]) throw unauthenticated();
  return req.userId;
}
