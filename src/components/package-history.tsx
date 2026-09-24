'use client';

import { useI18n } from './locale-provider';

import { useCallback, useEffect } from 'react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import type { LessonPackage, PackageHistoryEvent } from '@/lib/account-packages';
import { plural } from '@/lib/plural';
import { useAccountPage } from './account-connections-state';
import { PageContent } from './account-connections';
import { Modal } from './ui';
import { packageDateTime, type PackageFormProps } from './package-dialog';

const HISTORY_LABELS: Record<PackageHistoryEvent['type'], string> = {
  created: 'Пакет создан', charged: 'Занятие списано', reversed: 'Занятие возвращено', closed: 'Пакет закрыт',
};

export function PackageHistory({ accountId, role, record, onSessionChanged, onClose, onReverse }: Omit<PackageFormProps, 'onChanged'> & {
  role: AccountRole; record: LessonPackage; onReverse: (entry: PackageHistoryEvent) => void;
}) {
  const { t } = useI18n();
  const load = useCallback((offset: number) => accountApi.packageHistory(accountId, record.id, role, offset), [accountId, record.id, role]);
  const history = useAccountPage(load, onSessionChanged);
  useEffect(() => accountApi.subscribePayments(accountId, history.reload), [accountId, history.reload]);
  return <Modal title={t("История занятий в пакете")} onClose={onClose}>
    <p className="account-payment-dialog-summary">{record.studentName} · {record.subjectName}<br /><strong>{record.title}</strong></p>
    <p className="muted">{t("Списание уменьшает остаток на одно занятие. Возврат восстанавливает занятие и сохраняет прежнюю запись.")}</p>
    <PageContent page={history} emptyTitle={t("История пока пуста")} emptyText={t("Здесь появятся создание пакета, списания и возвраты занятий.")} disabled={false}>
      <PackageHistoryList items={history.items} role={role} disabled={history.loading || history.loadingMore || !!history.error} onReverse={onReverse} />
    </PageContent>
    <div className="form-actions"><button className="button secondary" onClick={onClose}>{t("Закрыть")}</button></div>
  </Modal>;
}

export function PackageHistoryList({ items, role, disabled, onReverse }: {
  items: PackageHistoryEvent[]; role: AccountRole; disabled: boolean; onReverse: (entry: PackageHistoryEvent) => void;
}) {
  const { t } = useI18n();
  return <ol className="account-payment-history package-history">{items.map(entry => <li key={entry.id}>
    <div className="package-history-heading"><h3>{t(HISTORY_LABELS[entry.type])}</h3><strong>{entry.delta > 0 ? '+' : ''}{entry.delta} {plural(Math.abs(entry.delta), 'занятие', 'занятия', 'занятий')}</strong></div>
    <p><time dateTime={entry.occurredAt}>{packageDateTime(entry.occurredAt)}</time>{role === 'teacher' && entry.actorName ? ` · ${entry.actorName}` : ''}</p>
    {entry.lessonStartsAt && <p>{t("Занятие:")}{' '}<time dateTime={entry.lessonStartsAt}>{packageDateTime(entry.lessonStartsAt)}</time></p>}
    {entry.type === 'charged' && entry.reversed && <p className="account-list-help">{t("Это списание исправлено: занятие возвращено в пакет.")}</p>}
    {role === 'teacher' && entry.reason && <p className="account-payment-reason">{t("Причина:")}{' '}{entry.reason}</p>}
    {role === 'teacher' && entry.type === 'charged' && !entry.reversed && <button className="text-button" disabled={disabled} onClick={() => onReverse(entry)}>{t("Вернуть занятие")}</button>}
  </li>)}</ol>;
}
