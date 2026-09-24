'use client';

import { useI18n } from './locale-provider';

import Link from 'next/link';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import type { LessonPackage, PackageHistoryEvent } from '@/lib/account-packages';
import { formatPaymentAmount } from '@/lib/account-payments';
import { useAccountPage } from './account-connections-state';
import { ConnectionHeading, PageContent } from './account-connections';
import { ChargePackage, CreatePackage, PackageCorrection } from './package-forms';
import { PackageHistory } from './package-history';

interface PackageProps { accountId: string; role: AccountRole; onSessionChanged: () => void }
type PackageDialogState = { kind: 'create' }
  | { kind: 'charge' | 'close' | 'history'; record: LessonPackage }
  | { kind: 'reverse'; record: LessonPackage; entry: PackageHistoryEvent };

export function AccountPackages({ accountId, role, onSessionChanged }: PackageProps) {
  const { t } = useI18n();
  const id = useId();
  const load = useCallback((offset: number) => accountApi.packageRecords(accountId, role, offset), [accountId, role]);
  const page = useAccountPage(load, onSessionChanged);
  const sectionRef = useRef<HTMLElement>(null);
  // Keep forms outside the refreshed list so incoming payment changes preserve drafts.
  const [dialog, setDialog] = useState<PackageDialogState | null>(null);
  useEffect(() => accountApi.subscribePayments(accountId, page.reload), [accountId, page.reload]);
  function changed() {
    setDialog(null); page.reload();
    // Refresh removes the original row button; return focus to a stable section.
    window.requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }));
  }
  const formProps = { accountId, onSessionChanged, onClose: () => setDialog(null), onChanged: changed };

  return <section ref={sectionRef} tabIndex={-1} className="account-packages" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={t("Пакеты занятий")} description={role === 'teacher' ? t("Количество занятий, остаток и история списаний по каждому ученику.") : t("Остаток занятий и история списаний у преподавателей.")} onRefresh={page.reload} disabled={page.loading || page.loadingMore} />
    <p className="account-payment-note">{t("Оплата производится вне платформы. Преподаватель отмечает её вручную в")}{' '}<Link href="/account/payments/">{t("журнале оплаты")}</Link>{t(". Списание занятия не меняет отметку оплаты.")}</p>
    {role === 'teacher' && <div className="package-toolbar"><button className="button" onClick={() => setDialog({ kind: 'create' })}><Plus size={18} aria-hidden="true" />{t("Добавить пакет")}</button></div>}
    <PageContent page={page} disabled={false} emptyTitle={t("Пакетов пока нет")} emptyText={role === 'teacher' ? t("Создайте пакет, например на 8 занятий. Списывайте завершённые занятия и проверяйте остаток.") : t("Здесь появятся пакеты, которые добавит преподаватель.")}>
      <PackageList items={page.items} role={role} disabled={page.loading || page.loadingMore} onHistory={record => setDialog({ kind: 'history', record })} onCharge={record => setDialog({ kind: 'charge', record })} onClosePackage={record => setDialog({ kind: 'close', record })} />
    </PageContent>
    {dialog?.kind === 'history' && <PackageHistory {...formProps} role={role} record={dialog.record} onReverse={entry => setDialog({ kind: 'reverse', record: dialog.record, entry })} />}
    {role === 'teacher' && <>
      {dialog?.kind === 'create' && <CreatePackage {...formProps} />}
      {dialog?.kind === 'charge' && <ChargePackage {...formProps} record={dialog.record} />}
      {dialog?.kind === 'close' && <PackageCorrection {...formProps} record={dialog.record} action="close" />}
      {dialog?.kind === 'reverse' && <PackageCorrection {...formProps} record={dialog.record} action="reverse" entry={dialog.entry} />}
    </>}
  </section>;
}

export function PackageList({ items, role, disabled, onHistory, onCharge, onClosePackage }: {
  items: LessonPackage[]; role: AccountRole; disabled: boolean;
  onHistory: (record: LessonPackage) => void; onCharge: (record: LessonPackage) => void; onClosePackage: (record: LessonPackage) => void;
}) {
  const { t } = useI18n();
  return <ul className="package-list">{items.map(record => <li key={record.id}>
    <div className="package-main"><h3>{record.title}</h3><p>{record.subjectName} · {role === 'teacher' ? record.studentName : role === 'parent' ? `${record.studentName} · ${record.teacherName}` : record.teacherName}</p>
      {role === 'teacher' && <small>{record.studentPublicId}</small>}
      <div className="package-statuses"><span className={`status status-${record.cancelled ? 'cancelled' : record.paid ? 'active' : 'pending'}`}>{record.cancelled ? t("Запись оплаты отменена") : record.paid ? t("Оплачено") : t("Не оплачено")}</span>
        {record.closed && <span className="status status-completed">{t("Пакет закрыт")}</span>}
      </div>
      <p className="muted">{formatPaymentAmount(record)}</p>
    </div>
    <div className="package-balance"><span>{t("Осталось занятий")}</span><strong>{record.balance}<small>{' '}{t("из")}{' '}{record.lessonCount}</small></strong><span>{record.lessonCount - record.balance}{' '}{t("списано")}</span></div>
    <div className="package-actions"><button className="text-button" disabled={disabled} onClick={() => onHistory(record)}>{t("История занятий")}</button>
      {role === 'teacher' && <>
        {!record.closed && !record.cancelled && record.balance > 0 && <button className="button secondary" disabled={disabled} onClick={() => onCharge(record)}>{t("Списать занятие")}</button>}
        {!record.closed && <button className="text-button" disabled={disabled} onClick={() => onClosePackage(record)}>{t("Закрыть пакет")}</button>}
      </>}
    </div>
  </li>)}</ul>;
}
