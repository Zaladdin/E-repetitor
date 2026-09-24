'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AccountApiError, accountApi, accountErrorMessage, isStaleAccountRequest, type InvitationPreview } from '@/lib/account-api';

export function InvitationActivation({ token, onComplete, onCancel }: {
  token: string; onComplete: (message: string) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [existingAccount, setExistingAccount] = useState(false);
  const alive = useRef(false);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { alive.current = true; heading.current?.focus(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    accountApi.previewInvitation(token).then((result) => {
      if (current) { setPreview(result); setLoadError(''); }
    }).catch((failure: unknown) => {
      if (current && !isStaleAccountRequest(failure)) setLoadError(accountErrorMessage(failure));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [token, revision]);
  useEffect(() => { if (error) feedback.current?.focus(); }, [error]);

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || submitting.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (['acceptTerms', 'acceptPrivacy', 'acceptEnrollment'].some(name => data.get(name) !== 'on')) {
      setError(t("Для создания аккаунта нужны ваши согласия и подтверждение обучения.")); return;
    }
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await accountApi.activateInvitation({ token,
        name: String(data.get('name') ?? '').trim(), password: String(data.get('password') ?? ''),
        acceptTerms: true, acceptPrivacy: true, acceptEnrollment: true,
      });
      if (alive.current) { form.reset(); onComplete(result.message); }
    } catch (failure) {
      if (!alive.current || isStaleAccountRequest(failure)) return;
      setError(accountErrorMessage(failure));
      if (failure instanceof AccountApiError && failure.code === 'account_exists') { form.reset(); setExistingAccount(true); }
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <section className="account-auth invitation-activation" aria-labelledby="invitation-title">
    <p className="account-eyebrow">{t("Приглашение к обучению")}</p>
    <h1 id="invitation-title" ref={heading} tabIndex={-1}>{t("Ваш первый предмет")}</h1>
    {loading ? <p role="status" className="account-lead">{t("Проверяем приглашение…")}</p>
      : loadError ? <div className="account-invitation-error"><p className="form-error" role="alert">{t(loadError)}</p>
        <p className="muted">{t("Если ссылка уже использована, войдите в аккаунт. Для истёкшей или отозванной ссылки понадобится новое приглашение преподавателя.")}</p>
        <button className="button secondary" onClick={() => { setLoading(true); setLoadError(''); setRevision(value => value + 1); }}>{t("Проверить ещё раз")}</button></div>
        : preview && <>
          <div className="invitation-summary"><h2>{preview.subjectName}</h2><p>{t("Преподаватель: ")}{preview.teacherName}</p><small>{t("Приглашение действительно до ")}{new Date(preview.expiresAt).toLocaleDateString(localeTag())}.</small></div>
          <p className="account-lead">{t("Создайте собственный аккаунт ученика на адрес, куда пришло это письмо. Student ID будет единым для всех ваших преподавателей.")}</p>
          {!existingAccount && <form className="account-form" onSubmit={activate} aria-busy={busy} aria-describedby={error ? 'invitation-error' : undefined}>
            <label htmlFor="invitation-name">{t("Ваше имя и фамилия")}</label>
            <input id="invitation-name" name="name" autoComplete="name" minLength={2} maxLength={100} required disabled={busy} />
            <label htmlFor="invitation-password">{t("Придумайте пароль")}</label>
            <input id="invitation-password" name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required disabled={busy} aria-describedby="invitation-password-hint" />
            <small id="invitation-password-hint">{t("Не менее 10 символов. Преподаватель не получает ваш пароль.")}</small>
            <div className="account-consents">
              <p>{t("Условия пилота: это тестовая версия. Используйте вымышленные данные; реальные данные учеников пока добавлять не нужно.")}</p>
              <label><input type="checkbox" name="acceptTerms" required disabled={busy} /><span>{t("Принимаю эти условия тестирования.")}</span></label>
              <label><input type="checkbox" name="acceptPrivacy" required disabled={busy} /><span>{t("Согласен на сохранение введённых имени, email и роли для работы тестового аккаунта.")}</span></label>
              <label><input type="checkbox" name="acceptEnrollment" required disabled={busy} /><span>{t('Подтверждаю обучение по предмету «{subject}» у преподавателя {teacher}.', { subject: preview.subjectName, teacher: preview.teacherName })}</span></label>
            </div>
            <button className="button account-submit" type="submit" disabled={busy}>{busy ? t("Создаём аккаунт…") : t("Создать аккаунт и подключиться")}</button>
          </form>}
          <p className="form-error" id="invitation-error" role="alert" tabIndex={-1} ref={feedback}>{t(error)}</p>
          <p className="account-invitation-existing muted">{t("Уже есть аккаунт? Войдите и передайте преподавателю ваш Student ID. Существующие аккаунты автоматически не объединяются с приглашением.")}</p>
        </>}
    <button className="text-button account-back" disabled={busy} onClick={onCancel}><ArrowLeft size={16} aria-hidden="true" />{t("Ко входу")}</button>
  </section>;
}
