import { Inject, Injectable } from '@nestjs/common';
import { Algorithm, hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AccountsService } from './accounts';
import { ApiError, ApiRequest, audit, hashToken, lockActiveSession, newToken } from './common';
import { ConnectionPageDto } from './connections.dto';
import { Database } from './database';
import { ActivateInvitationDto, TemporaryStudentDto, TemporaryStudentPage, TemporaryStudentStatus } from './invitations.dto';
import { MAIL, MailDelivery } from './mail';

interface DraftRow { id: string; teacher_id: string; subject_id: string; email: string; status: TemporaryStudentStatus; current_invitation_id: string }
interface InvitationRow { id: string; status: 'pending' | 'accepted' | 'expired' | 'revoked'; expires_at: Date }
interface Delivery { id: string; email: string; token: string }
const unavailable = () => new ApiError(410, 'invitation_unavailable', 'Приглашение недействительно или срок его действия истёк. Обратитесь к преподавателю за новым.');
const notFound = () => new ApiError(404, 'not_found', 'Приглашение не найдено.');
const invalidState = () => new ApiError(409, 'invalid_transition', 'Приглашение уже обработано. Обновите список.');
const passwordOptions = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

@Injectable()
export class InvitationsService {
  constructor(private readonly db: Database, private readonly accounts: AccountsService, @Inject(MAIL) private readonly mail: MailDelivery) {}

  private async teacher(userId: string, client?: PoolClient): Promise<string> {
    const sql = 'SELECT id FROM teacher_profiles WHERE user_id=$1';
    const result = client ? await client.query<{ id: string }>(sql, [userId]) : await this.db.query<{ id: string }>(sql, [userId]);
    if (!result.rows[0]) throw new ApiError(403, 'teacher_required', 'Добавьте роль преподавателя.');
    return result.rows[0].id;
  }

  async list(userId: string, query: ConnectionPageDto): Promise<TemporaryStudentPage> {
    const teacherId = await this.teacher(userId);
    // Supplied name/email belong to this teacher's draft. Never join users by email.
    const result = await this.db.query<{ items: TemporaryStudentPage['items']; total: number }>(`WITH visible AS (
      SELECT t.created_at,t.id,jsonb_strip_nulls(jsonb_build_object(
        'id',t.id,'name',t.name,'email',t.email,'subjectName',s.name,
        'status',CASE WHEN t.status='pending' AND i.expires_at<=statement_timestamp() THEN 'expired' ELSE t.status END,
        'studentPublicId',p.public_id,'createdAt',t.created_at,
        'invitation',jsonb_build_object('id',i.id,
          'status',CASE WHEN i.status='pending' AND i.expires_at<=statement_timestamp() THEN 'expired' ELSE i.status END,
          'expiresAt',i.expires_at,'deliveryStatus',i.delivery_status,'deliveryAttempts',i.delivery_attempts))) AS item
      FROM temporary_students t JOIN subjects s ON s.id=t.subject_id
      JOIN invitations i ON i.id=t.current_invitation_id LEFT JOIN student_profiles p ON p.id=t.student_id
      WHERE t.teacher_id=$1
    ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY created_at,id) FROM
      (SELECT * FROM visible ORDER BY created_at,id LIMIT $2 OFFSET $3) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [teacherId, query.limit, query.offset]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }

  async create(req: ApiRequest, dto: TemporaryStudentDto) {
    const result = await this.db.transaction(async client => {
      const actor = await lockActiveSession(client, req);
      const teacherId = await this.teacher(actor, client);
      const subject = await client.query('SELECT id FROM subjects WHERE id=$1 AND teacher_id=$2', [dto.subjectId, teacherId]);
      if (!subject.rows[0]) throw notFound();
      const existing = (await client.query<DraftRow>(`SELECT * FROM temporary_students
        WHERE teacher_id=$1 AND email=$2 AND subject_id=$3 AND status IN ('pending','activated') FOR UPDATE`, [teacherId, dto.email, dto.subjectId])).rows[0];
      if (existing?.status === 'activated') throw new ApiError(409, 'temporary_student_activated', 'Ученик уже активировал приглашение. Используйте его Student ID.');
      if (existing && !await this.expire(client, existing)) return { id: existing.id, status: 'pending' as const };
      if (!await this.allowRecipient(client, dto.email)) return { error: new ApiError(429, 'rate_limited', 'Слишком много приглашений на этот адрес. Попробуйте позже.') };
      const id = randomUUID(); const invitationId = randomUUID(); const token = newToken();
      await client.query(`INSERT INTO temporary_students(id,teacher_id,subject_id,name,email,current_invitation_id)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, teacherId, dto.subjectId, dto.name, dto.email, invitationId]);
      await client.query('INSERT INTO invitations(id,temporary_student_id,token_hash) VALUES($1,$2,$3)', [invitationId, id, hashToken(token)]);
      await audit(client, actor, 'temporary_student.created', id);
      await audit(client, actor, 'invitation.created', invitationId);
      return { id, status: 'pending' as const, delivery: { id: invitationId, email: dto.email, token } };
    });
    if ('error' in result) throw result.error;
    if ('delivery' in result && result.delivery) this.deliver(result.delivery);
    return { id: result.id, status: result.status };
  }

  async resend(req: ApiRequest, id: string) {
    const result = await this.db.transaction(async client => {
      const actor = await lockActiveSession(client, req);
      const teacherId = await this.teacher(actor, client);
      const draft = await this.lockDraft(client, id, teacherId);
      if (!['pending','expired'].includes(draft.status)) throw invalidState();
      await this.expire(client, draft);
      const latest = (await client.query<{ recent: boolean }>('SELECT created_at>clock_timestamp()-interval \'60 seconds\' AS recent FROM invitations WHERE id=$1 FOR UPDATE', [draft.current_invitation_id])).rows[0]!;
      if (latest.recent) return { error: new ApiError(409, 'invitation_resend_too_soon', 'Повторная отправка доступна через минуту после предыдущей.') };
      const other = await client.query(`SELECT id FROM temporary_students WHERE teacher_id=$1 AND email=$2 AND subject_id=$3
        AND id<>$4 AND status IN ('pending','activated')`, [teacherId, draft.email, draft.subject_id, id]);
      if (other.rows[0]) return { error: new ApiError(409, 'invitation_already_exists', 'Для ученика уже есть другое приглашение. Обновите список.') };
      if (!await this.allowRecipient(client, draft.email)) return { error: new ApiError(429, 'rate_limited', 'Слишком много приглашений на этот адрес. Попробуйте позже.') };
      await client.query("UPDATE invitations SET status='revoked' WHERE id=$1 AND status='pending'", [draft.current_invitation_id]);
      const invitationId = randomUUID(); const token = newToken();
      await client.query('INSERT INTO invitations(id,temporary_student_id,token_hash) VALUES($1,$2,$3)', [invitationId, id, hashToken(token)]);
      await client.query("UPDATE temporary_students SET current_invitation_id=$2,status='pending',updated_at=clock_timestamp() WHERE id=$1", [id, invitationId]);
      await audit(client, actor, 'invitation.replaced', draft.current_invitation_id);
      await audit(client, actor, 'invitation.created', invitationId);
      return { delivery: { id: invitationId, email: draft.email, token } };
    });
    if ('error' in result) throw result.error;
    this.deliver(result.delivery);
    return { id, status: 'pending' as const };
  }

  async revoke(req: ApiRequest, id: string) {
    const result = await this.db.transaction(async client => {
      const actor = await lockActiveSession(client, req);
      const teacherId = await this.teacher(actor, client);
      const draft = await this.lockDraft(client, id, teacherId);
      if (draft.status === 'revoked') return { id, status: 'revoked' as const };
      if (draft.status === 'activated') throw invalidState();
      if (draft.status === 'expired' || await this.expire(client, draft)) return { error: invalidState() };
      await client.query("UPDATE invitations SET status='revoked' WHERE id=$1 AND status='pending'", [draft.current_invitation_id]);
      await client.query("UPDATE temporary_students SET status='revoked',updated_at=clock_timestamp() WHERE id=$1", [id]);
      await audit(client, actor, 'invitation.revoked', draft.current_invitation_id);
      return { id, status: 'revoked' as const };
    });
    if ('error' in result) throw result.error;
    return result;
  }

  async preview(token: string) {
    const result = await this.db.query<{ teacherName: string; subjectName: string; expiresAt: Date }>(`SELECT u.name AS "teacherName",s.name AS "subjectName",i.expires_at AS "expiresAt"
      FROM invitations i JOIN temporary_students t ON t.id=i.temporary_student_id AND t.current_invitation_id=i.id
      JOIN teacher_profiles p ON p.id=t.teacher_id JOIN users u ON u.id=p.user_id JOIN subjects s ON s.id=t.subject_id
      WHERE i.token_hash=$1 AND i.status='pending' AND i.expires_at>statement_timestamp() AND t.status='pending' AND u.status='active'`, [hashToken(token)]);
    if (!result.rows[0]) throw unavailable();
    return result.rows[0];
  }

  async activate(dto: ActivateInvitationDto) {
    // Cheap token lookup before hashing; valid tokens still serialize and re-check after Argon2.
    const reference = (await this.db.query<{ id: string; temporary_student_id: string; teacher_user_id: string }>(`SELECT i.id,i.temporary_student_id,p.user_id AS teacher_user_id
      FROM invitations i JOIN temporary_students t ON t.id=i.temporary_student_id JOIN teacher_profiles p ON p.id=t.teacher_id
      WHERE i.token_hash=$1`, [hashToken(dto.token)])).rows[0];
    if (!reference) throw unavailable();
    const passwordHash = await hash(dto.password, passwordOptions);
    const failure = await this.db.transaction(async client => {
      // Every command, including public activation, uses teacher user -> draft -> invitation.
      // No existing recipient user is locked or modified. This also serializes with suspension.
      const teacher = (await client.query<{ status: string }>('SELECT status FROM users WHERE id=$1 FOR UPDATE', [reference.teacher_user_id])).rows[0];
      if (teacher?.status !== 'active') return unavailable();
      const draft = (await client.query<DraftRow>('SELECT * FROM temporary_students WHERE id=$1 FOR UPDATE', [reference.temporary_student_id])).rows[0];
      if (!draft || draft.status !== 'pending' || draft.current_invitation_id !== reference.id) return unavailable();
      const invitation = (await client.query<InvitationRow>('SELECT id,status,expires_at FROM invitations WHERE id=$1 FOR UPDATE', [reference.id])).rows[0];
      if (!invitation || invitation.status !== 'pending') return unavailable();
      if (await this.expire(client, draft)) return unavailable();
      const userId = randomUUID();
      await client.query('SAVEPOINT new_recipient');
      const inserted = await client.query(`INSERT INTO users(id,name,email,password_hash,status,terms_version,privacy_version)
        VALUES($1,$2,$3,$4,'active','local-preview-v1','local-preview-v1') ON CONFLICT(email) DO NOTHING RETURNING id`, [userId, dto.name, draft.email, passwordHash]);
      // A concurrent registration can make the unique-email insert wait. Do not
      // activate after expiry, and do not leave a user created by a now-expired link.
      const stillValid = (await client.query<{ valid: boolean }>('SELECT expires_at>clock_timestamp() AS valid FROM invitations WHERE id=$1', [reference.id])).rows[0]!.valid;
      if (!stillValid) {
        await client.query('ROLLBACK TO SAVEPOINT new_recipient');
        await this.expire(client, draft);
        return unavailable();
      }
      if (!inserted.rows[0]) return new ApiError(409, 'account_exists', 'На email из приглашения уже есть аккаунт. Войдите в него и передайте преподавателю свой Student ID. Объединение аккаунтов автоматически не выполняется.');
      await this.accounts.createProfile(client, userId, 'student');
      const student = (await client.query<{ id: string }>('SELECT id FROM student_profiles WHERE user_id=$1', [userId])).rows[0]!;
      const enrollmentId = randomUUID();
      await client.query(`INSERT INTO enrollments(id,teacher_id,student_id,subject_id,status,accepted_at,accepted_by)
        VALUES($1,$2,$3,$4,'active',clock_timestamp(),$5)`, [enrollmentId, draft.teacher_id, student.id, draft.subject_id, userId]);
      const consumed = await client.query(`UPDATE invitations SET status='accepted',accepted_at=clock_timestamp(),accepted_by=$2
        WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp() RETURNING id`, [reference.id, userId]);
      if (!consumed.rows[0]) {
        await client.query('ROLLBACK TO SAVEPOINT new_recipient');
        await this.expire(client, draft);
        return unavailable();
      }
      await client.query('RELEASE SAVEPOINT new_recipient');
      await client.query("UPDATE temporary_students SET status='activated',student_id=$2,activated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [draft.id, student.id]);
      await audit(client, userId, 'account.activated_from_invitation');
      await audit(client, userId, 'email.verified');
      await audit(client, userId, 'invitation.accepted', reference.id);
      await audit(client, userId, 'enrollment.invitation.active', enrollmentId);
      return undefined;
    });
    if (failure) throw failure;
    return { message: 'Аккаунт ученика создан, подключение к преподавателю подтверждено. Войдите с email, на который получили приглашение, и вашим новым паролем.' };
  }

  private async lockDraft(client: PoolClient, id: string, teacherId: string): Promise<DraftRow> {
    const row = (await client.query<DraftRow>('SELECT * FROM temporary_students WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [id, teacherId])).rows[0];
    if (!row) throw notFound();
    return row;
  }
  private async allowRecipient(client: PoolClient, email: string): Promise<boolean> {
    // Same bucket for all teachers and resend. This only limits actual mail commands;
    // it never checks whether the supplied recipient has an account.
    const result = await client.query<{ hits: number }>(`INSERT INTO rate_limits(bucket_hash,hits,expires_at)
      VALUES($1,1,clock_timestamp()+interval '1 hour') ON CONFLICT(bucket_hash) DO UPDATE
      SET hits=CASE WHEN rate_limits.expires_at<=clock_timestamp() THEN 1 ELSE rate_limits.hits+1 END,
          expires_at=CASE WHEN rate_limits.expires_at<=clock_timestamp() THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING hits`, [hashToken(`invitation-recipient:${email}`)]);
    return result.rows[0]!.hits<=5;
  }
  private async expire(client: PoolClient, draft: DraftRow): Promise<boolean> {
    const expired = await client.query(`UPDATE invitations SET status='expired' WHERE id=$1 AND status='pending'
      AND expires_at<=clock_timestamp() RETURNING id`, [draft.current_invitation_id]);
    if (!expired.rows[0]) return false;
    await client.query("UPDATE temporary_students SET status='expired',updated_at=clock_timestamp() WHERE id=$1 AND status='pending'", [draft.id]);
    await client.query("INSERT INTO audit_events(id,action,entity_id) VALUES($1,'invitation.expired',$2)", [randomUUID(), draft.current_invitation_id]);
    return true;
  }
  private deliver(message: Delivery): void {
    // Raw tokens live only in this bounded in-process delivery, never in a queue/database.
    // A crash can leave queued status; a teacher can rotate the link using resend.
    const delivery = this.sendTracked(message).catch(() => {
      console.error(JSON.stringify({ event: 'invitation_mail_tracking_failed' }));
    });
    this.db.trackBackground(delivery);
  }
  private async sendTracked(message: Delivery): Promise<void> {
    const claimed = await this.db.query(`UPDATE invitations SET delivery_attempts=1 WHERE id=$1
      AND delivery_attempts=0 RETURNING id`, [message.id]);
    if (!claimed.rows[0]) return;
    try {
      await this.mail.send({ email: message.email, token: message.token, purpose: 'invite' });
    } catch {
      await this.db.query("UPDATE invitations SET delivery_status='failed' WHERE id=$1", [message.id]);
      console.error(JSON.stringify({ event: 'invitation_mail_delivery_failed' }));
      return;
    }
    await this.db.query("UPDATE invitations SET delivery_status='sent',delivered_at=clock_timestamp() WHERE id=$1", [message.id]);
  }
}
