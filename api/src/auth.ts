import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Database } from './database';
import { AccountsService } from './accounts';
import { ACCESS_SECONDS, Account, ApiError, ApiRequest, REFRESH_SECONDS, accountChanged, audit, cookie, hashToken, lockActiveSession, newToken, unauthenticated } from './common';
import { LoginDto, RegisterDto, ResetDto } from './dto';
import { MAIL, AccountMail, MailDelivery } from './mail';

const passwordOptions = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };
type UserRow = { id: string; email: string; password_hash: string; status: string };
export interface Credentials { access: string; refresh: string }
const invalidLink = () => new ApiError(400, 'invalid_token', 'Ссылка недействительна или срок её действия истёк. Запросите новую.');
const invalidLogin = () => new ApiError(401, 'invalid_credentials', 'Email или пароль не подходят, либо адрес ещё не подтверждён.');
export const mailMessage = { message: 'Запрос принят. Если адрес подходит для этого действия, ожидайте письмо. Проверьте входящие и спам; при необходимости запросите отправку ещё раз.' };

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private dummyHash = '';
  private readonly deliveries = new Set<Promise<void>>();
  constructor(private readonly db: Database, private readonly accounts: AccountsService, @Inject(MAIL) private readonly mail: MailDelivery) {}
  async onModuleInit() { this.dummyHash = await hash(newToken(), passwordOptions); }
  async onModuleDestroy() { await Promise.allSettled([...this.deliveries]); }
  async register(dto: RegisterDto) {
    // Always hash, including duplicate addresses, to keep the public response and work comparable.
    const passwordHash = await hash(dto.password, passwordOptions);
    const message = await this.db.transaction(async client => {
      const userId = randomUUID();
      const inserted = await client.query(`INSERT INTO users(id,name,email,password_hash,terms_version,privacy_version)
        VALUES($1,$2,$3,$4,'local-preview-v1','local-preview-v1') ON CONFLICT(email) DO NOTHING RETURNING id`,
      [userId, dto.name, dto.email, passwordHash]);
      if (!inserted.rows[0]) return undefined;
      await this.accounts.createProfile(client, userId, dto.role);
      const token = await this.issueAccountToken(client, userId, 'verify');
      await audit(client, userId, 'account.registered');
      return { email: dto.email, token, purpose: 'verify' as const };
    });
    if (message) this.deliver(message);
    return mailMessage;
  }

  async login(dto: LoginDto): Promise<{ credentials: Credentials; user: Account }> {
    const initial = (await this.db.query<UserRow>('SELECT id,email,password_hash,status FROM users WHERE email=$1', [dto.email])).rows[0];
    const matches = await verify(initial?.password_hash ?? this.dummyHash, dto.password);
    if (!initial || !matches) throw invalidLogin();
    return this.db.transaction(async client => {
      const user = (await client.query<UserRow>('SELECT id,email,password_hash,status FROM users WHERE id=$1 FOR UPDATE', [initial.id])).rows[0];
      // A reset may have occurred while Argon2 was running. Never issue a session for an old password.
      if (!user || user.status !== 'active' || user.password_hash !== initial.password_hash) throw invalidLogin();
      const sessionId = randomUUID();
      await client.query(`INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+$3*interval '1 second')`, [sessionId, user.id, REFRESH_SECONDS]);
      const credentials = await this.issueSessionTokens(client, sessionId);
      await audit(client, user.id, 'session.created', sessionId);
      return { credentials, user: await this.accounts.account(user.id, client) };
    });
  }

  async refresh(token: string | undefined): Promise<Credentials> {
    if (!token) throw unauthenticated();
    const tokenHash = hashToken(token);
    const result = await this.db.transaction(async client => {
      const reference = (await client.query<{ user_id: string; session_id: string }>(`SELECT s.user_id,t.session_id
        FROM refresh_tokens t JOIN sessions s ON s.id=t.session_id WHERE t.token_hash=$1`, [tokenHash])).rows[0];
      if (!reference) return undefined;
      // All session/account writes use user -> session/token lock order to avoid deadlocks.
      const user = (await client.query<UserRow>('SELECT id,status FROM users WHERE id=$1 FOR UPDATE', [reference.user_id])).rows[0];
      const current = (await client.query<{ used_at: Date | null; valid: boolean; revoked_at: Date | null }>(`SELECT t.used_at,
        (t.expires_at>now() AND s.expires_at>now()) AS valid,s.revoked_at FROM refresh_tokens t
        JOIN sessions s ON s.id=t.session_id WHERE t.token_hash=$1 FOR UPDATE OF s,t`, [tokenHash])).rows[0];
      if (!current || current.revoked_at) return undefined;
      if (current.used_at) {
        await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [reference.session_id]);
        await audit(client, reference.user_id, 'session.refresh_reuse', reference.session_id);
        // Return, then throw outside transaction so the revocation is committed.
        return undefined;
      }
      if (!current.valid || user?.status !== 'active') return undefined;
      await client.query('UPDATE refresh_tokens SET used_at=now() WHERE token_hash=$1', [tokenHash]);
      await client.query('DELETE FROM access_tokens WHERE session_id=$1', [reference.session_id]);
      return this.issueSessionTokens(client, reference.session_id);
    });
    if (!result) throw unauthenticated();
    return result;
  }

  async logout(req: ApiRequest) {
    const access = cookie(req, 'er_access'); const refresh = cookie(req, 'er_refresh');
    await this.db.transaction(async client => {
      const sessions = await client.query<{ id: string; user_id: string }>(`SELECT DISTINCT s.id,s.user_id FROM sessions s
        LEFT JOIN access_tokens a ON a.session_id=s.id LEFT JOIN refresh_tokens r ON r.session_id=s.id
        WHERE a.token_hash=$1 OR r.token_hash=$2 ORDER BY s.user_id,s.id`, [access ? hashToken(access) : null, refresh ? hashToken(refresh) : null]);
      const expectedUser = req.headers['x-account-id'];
      if (expectedUser !== undefined && sessions.rows.some(session => session.user_id !== expectedUser)) throw accountChanged();
      for (const session of sessions.rows) {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [session.user_id]);
        await client.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1', [session.id]);
        await audit(client, session.user_id, 'session.logged_out', session.id);
      }
    });
    return { message: 'Вы вышли из аккаунта.' };
  }
  async logoutAll(req: ApiRequest) {
    await this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
      await audit(client, userId, 'sessions.revoked');
    });
    return { message: 'Вы вышли на всех устройствах.' };
  }
  async verifyEmail(token: string) {
    await this.db.transaction(async client => {
      const user = await this.lockAccountToken(client, token, 'verify');
      if (user.status !== 'pending_verification') throw invalidLink();
      await client.query("UPDATE users SET status='active',status_version=status_version+1,updated_at=now() WHERE id=$1", [user.id]);
      await client.query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='verify' AND used_at IS NULL", [user.id]);
      await audit(client, user.id, 'email.verified');
    });
    return { message: 'Email подтверждён. Теперь можно войти.' };
  }
  async requestMail(email: string, purpose: 'verify' | 'reset') {
    const message = await this.db.transaction<AccountMail | undefined>(async client => {
      const user = (await client.query<UserRow>('SELECT id,email,status FROM users WHERE email=$1 FOR UPDATE', [email])).rows[0];
      if (!user || (purpose === 'verify' ? user.status !== 'pending_verification' : user.status !== 'active')) return undefined;
      const token = await this.issueAccountToken(client, user.id, purpose);
      await audit(client, user.id, purpose === 'verify' ? 'email.verification_requested' : 'password.reset_requested');
      return { email, purpose, token };
    });
    if (message) this.deliver(message);
    return mailMessage;
  }
  async resetPassword(dto: ResetDto) {
    const passwordHash = await hash(dto.password, passwordOptions);
    await this.db.transaction(async client => {
      const user = await this.lockAccountToken(client, dto.token, 'reset');
      if (user.status !== 'active') throw invalidLink();
      await client.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [passwordHash, user.id]);
      await client.query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='reset' AND used_at IS NULL", [user.id]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
      await audit(client, user.id, 'password.reset');
    });
    return { message: 'Пароль изменён. Войдите снова на ваших устройствах.' };
  }

  private async issueSessionTokens(client: PoolClient, sessionId: string): Promise<Credentials> {
    const credentials = { access: newToken(), refresh: newToken() };
    await client.query(`INSERT INTO access_tokens(token_hash,session_id,expires_at)
      SELECT $1,id,least(expires_at,now()+$3*interval '1 second') FROM sessions WHERE id=$2`, [hashToken(credentials.access), sessionId, ACCESS_SECONDS]);
    await client.query(`INSERT INTO refresh_tokens(token_hash,session_id,expires_at)
      SELECT $1,id,expires_at FROM sessions WHERE id=$2`, [hashToken(credentials.refresh), sessionId]);
    return credentials;
  }
  private deliver(message: AccountMail): void {
    // SMTP timing/failure must not disclose whether an address exists. Requests stay retryable via resend.
    // This milestone has no durable queue: a process interruption can require a new request.
    const delivery = this.mail.send(message).catch(() => {
      console.error(JSON.stringify({ event: 'account_mail_delivery_failed', purpose: message.purpose }));
    }).finally(() => this.deliveries.delete(delivery));
    this.deliveries.add(delivery);
  }
  private async issueAccountToken(client: PoolClient, userId: string, purpose: 'verify' | 'reset'): Promise<string> {
    const token = newToken();
    // Latest request wins. A failed delivery can always be retried using the resend endpoint.
    await client.query('UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL', [userId, purpose]);
    await client.query(`INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 second')`,
      [hashToken(token), userId, purpose, purpose === 'verify' ? 86400 : 1800]);
    return token;
  }
  private async lockAccountToken(client: PoolClient, token: string, purpose: 'verify' | 'reset'): Promise<UserRow> {
    const tokenHash = hashToken(token);
    const reference = (await client.query<{ user_id: string }>('SELECT user_id FROM account_tokens WHERE token_hash=$1 AND purpose=$2', [tokenHash, purpose])).rows[0];
    if (!reference) throw invalidLink();
    const user = (await client.query<UserRow>('SELECT id,email,status FROM users WHERE id=$1 FOR UPDATE', [reference.user_id])).rows[0];
    const current = await client.query(`SELECT token_hash FROM account_tokens
      WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE`, [tokenHash, purpose]);
    if (!user || !current.rows[0]) throw invalidLink();
    return user;
  }
}
