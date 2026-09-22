import type { AccountRole } from './account-api';

export const NOTIFICATION_TYPES = ['lesson_reminder', 'lesson_rescheduled', 'lesson_cancelled', 'test_assigned', 'result_published'] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];
export type NotificationTarget = 'lessons' | 'tests';
export interface AccountNotification {
  id: string; type: NotificationType; recipientRole: AccountRole; title: string; body: string;
  target: NotificationTarget; createdAt: string; readAt: string | null;
}
export interface NotificationPage {
  items: AccountNotification[]; total: number; unreadTotal: number; limit: number; offset: number;
}
export interface NotificationPreference { type: NotificationType; inApp: boolean; email: boolean; version: number }
export type NotificationPreferenceInput = Omit<NotificationPreference, 'type'>;
export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  lesson_reminder: 'Напоминание о занятии', lesson_rescheduled: 'Перенос занятия', lesson_cancelled: 'Отмена занятия',
  test_assigned: 'Назначение теста', result_published: 'Публикация результата',
};
export const NOTIFICATION_TARGETS: Record<NotificationTarget, { href: string; label: string }> = {
  lessons: { href: '#account-lessons-section', label: 'К расписанию' },
  tests: { href: '#account-tests-section', label: 'К тестам и результатам' },
};
