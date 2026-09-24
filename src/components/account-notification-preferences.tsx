'use client';

import { useI18n } from './locale-provider';


import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountApi, accountErrorMessage, accountSessionChanged, isStaleAccountRequest } from '@/lib/account-api';
import { NOTIFICATION_LABELS, type NotificationPreference } from '@/lib/account-notifications';

export function AccountNotificationPreferences({ accountId, onSessionChanged }: { accountId: string; onSessionChanged: () => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<NotificationPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const sessionChanged = useRef(onSessionChanged);
  useEffect(() => { sessionChanged.current = onSessionChanged; }, [onSessionChanged]);
  useEffect(() => {
    let alive = true;
    accountApi.notificationPreferences(accountId).then(result => { if (alive) setItems(result.items); }).catch((failure: unknown) => {
      if (!alive || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) sessionChanged.current(); else setError(accountErrorMessage(failure));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [accountId, revision]);
  return <div className="notification-preferences">
    <p className="muted">{t("Настройки общие для всех ваших ролей. Уведомления в кабинете включены по умолчанию, письма можно включить отдельно.")}</p>
    <p className="muted">{t("Изменения действуют на новые события. Отключение писем также отменяет ещё не отправленные письма этого типа. Прежние уведомления в кабинете сохраняются, пока доступно обучение.")}</p>
    {loading ? <p role="status">{t("Загружаем настройки…")}</p> : error ? <div><p role="alert" className="form-error">{t(error)}</p><button className="text-button" onClick={() => { setLoading(true); setError(''); setRevision(value => value + 1); }}>{t("Повторить загрузку")}</button></div>
      : <div className="notification-preference-list">{items.map(item => <PreferenceRow key={item.type} item={item} accountId={accountId} onSessionChanged={onSessionChanged} />)}</div>}
  </div>;
}

function PreferenceRow({ item, accountId, onSessionChanged }: { item: NotificationPreference; accountId: string; onSessionChanged: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [saved, setSaved] = useState(item);
  const [draft, setDraft] = useState({ inApp: item.inApp, email: item.email });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(false), inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const changed = draft.inApp !== saved.inApp || draft.email !== saved.email;

  async function run(refresh: boolean) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = refresh
        ? (await accountApi.notificationPreferences(accountId)).items.find(row => row.type === item.type)
        : await accountApi.saveNotificationPreference(accountId, item.type, { ...draft, version: saved.version });
      if (!result) throw new Error('Missing notification preference');
      if (!alive.current) return;
      setSaved(result); setDraft({ inApp: result.inApp, email: result.email });
      setMessage(refresh ? t("Загружены актуальные настройки этого типа.") : t("Настройки сохранены."));
    } catch (failure) {
      if (!alive.current || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) onSessionChanged(); else setError(accountErrorMessage(failure));
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (changed) void run(false); }
  return <form className="notification-preference-row" onSubmit={submit} aria-busy={busy} aria-labelledby={`${id}-title`}>
    <div><h3 id={`${id}-title`}>{t(NOTIFICATION_LABELS[item.type])}</h3>{item.type === 'lesson_reminder' && <p>{t("В течение часа до начала занятия.")}</p>}{item.type === 'test_assigned' && <p>{t("Только для роли ученика.")}</p>}</div>
    <fieldset disabled={busy}><legend className="sr-only">{t("Каналы:")}{' '}{t(NOTIFICATION_LABELS[item.type])}</legend>
      <label><input type="checkbox" checked={draft.inApp} onChange={event => { setDraft(value => ({ ...value, inApp: event.target.checked })); setMessage(''); }} />{t("В кабинете")}</label>
      <label><input type="checkbox" checked={draft.email} onChange={event => { setDraft(value => ({ ...value, email: event.target.checked })); setMessage(''); }} />{t("По email")}</label>
      <button className="button secondary small" type="submit" disabled={!changed}>{busy ? t("Сохраняем…") : t("Сохранить")}</button>
    </fieldset>
    {error && <div className="notification-preference-feedback"><p role="alert" className="form-error">{t(error)}</p><button type="button" className="text-button" disabled={busy} onClick={() => void run(true)}>{t("Загрузить актуальные настройки этого типа")}</button><p className="muted">{t("Это заменит несохранённые изменения в этой строке.")}</p></div>}
    <p className="notification-preference-feedback" role="status">{t(message)}</p>
  </form>;
}
