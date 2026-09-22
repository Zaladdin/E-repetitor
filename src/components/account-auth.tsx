'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Mail } from 'lucide-react';
import { accountApi, accountErrorMessage, isStaleAccountRequest, type Account, type AccountRole } from '@/lib/account-api';

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  teacher: 'Преподаватель', student: 'Ученик', parent: 'Родитель',
};

type AuthView = 'login' | 'register' | 'forgot' | 'resend';
const HEADINGS: Record<AuthView, string> = {
  login: 'С возвращением', register: 'Создайте свой аккаунт',
  forgot: 'Восстановить пароль', resend: 'Подтвердить email',
};

export function AccountAuth({ onLogin }: { onLogin: (account: Account) => void }) {
  const [view, setView] = useState<AuthView>('login');
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
        const role = String(values.get('role')) as AccountRole;
        const result = await accountApi.register({
          name: String(values.get('name') ?? '').trim(), email, password, role,
          acceptTerms: values.get('acceptTerms') === 'on', acceptPrivacy: values.get('acceptPrivacy') === 'on',
        });
        if (!aliveRef.current) return;
        form.reset(); navigate('login'); setMessage(result.message);
      } else {
        const result = view === 'forgot' ? await accountApi.forgotPassword(email) : await accountApi.resendVerification(email);
        if (aliveRef.current) setMessage(result.message);
      }
    } catch (failure) {
      if (aliveRef.current && !isStaleAccountRequest(failure)) setError(accountErrorMessage(failure));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  return <section className="account-auth" aria-labelledby="auth-title">
    <p className="account-eyebrow">Ваше учебное пространство</p>
    <h1 id="auth-title" ref={headingRef} tabIndex={-1}>{HEADINGS[view]}</h1>
    <p className="account-lead">{view === 'login' ? 'Один аккаунт для преподавания, учёбы и заботы о ребёнке.'
      : view === 'register' ? 'Выберите первую роль. Другую можно добавить в этом же аккаунте.'
        : view === 'forgot' ? 'Отправим ссылку для создания нового пароля.' : 'Отправим новое письмо со ссылкой для подтверждения.'}</p>
    {(view === 'login' || view === 'register') && <div className="account-auth-switch" aria-label="Вход и регистрация">
      <button className={view === 'login' ? 'selected' : ''} aria-pressed={view === 'login'} disabled={busy} onClick={() => navigate('login')}>Вход</button>
      <button className={view === 'register' ? 'selected' : ''} aria-pressed={view === 'register'} disabled={busy} onClick={() => navigate('register')}>Регистрация</button>
    </div>}
    {message && <p className="success-message" role="status">{message}</p>}
    <form className="account-form" onSubmit={submit} key={view} aria-busy={busy} aria-describedby={error ? 'auth-error' : undefined}>
      {view === 'register' && <>
        <fieldset className="account-roles" disabled={busy}>
          <legend>Я регистрируюсь как</legend>
          {(Object.keys(ACCOUNT_ROLE_LABELS) as AccountRole[]).map((role) => <label key={role}>
            <input name="role" type="radio" value={role} defaultChecked={role === 'teacher'} required />
            <span>{ACCOUNT_ROLE_LABELS[role]}</span>
          </label>)}
        </fieldset>
        <label htmlFor="account-name">Имя и фамилия</label>
        <input id="account-name" name="name" autoComplete="name" required minLength={2} maxLength={100} disabled={busy} />
      </>}
      <label htmlFor="account-email">Электронная почта</label>
      <input id="account-email" name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} />
      {(view === 'login' || view === 'register') && <>
        <label htmlFor="account-password">Пароль</label>
        <input id="account-password" name="password" type="password" autoComplete={view === 'login' ? 'current-password' : 'new-password'}
          required minLength={view === 'register' ? 10 : undefined} maxLength={128} disabled={busy}
          aria-describedby={view === 'register' ? 'password-hint' : undefined} />
        {view === 'register' && <small id="password-hint">Не менее 10 символов.</small>}
      </>}
      {view === 'register' && <div className="account-consents">
        <p>Условия пилота: это тестовая версия. Используйте вымышленные данные; реальные данные учеников пока добавлять не нужно.</p>
        <label><input name="acceptTerms" type="checkbox" required disabled={busy} /><span>Принимаю эти условия тестирования.</span></label>
        <label><input name="acceptPrivacy" type="checkbox" required disabled={busy} /><span>Согласен на сохранение введённых имени, email и роли для работы тестового аккаунта.</span></label>
      </div>}
      {error && <p id="auth-error" className="form-error" role="alert">{error}</p>}
      <button className="button account-submit" disabled={busy} type="submit">
        {busy ? 'Подождите…' : view === 'login' ? 'Войти в аккаунт' : view === 'register' ? 'Создать аккаунт' : 'Отправить письмо'}
        {!busy && <ArrowRight size={18} aria-hidden="true" />}
      </button>
    </form>
    {view === 'login' ? <div className="account-auth-links">
      <button className="text-button" disabled={busy} onClick={() => navigate('forgot')}>Забыли пароль?</button>
      <button className="text-button" disabled={busy} onClick={() => navigate('resend')}>Не пришло подтверждение?</button>
    </div> : <button className="text-button account-back" disabled={busy} onClick={() => navigate('login')}><ArrowLeft size={16} aria-hidden="true" />Ко входу</button>}
    <LocalMailbox />
  </section>;
}

export interface AccountLink { kind: 'verify' | 'reset'; token: string }

export function AccountLinkForm({ link, onComplete, onCancel }: {
  link: AccountLink; onComplete: (message: string) => void; onCancel: () => void;
}) {
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
    <p className="account-eyebrow">E-repetitor · аккаунт</p>
    <h1 id="link-title">{link.kind === 'verify' ? 'Подтвердите вашу почту' : 'Новый пароль'}</h1>
    <p className="account-lead">{link.kind === 'verify' ? 'Нажмите кнопку, чтобы активировать аккаунт. После этого можно войти.' : 'После смены пароля нужно будет войти заново на всех устройствах.'}</p>
    <form className="account-form" onSubmit={submit} aria-busy={busy} aria-describedby={error ? 'link-error' : undefined}>
      {link.kind === 'reset' && <>
        <label htmlFor="reset-password">Новый пароль</label>
        <input id="reset-password" name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required disabled={busy} aria-describedby="reset-hint" />
        <small id="reset-hint">Не менее 10 символов.</small>
      </>}
      {error && <p id="link-error" className="form-error" role="alert">{error}</p>}
      <button className="button account-submit" type="submit" disabled={busy}>{busy ? 'Подождите…' : link.kind === 'verify' ? 'Подтвердить email' : 'Сохранить пароль'}</button>
    </form>
    <button className="text-button account-back" onClick={onCancel} disabled={busy}><ArrowLeft size={16} aria-hidden="true" />Ко входу</button>
  </section>;
}

function LocalMailbox() {
  if (process.env.NODE_ENV !== 'development') return null;
  return <aside className="account-mailbox"><Mail size={18} aria-hidden="true" /><p>В локальной разработке письма попадают в <a href="http://127.0.0.1:8025" target="_blank" rel="noopener noreferrer">тестовый почтовый ящик</a>. На настоящую почту они не отправляются.</p></aside>;
}
