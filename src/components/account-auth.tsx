'use client';

import { useI18n } from './locale-provider';


import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Mail } from 'lucide-react';
import { accountApi, accountErrorMessage, isStaleAccountRequest, type Account, type AccountRole } from '@/lib/account-api';
import { readRegistration, RegistrationValidationError } from '@/lib/account-registration';
import { TeacherProfileFields } from './teacher-profile-fields';

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  teacher: 'Преподаватель', student: 'Ученик', parent: 'Родитель',
};

type AuthView = 'login' | 'register' | 'forgot' | 'resend';
const HEADINGS: Record<AuthView, string> = {
  login: 'С возвращением', register: 'Создать аккаунт',
  forgot: 'Восстановить пароль', resend: 'Подтвердить email',
};

export function AccountAuth({ onLogin }: { onLogin: (account: Account) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<AuthView>('login');
  const [registrationRole, setRegistrationRole] = useState<AccountRole>('teacher');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const aliveRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    if (focusHeading.current) { headingRef.current?.focus(); focusHeading.current = false; }
  }, [view]);

  function navigate(next: AuthView) {
    focusHeading.current = next !== view;
    if (next !== view) setRegistrationRole('teacher');
    setError(''); setMessage(''); setView(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const email = String(values.get('email') ?? '').trim();
    const password = String(values.get('password') ?? '');
    setBusy(true); setError(''); setMessage('');
    try {
      if (view === 'login') {
        const result = await accountApi.login(email, password);
        if (aliveRef.current) onLogin(result.user);
      } else if (view === 'register') {
        const result = await accountApi.register(readRegistration(values));
        if (!aliveRef.current) return;
        form.reset(); navigate('login'); setMessage(result.message);
      } else {
        const result = view === 'forgot' ? await accountApi.forgotPassword(email) : await accountApi.resendVerification(email);
        if (aliveRef.current) setMessage(result.message);
      }
    } catch (failure) {
      if (aliveRef.current && !isStaleAccountRequest(failure)) {
        setError(failure instanceof RegistrationValidationError ? failure.message : accountErrorMessage(failure));
      }
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  return <section className="account-auth" aria-labelledby="auth-title">
    <h1 id="auth-title" ref={headingRef} tabIndex={-1}>{t(HEADINGS[view])}</h1>
    <p className="account-lead">{view === 'login' ? t("Один аккаунт для преподавания, учёбы и заботы о ребёнке.")
      : view === 'register' ? t("Всё для обучения. В одном месте.")
        : view === 'forgot' ? t("Отправим ссылку для создания нового пароля.") : t("Отправим новое письмо со ссылкой для подтверждения.")}</p>
    {(view === 'login' || view === 'register') && <div className="account-auth-switch" aria-label={t("Вход и регистрация")}>
      <button className={view === 'login' ? 'selected' : ''} aria-pressed={view === 'login'} disabled={busy} onClick={() => navigate('login')}>{t("Вход")}</button>
      <button className={view === 'register' ? 'selected' : ''} aria-pressed={view === 'register'} disabled={busy} onClick={() => navigate('register')}>{t("Регистрация")}</button>
    </div>}
    {message && <p className="success-message" role="status">{t(message)}</p>}
    <form className="account-form" onSubmit={submit} key={view} aria-busy={busy} aria-describedby={error ? 'auth-error' : undefined}>
      {view === 'register' && <>
        <fieldset className="account-roles" disabled={busy}>
          <legend>{t("Я регистрируюсь как")}</legend>
          {(Object.keys(ACCOUNT_ROLE_LABELS) as AccountRole[]).map((role) => <label key={role}>
            <input name="role" type="radio" value={role} checked={role === registrationRole} required
              onChange={() => { setRegistrationRole(role); setError(''); }} />
            <span>{t(ACCOUNT_ROLE_LABELS[role])}</span>
          </label>)}
        </fieldset>
        <label htmlFor="account-name">{registrationRole === 'teacher' ? t("ФИО") : t("Имя и фамилия")}</label>
        <input id="account-name" name="name" autoComplete="name" required minLength={2} maxLength={100} disabled={busy} />
        {registrationRole === 'teacher' && <TeacherProfileFields disabled={busy} />}
      </>}
      <label htmlFor="account-email">{t("Электронная почта")}</label>
      <input id="account-email" name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} />
      {(view === 'login' || view === 'register') && <>
        <label htmlFor="account-password">{t("Пароль")}</label>
        <input id="account-password" name="password" type="password" autoComplete={view === 'login' ? 'current-password' : 'new-password'}
          required minLength={view === 'register' ? 10 : undefined} maxLength={128} disabled={busy}
          aria-describedby={view === 'register' ? 'password-hint' : undefined} />
        {view === 'register' && <small id="password-hint">{t("Не менее 10 символов.")}</small>}
      </>}
      {view === 'register' && <div className="account-consents">
        <p>{t("Условия пилота: это тестовая версия. Используйте вымышленные данные; реальные данные учеников пока добавлять не нужно.")}</p>
        <label><input name="acceptTerms" type="checkbox" required disabled={busy} /><span>{t("Принимаю эти условия тестирования.")}</span></label>
        <label><input name="acceptPrivacy" type="checkbox" required disabled={busy} /><span>{registrationRole === 'teacher'
          ? t("Согласен на сохранение введённых ФИО, email, телефона, даты рождения, предмета и роли для работы тестового аккаунта.")
          : t("Согласен на сохранение введённых имени, email и роли для работы тестового аккаунта.")}</span></label>
      </div>}
      {error && <p id="auth-error" className="form-error" role="alert">{t(error)}</p>}
      <button className="button account-submit" disabled={busy} type="submit">
        {busy ? t("Подождите…") : view === 'login' ? t("Войти в аккаунт") : view === 'register' ? t("Создать аккаунт") : t("Отправить письмо")}
      </button>
    </form>
    {view === 'login' ? <div className="account-auth-links">
      <button className="text-button" disabled={busy} onClick={() => navigate('forgot')}>{t("Забыли пароль?")}</button>
      <button className="text-button" disabled={busy} onClick={() => navigate('resend')}>{t("Не пришло подтверждение?")}</button>
    </div> : <button className="text-button account-back" disabled={busy} onClick={() => navigate('login')}><ArrowLeft size={16} aria-hidden="true" />{t("Ко входу")}</button>}
    <LocalMailbox />
  </section>;
}

export interface AccountLink { kind: 'verify' | 'reset'; token: string }

export function AccountLinkForm({ link, onComplete, onCancel }: {
  link: AccountLink; onComplete: (message: string) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const aliveRef = useRef(false);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    setBusy(true); setError('');
    try {
      const result = link.kind === 'verify' ? await accountApi.verifyEmail(link.token) : await accountApi.resetPassword(link.token, password);
      if (aliveRef.current) onComplete(result.message);
    } catch (failure) {
      if (aliveRef.current && !isStaleAccountRequest(failure)) setError(accountErrorMessage(failure));
    } finally { if (aliveRef.current) setBusy(false); }
  }
  return <section className="account-auth" aria-labelledby="link-title">
    <h1 id="link-title">{link.kind === 'verify' ? t("Подтвердите вашу почту") : t("Новый пароль")}</h1>
    <p className="account-lead">{link.kind === 'verify' ? t("Нажмите кнопку, чтобы активировать аккаунт. После этого можно войти.") : t("После смены пароля нужно будет войти заново на всех устройствах.")}</p>
    <form className="account-form" onSubmit={submit} aria-busy={busy} aria-describedby={error ? 'link-error' : undefined}>
      {link.kind === 'reset' && <>
        <label htmlFor="reset-password">{t("Новый пароль")}</label>
        <input id="reset-password" name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required disabled={busy} aria-describedby="reset-hint" />
        <small id="reset-hint">{t("Не менее 10 символов.")}</small>
      </>}
      {error && <p id="link-error" className="form-error" role="alert">{t(error)}</p>}
      <button className="button account-submit" type="submit" disabled={busy}>{busy ? t("Подождите…") : link.kind === 'verify' ? t("Подтвердить email") : t("Сохранить пароль")}</button>
    </form>
    <button className="text-button account-back" onClick={onCancel} disabled={busy}><ArrowLeft size={16} aria-hidden="true" />{t("Ко входу")}</button>
  </section>;
}

function LocalMailbox() {
  const { t } = useI18n();
  if (process.env.NODE_ENV !== 'development') return null;
  return <aside className="account-mailbox"><Mail size={18} aria-hidden="true" /><p>{t("В локальной разработке письма попадают в")}{' '}<a href="http://127.0.0.1:8025" target="_blank" rel="noopener noreferrer">{t("тестовый почтовый ящик")}</a>{t(". На настоящую почту они не отправляются.")}</p></aside>;
}
