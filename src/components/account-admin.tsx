'use client';

import { useI18n } from './locale-provider';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { AccountApiError, accountApi } from '@/lib/account-api';
import type { AdminOverview as AdminOverviewData } from '@/lib/account-admin';
import { AdminAudit } from './account-admin-audit';
import { AdminUsers } from './account-admin-users';
import { adminDate, useAdminValue, type AdminContextProps } from './account-admin-state';

export function AccountAdmin({ accountId, onSessionChanged }: { accountId: string; onSessionChanged: () => void }) {
  const { t } = useI18n();
  const [denied, setDenied] = useState(false);
  const [revision, setRevision] = useState(0);
  const guard = useCallback(async <T,>(request: Promise<T>): Promise<T> => {
    try { return await request; } catch (failure) {
      if (failure instanceof AccountApiError && failure.status === 403 && failure.code === 'admin_required') setDenied(true);
      throw failure;
    }
  }, []);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  if (denied) return <div role="alert" className="admin-access-error"><h3>{t("Доступ администратора недоступен")}</h3><p>{t("Обновите аккаунт, чтобы проверить текущие права.")}</p><button className="button secondary" onClick={onSessionChanged}>{t("Обновить аккаунт")}</button></div>;
  const context = { accountId, guard, onSessionChanged };
  return <div className="admin-workspace">
    <p className="muted">{t("Управление аккаунтами и техническая статистика платформы. Изменение доступа сохраняется в журнале с вашей причиной.")}</p>
    <AdminSummary key={`summary:${revision}`} {...context} />
    <AdminUsers {...context} onChanged={changed} />
    <section className="admin-audit" aria-labelledby="admin-audit-title"><h3 id="admin-audit-title">{t("Журнал действий")}</h3><p className="muted">{t("Критические события аккаунтов и платформы. Для истории конкретного пользователя откройте его карточку.")}</p><AdminAudit key={`audit:${revision}`} {...context} /></section>
  </div>;
}

function AdminSummary(props: AdminContextProps) {
  const { t } = useI18n();
  const { guard, accountId } = props;
  const fetchSummary = useCallback(() => guard(accountApi.adminOverview(accountId)), [guard, accountId]);
  const summary = useAdminValue(fetchSummary, props.onSessionChanged);
  const { reload } = summary;
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', refresh); const timer = window.setInterval(refresh, 60_000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(timer); };
  }, [reload]);
  return <section aria-labelledby="admin-summary-title" aria-busy={summary.loading}>
    <div className="admin-section-heading"><h3 id="admin-summary-title"><ShieldCheck size={20} aria-hidden="true" />{t("Состояние платформы")}</h3><button className="text-button" disabled={summary.loading} onClick={summary.reload}><RefreshCw size={16} aria-hidden="true" />{t("Обновить статистику")}</button></div>
    {summary.error && <p role="alert" className="form-error">{t(summary.error)}</p>}
    {summary.loading && <p role="status">{t("Загружаем статистику…")}</p>}
    {summary.value && <AdminStats value={summary.value} />}
  </section>;
}

export function AdminStats({ value }: { value: AdminOverviewData }) {
  const { t } = useI18n();
  return <><dl className="admin-stats">
    <div><dt>{t("Пользователи")}</dt><dd>{value.users.total}</dd><small>{t("Активных аккаунтов:")}{' '}{value.users.active}</small></div>
    <div><dt>{t("Подключения к предметам")}</dt><dd>{value.enrollments.total}</dd><small>{t("Активных:")}{' '}{value.enrollments.active}</small></div>
    <div><dt>{t("Занятия")}</dt><dd>{value.lessons.total}</dd><small>{t("Запланированных:")}{' '}{value.lessons.scheduled}</small></div>
    <div><dt>{t("Тесты")}</dt><dd>{value.tests.total}</dd><small>{t("Опубликованных:")}{' '}{value.tests.published}</small></div>
  </dl><p className="admin-counts muted">{t("Ждут подтверждения почты:")}{' '}{value.users.pendingVerification}{' '}{t("· заблокированы:")}{' '}{value.users.suspended}{' '}{t("· деактивированы:")}{' '}{value.users.deactivated}{' '}{t("· удалены:")}{' '}{value.users.deleted}</p><p className="muted">{t("Данные на")}{' '}<time dateTime={value.generatedAt}>{adminDate(value.generatedAt)}</time>{t(". Активный аккаунт означает разрешённый доступ, а не присутствие онлайн.")}</p></>;
}
