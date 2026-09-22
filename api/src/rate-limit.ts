import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Database } from './database';
import { ApiError, ApiRequest, cookie, hashToken } from './common';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private lastCleanup = 0;
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const res = context.switchToHttp().getResponse();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    // Express may route mixed case and trailing slashes to the same handler. Share its canonical bucket.
    const matchedPath: unknown = req.route?.path;
    const path = (typeof matchedPath === 'string' ? matchedPath : req.path).toLowerCase().replace(/\/+$/, '');
    const mail = /\/(register|forgot-password|resend-verification)$/.test(path);
    const credentials = /\/(login|reset-password|verify-email|refresh)$/.test(path);
    const connection = req.method === 'POST' && /\/(enrollments|parent-connections)$/.test(path);
    const invitationMail = req.method === 'POST' && /\/temporary-students(?:\/:id\/resend)?$/.test(path);
    const invitationPublic = req.method === 'POST' && /\/invitations\/(preview|activate)$/.test(path);
    const limit = mail || invitationMail ? 20 : credentials ? 60 : connection || invitationPublic ? 30 : 180;
    const seconds = mail || invitationMail ? 3600 : credentials || connection || invitationPublic ? 900 : 60;
    const bucketPath = invitationMail ? 'invitation-mail' : path;
    const allowed = await this.take(`ip:${ip}:${connection ? 'connection-create:' : ''}${bucketPath}`, limit, seconds);
    let accountAllowed = true;
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : undefined;
    if (email && (mail || path.endsWith('/login'))) accountAllowed = await this.take(`account:${email}:${path}`, mail ? 5 : 10, seconds);
    if (connection || invitationMail) {
      // Global guards precede SessionGuard. Resolve the account from its valid access
      // cookie here; caller-controlled X-Account-ID must never choose a rate bucket.
      const token = cookie(req, 'er_access');
      if (token) {
        const account = await this.db.query<{ user_id: string }>(`SELECT s.user_id FROM access_tokens a
          JOIN sessions s ON s.id=a.session_id JOIN users u ON u.id=s.user_id
          WHERE a.token_hash=$1 AND a.expires_at>now() AND s.expires_at>now() AND s.revoked_at IS NULL AND u.status='active'`, [hashToken(token)]);
        if (account.rows[0]) accountAllowed = await this.take(`${invitationMail ? 'invitation-mail' : 'connection'}:${account.rows[0].user_id}:${bucketPath}`, 15, seconds);
      }
    }
    if (Date.now() - this.lastCleanup > 60000) {
      this.lastCleanup = Date.now();
      await this.db.query("DELETE FROM rate_limits WHERE expires_at < now() - interval '1 hour'");
    }
    if (!allowed || !accountAllowed) {
      res.setHeader('Retry-After', String(seconds));
      throw new ApiError(429, 'rate_limited', 'Слишком много запросов. Попробуйте позже.');
    }
    return true;
  }
  private async take(key: string, limit: number, seconds: number): Promise<boolean> {
    const result = await this.db.query<{ hits: number }>(`INSERT INTO rate_limits(bucket_hash,hits,expires_at)
      VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(bucket_hash) DO UPDATE
      SET hits=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.hits+1 END,
          expires_at=CASE WHEN rate_limits.expires_at<=now() THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING hits`,
    [hashToken(key), seconds]);
    return result.rows[0]!.hits <= limit;
  }
}
