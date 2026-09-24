'use client';

import { useI18n } from './locale-provider';

import { useCallback } from 'react';
import { accountApi } from '@/lib/account-api';
import { USER_STATUS_LABELS, type AdminAuditEvent, type UserStatus } from '@/lib/account-admin';
import { useAccountPage } from './account-connections-state';
import { adminDate, type AdminContextProps } from './account-admin-state';
export function AdminAudit(props: AdminContextProps & { userId?: string }) {
  const { t } = useI18n();
  const { guard, accountId, userId } = props;
  const fetchPage = useCallback((offset: number) => guard(accountApi.adminAudit(accountId, userId, offset)), [guard, accountId, userId]);
  const page = useAccountPage(fetchPage, props.onSessionChanged);
  return <div aria-busy={page.loading}>
    <div className="admin-section-heading"><p className="muted">{t("Событий:")}{' '}{page.total}</p><button className="text-button" disabled={page.loading || page.loadingMore} onClick={page.reload}>{t("Обновить журнал")}</button></div>
    {page.error && <p className="form-error" role="alert">{t(page.error)}</p>}
    {page.loading ? <p role="status">{t("Загружаем журнал…")}</p> : <>
      {!page.items.length && !page.error && <p>{t("Событий пока нет.")}</p>}
      <AdminAuditList items={page.items} />
      {page.nextOffset < page.total && <button className="text-button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? t("Загружаем…") : t("Показать ещё события")}</button>}
    </>}
  </div>;
}

const EVENT_NAMES: Record<string, string> = {
  'admin.user.suspended': 'Аккаунт заблокирован', 'admin.user.unsuspended': 'Доступ восстановлен',
  'admin.user.deactivated': 'Аккаунт деактивирован', 'admin.membership.granted': 'Выдан доступ администратора',
  'admin.membership.revoked': 'Отозван доступ администратора', 'email.verified': 'Почта подтверждена',
  'account.registered': 'Регистрация аккаунта', 'session.created': 'Вход в аккаунт',
  'session.logged_out': 'Выход из аккаунта', 'sessions.revoked': 'Все сессии завершены',
  'session.refresh_reuse': 'Сессия завершена после повторного использования токена',
  'email.verification_requested': 'Запрошено подтверждение почты', 'password.reset_requested': 'Запрошено восстановление пароля',
  'password.reset': 'Пароль изменён', 'subject.created': 'Предмет создан',
  'lesson.created': 'Занятие создано', 'lesson.rescheduled': 'Занятие перенесено', 'lesson.cancelled': 'Занятие отменено',
  'lesson.attendance_marked': 'Посещаемость отмечена', 'lesson.attendance_corrected': 'Посещаемость исправлена',
  'test.created': 'Тест создан', 'test.updated': 'Тест обновлён', 'test.published': 'Версия теста опубликована',
  'test.archived': 'Тест архивирован', 'test.assigned': 'Тест назначен',
  'test_attempt.started': 'Попытка теста начата', 'test_attempt.submitted': 'Попытка сдана',
  'test_attempt.reviewed': 'Ответы проверены', 'test_attempt.published': 'Результат опубликован',
  'test_attempt.expired': 'Время попытки истекло', 'test_attempt.abandoned': 'Попытка прервана',
  'temporary_student.created': 'Создано приглашение новому ученику', 'invitation.created': 'Ссылка приглашения создана',
  'invitation.accepted': 'Приглашение принято', 'invitation.expired': 'Приглашение истекло',
  'invitation.replaced': 'Ссылка приглашения заменена', 'invitation.revoked': 'Приглашение отозвано',
  'account.activated_from_invitation': 'Аккаунт активирован по приглашению',
  'enrollment.requested': 'Запрошено подключение к предмету', 'enrollment.invitation.active': 'Обучение подтверждено по приглашению',
  'enrollment.pending.expired': 'Запрос обучения истёк', 'parent_connection.requested': 'Запрошен родительский доступ',
  'parent_connection.active.revoked': 'Родительский доступ отозван',
  'profile.teacher.enabled': 'Добавлена роль преподавателя', 'profile.student.enabled': 'Добавлена роль ученика', 'profile.parent.enabled': 'Добавлена роль родителя',
};
export function AdminAuditList({ items }: { items: AdminAuditEvent[] }) {
  const { t } = useI18n();
  return <ul className="admin-audit-list">{items.map(item => <li key={item.id}>
    <div className="admin-section-heading"><strong>{EVENT_NAMES[item.action] ? t(EVENT_NAMES[item.action]) : item.action}</strong><time dateTime={item.createdAt}>{adminDate(item.createdAt)}</time></div>
    <p>{t("Автор:")}{' '}{item.actorName ?? t("Оператор системы")}{item.actorId && <small> · {item.actorId}</small>}</p>
    <p className="muted">{t("Объект:")}{' '}{item.entityId}</p>
    {item.fromStatus && item.toStatus && <p>{USER_STATUS_LABELS[item.fromStatus as UserStatus] ? t(USER_STATUS_LABELS[item.fromStatus as UserStatus]) : item.fromStatus} → {USER_STATUS_LABELS[item.toStatus as UserStatus] ? t(USER_STATUS_LABELS[item.toStatus as UserStatus]) : item.toStatus}</p>}
    {item.reason && <p>{t("Причина:")}{' '}{item.reason}</p>}
  </li>)}</ul>;
}
