import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Role } from './common';
import { NotificationType } from './notifications.dto';

type EventContext = { enrollment_id: string; student_user_id: string; teacher_user_id: string; student_id: string; status: string; student_status: string };
type Recipient = { user_id: string; role: Role; connection_id: string | null };
async function enqueue(client: PoolClient, type: NotificationType, eventKey: string, context: EventContext, lessonId: string | null, assignmentId: string | null, attemptId: string | null) {
  if (context.student_status !== 'active') return;
  const recipients: Recipient[] = [{ user_id: context.student_user_id, role: 'student', connection_id: null }];
  if (type === 'lesson_reminder') recipients.push({ user_id: context.teacher_user_id, role: 'teacher', connection_id: null });
  if (type !== 'test_assigned' && context.status === 'active') {
    const parents = await client.query<{ user_id: string; connection_id: string }>(`SELECT p.user_id,pc.id AS connection_id FROM parent_connections pc
      JOIN parent_profiles p ON p.id=pc.parent_id WHERE pc.student_id=$1 AND pc.status='active'`, [context.student_id]);
    recipients.push(...parents.rows.map(p => ({ ...p, role: 'parent' as const })));
  }
  for (const recipient of recipients) {
    const created = await client.query<{ id: string; email: boolean }>(`WITH preference AS (
      SELECT u.id,COALESCE(p.in_app,true) AS in_app,COALESCE(p.email,false) AS email FROM users u
      LEFT JOIN notification_preferences p ON p.user_id=u.id AND p.type=$2 WHERE u.id=$1 AND u.status='active'
    ), inserted AS (
      INSERT INTO notifications(id,recipient_user_id,recipient_role,type,event_key,enrollment_id,lesson_id,assignment_id,attempt_id,parent_connection_id,in_app)
      SELECT $3,$1,$4,$2,$5,$6,$7,$8,$9,$10,in_app FROM preference
      ON CONFLICT(recipient_user_id,recipient_role,type,event_key) DO NOTHING RETURNING id
    ) SELECT inserted.id,preference.email FROM inserted CROSS JOIN preference`,
    [recipient.user_id, type, randomUUID(), recipient.role, eventKey, context.enrollment_id, lessonId, assignmentId, attemptId, recipient.connection_id]);
    if (created.rows[0]?.email) await client.query('INSERT INTO notification_email_deliveries(notification_id) VALUES($1)', [created.rows[0].id]);
  }
}
const contextSelect = `SELECT e.id AS enrollment_id,e.student_id,e.status,su.status AS student_status,s.user_id AS student_user_id,t.user_id AS teacher_user_id
  FROM enrollments e JOIN student_profiles s ON s.id=e.student_id JOIN users su ON su.id=s.user_id JOIN teacher_profiles t ON t.id=e.teacher_id`;
export async function notifyLesson(client: PoolClient, id: string, type: 'lesson_reminder' | 'lesson_rescheduled' | 'lesson_cancelled') {
  const result = await client.query<EventContext>(`${contextSelect} JOIN lessons l ON l.enrollment_id=e.id WHERE l.id=$1`, [id]);
  if (result.rows[0]) await enqueue(client, type, id, result.rows[0], id, null, null);
}
export async function notifyAssignment(client: PoolClient, id: string) {
  const result = await client.query<EventContext>(`${contextSelect} JOIN test_assignments a ON a.enrollment_id=e.id WHERE a.id=$1`, [id]);
  if (result.rows[0]) await enqueue(client, 'test_assigned', id, result.rows[0], null, id, null);
}
export async function notifyResult(client: PoolClient, id: string) {
  const result = await client.query<EventContext & { assignment_id: string }>(`SELECT context.*,a.id AS assignment_id FROM (${contextSelect}) context
    JOIN test_assignments a ON a.enrollment_id=context.enrollment_id JOIN test_attempts attempt ON attempt.assignment_id=a.id WHERE attempt.id=$1 AND attempt.status='published'`, [id]);
  if (result.rows[0]) await enqueue(client, 'result_published', id, result.rows[0], null, result.rows[0].assignment_id, id);
}
