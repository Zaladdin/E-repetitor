import { NotificationType } from './notifications.dto';

export const notificationTitles: Record<NotificationType, string> = {
  lesson_reminder: 'Скоро занятие', lesson_rescheduled: 'Занятие перенесено', lesson_cancelled: 'Занятие отменено',
  test_assigned: 'Назначен новый тест', result_published: 'Опубликован результат теста',
};
// All consumers authorize against the current resource and the original consent.
// Disabling future in-app notifications does not hide already recorded history.
export const notificationJoins = `FROM notifications n
  JOIN users recipient ON recipient.id=n.recipient_user_id
  JOIN enrollments e ON e.id=n.enrollment_id
  JOIN student_profiles s ON s.id=e.student_id JOIN users su ON su.id=s.user_id
  JOIN teacher_profiles t ON t.id=e.teacher_id
  JOIN subjects subject ON subject.id=e.subject_id
  LEFT JOIN parent_connections pc ON pc.id=n.parent_connection_id AND pc.student_id=e.student_id
  LEFT JOIN parent_profiles p ON p.id=pc.parent_id
  LEFT JOIN lessons l ON l.id=n.lesson_id AND l.enrollment_id=e.id
  LEFT JOIN test_assignments a ON a.id=n.assignment_id AND a.enrollment_id=e.id
  LEFT JOIN test_attempts attempt ON attempt.id=n.attempt_id AND attempt.assignment_id=a.id`;
export const notificationScope = `recipient.status='active' AND e.accepted_at IS NOT NULL AND (
  (n.recipient_role='teacher' AND t.user_id=n.recipient_user_id)
  OR (n.recipient_role='student' AND s.user_id=n.recipient_user_id AND su.status='active')
  OR (n.recipient_role='parent' AND p.user_id=n.recipient_user_id AND pc.status='active' AND e.status='active' AND su.status='active')
  ) AND (
    (n.type IN ('lesson_reminder','lesson_rescheduled','lesson_cancelled') AND l.id IS NOT NULL)
    OR (n.type='test_assigned' AND a.id IS NOT NULL AND n.recipient_role='student')
    OR (n.type='result_published' AND attempt.status='published')
  )`;
export const timelyEmailScope = `(n.type<>'lesson_reminder' OR (l.status='scheduled' AND l.starts_at>clock_timestamp() AND e.status='active' AND su.status='active'))
  AND (n.type<>'lesson_rescheduled' OR l.status='scheduled')`;
