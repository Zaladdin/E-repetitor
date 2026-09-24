import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, ApiRequest, Role, audit, lockActiveSession } from './common';
import { ConnectionPageDto } from './connections.dto';
import { Database } from './database';
import { ChargePackageDto, ClosePackageDto, CreatePackageDto, PackageHistoryPage, PackageHistoryView, PackageLessonPage, PackagePage, PackageQueryDto, PackageRoleQueryDto, PackageView, ReversePackageDto } from './packages.dto';

const unavailable = () => new ApiError(404, 'not_found', 'Пакет занятий или запись на предмет недоступны.');
const stale = () => new ApiError(409, 'stale_version', 'Данные уже изменились. Обновите пакет и повторите действие.');
const tables = { teacher: 'teacher_profiles', student: 'student_profiles', parent: 'parent_profiles' } as const;
const joins = `FROM lesson_packages k JOIN payment_records p ON p.id=k.id JOIN enrollments e ON e.id=p.enrollment_id
  JOIN student_profiles s ON s.id=p.student_id JOIN users su ON su.id=s.user_id
  JOIN teacher_profiles t ON t.id=p.teacher_id JOIN users tu ON tu.id=t.user_id
  JOIN subjects subject ON subject.id=e.subject_id`;
const projection = `jsonb_strip_nulls(jsonb_build_object('id',k.id,'enrollmentId',p.enrollment_id,
  'studentName',su.name,'studentPublicId',s.public_id,'teacherName',tu.name,'subjectName',subject.name,
  'title',p.title,'lessonCount',k.lesson_count,'balance',(SELECT COALESCE(sum(delta),0)::integer FROM lesson_package_ledger WHERE package_id=k.id),
  'paid',p.paid,'cancelled',p.cancelled,'closed',k.closed,'amountMinor',p.amount_minor,'currency',p.currency,
  'paidMarkedAt',p.paid_marked_at,'version',k.version,'paymentVersion',p.version,'createdAt',p.created_at))`;
type LockedPackage = { id: string; enrollment_id: string; closed: boolean; cancelled: boolean; version: number };
type LedgerChange = { type: PackageHistoryView['type']; delta: number; lessonId?: string; reversesEntryId?: string; reason?: string; requestId?: string; payload?: string };

@Injectable()
export class PackagesService {
  constructor(private readonly db: Database) {}

  private async profile(userId: string, role: Role, client?: PoolClient) {
    const sql = `SELECT p.id FROM ${tables[role]} p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`;
    const result = client ? await client.query<{ id: string }>(sql, [userId]) : await this.db.query<{ id: string }>(sql, [userId]);
    if (!result.rows[0]) throw new ApiError(403, 'role_required', 'Выберите доступную роль аккаунта.');
    return result.rows[0].id;
  }

  private scope(role: Role) {
    return role === 'teacher' ? 'p.teacher_id=$1' : role === 'student' ? 'p.student_id=$1 AND e.accepted_at IS NOT NULL'
      : `e.status='active' AND su.status='active' AND EXISTS(SELECT 1 FROM parent_connections pc
          WHERE pc.parent_id=$1 AND pc.student_id=p.student_id AND pc.status='active')`;
  }

  async list(userId: string, query: PackageQueryDto): Promise<PackagePage> {
    const profileId = await this.profile(userId, query.role);
    const result = await this.db.query<{ items: PackageView[]; total: number }>(`WITH visible AS (
      SELECT k.id,p.created_at,${projection} AS item ${joins} WHERE ${this.scope(query.role)}
      AND ($2::uuid IS NULL OR p.enrollment_id=$2)
    ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC) FROM
      (SELECT * FROM visible ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [profileId, query.enrollmentId ?? null, query.limit, query.offset]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }

  private async view(client: PoolClient, teacherId: string, id: string): Promise<PackageView> {
    const result = await client.query<{ item: PackageView }>(`SELECT ${projection} AS item ${joins} WHERE k.id=$1 AND p.teacher_id=$2`, [id, teacherId]);
    if (!result.rows[0]) throw unavailable();
    return result.rows[0].item;
  }

  /** Shared writer order: actor user -> student profile -> enrollment -> lesson -> package/payment. */
  private async lockEnrollment(client: PoolClient, teacherId: string, enrollmentId: string, requireActive: boolean) {
    const candidate = (await client.query<{ student_id: string }>('SELECT student_id FROM enrollments WHERE id=$1 AND teacher_id=$2', [enrollmentId, teacherId])).rows[0];
    if (!candidate) throw unavailable();
    const student = (await client.query<{ status: string }>('SELECT u.status FROM student_profiles s JOIN users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE OF s', [candidate.student_id])).rows[0];
    const enrollment = (await client.query<{ status: string; accepted_at: Date | null }>('SELECT status,accepted_at FROM enrollments WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [enrollmentId, teacherId])).rows[0];
    if (!enrollment?.accepted_at) throw unavailable();
    if (requireActive && (enrollment.status !== 'active' || student?.status !== 'active')) {
      throw new ApiError(409, 'enrollment_inactive', 'Новый пакет доступен только при активном обучении и активном аккаунте ученика.');
    }
    return candidate.student_id;
  }

  private async context(client: PoolClient, teacherId: string, id: string) {
    const candidate = (await client.query<{ enrollment_id: string }>(`SELECT p.enrollment_id FROM lesson_packages k
      JOIN payment_records p ON p.id=k.id WHERE k.id=$1 AND p.teacher_id=$2`, [id, teacherId])).rows[0];
    if (!candidate) throw unavailable();
    await this.lockEnrollment(client, teacherId, candidate.enrollment_id, false);
    return candidate.enrollment_id;
  }

  private async lockPackage(client: PoolClient, teacherId: string, id: string): Promise<LockedPackage> {
    const result = await client.query<LockedPackage>(`SELECT k.id,k.enrollment_id,k.closed,k.version,p.cancelled FROM lesson_packages k
      JOIN payment_records p ON p.id=k.id WHERE k.id=$1 AND p.teacher_id=$2 FOR UPDATE OF k,p`, [id, teacherId]);
    if (!result.rows[0]) throw unavailable();
    return result.rows[0];
  }

  private async balance(client: PoolClient, id: string): Promise<number> {
    return (await client.query<{ balance: number }>('SELECT COALESCE(sum(delta),0)::integer AS balance FROM lesson_package_ledger WHERE package_id=$1', [id])).rows[0]!.balance;
  }

  private async retry(client: PoolClient, actorId: string, requestId: string, payload: string) {
    const prior = (await client.query<{ same: boolean }>('SELECT request_payload=$3::jsonb AS same FROM lesson_package_ledger WHERE actor_user_id=$1 AND request_id=$2', [actorId, requestId, payload])).rows[0];
    if (prior && !prior.same) throw new ApiError(409, 'request_id_conflict', 'Этот запрос уже использован для другого движения пакета.');
    return Boolean(prior);
  }

  private async event(client: PoolClient, actorId: string, id: string, enrollmentId: string, change: LedgerChange) {
    await client.query(`INSERT INTO lesson_package_ledger(id,package_id,enrollment_id,actor_user_id,type,delta,
      lesson_id,reverses_entry_id,reason,request_id,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [randomUUID(), id, enrollmentId, actorId, change.type, change.delta, change.lessonId ?? null,
      change.reversesEntryId ?? null, change.reason ?? null, change.requestId ?? null, change.payload ?? null]);
    await audit(client, actorId, `lesson_package.${change.type}`, id);
  }

  async create(req: ApiRequest, dto: CreatePackageDto): Promise<PackageView> {
    const payload = JSON.stringify({ kind: 'lesson_package', enrollmentId: dto.enrollmentId, title: dto.title,
      lessonCount: dto.lessonCount, amountMinor: dto.amountMinor, currency: dto.currency });
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const existing = (await client.query<{ id: string; same: boolean }>('SELECT id,request_payload=$3::jsonb AS same FROM payment_records WHERE teacher_id=$1 AND request_id=$2', [teacherId, dto.requestId, payload])).rows[0];
      if (existing) {
        if (!existing.same) throw new ApiError(409, 'request_id_conflict', 'Этот запрос уже использован для другой записи.');
        return this.view(client, teacherId, existing.id);
      }
      const studentId = await this.lockEnrollment(client, teacherId, dto.enrollmentId, true); const id = randomUUID();
      await client.query(`INSERT INTO payment_records(id,enrollment_id,teacher_id,student_id,request_id,request_payload,title,amount_minor,currency)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [id, dto.enrollmentId, teacherId, studentId, dto.requestId, payload, dto.title, dto.amountMinor, dto.currency]);
      await client.query(`INSERT INTO payment_record_history(id,payment_record_id,actor_user_id,type,before_paid,after_paid)
        VALUES($1,$2,$3,'created',NULL,false)`, [randomUUID(), id, userId]);
      await audit(client, userId, 'payment_record.created', id);
      await client.query('INSERT INTO lesson_packages(id,enrollment_id,lesson_count) VALUES($1,$2,$3)', [id, dto.enrollmentId, dto.lessonCount]);
      await this.event(client, userId, id, dto.enrollmentId, { type: 'created', delta: dto.lessonCount });
      return this.view(client, teacherId, id);
    });
  }

  async lessons(userId: string, id: string, query: ConnectionPageDto): Promise<PackageLessonPage> {
    const teacherId = await this.profile(userId, 'teacher');
    const result = await this.db.query<{ owned: boolean; items: PackageLessonPage['items']; total: number }>(`WITH owned AS (
      SELECT k.enrollment_id,k.closed,p.cancelled FROM lesson_packages k JOIN payment_records p ON p.id=k.id WHERE k.id=$1 AND p.teacher_id=$2
    ), visible AS (
      SELECT l.id,l.starts_at,l.duration_min,l.status,l.version FROM lessons l JOIN owned ON owned.enrollment_id=l.enrollment_id
      WHERE NOT owned.closed AND NOT owned.cancelled AND l.status IN ('completed','student_absent')
        AND l.starts_at+make_interval(mins=>l.duration_min)<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM lesson_package_ledger d WHERE d.lesson_id=l.id AND d.type='charged'
          AND NOT EXISTS(SELECT 1 FROM lesson_package_ledger r WHERE r.reverses_entry_id=d.id))
    ) SELECT EXISTS(SELECT 1 FROM owned) AS owned,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'startsAt',starts_at,'durationMin',duration_min,'status',status,'version',version) ORDER BY starts_at,id)
        FROM (SELECT * FROM visible ORDER BY starts_at,id LIMIT $3 OFFSET $4) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [id, teacherId, query.limit, query.offset]);
    const row = result.rows[0]!; if (!row.owned) throw unavailable();
    return { items: row.items, total: row.total, limit: query.limit, offset: query.offset };
  }

  async charge(req: ApiRequest, id: string, dto: ChargePackageDto): Promise<PackageView> {
    const payload = JSON.stringify({ type: 'charged', packageId: id, version: dto.version, lessonId: dto.lessonId, lessonVersion: dto.lessonVersion, reason: dto.reason ?? null });
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      if (await this.retry(client, userId, dto.requestId, payload)) return this.view(client, teacherId, id);
      const enrollmentId = await this.context(client, teacherId, id);
      const lesson = (await client.query<{ status: string; version: number; ended: boolean }>(`SELECT status,version,
        starts_at+make_interval(mins=>duration_min)<=clock_timestamp() AS ended FROM lessons
        WHERE id=$1 AND enrollment_id=$2 AND teacher_id=$3 FOR UPDATE`, [dto.lessonId, enrollmentId, teacherId])).rows[0];
      if (!lesson) throw unavailable();
      const row = await this.lockPackage(client, teacherId, id);
      if (row.version !== dto.version || lesson.version !== dto.lessonVersion) throw stale();
      if (row.closed || row.cancelled) throw new ApiError(409, 'package_closed', 'Закрытый или аннулированный пакет нельзя использовать для нового списания.');
      if (!['completed', 'student_absent'].includes(lesson.status)) throw new ApiError(409, 'lesson_not_chargeable', 'Сначала отметьте посещаемость проведённого занятия.');
      if (!lesson.ended) throw new ApiError(409, 'lesson_not_ended', 'Списать занятие можно после его окончания.');
      if (lesson.status === 'student_absent' && !dto.reason) throw new ApiError(400, 'absence_reason_required', 'Укажите причину списания пропущенного занятия.');
      // The lesson row lock serializes this check across every package, including after a reversal.
      const charged = await client.query(`SELECT d.id FROM lesson_package_ledger d WHERE d.lesson_id=$1 AND d.type='charged'
        AND NOT EXISTS(SELECT 1 FROM lesson_package_ledger r WHERE r.reverses_entry_id=d.id)`, [dto.lessonId]);
      if (charged.rows[0]) throw new ApiError(409, 'lesson_already_charged', 'Это занятие уже списано из пакета.');
      if (await this.balance(client, id) <= 0) throw new ApiError(409, 'package_empty', 'В пакете не осталось занятий.');
      await this.event(client, userId, id, enrollmentId, { type: 'charged', delta: -1, lessonId: dto.lessonId, reason: dto.reason, requestId: dto.requestId, payload });
      await client.query('UPDATE lesson_packages SET version=version+1 WHERE id=$1', [id]);
      return this.view(client, teacherId, id);
    });
  }

  async reverse(req: ApiRequest, id: string, dto: ReversePackageDto): Promise<PackageView> {
    const payload = JSON.stringify({ type: 'reversed', packageId: id, version: dto.version, entryId: dto.entryId, reason: dto.reason });
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      if (await this.retry(client, userId, dto.requestId, payload)) return this.view(client, teacherId, id);
      const enrollmentId = await this.context(client, teacherId, id);
      const debit = (await client.query<{ lesson_id: string }>("SELECT lesson_id FROM lesson_package_ledger WHERE id=$1 AND package_id=$2 AND type='charged'", [dto.entryId, id])).rows[0];
      if (!debit) throw unavailable();
      await client.query('SELECT id FROM lessons WHERE id=$1 AND enrollment_id=$2 FOR UPDATE', [debit.lesson_id, enrollmentId]);
      const row = await this.lockPackage(client, teacherId, id);
      if (row.version !== dto.version) throw stale();
      const reversed = await client.query('SELECT id FROM lesson_package_ledger WHERE reverses_entry_id=$1', [dto.entryId]);
      if (reversed.rows[0]) throw new ApiError(409, 'charge_already_reversed', 'Это списание уже исправлено.');
      await this.event(client, userId, id, enrollmentId, { type: 'reversed', delta: 1, lessonId: debit.lesson_id,
        reversesEntryId: dto.entryId, reason: dto.reason, requestId: dto.requestId, payload });
      await client.query('UPDATE lesson_packages SET version=version+1 WHERE id=$1', [id]);
      return this.view(client, teacherId, id);
    });
  }

  async close(req: ApiRequest, id: string, dto: ClosePackageDto): Promise<PackageView> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const enrollmentId = await this.context(client, teacherId, id); const row = await this.lockPackage(client, teacherId, id);
      if (row.closed) return this.view(client, teacherId, id);
      if (row.version !== dto.version) throw stale();
      await this.event(client, userId, id, enrollmentId, { type: 'closed', delta: 0, reason: dto.reason });
      await client.query('UPDATE lesson_packages SET closed=true,version=version+1 WHERE id=$1', [id]);
      return this.view(client, teacherId, id);
    });
  }

  async history(userId: string, id: string, query: PackageRoleQueryDto): Promise<PackageHistoryPage> {
    const profileId = await this.profile(userId, query.role);
    // Authorization, consent and rows share one snapshot. Family projections never contain reasons.
    const result = await this.db.query<{ owned: boolean; items: PackageHistoryView[]; total: number }>(`WITH owned AS (
      SELECT k.id ${joins} WHERE ${this.scope(query.role)} AND k.id=$2
    ), visible AS (
      SELECT h.*,l.starts_at,u.name AS actor_name,
        CASE WHEN h.type='charged' THEN EXISTS(SELECT 1 FROM lesson_package_ledger r WHERE r.reverses_entry_id=h.id) END AS reversed
      FROM lesson_package_ledger h JOIN owned ON owned.id=h.package_id
      JOIN users u ON u.id=h.actor_user_id LEFT JOIN lessons l ON l.id=h.lesson_id
    ) SELECT EXISTS(SELECT 1 FROM owned) AS owned,
      COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',id,'type',type,'delta',delta,
        'lessonId',lesson_id,'lessonStartsAt',starts_at,'reversesEntryId',reverses_entry_id,'reversed',reversed,
        'occurredAt',occurred_at,'actorName',CASE WHEN $3='teacher' THEN actor_name END,'reason',CASE WHEN $3='teacher' THEN reason END)) ORDER BY occurred_at,id)
        FROM (SELECT * FROM visible ORDER BY occurred_at,id LIMIT $4 OFFSET $5) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [profileId, id, query.role, query.limit, query.offset]);
    const row = result.rows[0]!; if (!row.owned) throw unavailable();
    return { items: row.items, total: row.total, limit: query.limit, offset: query.offset };
  }
}
