'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Check, Copy, GraduationCap, LogOut, Plus } from 'lucide-react';
import { accountApi, accountErrorMessage, accountSessionChanged, isStaleAccountRequest, type Account, type AccountRole, type AccountSubject } from '@/lib/account-api';
import { ACCOUNT_ROLE_LABELS } from './account-auth';
import { ConfirmDialog } from './ui';
import { ParentConnections, StudentConnections, TeacherConnections } from './account-connections';
import { TeacherInvitations } from './account-invitations';
import { AccountLessons } from './account-lessons';
import { AccountTests } from './account-tests';
import { AccountPayments } from './account-payments';
import { AccountOverview } from './account-overview';
import { AccountNotifications } from './account-notifications';
import { AccountAdmin } from './account-admin';
import { NOTIFICATION_TARGETS, type NotificationTarget } from '@/lib/account-notifications';

export function AccountDashboard({ account, onAccountChange, onLogout, onSessionChanged }: {
  account: Account; onAccountChange: (account: Account) => void; onLogout: (message: string) => void;
  onSessionChanged: () => void;
}) {
  const [role, setRole] = useState<AccountRole>(account.roles[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [subjectRevision, setSubjectRevision] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminVisited, setAdminVisited] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState<number | null>(null);
  const [notificationNavigation, setNotificationNavigation] = useState<{ role: AccountRole; target: NotificationTarget } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const aliveRef = useRef(false);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    if (!notificationNavigation) return;
    const target = document.querySelector<HTMLElement>(NOTIFICATION_TARGETS[notificationNavigation.target].href);
    target?.focus(); target?.scrollIntoView({ block: 'start' });
  }, [notificationNavigation]);
  const availableRoles = (Object.keys(ACCOUNT_ROLE_LABELS) as AccountRole[]).filter((item) => !account.roles.includes(item));

  function fail(failure: unknown) {
    if (!aliveRef.current || isStaleAccountRequest(failure)) return;
    if (accountSessionChanged(failure)) {
      onSessionChanged();
    } else setError(accountErrorMessage(failure));
  }

  async function logout(all = false) {
    setBusy(true); setError('');
    try {
      const result = all ? await accountApi.logoutAll(account.id) : await accountApi.logout(account.id);
      if (aliveRef.current) onLogout(result.message);
    } catch (failure) { fail(failure); }
    finally { if (aliveRef.current) { setBusy(false); setConfirmLogoutAll(false); } }
  }

  async function addRole(nextRole: AccountRole) {
    setBusy(true); setError('');
    try {
      const updated = await accountApi.addRole(account.id, nextRole);
      if (!aliveRef.current) return;
      onAccountChange(updated); setRole(nextRole); setCopied(false);
      headingRef.current?.focus();
    } catch (failure) { fail(failure); }
    finally { if (aliveRef.current) setBusy(false); }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(account.profiles.student!.publicId);
      if (aliveRef.current) setCopied(true);
    } catch {
      if (aliveRef.current) setError('Не получилось скопировать ID. Выделите его и скопируйте вручную.');
    }
  }

  return <div className="account-dashboard">
    <header className="account-dashboard-heading">
      <div><p className="account-eyebrow">Личный кабинет</p><h1 ref={headingRef} tabIndex={-1}>{account.name}</h1><p className="account-email">{account.email}</p></div>
      <button className="button secondary" onClick={() => void logout()} disabled={busy}><LogOut size={18} aria-hidden="true" />Выйти</button>
    </header>
    <div className="account-context">
      <label htmlFor="account-context">Сейчас я</label>
      <select id="account-context" value={role} disabled={busy} onChange={(event) => { setRole(event.target.value as AccountRole); setCopied(false); setError(''); }}>
        {account.roles.map((item) => <option key={item} value={item}>{ACCOUNT_ROLE_LABELS[item]}</option>)}
      </select>
      <span className="account-verified"><Check size={16} aria-hidden="true" />Почта подтверждена</span>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <nav className="account-section-nav" aria-label="Разделы кабинета">
      {account.isAdmin && <a href="#account-admin-section" onClick={() => { setAdminOpen(true); setAdminVisited(true); }}>Администрирование</a>}
      <a href="#account-overview-section">Обзор</a><a href="#account-lessons-section">Расписание</a><a href="#account-tests-section">Тесты и результаты</a><a href="#account-payments-section">Оплата</a><a href="#account-connections-section">{role === 'teacher' ? 'Ученики и предметы' : role === 'parent' ? 'Дети и подключения' : 'Мои подключения'}</a><a href="#account-notifications-section" onClick={() => setNotificationsOpen(true)}>Уведомления{unreadNotifications ? ` · ${unreadNotifications}` : ''}</a><a href="#account-settings-section">Аккаунт</a>
    </nav>
    {account.isAdmin && <section id="account-admin-section" className="account-admin account-section-target" tabIndex={-1} aria-labelledby="admin-title">
      <div className="admin-section-heading"><h2 id="admin-title">Администрирование</h2><button className="button secondary small" aria-expanded={adminOpen} aria-controls="admin-content" onClick={() => { setAdminOpen(value => !value); setAdminVisited(true); }}>{adminOpen ? 'Свернуть' : 'Открыть'}</button></div>
      <div id="admin-content" hidden={!adminOpen}>{adminVisited && <AccountAdmin key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} />}</div>
    </section>}
    <AccountNotifications key={`notifications:${account.id}`} accountId={account.id} open={notificationsOpen} onOpenChange={setNotificationsOpen} onSessionChanged={onSessionChanged} onUnreadCount={setUnreadNotifications} onNavigate={(nextRole, target) => {
      if (!account.roles.includes(nextRole)) { setError('Эта роль больше недоступна. Обновите кабинет.'); return; }
      setRole(nextRole); setNotificationNavigation({ role: nextRole, target });
    }} />
    <section className="account-role-content" aria-label={`Кабинет: ${ACCOUNT_ROLE_LABELS[role]}`}>
      <div id="account-overview-section" className="account-section-target" tabIndex={-1}><AccountOverview key={`overview:${account.id}:${role}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} /></div>
      <div id="account-lessons-section" className="account-section-target" tabIndex={-1}>
      <AccountLessons key={`lessons:${account.id}:${role}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} />
      </div>
      <div id="account-tests-section" className="account-section-target" tabIndex={-1}>
      <AccountTests key={`tests:${account.id}:${role}:${subjectRevision}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} />
      </div>
      <div id="account-payments-section" className="account-section-target" tabIndex={-1}>
      <AccountPayments key={`payments:${account.id}:${role}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} />
      </div>
      <div id="account-connections-section" className="account-section-target" tabIndex={-1}>
      {role === 'teacher' && <>
        <TeacherSubjects key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} onSubjectCreated={() => setSubjectRevision((value) => value + 1)} />
        <TeacherConnections key={`${account.id}:${subjectRevision}`} accountId={account.id} onSessionChanged={onSessionChanged} />
        <TeacherInvitations key={`invitations:${account.id}:${subjectRevision}`} accountId={account.id} onSessionChanged={onSessionChanged} />
      </>}
      {role === 'student' && <>
        <div className="account-section-heading"><div className="subject-icon"><GraduationCap size={25} aria-hidden="true" /></div><div><h2>Ваш Student ID</h2><p className="muted">Один идентификатор для всех преподавателей.</p></div></div>
        <div className="student-id-panel"><div><span>Постоянный ID ученика</span><strong>{account.profiles.student?.publicId ?? 'ID пока не доступен'}</strong></div>
          <button className="button secondary" onClick={() => void copyId()} disabled={!account.profiles.student?.publicId}><Copy size={17} aria-hidden="true" />{copied ? 'Скопировано' : 'Скопировать ID'}</button></div>
        <span className="sr-only" role="status">{copied ? 'Student ID скопирован' : ''}</span>
        <StudentConnections key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} />
      </>}
      {role === 'parent' && <ParentConnections key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} />}
      </div>
    </section>
    <section id="account-settings-section" tabIndex={-1} className="account-settings account-section-target" aria-labelledby="account-settings-title">
      <h2 id="account-settings-title">Ваш аккаунт</h2>
      {availableRoles.length > 0 && <div className="account-setting-row"><div><h3>Добавить ещё одну роль</h3><p className="muted">Все ваши роли используют один email и пароль.</p></div><div className="account-role-actions">
        {availableRoles.map((item) => <button key={item} className="button secondary" onClick={() => void addRole(item)} disabled={busy}><Plus size={16} aria-hidden="true" />{ACCOUNT_ROLE_LABELS[item]}</button>)}
      </div></div>}
      <div className="account-setting-row"><div><h3>Завершить все сессии</h3><p className="muted">Выйти из аккаунта на всех устройствах, включая это.</p></div><button className="text-button" onClick={() => setConfirmLogoutAll(true)} disabled={busy}>Выйти везде</button></div>
    </section>
    {confirmLogoutAll && <ConfirmDialog title="Выйти на всех устройствах?" description="Все текущие сессии будут завершены. Для продолжения понадобится снова ввести email и пароль." action={busy ? 'Выходим…' : 'Выйти везде'} onConfirm={() => { if (!busy) void logout(true); }} onClose={() => { if (!busy) setConfirmLogoutAll(false); }} />}
  </div>;
}

function TeacherSubjects({ accountId, onSessionChanged, onSubjectCreated }: { accountId: string; onSessionChanged: () => void; onSubjectCreated: () => void }) {
  const [page, setPage] = useState<{ items: AccountSubject[]; total: number; nextOffset: number }>({ items: [], total: 0, nextOffset: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const aliveRef = useRef(false);
  const onSessionChangedRef = useRef(onSessionChanged);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => { onSessionChangedRef.current = onSessionChanged; }, [onSessionChanged]);
  useEffect(() => {
    let alive = true;
    accountApi.subjects(accountId).then((result) => {
      if (alive) { setPage({ items: result.items, total: result.total, nextOffset: result.items.length }); setLoadError(''); }
    }).catch((failure: unknown) => {
      if (!alive || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) onSessionChangedRef.current();
      else setLoadError(accountErrorMessage(failure));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [accountId, revision]);

  async function loadMore() {
    if (loadingMore || busy) return;
    const offset = page.nextOffset;
    setLoadingMore(true); setError('');
    try {
      const result = await accountApi.subjects(accountId, offset);
      if (!aliveRef.current) return;
      setPage((current) => ({
        items: [...new Map([...current.items, ...result.items].map((subject) => [subject.id, subject])).values()],
        total: result.total, nextOffset: offset + result.items.length,
      }));
    } catch (failure) {
      if (!aliveRef.current || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) onSessionChanged();
      else setError(accountErrorMessage(failure));
    } finally { if (aliveRef.current) setLoadingMore(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || loadingMore) return;
    const form = event.currentTarget;
    const name = String(new FormData(form).get('subject') ?? '').trim();
    if (!name) { setError('Введите название предмета.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const subject = await accountApi.createSubject(accountId, name);
      if (!aliveRef.current) return;
      setPage((current) => ({
        items: [...current.items, subject], total: current.total + 1,
        // A newly created item is after any unloaded pages; it must not skip their first row.
        nextOffset: current.nextOffset === current.total ? current.nextOffset + 1 : current.nextOffset,
      }));
      form.reset(); setMessage(`Предмет «${subject.name}» добавлен.`); onSubjectCreated();
    } catch (failure) {
      if (!aliveRef.current || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) onSessionChanged();
      else setError(accountErrorMessage(failure));
    } finally { if (aliveRef.current) setBusy(false); }
  }

  return <>
    <div className="account-section-heading"><div className="subject-icon"><BookOpen size={24} aria-hidden="true" /></div><div><h2>Мои предметы</h2><p className="muted">Создайте предметы, которые вы преподаёте.</p></div></div>
    {loading ? <p role="status" className="muted">Загружаем ваши предметы…</p> : loadError ? <div className="form-error"><p role="alert">{loadError}</p><button className="text-button" onClick={() => { setLoading(true); setRevision((current) => current + 1); }}>Повторить загрузку</button></div>
      : page.items.length ? <ul className="account-subject-list">{page.items.map((subject) => <li key={subject.id}><BookOpen size={20} aria-hidden="true" /><strong>{subject.name}</strong><span className="status status-active">Активен</span></li>)}</ul>
        : <div className="empty-state"><h3>Добавьте первый предмет</h3><p>Например, математику или физику. Здесь будут только предметы, которые создали вы.</p></div>}
    {!loading && !loadError && page.nextOffset < page.total && <button className="text-button" onClick={() => void loadMore()} disabled={loadingMore || busy}>{loadingMore ? 'Загружаем…' : `Показать ещё · отображается ${page.items.length} из ${page.total}`}</button>}
    <form className="account-subject-form account-form" onSubmit={submit} aria-busy={busy} aria-describedby={error ? 'subject-error' : undefined}>
      <label htmlFor="new-account-subject">Название предмета</label>
      <div><input id="new-account-subject" name="subject" placeholder="Например, математика" required maxLength={100} disabled={busy || loading || loadingMore || !!loadError} /><button className="button" type="submit" disabled={busy || loading || loadingMore || !!loadError}><Plus size={18} aria-hidden="true" />{busy ? 'Добавляем…' : 'Добавить предмет'}</button></div>
      {error && <p id="subject-error" className="form-error" role="alert">{error}</p>}
      {message && <p className="success-message" role="status">{message}</p>}
    </form>
  </>;
}
