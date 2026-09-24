'use client';

import { useI18n } from './locale-provider';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountApi } from '@/lib/account-api';
import type { LessonPackage, PackageHistoryEvent } from '@/lib/account-packages';
import { PAYMENT_CURRENCIES, parsePaymentAmount, type PaymentCurrency } from '@/lib/account-payments';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionFeedback } from './account-connections';
import { PackageDialog, packageDateTime, type PackageFormProps } from './package-dialog';

export function CreatePackage({ accountId, onSessionChanged, onClose, onChanged }: PackageFormProps) {
  const { t, locale } = useI18n();
  const id = useId();
  const load = useCallback((offset: number) => accountApi.enrollments(accountId, 'teacher', offset), [accountId]);
  const enrollments = useAccountPage(load, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, onChanged);
  const [dirty, setDirty] = useState(false);
  const [amount, setAmount] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');
  const [inputError, setInputError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const active = enrollments.items.filter(item => item.status === 'active');
  const blocked = actions.busy || enrollments.loading || enrollments.loadingMore || !!enrollments.error || !active.length;
  useEffect(() => { if (inputError) errorRef.current?.focus(); }, [inputError]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') ?? '').trim();
    const lessonCount = Number(data.get('lessonCount'));
    let amountMinor: number | undefined;
    try { amountMinor = parsePaymentAmount(amount); }
    catch (error) { setInputError(error instanceof Error ? error.message : t("Проверьте сумму.")); return; }
    if (!title || !Number.isInteger(lessonCount) || lessonCount < 1 || lessonCount > 1000 || !amountMinor || !active.some(item => item.id === enrollmentId)) {
      setInputError(t("Выберите ученика, укажите название, от 1 до 1000 занятий и сумму пакета.")); return;
    }
    setInputError('');
    const input = { enrollmentId, title, lessonCount, amountMinor, currency: String(data.get('currency')) as PaymentCurrency };
    const payload = JSON.stringify(input);
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    const requestId = retry.current.key;
    await actions.run(() => accountApi.createPackage(accountId, { ...input, requestId }), t("Пакет добавлен."));
  }

  return <PackageDialog title={t("Добавить пакет занятий")} dirty={dirty} busy={actions.busy} onClose={onClose}>{close => <>
    <p className="muted">{t("Пакет появится в журнале оплаты как неоплаченный. Получив оплату вне платформы, преподаватель ставит галочку в журнале.")}</p>
    <form className="account-form account-payment-form" onSubmit={submit} onChange={() => setDirty(true)} aria-busy={actions.busy}>
      <label htmlFor={`${id}-enrollment`}>{t("Ученик и предмет")}</label><select id={`${id}-enrollment`} name="enrollmentId" required value={enrollmentId} onChange={event => setEnrollmentId(event.target.value)} disabled={blocked}>
        <option value="">{t("Выберите активное обучение")}</option>{active.map(item => <option key={item.id} value={item.id}>{item.studentName ?? item.studentPublicId} · {item.subjectName}</option>)}
      </select>
      {enrollments.loading && <p role="status" className="muted">{t("Загружаем учеников…")}</p>}
      {enrollments.error && <p className="form-error" role="alert">{t(enrollments.error)}</p>}
      {!enrollments.loading && !enrollments.error && !active.length && <p className="account-list-help">{t("Нет активного обучения среди загруженных записей. Подключите ученика или загрузите остальные записи.")}</p>}
      {enrollmentId && !enrollments.loading && !enrollments.error && !active.some(item => item.id === enrollmentId) && <p className="account-list-help" role="status">{t("Выбранное обучение отсутствует среди загруженных активных записей. Загрузите остальные записи или выберите другое обучение.")}</p>}
      <div className="account-payment-enrollment-actions"><button type="button" className="text-button" disabled={actions.busy || enrollments.loading || enrollments.loadingMore} onClick={enrollments.reload}>{t("Обновить учеников")}</button>
        {enrollments.nextOffset < enrollments.total && <button type="button" className="text-button" disabled={actions.busy || enrollments.loading || enrollments.loadingMore} onClick={() => void enrollments.loadMore()}>{enrollments.loadingMore ? t("Загружаем…") : t("Загрузить ещё")}</button>}
      </div>
      <label htmlFor={`${id}-title`}>{t("Название пакета")}</label><input id={`${id}-title`} name="title" required maxLength={200} placeholder={t("Например, математика · 8 занятий")} disabled={blocked} aria-describedby={`${id}-shared`} />
      <p id={`${id}-shared`} className="account-list-help muted">{t("Название, сумма и остаток видны ученику и родителю с подтверждённым доступом.")}</p>
      <label htmlFor={`${id}-count`}>{t("Количество занятий")}</label><input id={`${id}-count`} type="number" name="lessonCount" required min={1} max={1000} step={1} defaultValue={8} disabled={blocked} />
      <div className="account-payment-money-fields"><div><label htmlFor={`${id}-amount`}>{t("Сумма за весь пакет")}</label><input id={`${id}-amount`} inputMode="decimal" required value={amount} onChange={event => setAmount(event.target.value)} maxLength={16} placeholder={locale === 'en' ? '120.00' : '120,00'} disabled={blocked} /></div>
        <div><label htmlFor={`${id}-currency`}>{t("Валюта")}</label><select id={`${id}-currency`} name="currency" defaultValue="AZN" disabled={blocked}>{PAYMENT_CURRENCIES.map(currency => <option key={currency}>{currency}</option>)}</select></div>
      </div>
      {inputError && <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">{t(inputError)}</p>}
      <ActionFeedback actions={actions} />
      <div className="form-actions"><button type="button" className="button secondary" disabled={actions.busy} onClick={close}>{t("Закрыть")}</button><button className="button" disabled={blocked}>{actions.busy ? t("Сохраняем…") : t("Добавить пакет")}</button></div>
    </form>
  </>}</PackageDialog>;
}

export function ChargePackage({ accountId, record, onSessionChanged, onClose, onChanged }: PackageFormProps & { record: LessonPackage }) {
  const { t } = useI18n();
  const id = useId();
  const load = useCallback((offset: number) => accountApi.packageLessons(accountId, record.id, offset), [accountId, record.id]);
  const lessons = useAccountPage(load, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, onChanged);
  const [lessonId, setLessonId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [inputError, setInputError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const selected = lessons.items.find(item => item.id === lessonId);
  const blocked = actions.busy || lessons.loading || lessons.loadingMore || !!lessons.error || record.closed || record.cancelled || record.balance < 1;
  useEffect(() => { if (inputError) errorRef.current?.focus(); }, [inputError]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || !selected) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (selected.status === 'student_absent' && reason.length < 3) { setInputError(t("Укажите причину списания пропущенного занятия, не менее 3 символов.")); return; }
    setInputError('');
    const input = { version: record.version, lessonId: selected.id, lessonVersion: selected.version, ...(reason ? { reason } : {}) };
    const payload = JSON.stringify(input);
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    const requestId = retry.current.key;
    await actions.run(() => accountApi.chargePackage(accountId, record.id, { ...input, requestId }), t("Занятие списано."));
  }
  return <PackageDialog title={t("Списать занятие из пакета")} dirty={dirty} busy={actions.busy} onClose={onClose}>{close => <>
    <PackageSummary record={record} />
    <p className="muted">{t("Выберите прошедшее занятие с отметкой «Проведено» или «Ученик отсутствовал». Одно занятие списывается только из одного пакета.")}</p>
    <form className="account-form account-payment-form" onSubmit={submit} onChange={() => setDirty(true)} aria-busy={actions.busy}>
      <label htmlFor={`${id}-lesson`}>{t("Занятие")}</label><select id={`${id}-lesson`} required value={lessonId} disabled={blocked} onChange={event => setLessonId(event.target.value)}>
        <option value="">{t("Выберите занятие")}</option>{lessons.items.map(lesson => <option key={lesson.id} value={lesson.id}>{packageDateTime(lesson.startsAt)} · {lesson.durationMin}{' '}{t("мин ·")}{' '}{lesson.status === 'completed' ? t("Проведено") : t("Ученик отсутствовал")}</option>)}
      </select>
      {lessons.loading && <p role="status" className="muted">{t("Загружаем занятия…")}</p>}
      {lessons.error && <p className="form-error" role="alert">{t(lessons.error)}</p>}
      {!lessons.loading && !lessons.error && !lessons.items.length && <p className="account-list-help muted">{t("Подходящих занятий нет. Сначала отметьте прошедшее занятие в расписании. Уже списанные занятия сюда не попадают.")}</p>}
      <div className="account-payment-enrollment-actions"><button type="button" className="text-button" disabled={actions.busy || lessons.loading || lessons.loadingMore} onClick={lessons.reload}>{t("Обновить занятия")}</button>
        {lessons.nextOffset < lessons.total && <button type="button" className="text-button" disabled={actions.busy || lessons.loading || lessons.loadingMore} onClick={() => void lessons.loadMore()}>{lessons.loadingMore ? t("Загружаем…") : t("Загрузить ещё")}</button>}
      </div>
      <label htmlFor={`${id}-reason`}>{t("Причина списания")}{selected?.status === 'student_absent' ? t(" · обязательна при пропуске") : t(" · необязательно")}</label>
      <textarea id={`${id}-reason`} name="reason" required={selected?.status === 'student_absent'} minLength={3} maxLength={1000} rows={3} disabled={blocked} aria-describedby={`${id}-private`} />
      <p id={`${id}-private`} className="account-list-help muted">{t("Причину видите только вы. Семья видит дату занятия и изменение остатка.")}</p>
      {inputError && <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">{t(inputError)}</p>}
      <ActionFeedback actions={actions} />
      {actions.error && <p className="account-list-help muted">{t("Если пакет изменился в другом окне, закройте форму, обновите список пакетов и откройте действие заново.")}</p>}
      <div className="form-actions"><button type="button" className="button secondary" disabled={actions.busy} onClick={close}>{t("Закрыть")}</button><button className="button" disabled={blocked || !selected}>{actions.busy ? t("Списываем…") : t("Списать 1 занятие")}</button></div>
    </form>
  </>}</PackageDialog>;
}

export function PackageCorrection({ accountId, record, action, entry, onSessionChanged, onClose, onChanged }: PackageFormProps & {
  record: LessonPackage; action: 'close' | 'reverse'; entry?: PackageHistoryEvent;
}) {
  const { t } = useI18n();
  const id = useId();
  const actions = useConnectionActions(onSessionChanged, onChanged);
  const [dirty, setDirty] = useState(false);
  const [inputError, setInputError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const validAction = action === 'close' ? !record.closed : entry?.type === 'charged' && !entry.reversed;
  useEffect(() => { if (inputError) errorRef.current?.focus(); }, [inputError]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actions.busy || !validAction) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (reason.length < 3) { setInputError(t("Укажите причину, не менее 3 символов.")); return; }
    setInputError('');
    if (action === 'close') {
      await actions.run(() => accountApi.closePackage(accountId, record.id, { version: record.version, reason }), t("Пакет закрыт."));
    } else if (entry) {
      const input = { version: record.version, entryId: entry.id, reason };
      const payload = JSON.stringify(input);
      if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
      const requestId = retry.current.key;
      await actions.run(() => accountApi.reversePackageCharge(accountId, record.id, { ...input, requestId }), t("Занятие возвращено в пакет."));
    }
  }
  return <PackageDialog title={action === 'close' ? t("Закрыть пакет занятий") : t("Вернуть занятие в пакет")} dirty={dirty} busy={actions.busy} onClose={onClose}>{close => <>
    <PackageSummary record={record} />
    {entry?.lessonStartsAt && <p className="account-payment-dialog-summary">{t("Занятие:")}{' '}{packageDateTime(entry.lessonStartsAt)}</p>}
    <p className="muted">{action === 'close' ? t("Новые списания будут недоступны. Остаток и история сохранятся. Ошибочное списание можно вернуть и после закрытия пакета.") : t("Остаток увеличится на одно занятие. Исходное списание и исправление останутся в истории. Отметка оплаты не изменится.")}</p>
    <form className="account-form account-payment-form" onSubmit={submit} onChange={() => setDirty(true)} aria-busy={actions.busy}>
      <label htmlFor={`${id}-reason`}>{t("Причина")}{action === 'close' ? t(" закрытия") : t(" исправления")}</label><textarea id={`${id}-reason`} name="reason" required minLength={3} maxLength={1000} rows={3} disabled={actions.busy} aria-describedby={`${id}-private`} />
      <p id={`${id}-private`} className="account-list-help muted">{t("Причину видите только вы в истории пакета.")}</p>
      {inputError && <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">{t(inputError)}</p>}
      <ActionFeedback actions={actions} />
      {actions.error && <p className="account-list-help muted">{t("Если пакет изменился в другом окне, закройте форму, обновите список пакетов и откройте действие заново.")}</p>}
      <div className="form-actions"><button type="button" className="button secondary" disabled={actions.busy} onClick={close}>{t("Закрыть форму")}</button><button className="button" disabled={actions.busy || !validAction}>{actions.busy ? t("Сохраняем…") : action === 'close' ? t("Закрыть пакет") : t("Вернуть 1 занятие")}</button></div>
    </form>
  </>}</PackageDialog>;
}

export function PackageSummary({ record }: { record: LessonPackage }) {
  const { t } = useI18n();
  return <p className="account-payment-dialog-summary">{record.studentName} · {record.subjectName}<br /><strong>{record.title}</strong><br />{t("Осталось")}{' '}{record.balance}{' '}{t("из")}{' '}{record.lessonCount}{' '}{t("занятий")}</p>;
}
