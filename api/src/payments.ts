import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, ApiRequest, Role, audit, lockActiveSession } from './common';
import { Database } from './database';
import { ConnectionPageDto } from './connections.dto';
import { CancelPaymentDto, CreatePaymentRecordDto, MarkPaymentDto, PaymentHistoryPage, PaymentHistoryView, PaymentQueryDto, PaymentRecordPage, PaymentRecordView } from './payments.dto';

const unavailable = () => new ApiError(404, 'not_found', 'Запись об оплате или запись на предмет недоступны.');
const tables = { teacher: 'teacher_profiles', student: 'student_profiles', parent: 'parent_profiles' } as const;
type PaymentRow = { id: string; enrollment_id: string; paid: boolean; cancelled: boolean; paid_marked_at: Date | null; version: number };
const joins = `FROM payment_records p JOIN enrollments e ON e.id=p.enrollment_id
  JOIN student_profiles s ON s.id=p.student_id JOIN users su ON su.id=s.user_id
  JOIN teacher_profiles t ON t.id=p.teacher_id JOIN users tu ON tu.id=t.user_id
  JOIN subjects subject ON subject.id=e.subject_id`;
// Explicit projection is shared by mutations and every role. Private events never enter it.
const projection = `jsonb_strip_nulls(jsonb_build_object('id',p.id,'enrollmentId',p.enrollment_id,
  'studentName',su.name,'studentPublicId',s.public_id,'teacherName',tu.name,'subjectName',subject.name,
  'title',p.title,'amountMinor',p.amount_minor,'currency',p.currency,'paid',p.paid,'cancelled',p.cancelled,
  'version',p.version,'paidMarkedAt',p.paid_marked_at,'createdAt',p.created_at,'updatedAt',p.updated_at))`;

@Injectable()
export class PaymentsService {
  constructor(private readonly db: Database) {}

  private async profile(userId: string, role: Role, client?: PoolClient): Promise<string> {
    const sql = `SELECT p.id FROM ${tables[role]} p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`;
    const result = client ? await client.query<{ id: string }>(sql, [userId]) : await this.db.query<{ id: string }>(sql, [userId]);
    if (!result.rows[0]) throw new ApiError(403, 'role_required', 'Выберите доступную роль аккаунта.');
    return result.rows[0].id;
  }

  async list(userId: string, query: PaymentQueryDto): Promise<PaymentRecordPage> {
    const profileId = await this.profile(userId, query.role);
    const predicate = query.role === 'teacher' ? 'p.teacher_id=$1'
      : query.role === 'student' ? 'p.student_id=$1 AND e.accepted_at IS NOT NULL'
        : `e.status='active' AND su.status='active' AND EXISTS(SELECT 1 FROM parent_connections pc
          WHERE pc.parent_id=$1 AND pc.student_id=p.student_id AND pc.status='active')`;
    // Scope, family consent, totals and page rows use the same statement snapshot.
    const result = await this.db.query<{ items: PaymentRecordView[]; total: number }>(`WITH visible AS (
      SELECT p.id,p.created_at,${projection} AS item ${joins} WHERE ${predicate}
      AND ($2::uuid IS NULL OR p.enrollment_id=$2)
      AND ($3::text IS NULL OR ($3='cancelled' AND p.cancelled) OR ($3='paid' AND p.paid AND NOT p.cancelled)
        OR ($3='unpaid' AND NOT p.paid AND NOT p.cancelled))
    ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC) FROM
      (SELECT * FROM visible ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [profileId, query.enrollmentId ?? null, query.status ?? null, query.limit, query.offset]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }

  private async view(client: PoolClient, teacherId: string, id: string): Promise<PaymentRecordView> {
    const result = await client.query<{ item: PaymentRecordView }>(`SELECT ${projection} AS item ${joins} WHERE p.id=$1 AND p.teacher_id=$2`, [id, teacherId]);
    if (!result.rows[0]) throw unavailable(); return result.rows[0].item;
  }

  /** Match the existing writer order: actor user -> student profile -> enrollment -> record. */
  private async lockEnrollment(client: PoolClient, teacherId: string, enrollmentId: string, requireActive: boolean) {
    const candidate = await client.query<{ student_id: string }>('SELECT student_id FROM enrollments WHERE id=$1 AND teacher_id=$2', [enrollmentId, teacherId]);
    if (!candidate.rows[0]) throw unavailable(); const studentId = candidate.rows[0].student_id;
    const student = await client.query<{ status: string }>('SELECT u.status FROM student_profiles s JOIN users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE OF s', [studentId]);
    const enrollment = await client.query<{ status: string; accepted_at: Date | null }>('SELECT status,accepted_at FROM enrollments WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [enrollmentId, teacherId]);
    if (!enrollment.rows[0]?.accepted_at) throw unavailable();
    if (requireActive && (enrollment.rows[0].status !== 'active' || student.rows[0]?.status !== 'active')) {
      throw new ApiError(409, 'enrollment_inactive', 'Новую запись можно добавить только при активном обучении и активном аккаунте ученика.');
    }
    return studentId;
  }

  private async lockRecord(client: PoolClient, teacherId: string, id: string, version: number) {
    const candidate = await client.query<{ enrollment_id: string }>('SELECT enrollment_id FROM payment_records WHERE id=$1 AND teacher_id=$2', [id, teacherId]);
    if (!candidate.rows[0]) throw unavailable(); await this.lockEnrollment(client, teacherId, candidate.rows[0].enrollment_id, false);
    const row = (await client.query<PaymentRow>('SELECT id,enrollment_id,paid,cancelled,paid_marked_at,version FROM payment_records WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [id, teacherId])).rows[0];
    if (!row) throw unavailable();
    if (row.version !== version) throw new ApiError(409, 'stale_version', 'Статус уже изменился. Обновите журнал и повторите действие.');
    return row;
  }

  private async event(client: PoolClient, actorId: string, id: string, type: PaymentHistoryView['type'], beforePaid: boolean | null, afterPaid: boolean, reason?: string, previousPaidMarkedAt?: Date | null) {
    await client.query(`INSERT INTO payment_record_history(id,payment_record_id,actor_user_id,type,before_paid,after_paid,reason,previous_paid_marked_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), id, actorId, type, beforePaid, afterPaid, reason ?? null, previousPaidMarkedAt ?? null]);
    await audit(client, actorId, `payment_record.${type}`, id);
  }

  async create(req: ApiRequest, dto: CreatePaymentRecordDto): Promise<PaymentRecordView> {
    if ((dto.amountMinor === undefined) !== (dto.currency === undefined)) throw new ApiError(400, 'validation_error', 'Укажите сумму и валюту вместе или оставьте оба поля пустыми.');
    const payload = JSON.stringify({ enrollmentId: dto.enrollmentId, title: dto.title, amountMinor: dto.amountMinor ?? null, currency: dto.currency ?? null });
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const existing = (await client.query<{ id: string; same: boolean }>('SELECT id,request_payload=$3::jsonb AS same FROM payment_records WHERE teacher_id=$1 AND request_id=$2', [teacherId, dto.requestId, payload])).rows[0];
      if (existing) {
        if (!existing.same) throw new ApiError(409, 'request_id_conflict', 'Этот запрос уже использован для другой записи.');
        return this.view(client, teacherId, existing.id);
      }
      const studentId = await this.lockEnrollment(client, teacherId, dto.enrollmentId, true); const id = randomUUID();
      await client.query(`INSERT INTO payment_records(id,enrollment_id,teacher_id,student_id,request_id,request_payload,title,amount_minor,currency)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [id, dto.enrollmentId, teacherId, studentId, dto.requestId, payload, dto.title, dto.amountMinor ?? null, dto.currency ?? null]);
      await this.event(client, userId, id, 'created', null, false); return this.view(client, teacherId, id);
    });
  }

  async mark(req: ApiRequest, id: string, dto: MarkPaymentDto): Promise<PaymentRecordView> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const row = await this.lockRecord(client, teacherId, id, dto.version);
      if (row.cancelled) throw new ApiError(409, 'record_cancelled', 'Аннулированную запись нельзя изменить.');
      if (row.paid === dto.paid) return this.view(client, teacherId, id);
      if (!dto.paid && !dto.reason) throw new ApiError(400, 'correction_reason_required', 'Укажите причину снятия отметки об оплате.');
      await client.query(`UPDATE payment_records SET paid=$2,paid_marked_at=CASE WHEN $2 THEN clock_timestamp() END,
        version=version+1,updated_at=clock_timestamp() WHERE id=$1`, [id, dto.paid]);
      await this.event(client, userId, id, dto.paid ? 'marked_paid' : 'marked_unpaid', row.paid, dto.paid, dto.reason, row.paid_marked_at);
      return this.view(client, teacherId, id);
    });
  }

  async cancel(req: ApiRequest, id: string, dto: CancelPaymentDto): Promise<PaymentRecordView> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const row = await this.lockRecord(client, teacherId, id, dto.version);
      if (row.cancelled) return this.view(client, teacherId, id);
      if (row.paid) throw new ApiError(409, 'record_paid', 'Сначала исправьте отметку об оплате с указанием причины.');
      await client.query('UPDATE payment_records SET cancelled=true,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id]);
      await this.event(client, userId, id, 'cancelled', false, false, dto.reason); return this.view(client, teacherId, id);
    });
  }

  async history(userId: string, id: string, query: ConnectionPageDto): Promise<PaymentHistoryPage> {
    const teacherId = await this.profile(userId, 'teacher');
    const result = await this.db.query<{ owned: boolean; items: PaymentHistoryView[]; total: number }>(`WITH owned AS (
      SELECT id FROM payment_records WHERE id=$1 AND teacher_id=$2
    ), visible AS (SELECT h.*,u.name AS actor_name FROM payment_record_history h JOIN owned ON owned.id=h.payment_record_id JOIN users u ON u.id=h.actor_user_id)
    SELECT EXISTS(SELECT 1 FROM owned) AS owned,
      COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',id,'type',type,'occurredAt',occurred_at,
        'actorName',actor_name,'beforePaid',before_paid,'afterPaid',after_paid,'reason',reason,'previousPaidMarkedAt',previous_paid_marked_at)) ORDER BY occurred_at,id)
        FROM (SELECT * FROM visible ORDER BY occurred_at,id LIMIT $3 OFFSET $4) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [id, teacherId, query.limit, query.offset]);
    if (!result.rows[0]!.owned) throw unavailable();
    return { items: result.rows[0]!.items, total: result.rows[0]!.total, limit: query.limit, offset: query.offset };
  }
}
