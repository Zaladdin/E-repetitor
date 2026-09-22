'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountApi } from '@/lib/account-api';
import { PAYMENT_CURRENCIES, formatPaymentAmount, parsePaymentAmount, type PaymentCurrency, type PaymentHistoryEvent, type PaymentRecord } from '@/lib/account-payments';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionFeedback, PageContent } from './account-connections';
import { Modal } from './ui';

interface FormProps { accountId: string; onSessionChanged: () => void; onClose: () => void }

export function CreatePaymentRecord({ accountId, onSessionChanged, onClose, onCreated }: FormProps & { onCreated: () => void }) {
  const id = useId();
  const getEnrollments = useCallback((offset: number) => accountApi.enrollments(accountId, 'teacher', offset), [accountId]);
  const enrollments = useAccountPage(getEnrollments, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, onCreated);
  const [inputError, setInputError] = useState('');
  const [amount, setAmount] = useState('');
  const [dirty, setDirty] = useState(false);
  const [closing, setClosing] = useState(false);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const closingRef = useRef<HTMLDivElement>(null);
  const active = enrollments.items.filter(item => item.status === 'active');
  const blocked = actions.busy || closing || enrollments.loading || enrollments.loadingMore || !!enrollments.error || !active.length;
  useEffect(() => { if (inputError) errorRef.current?.focus(); }, [inputError]);
  useEffect(() => { if (closing) closingRef.current?.focus(); }, [closing]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const data = new FormData(event.currentTarget);
    let amountMinor: number | undefined;
    try { amountMinor = parsePaymentAmount(amount); setInputError(''); }
    catch (error) { setInputError(error instanceof Error ? error.message : 'Проверьте сумму.'); return; }
    const input = { enrollmentId: String(data.get('enrollmentId')), title: String(data.get('title')).trim(),
      ...(amountMinor === undefined ? {} : { amountMinor, currency: String(data.get('currency')) as PaymentCurrency }) };
    const payload = JSON.stringify(input);
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    await actions.run(() => accountApi.createPaymentRecord(accountId, { ...input, requestId: retry.current!.key }), 'Запись добавлена.');
  }
  function close() { if (!actions.busy) { if (dirty) setClosing(true); else onClose(); } }

  return <Modal title="Добавить запись об оплате" onClose={close}>
    <p className="muted">Создайте запись за занятие, пакет или период. Получив оплату, отметьте её галочкой в журнале.</p>
    <form className="account-form account-payment-form" onSubmit={create} onChange={() => setDirty(true)} aria-busy={actions.busy}>
      <label htmlFor={`${id}-enrollment`}>Ученик и предмет</label><select id={`${id}-enrollment`} name="enrollmentId" required defaultValue="" disabled={blocked}>
        <option value="">Выберите активное обучение</option>{active.map(item => <option key={item.id} value={item.id}>{item.studentName ?? item.studentPublicId} · {item.subjectName}</option>)}
      </select>
      {enrollments.loading && <p role="status" className="muted">Загружаем учеников…</p>}
      {enrollments.error && <p className="form-error" role="alert">{enrollments.error}</p>}
      {!enrollments.loading && !enrollments.error && !active.length && <p className="account-list-help">Нет активного обучения среди загруженных записей. Подключите ученика или загрузите остальные записи.</p>}
      <div className="account-payment-enrollment-actions"><button type="button" className="text-button" disabled={actions.busy || enrollments.loading || enrollments.loadingMore} onClick={enrollments.reload}>Обновить учеников</button>
        {enrollments.nextOffset < enrollments.total && <button type="button" className="text-button" disabled={actions.busy || enrollments.loading || enrollments.loadingMore} onClick={() => void enrollments.loadMore()}>{enrollments.loadingMore ? 'Загружаем…' : 'Загрузить ещё'}</button>}
      </div>
      <label htmlFor={`${id}-title`}>За что оплата</label><input id={`${id}-title`} name="title" required maxLength={200} placeholder="Например, математика за сентябрь" disabled={blocked} aria-describedby={`${id}-shared`} />
      <p id={`${id}-shared`} className="account-list-help muted">Название, сумма и статус видны ученику и родителю с подтверждённым доступом.</p>
      <div className="account-payment-money-fields"><div><label htmlFor={`${id}-amount`}>Сумма · необязательно</label><input id={`${id}-amount`} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} maxLength={16} placeholder="120,00" disabled={blocked} aria-describedby={`${id}-amount-help`} /></div>
        <div><label htmlFor={`${id}-currency`}>Валюта</label><select id={`${id}-currency`} name="currency" defaultValue="AZN" disabled={blocked || !amount.trim()}>{PAYMENT_CURRENCIES.map(currency => <option key={currency}>{currency}</option>)}</select></div>
      </div>
      <p id={`${id}-amount-help`} className="account-list-help muted">Если нужен только статус, оставьте сумму пустой. Сумма относится ко всей записи.</p>
      {inputError && <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">{inputError}</p>}
      <ActionFeedback actions={actions} />
      <div className="form-actions"><button type="button" className="button secondary" disabled={actions.busy} onClick={close}>Закрыть</button><button className="button" disabled={blocked || closing}>{actions.busy ? 'Сохраняем…' : 'Добавить как неоплаченную'}</button></div>
    </form>
    {closing && <div className="account-test-confirm" role="group" aria-label="Закрытие записи" ref={closingRef} tabIndex={-1}><p>Закрыть форму без сохранения?</p><div className="form-actions"><button className="button secondary" onClick={() => setClosing(false)}>Продолжить заполнение</button><button className="button" onClick={onClose}>Закрыть без сохранения</button></div></div>}
  </Modal>;
}

export function PaymentCorrection({ accountId, record, action, onSessionChanged, onClose, onChanged }: FormProps & {
  record: PaymentRecord; action: 'unpay' | 'cancel'; onChanged: () => void;
}) {
  const id = useId();
  const actions = useConnectionActions(onSessionChanged, onChanged);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    await actions.run(() => action === 'unpay'
      ? accountApi.markPayment(accountId, record.id, { version: record.version, paid: false, reason })
      : accountApi.cancelPaymentRecord(accountId, record.id, { version: record.version, reason }), action === 'unpay' ? 'Отметка снята.' : 'Запись отменена.');
  }
  return <Modal title={action === 'unpay' ? 'Снять отметку «Оплачено»' : 'Отменить запись'} onClose={() => { if (!actions.busy) onClose(); }}>
    <p className="account-payment-dialog-summary">{record.studentName} · {record.subjectName}<br /><strong>{record.title}</strong><br />{formatPaymentAmount(record)}</p>
    <p className="muted">{action === 'unpay' ? 'Запись снова будет показана как неоплаченная. Предыдущая отметка останется в истории.' : 'Ошибочная запись останется в истории со статусом «Отменена». Восстановить её нельзя; при необходимости создайте новую.'}</p>
    <form className="account-form account-payment-form" onSubmit={submit} aria-busy={actions.busy}>
      <label htmlFor={`${id}-reason`}>Причина исправления</label><textarea id={`${id}-reason`} name="reason" required minLength={3} maxLength={1000} rows={3} disabled={actions.busy} aria-describedby={`${id}-reason-help`} />
      <p id={`${id}-reason-help`} className="account-list-help muted">Причину видите только вы в истории записи.</p>
      <ActionFeedback actions={actions} />
      <div className="form-actions"><button type="button" className="button secondary" disabled={actions.busy} onClick={onClose}>Закрыть</button><button className="button" disabled={actions.busy}>{actions.busy ? 'Сохраняем…' : action === 'unpay' ? 'Снять отметку' : 'Отменить запись'}</button></div>
    </form>
  </Modal>;
}

const HISTORY_LABELS: Record<PaymentHistoryEvent['type'], string> = { created: 'Запись создана', marked_paid: 'Отмечено «Оплачено»', marked_unpaid: 'Отметка оплаты снята', cancelled: 'Запись отменена' };

export function PaymentHistory({ accountId, record, onSessionChanged, onClose }: FormProps & { record: PaymentRecord }) {
  const load = useCallback((offset: number) => accountApi.paymentHistory(accountId, record.id, offset), [accountId, record.id]);
  const history = useAccountPage(load, onSessionChanged);
  return <Modal title="История оплаты" onClose={onClose}>
    <p className="account-payment-dialog-summary">{record.studentName} · {record.subjectName}<br /><strong>{record.title}</strong><br />{formatPaymentAmount(record)}</p>
    <PageContent page={history} emptyTitle="История пока пуста" emptyText="Изменения статуса будут отображаться здесь." disabled={false}>
      <ol className="account-payment-history">{history.items.map(event => <li key={event.id}><h3>{HISTORY_LABELS[event.type]}</h3><p><time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time> · {event.actorName}</p>
        {event.previousPaidMarkedAt && <p>Предыдущая отметка оплаты: {dateTime(event.previousPaidMarkedAt)}</p>}{event.reason && <p className="account-payment-reason">Причина: {event.reason}</p>}
      </li>)}</ol>
    </PageContent>
    <div className="form-actions"><button className="button secondary" onClick={onClose}>Закрыть</button></div>
  </Modal>;
}

function dateTime(value: string) { return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }); }
