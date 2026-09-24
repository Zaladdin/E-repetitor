'use client';

import { LanguageSwitcher, useI18n } from './locale-provider';


import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { accountSectionFromHash, accountSectionFromPath, accountSectionHref } from '@/lib/account-navigation';
import { ACCOUNT_SESSION_CHANNEL, accountApi, accountErrorMessage, isExternalAccountSessionChange, isStaleAccountRequest, type Account } from '@/lib/account-api';
import { consumeAccountLink, subscribeAccountLinks, type AccountEmailLink } from '@/lib/account-link';
import { AccountFocusVerifier } from '@/lib/account-focus-verifier';
import { AccountAuth, AccountLinkForm } from './account-auth';
import { InvitationActivation } from './invitation-activation';
import { AccountDashboard } from './account-dashboard';
import { AccountSessionSuspendedContext } from './account-session-context';
import '@/app/account.css';
import '@/app/apple-theme.css';
import '@/app/groups.css';

export function AccountPortal() {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const section = accountSectionFromPath(pathname) ?? 'account-overview-section';
  const [account, setAccount] = useState<Account | null>(null);
  const [navigationHost, setNavigationHost] = useState<HTMLDivElement | null>(null);
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
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [pathname]);
  useEffect(() => {
    if (!account) return;
    const followLegacyLink = () => {
      const target = accountSectionFromHash(window.location.hash, account.isAdmin);
      if (target) router.replace(accountSectionHref(target));
      else if ((pathname === '/' || pathname.replace(/\/$/, '') === '/account') && !window.location.hash) {
        router.replace(accountSectionHref('account-overview-section'));
      }
    };
    followLegacyLink();
    window.addEventListener('hashchange', followLegacyLink);
    return () => window.removeEventListener('hashchange', followLegacyLink);
  }, [account, pathname, router]);
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
    <a href="#account-main" className="skip-link">{t("Перейти к содержимому")}</a>
    <header className="account-header">
      <div className="account-header-brand"><Link href={account ? '/account/overview/' : '/'} className="account-logo">E-repetitor</Link></div>
      <div id="account-header-navigation" ref={setNavigationHost} hidden={sessionSuspended} inert={sessionSuspended} />
      <LanguageSwitcher />
    </header>
    <main id="account-main" ref={mainRef} tabIndex={-1} className="account-main">
      {notice && <p className="success-message" role="status">{t(notice)}</p>}
      {loading ? <div className="account-loading" role="status">{t("Открываем ваше пространство…")}</div>
        : error ? <section className="account-unavailable"><h1>{t("Не удалось открыть аккаунт")}</h1><p className="form-error" role="alert">{t(error)}</p><button className="button" onClick={() => { setLoading(true); setRevision((value) => value + 1); }}>{t("Повторить попытку")}</button></section>
          : link?.kind === 'invite' ? <InvitationActivation key={link.token} token={link.token} onComplete={completeLink} onCancel={() => completeLink()} />
            : link ? <AccountLinkForm key={`${link.kind}:${link.token}`} link={{ kind: link.kind, token: link.token }} onComplete={completeLink} onCancel={() => completeLink()} />
            : !account ? <AccountAuth onLogin={signedIn} /> : null}
      {account && checkingSession && <p className="account-loading" role="status">{t("Проверяем вход…")}</p>}
      {account && !checkingSession && sessionError && <section className="account-unavailable"><h1>{t("Не удалось проверить вход")}</h1><p className="form-error" role="alert">{t(sessionError)}</p><p>{t("Открытые формы сохранены в этом окне. Проверьте соединение и повторите попытку.")}</p><button className="button" onClick={() => void focusVerifier.check(account.id)}>{t("Повторить проверку")}</button></section>}
      <AccountSessionSuspendedContext.Provider value={sessionSuspended}>
        <div hidden={sessionSuspended} inert={sessionSuspended}>
          {account && !loading && !error && !link && <AccountDashboard key={account.id} section={section} navigationHost={navigationHost} account={account} onAccountChange={setAccount} onSessionChanged={revalidateSession} onLogout={(message) => {
            focusVerifier.invalidate(); setCheckingSession(false); setSessionError('');
            setAccount(null); setNotice(message); mainRef.current?.focus();
          }} />}
        </div>
      </AccountSessionSuspendedContext.Provider>
    </main>
    {!account && !loading && !error && !link && <AccountIntroduction />}
    <footer className="account-footer"><span>E-repetitor</span><p>{t("Рабочая версия для тестирования. Используйте вымышленные данные.")}</p></footer>
  </div>;
}

function AccountIntroduction() {
  const { t } = useI18n();
  return <aside className="account-introduction" aria-label={t("Возможности участников")}>
    <div className="account-intro-role"><h2>{t("Преподавателю")}</h2><p>{t("Свои предметы и ученики. Расписание, тесты и отметки оплаты в одном кабинете.")}</p></div>
    <div className="account-intro-role"><h2>{t("Ученику")}</h2><p>{t("Один Student ID для разных репетиторов. Занятия, тесты и результаты по всем предметам.")}</p></div>
    <div className="account-intro-role"><h2>{t("Родителю")}</h2><p>{t("Все предметы ребёнка, результаты и статусы оплаты — после подтверждения связи.")}</p></div>
  </aside>;
}
