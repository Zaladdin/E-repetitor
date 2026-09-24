'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

import { useCallback, useEffect, useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import { formatPaymentAmount, type PaymentFilter, type PaymentRecord } from '@/lib/account-payments';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionFeedback, ConnectionHeading, PageContent } from './account-connections';
import { CreatePaymentRecord, PaymentCorrection, PaymentHistory } from './payment-record-forms';

interface PaymentProps { accountId: string; role: AccountRole; onSessionChanged: () => void }

export function AccountPayments(props: PaymentProps) {
  const [filter, setFilter] = useState<PaymentFilter | ''>('');
  return <PaymentJournal key={filter} {...props} filter={filter} onFilter={setFilter} />;
}

function PaymentJournal({ accountId, role, onSessionChanged, filter, onFilter }: PaymentProps & {
  filter: PaymentFilter | ''; onFilter: (value: PaymentFilter | '') => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const load = useCallback((offset: number) => accountApi.paymentRecords(accountId, role, offset, filter || undefined), [accountId, role, filter]);
  const page = useAccountPage(load, onSessionChanged);
  useEffect(() => accountApi.subscribePayments(accountId, page.reload), [accountId, page.reload]);
  const actions = useConnectionActions(onSessionChanged, page.reload);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<PaymentRecord | null>(null);
  const [correction, setCorrection] = useState<{ record: PaymentRecord; action: 'unpay' | 'cancel' } | null>(null);
  const blocked = actions.busy || page.loading || page.loadingMore;

  function changePaid(record: PaymentRecord, paid: boolean) {
    if (blocked || record.cancelled) return;
    if (!paid) setCorrection({ record, action: 'unpay' });
    else void actions.run(() => accountApi.markPayment(accountId, record.id, { version: record.version, paid: true }), t("Оплата отмечена."));
  }

  return <section className="account-payments" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={t("Учёт оплаты")} description={role === 'teacher' ? t("Отмечайте получение оплаты от учеников.") : role === 'parent' ? t("Статусы оплаты детей по всем доступным предметам.") : t("Отметки ваших преподавателей об оплате.")} onRefresh={page.reload} disabled={blocked} />
    <p className="account-payment-note">{t("Оплата производится вне платформы. Статусы здесь вручную отмечает преподаватель.")}</p>
    <div className="account-payment-toolbar">
      <div><label htmlFor={`${id}-filter`}>{t("Показать")}</label><select id={`${id}-filter`} value={filter} disabled={actions.busy} onChange={event => onFilter(event.target.value as PaymentFilter | '')}>
        <option value="">{t("Все записи")}</option><option value="unpaid">{t("Не оплачено")}</option><option value="paid">{t("Оплачено")}</option><option value="cancelled">{t("Отменённые записи")}</option>
      </select></div>
      {role === 'teacher' && <button className="button" disabled={actions.busy} onClick={() => setCreating(true)}><Plus size={18} aria-hidden="true" />{t("Добавить запись")}</button>}
    </div>
    <ActionFeedback actions={actions} />
    <PageContent page={page} disabled={actions.busy} emptyTitle={filter ? t("Нет записей с таким статусом") : t("Записей об оплате пока нет")} emptyText={role === 'teacher' ? t("Добавьте запись для ученика и укажите, за что оплата: занятие, пакет или период.") : t("Записи появятся, когда преподаватель добавит их в журнал оплаты.")}>
      <ul className="account-payment-list">{page.items.map(record => <li key={record.id}>
        <div className="account-payment-main"><h3>{record.title}</h3><p>{record.subjectName} · {role === 'teacher' ? record.studentName : role === 'parent' ? `${record.studentName} · ${record.teacherName}` : record.teacherName}</p>
          {role === 'teacher' && <small>{record.studentPublicId}</small>}
          <p className="account-payment-date">{record.paidMarkedAt ? t("Отмечено как оплаченное {value1}", { value1: dateTime(record.paidMarkedAt) }) : t("Запись от {value1}", { value1: dateTime(record.createdAt) })}</p>
        </div>
        <div className="account-payment-side"><strong className="account-payment-amount">{formatPaymentAmount(record)}</strong>
          <span className={`status status-${record.cancelled ? 'cancelled' : record.paid ? 'active' : 'pending'}`}>{record.cancelled ? t("Запись отменена") : record.paid ? t("Оплачено") : t("Не оплачено")}</span>
          {role === 'teacher' && <>
            {!record.cancelled && <label className="account-payment-check"><input type="checkbox" checked={record.paid} disabled={blocked} aria-label={t("Оплачено: {value1}, {value2}, {value3}", { value1: record.title, value2: record.studentName, value3: record.subjectName })} onChange={event => changePaid(record, event.target.checked)} /><span>{t("Оплачено")}</span></label>}
            <div className="account-payment-actions"><button className="text-button" disabled={blocked} onClick={() => setHistory(record)}>{t("История")}</button>
              {!record.cancelled && !record.paid && <button className="text-button danger-text" disabled={blocked} onClick={() => setCorrection({ record, action: 'cancel' })}>{t("Отменить запись")}</button>}
            </div>
          </>}
        </div>
      </li>)}</ul>
    </PageContent>
    {role === 'teacher' && creating && <CreatePaymentRecord accountId={accountId} onSessionChanged={onSessionChanged} onClose={() => setCreating(false)} onCreated={() => {
      setCreating(false);
      if (filter === 'paid' || filter === 'cancelled') onFilter('unpaid'); else page.reload();
    }} />}
    {role === 'teacher' && correction && <PaymentCorrection accountId={accountId} {...correction} onSessionChanged={onSessionChanged} onClose={() => setCorrection(null)} onChanged={() => { setCorrection(null); page.reload(); }} />}
    {role === 'teacher' && history && <PaymentHistory accountId={accountId} record={history} onSessionChanged={onSessionChanged} onClose={() => setHistory(null)} />}
  </section>;
}

function dateTime(value: string) { return new Date(value).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }); }
