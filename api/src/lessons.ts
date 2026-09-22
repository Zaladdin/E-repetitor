import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, ApiRequest, Role, audit, lockActiveSession } from './common';
import { Database } from './database';
import { ConnectionPageDto } from './connections.dto';
import { notifyLesson } from './notifications.events';
import {
  AttendanceDto, CancelLessonDto, CreateLessonDto, LessonHistoryPage, LessonHistoryView, LessonMutationView,
  LessonPage, LessonQueryDto, LessonStatus, LessonTimeDto, RescheduleLessonDto,
} from './lessons.dto';

const unavailable = () => new ApiError(404, 'not_found', 'Занятие или запись на предмет недоступны.');
const invalidTransition = () => new ApiError(409, 'invalid_transition', 'Действие недоступно для текущего статуса занятия.');
const tables = { teacher: 'teacher_profiles', student: 'student_profiles', parent: 'parent_profiles' } as const;
type LessonRow = {
  id: string; enrollment_id: string; teacher_id: string; student_id: string; starts_at: Date; duration_min: number;
  format: 'online' | 'offline'; online_url: string | null; location_text: string | null; private_notes: string | null;
  status: LessonStatus; version: number;
};
type HistoryChange = {
  fromStartsAt?: Date; toStartsAt?: Date; fromStatus?: string; toStatus?: string;
  fromAttendance?: string; toAttendance?: string; reason?: string; comment?: string; previousComment?: string;
};

@Injectable()
export class LessonsService {
  constructor(private readonly db: Database) {}

  private async profile(userId: string, role: Role, client?: PoolClient): Promise<string> {
    const sql = `SELECT p.id FROM ${tables[role]} p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`;
    const result = client ? await client.query<{ id: string }>(sql, [userId]) : await this.db.query<{ id: string }>(sql, [userId]);
    if (!result.rows[0]) throw new ApiError(403, 'role_required', 'Выберите доступную роль аккаунта.');
    return result.rows[0].id;
  }

  async list(userId: string, query: LessonQueryDto): Promise<LessonPage> {
    const range = Date.parse(query.to) - Date.parse(query.from);
    if (range <= 0 || range > 93 * 86400000) throw new ApiError(400, 'validation_error', 'Выберите период от одного момента до 93 дней.');
    const profileId = await this.profile(userId, query.role);
    const predicate = query.role === 'teacher' ? 'l.teacher_id=$1'
      : query.role === 'student' ? 'l.student_id=$1 AND e.accepted_at IS NOT NULL'
        : `e.status='active' AND su.status='active' AND EXISTS(SELECT 1 FROM parent_connections pc
          WHERE pc.parent_id=$1 AND pc.student_id=l.student_id AND pc.status='active')`;
    // A single statement snapshot includes role scope, connection state, counts and page data.
    const result = await this.db.query<{ items: LessonPage['items']; total: number }>(`WITH visible AS (
      SELECT l.id,l.starts_at,jsonb_strip_nulls(jsonb_build_object(
        'id',l.id,'enrollmentId',l.enrollment_id,'studentName',su.name,'studentPublicId',s.public_id,
        'teacherName',tu.name,'subjectName',subject.name,'startsAt',l.starts_at,'durationMin',l.duration_min,
        'format',l.format,'onlineUrl',l.online_url,'locationText',l.location_text,'status',l.status,'version',l.version,
        'rescheduledFromId',previous.id,'rescheduledFromStartsAt',previous.starts_at,
        'replacementId',replacement.id,'replacementStartsAt',replacement.starts_at,
        'privateNotes',CASE WHEN $6='teacher' THEN l.private_notes END,
        'attendance',CASE WHEN a.lesson_id IS NOT NULL THEN jsonb_build_object('status',a.status,'markedAt',a.marked_at,
          'comment',CASE WHEN $6='teacher' THEN a.comment END) END)) AS item
      FROM lessons l JOIN enrollments e ON e.id=l.enrollment_id
      JOIN student_profiles s ON s.id=l.student_id JOIN users su ON su.id=s.user_id
      JOIN teacher_profiles t ON t.id=l.teacher_id JOIN users tu ON tu.id=t.user_id
      JOIN subjects subject ON subject.id=e.subject_id
      LEFT JOIN lesson_attendance a ON a.lesson_id=l.id
      LEFT JOIN lessons previous ON previous.id=l.rescheduled_from_id
      LEFT JOIN lessons replacement ON replacement.rescheduled_from_id=l.id
      WHERE ${predicate} AND l.starts_at<$3::timestamptz
        AND l.starts_at+make_interval(mins=>l.duration_min)>$2::timestamptz
        AND ($7::uuid IS NULL OR l.enrollment_id=$7) AND ($8::uuid IS NULL OR l.student_id=$8)
    ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY starts_at,id) FROM
      (SELECT * FROM visible ORDER BY starts_at,id LIMIT $4 OFFSET $5) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`,
    [profileId, query.from, query.to, query.limit, query.offset, query.role, query.enrollmentId ?? null, query.studentId ?? null]);
    return { ...result.rows[0]!, limit: query.limit, offset: query.offset };
  }

  private validateContext(dto: CreateLessonDto) {
    if ((dto.format === 'online' && dto.locationText !== undefined) || (dto.format === 'offline' && dto.onlineUrl !== undefined)) {
      throw new ApiError(400, 'validation_error', 'Для онлайн-занятия укажите ссылку, для очного — место проведения.');
    }
    if (dto.onlineUrl !== undefined) {
      let url: URL;
      try { url = new URL(dto.onlineUrl); } catch { throw new ApiError(400, 'validation_error', 'Укажите корректную HTTPS-ссылку занятия.'); }
      if (url.protocol !== 'https:' || !dto.onlineUrl.startsWith('https://') || url.username || url.password || /[\s\\]/u.test(dto.onlineUrl)) {
        throw new ApiError(400, 'validation_error', 'Ссылка занятия должна использовать HTTPS и не содержать данные входа.');
      }
    }
  }

  /** Every writer locks actor user -> student profile -> enrollment -> lesson. */
  private async lockEnrollment(client: PoolClient, teacherId: string, enrollmentId: string, requireActive: boolean) {
    const candidate = await client.query<{ student_id: string }>('SELECT student_id FROM enrollments WHERE id=$1 AND teacher_id=$2', [enrollmentId, teacherId]);
    if (!candidate.rows[0]) throw unavailable();
    const studentId = candidate.rows[0].student_id;
    const student = await client.query<{ status: string }>(`SELECT u.status FROM student_profiles s JOIN users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE OF s`, [studentId]);
    const enrollment = await client.query<{ status: string; accepted_at: Date | null }>('SELECT status,accepted_at FROM enrollments WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [enrollmentId, teacherId]);
    if (!enrollment.rows[0]?.accepted_at) throw unavailable();
    if (requireActive && (enrollment.rows[0].status !== 'active' || student.rows[0]?.status !== 'active')) {
      throw new ApiError(409, 'enrollment_inactive', 'Новое занятие доступно только при активном обучении и активном аккаунте ученика.');
    }
    return studentId;
  }

  private async lockLesson(client: PoolClient, teacherId: string, id: string, version: number, requireActive = false) {
    const candidate = await client.query<{ enrollment_id: string }>('SELECT enrollment_id FROM lessons WHERE id=$1 AND teacher_id=$2', [id, teacherId]);
    if (!candidate.rows[0]) throw unavailable();
    await this.lockEnrollment(client, teacherId, candidate.rows[0].enrollment_id, requireActive);
    const result = await client.query<LessonRow>('SELECT * FROM lessons WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [id, teacherId]);
    const row = result.rows[0];
    if (!row) throw unavailable();
    if (row.version !== version) throw new ApiError(409, 'stale_version', 'Занятие уже изменилось. Обновите расписание и повторите действие.');
    return row;
  }

  private async bookingTime(client: PoolClient, teacherId: string, dto: LessonTimeDto, excludingId: string | null = null) {
    const future = await client.query<{ future: boolean }>('SELECT $1::timestamptz>clock_timestamp() AS future', [dto.startsAt]);
    if (!future.rows[0]!.future) throw new ApiError(409, 'lesson_in_past', 'Новое время занятия должно быть в будущем.');
    // The actor user lock serializes every booking for this teacher, including across API instances.
    const conflict = await client.query(`SELECT id FROM lessons WHERE teacher_id=$1
      AND status NOT IN ('student_cancelled','teacher_cancelled','rescheduled')
      AND ($4::uuid IS NULL OR id<>$4)
      AND starts_at<$2::timestamptz+make_interval(mins=>$3)
      AND starts_at+make_interval(mins=>duration_min)>$2::timestamptz LIMIT 1`,
    [teacherId, dto.startsAt, dto.durationMin, excludingId]);
    if (conflict.rows[0]) throw new ApiError(409, 'lesson_overlap', 'У преподавателя уже есть занятие в это время.');
  }

  private async event(client: PoolClient, actorId: string, lessonId: string, type: LessonHistoryView['type'], change: HistoryChange) {
    await client.query(`INSERT INTO lesson_history(id,lesson_id,actor_user_id,type,occurred_at,from_starts_at,to_starts_at,
      from_status,to_status,from_attendance,to_attendance,reason,comment,previous_comment)
      VALUES($1,$2,$3,$4,clock_timestamp(),$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), lessonId, actorId, type, change.fromStartsAt ?? null, change.toStartsAt ?? null,
      change.fromStatus ?? null, change.toStatus ?? null, change.fromAttendance ?? null, change.toAttendance ?? null,
      change.reason ?? null, change.comment ?? null, change.previousComment ?? null]);
    await audit(client, actorId, `lesson.${type}`, lessonId);
  }

  async create(req: ApiRequest, dto: CreateLessonDto): Promise<LessonMutationView> {
    this.validateContext(dto);
    const payload = JSON.stringify({ enrollmentId: dto.enrollmentId, startsAt: new Date(dto.startsAt).toISOString(), durationMin: dto.durationMin,
      format: dto.format, onlineUrl: dto.onlineUrl ?? null, locationText: dto.locationText ?? null, privateNotes: dto.privateNotes ?? null });
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const existing = await client.query<LessonMutationView & { same: boolean }>(`SELECT id,status,version,request_payload=$3::jsonb AS same
        FROM lessons WHERE teacher_id=$1 AND request_id=$2`, [teacherId, dto.requestId, payload]);
      if (existing.rows[0]) {
        const { id, status, version, same } = existing.rows[0];
        if (!same) throw new ApiError(409, 'request_id_conflict', 'Этот запрос уже использован для другого занятия.');
        return { id, status, version };
      }
      const studentId = await this.lockEnrollment(client, teacherId, dto.enrollmentId, true);
      await this.bookingTime(client, teacherId, dto);
      const id = randomUUID();
      await client.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,request_id,request_payload,starts_at,duration_min,format,online_url,location_text,private_notes)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
      [id, dto.enrollmentId, teacherId, studentId, dto.requestId, payload, dto.startsAt, dto.durationMin, dto.format,
        dto.onlineUrl ?? null, dto.locationText ?? null, dto.privateNotes ?? null]);
      await this.event(client, userId, id, 'created', { toStartsAt: new Date(dto.startsAt), toStatus: 'scheduled' });
      return { id, status: 'scheduled', version: 1 };
    });
  }

  async reschedule(req: ApiRequest, id: string, dto: RescheduleLessonDto): Promise<LessonMutationView> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const old = await this.lockLesson(client, teacherId, id, dto.version, true);
      if (old.status !== 'scheduled') throw invalidTransition();
      await this.bookingTime(client, teacherId, dto, id);
      const nextId = randomUUID();
      await client.query(`UPDATE lessons SET status='rescheduled',version=version+1,updated_at=clock_timestamp() WHERE id=$1`, [id]);
      await client.query(`INSERT INTO lessons(id,enrollment_id,teacher_id,student_id,starts_at,duration_min,format,online_url,location_text,private_notes,rescheduled_from_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [nextId, old.enrollment_id, teacherId, old.student_id, dto.startsAt, dto.durationMin, old.format, old.online_url, old.location_text, old.private_notes, id]);
      const change: HistoryChange = { fromStartsAt: old.starts_at, toStartsAt: new Date(dto.startsAt), fromStatus: old.status, toStatus: 'rescheduled', reason: dto.reason };
      await this.event(client, userId, id, 'rescheduled', change);
      await this.event(client, userId, nextId, 'rescheduled', { ...change, toStatus: 'scheduled' });
      await notifyLesson(client, nextId, 'lesson_rescheduled');
      return { id: nextId, status: 'scheduled', version: 1, rescheduledFromId: id };
    });
  }

  async cancel(req: ApiRequest, id: string, dto: CancelLessonDto): Promise<LessonMutationView> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const old = await this.lockLesson(client, teacherId, id, dto.version);
      if (old.status !== 'scheduled') throw invalidTransition();
      await client.query('UPDATE lessons SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, dto.status]);
      await client.query(`INSERT INTO lesson_attendance(lesson_id,student_id,status,marked_at,marked_by)
        VALUES($1,$2,'cancelled',clock_timestamp(),$3)`, [id, old.student_id, userId]);
      await this.event(client, userId, id, 'cancelled', { fromStatus: old.status, toStatus: dto.status, toAttendance: 'cancelled', reason: dto.reason });
      await notifyLesson(client, id, 'lesson_cancelled');
      return { id, status: dto.status, version: old.version + 1 };
    });
  }

  async attendance(req: ApiRequest, id: string, dto: AttendanceDto): Promise<LessonMutationView> {
    return this.db.transaction(async client => {
      const userId = await lockActiveSession(client, req); const teacherId = await this.profile(userId, 'teacher', client);
      const old = await this.lockLesson(client, teacherId, id, dto.version);
      if (!['scheduled', 'completed', 'student_absent'].includes(old.status)) throw invalidTransition();
      const ended = await client.query<{ ended: boolean }>('SELECT starts_at+make_interval(mins=>duration_min)<=clock_timestamp() AS ended FROM lessons WHERE id=$1', [id]);
      if (!ended.rows[0]!.ended) throw new ApiError(409, 'lesson_not_ended', 'Посещаемость можно отметить после окончания занятия.');
      const previous = (await client.query<{ status: string; comment: string | null }>('SELECT status,comment FROM lesson_attendance WHERE lesson_id=$1', [id])).rows[0];
      const correction = old.status !== 'scheduled';
      if (correction && !dto.correctionReason) throw new ApiError(400, 'correction_reason_required', 'Укажите причину исправления посещаемости.');
      const status = dto.status === 'present' ? 'completed' : 'student_absent';
      await client.query('UPDATE lessons SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, status]);
      await client.query(`INSERT INTO lesson_attendance(lesson_id,student_id,status,comment,marked_at,marked_by)
        VALUES($1,$2,$3,$4,clock_timestamp(),$5) ON CONFLICT(lesson_id) DO UPDATE
        SET status=excluded.status,comment=excluded.comment,marked_at=excluded.marked_at,marked_by=excluded.marked_by`,
      [id, old.student_id, dto.status, dto.comment ?? null, userId]);
      await this.event(client, userId, id, correction ? 'attendance_corrected' : 'attendance_marked', {
        fromStatus: old.status, toStatus: status, fromAttendance: previous?.status, toAttendance: dto.status,
        reason: dto.correctionReason, comment: dto.comment, previousComment: previous?.comment ?? undefined,
      });
      return { id, status, version: old.version + 1 };
    });
  }

  async history(userId: string, id: string, query: ConnectionPageDto): Promise<LessonHistoryPage> {
    const teacherId = await this.profile(userId, 'teacher');
    const result = await this.db.query<{ owned: boolean; items: LessonHistoryPage['items']; total: number }>(`WITH owned AS (
      SELECT id FROM lessons WHERE id=$1 AND teacher_id=$2
    ), visible AS (SELECT h.* FROM lesson_history h JOIN owned ON owned.id=h.lesson_id)
    SELECT EXISTS(SELECT 1 FROM owned) AS owned,
      COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',id,'type',type,'occurredAt',occurred_at,
        'fromStartsAt',from_starts_at,'toStartsAt',to_starts_at,'fromStatus',from_status,'toStatus',to_status,
        'fromAttendance',from_attendance,'toAttendance',to_attendance,'reason',reason,'comment',comment)) ORDER BY occurred_at,id)
        FROM (SELECT * FROM visible ORDER BY occurred_at,id LIMIT $3 OFFSET $4) page),'[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM visible) AS total`, [id, teacherId, query.limit, query.offset]);
    if (!result.rows[0]!.owned) throw unavailable();
    return { items: result.rows[0]!.items, total: result.rows[0]!.total, limit: query.limit, offset: query.offset };
  }
}
