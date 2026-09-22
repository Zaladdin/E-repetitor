'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, BookOpen, GraduationCap, Users } from 'lucide-react';
import { ACCOUNT_SESSION_CHANNEL, accountApi, accountErrorMessage, isExternalAccountSessionChange, isStaleAccountRequest, type Account } from '@/lib/account-api';
import { consumeAccountLink, subscribeAccountLinks, type AccountEmailLink } from '@/lib/account-link';
import { AccountFocusVerifier } from '@/lib/account-focus-verifier';
import { AccountAuth, AccountLinkForm } from './account-auth';
import { InvitationActivation } from './invitation-activation';
import { AccountDashboard } from './account-dashboard';
import { AccountSessionSuspendedContext } from './account-session-context';
import '@/app/account.css';

export function AccountPortal() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [link, setLink] = useState<AccountEmailLink | null>(null);
  const [revision, setRevision] = useState(0);
  const [checkingSession, setCheckingSession] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [focusVerifier] = useState(() => new AccountFocusVerifier<Account>(() => accountApi.current(), {
    checking: setCheckingSession,
    result: (current, expectedId) => {
      if (current?.id !== expectedId) accountApi.invalidatePendingRequests();
      setAccount(current); setSessionError('');
    },
    error: (failure) => setSessionError(accountErrorMessage(failure)),
  }));
  const initialLink = useRef<AccountEmailLink | null | undefined>(undefined);
  const mainRef = useRef<HTMLElement>(null);
  const revalidateSession = useCallback(() => {
    // Email confirmation/reset is independent of the browser's signed-in account.
    if (initialLink.current) return;
    focusVerifier.invalidate(); setCheckingSession(false); setSessionError('');
    accountApi.invalidatePendingRequests();
    setAccount(null); setLoading(true); setError('');
    setRevision((value) => value + 1);
  }, [focusVerifier]);

  useEffect(() => () => focusVerifier.invalidate(), [focusVerifier]);

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(ACCOUNT_SESSION_CHANNEL);
    const onMessage = (event: MessageEvent<unknown>) => { if (isExternalAccountSessionChange(event.data)) revalidateSession(); };
    // Do not erase an unfinished login/registration form when switching windows.
    const onFocus = () => { if (account) void focusVerifier.check(account.id); };
    channel?.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    return () => { channel?.close(); window.removeEventListener('focus', onFocus); };
  }, [account, focusVerifier, revalidateSession]);

  useEffect(() => subscribeAccountLinks(window, (nextLink) => {
    focusVerifier.invalidate(); setCheckingSession(false); setSessionError('');
    accountApi.invalidatePendingRequests();
    initialLink.current = nextLink;
    setLink(nextLink); setAccount(null); setError(''); setNotice(''); setLoading(true);
    setRevision((value) => value + 1);
    mainRef.current?.focus();
  }), [focusVerifier]);

  useEffect(() => {
    let alive = true;
    if (initialLink.current === undefined) {
      initialLink.current = consumeAccountLink(window);
    }
    async function initialize() {
      try {
        // Keep the email token only in memory, including during Strict Mode's effect replay.
        const emailLink = initialLink.current;
        const current = emailLink ? await Promise.resolve(null) : await accountApi.current();
        if (!alive) return;
        setLink(emailLink ?? null); setAccount(current); setError('');
      } catch (failure) {
        if (alive && !isStaleAccountRequest(failure)) setError(accountErrorMessage(failure));
      } finally { if (alive) setLoading(false); }
    }
    void initialize();
    return () => { alive = false; };
  }, [revision]);

  function completeLink(message = '') {
    focusVerifier.invalidate(); setCheckingSession(false); setSessionError('');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    initialLink.current = null; setLink(null); setAccount(null); setNotice(message);
    mainRef.current?.focus();
  }

  function signedIn(current: Account) {
    focusVerifier.invalidate(); setCheckingSession(false); setSessionError('');
    setAccount(current); setNotice(''); setError(''); mainRef.current?.focus();
  }

  const sessionSuspended = checkingSession || !!sessionError;

  return <div className={`account-shell${account ? ' is-signed-in' : ''}`}>
    <a href="#account-main" className="skip-link">Перейти к содержимому</a>
    <header className="account-header"><Link href="/" className="account-logo">E-repetitor<span>Учиться. Преподавать. Быть рядом.</span></Link>
      <Link href="/demo/" className="account-demo-link">Демо интерфейса<ArrowUpRight size={17} aria-hidden="true" /></Link></header>
    <div className="account-pilot-bar">Пилотная версия · регистрация и личные аккаунты</div>
    <main id="account-main" ref={mainRef} tabIndex={-1} className="account-main">
      {notice && <p className="success-message" role="status">{notice}</p>}
      {loading ? <div className="account-loading" role="status">Открываем ваше пространство…</div>
        : error ? <section className="account-unavailable"><h1>Не удалось открыть аккаунт</h1><p className="form-error" role="alert">{error}</p><button className="button" onClick={() => { setLoading(true); setRevision((value) => value + 1); }}>Повторить попытку</button><p className="muted">Демонстрация интерфейса доступна по ссылке вверху.</p></section>
          : link?.kind === 'invite' ? <InvitationActivation key={link.token} token={link.token} onComplete={completeLink} onCancel={() => completeLink()} />
            : link ? <AccountLinkForm key={`${link.kind}:${link.token}`} link={{ kind: link.kind, token: link.token }} onComplete={completeLink} onCancel={() => completeLink()} />
            : !account ? <div className="account-entry-grid"><AccountAuth onLogin={signedIn} /><AccountIntroduction /></div> : null}
      {account && checkingSession && <p className="account-loading" role="status">Проверяем вход…</p>}
      {account && !checkingSession && sessionError && <section className="account-unavailable"><h1>Не удалось проверить вход</h1><p className="form-error" role="alert">{sessionError}</p><p>Открытые формы сохранены в этом окне. Проверьте соединение и повторите попытку.</p><button className="button" onClick={() => void focusVerifier.check(account.id)}>Повторить проверку</button></section>}
      <AccountSessionSuspendedContext.Provider value={sessionSuspended}>
        <div hidden={sessionSuspended} inert={sessionSuspended}>
          {account && !loading && !error && !link && <AccountDashboard key={account.id} account={account} onAccountChange={setAccount} onSessionChanged={revalidateSession} onLogout={(message) => {
            focusVerifier.invalidate(); setCheckingSession(false); setSessionError('');
            setAccount(null); setNotice(message); mainRef.current?.focus();
          }} />}
        </div>
      </AccountSessionSuspendedContext.Provider>
    </main>
    <footer className="account-footer"><span>E-repetitor</span><p>Рабочая версия для тестирования. Используйте вымышленные данные.</p></footer>
  </div>;
}

function AccountIntroduction() {
  return <aside className="account-introduction" aria-labelledby="intro-title">
    <p className="account-eyebrow">Всё начинается со связи</p>
    <h2 id="intro-title">Одно пространство.<br />Три точки зрения.</h2>
    <p className="account-intro-lead">Свой кабинет для каждого участника обучения.</p>
    <div className="account-intro-role"><BookOpen size={23} aria-hidden="true" /><div><h3>Преподавателю</h3><p>Свои предметы и ученики. Подключение по Student ID и управление обучением.</p></div></div>
    <div className="account-intro-role"><GraduationCap size={23} aria-hidden="true" /><div><h3>Ученику</h3><p>Один Student ID для разных репетиторов. Вы подтверждаете подключения и доступ родителей.</p></div></div>
    <div className="account-intro-role"><Users size={23} aria-hidden="true" /><div><h3>Родителю</h3><p>Предметы ребёнка у всех преподавателей в одном кабинете — после его подтверждения.</p></div></div>
    <div className="account-intro-footnote">Учебные кабинеты с примерами можно посмотреть в демо интерфейса.</div>
  </aside>;
}
