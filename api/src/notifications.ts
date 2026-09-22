import { Injectable } from '@nestjs/common';
import { ApiError, ApiRequest, Role, lockActiveSession } from './common';
import { Database } from './database';
import { NotificationPage, NotificationPreferenceDto, NotificationPreferenceList, NotificationPreferenceView, NotificationQueryDto, NotificationReadView, NotificationType, notificationTypes } from './notifications.dto';
import { notificationJoins, notificationScope, notificationTitles } from './notifications.shared';

type NotificationRow = { id: string; type: NotificationType; recipient_role: Role; subject_name: string; student_name: string; created_at: string; read_at: string | null };
const iso = (value: string | Date) => new Date(value).toISOString();
@Injectable()
export class NotificationsService {
  constructor(private readonly db: Database) {}
  async list(userId: string, query: NotificationQueryDto): Promise<NotificationPage> {
    const result = await this.db.query<{ items: NotificationRow[]; total: number; unread_total: number }>(`WITH visible AS (
      SELECT n.id,n.type,n.recipient_role,n.created_at,n.read_at,subject.name AS subject_name,su.name AS student_name
      ${notificationJoins} WHERE n.recipient_user_id=$1 AND n.in_app AND ${notificationScope}
    ), filtered AS (SELECT * FROM visible WHERE NOT $2 OR read_at IS NULL)
    SELECT COALESCE((SELECT jsonb_agg(page ORDER BY created_at DESC,id DESC) FROM (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4) page),'[]'::jsonb) AS items,
      (SELECT count(*)::int FROM filtered) AS total,(SELECT count(*)::int FROM visible WHERE read_at IS NULL) AS unread_total`, [userId, query.unreadOnly, query.limit, query.offset]);
    const row = result.rows[0]!;
    return { items: row.items.map(n => ({ id: n.id, type: n.type, recipientRole: n.recipient_role, title: notificationTitles[n.type],
      body: `${n.subject_name} · ${n.student_name}. ${n.type.startsWith('lesson_') ? 'Проверьте расписание занятия.' : 'Подробности доступны в разделе тестов.'}`,
      target: n.type.startsWith('lesson_') ? 'lessons' : 'tests', createdAt: iso(n.created_at), readAt: n.read_at === null ? null : iso(n.read_at) })),
    total: row.total, unreadTotal: row.unread_total, limit: query.limit, offset: query.offset };
  }
  async read(req: ApiRequest, id: string): Promise<NotificationReadView> {
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req);
      const result = await client.query<{ id: string; read_at: Date }>(`UPDATE notifications target SET read_at=COALESCE(target.read_at,clock_timestamp())
        WHERE target.id=$2 AND EXISTS(SELECT 1 ${notificationJoins} WHERE n.id=target.id AND n.recipient_user_id=$1 AND n.in_app AND ${notificationScope}) RETURNING target.id,target.read_at`, [user, id]);
      if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Уведомление недоступно.');
      return { id: result.rows[0].id, readAt: iso(result.rows[0].read_at) };
    });
  }
  async preferences(userId: string): Promise<NotificationPreferenceList> {
    const result = await this.db.query<NotificationPreferenceView>(`SELECT types.type,COALESCE(p.in_app,true) AS "inApp",COALESCE(p.email,false) AS email,COALESCE(p.version,0) AS version
      FROM unnest($2::text[]) WITH ORDINALITY AS types(type,position)
      LEFT JOIN notification_preferences p ON p.user_id=$1 AND p.type=types.type ORDER BY position`, [userId, notificationTypes]);
    return { items: result.rows };
  }
  async preference(req: ApiRequest, type: string, dto: NotificationPreferenceDto): Promise<NotificationPreferenceView> {
    if (!notificationTypes.includes(type as NotificationType)) throw new ApiError(400, 'validation_error', 'Неизвестный тип уведомления.');
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req);
      const result = dto.version === 0
        ? await client.query<NotificationPreferenceView>(`INSERT INTO notification_preferences(user_id,type,in_app,email,version) VALUES($1,$2,$3,$4,1)
          ON CONFLICT(user_id,type) DO NOTHING RETURNING type,in_app AS "inApp",email,version`, [user, type, dto.inApp, dto.email])
        : await client.query<NotificationPreferenceView>(`UPDATE notification_preferences SET in_app=$3,email=$4,version=version+1,updated_at=clock_timestamp()
          WHERE user_id=$1 AND type=$2 AND version=$5 RETURNING type,in_app AS "inApp",email,version`, [user, type, dto.inApp, dto.email, dto.version]);
      if (!result.rows[0]) throw new ApiError(409, 'stale_version', 'Настройки уже изменились. Обновите их и повторите действие.');
      return result.rows[0];
    });
  }
}
