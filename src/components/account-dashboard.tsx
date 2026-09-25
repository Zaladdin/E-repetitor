'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';


import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { BookOpen, Copy, GraduationCap, LogOut, Plus } from 'lucide-react';
import { accountApi, accountErrorMessage, accountSessionChanged, isStaleAccountRequest, type Account, type AccountRole, type AccountSubject, type AddAccountRoleInput } from '@/lib/account-api';
import { readTeacherProfile, RegistrationValidationError } from '@/lib/account-registration';
import { TeacherProfileFields } from './teacher-profile-fields';
import { ACCOUNT_ROLE_LABELS } from './account-auth';
import { ConfirmDialog } from './ui';
import { ParentConnections, StudentConnections, TeacherConnections } from './account-connections';
import { TeacherInvitations } from './account-invitations';
import { AccountLessons } from './account-lessons';
import { AccountGroups } from './account-groups';
import { AccountTests } from './account-tests';
import { AccountPayments } from './account-payments';
import { AccountPackages } from './account-packages';
import { AccountOverview } from './account-overview';
import { AccountNotifications } from './account-notifications';
import { AccountAdmin } from './account-admin';
import { AccountNavigation } from './account-navigation';
import { accountSectionHref, type AccountSectionId } from '@/lib/account-navigation';
import { NotificationFeedLoader } from '@/lib/notification-feed';

export function AccountDashboard({ account, section = 'account-overview-section', navigationHost = null, onAccountChange, onLogout, onSessionChanged }: {
  account: Account; onAccountChange: (account: Account) => void; onLogout: (message: string) => void;
  section?: AccountSectionId;
  navigationHost?: HTMLElement | null;
  onSessionChanged: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<AccountRole>(() => {
    if (/^\/account\/tests\/(new|edit)\/?$/.test(pathname ?? '') && account.roles.includes('teacher')) return 'teacher';
    try {
      const saved = window.sessionStorage.getItem(`account-role:${account.id}`);
      if (account.roles.includes(saved as AccountRole)) return saved as AccountRole;
    } catch { /* Storage may be unavailable; use the account's default role. */ }
    return account.roles[0];
  });
  useEffect(() => {
    try { window.sessionStorage.setItem(`account-role:${account.id}`, role); }
    catch { /* Role selection remains usable when browser storage is disabled. */ }
  }, [account.id, role]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [teacherRoleOpen, setTeacherRoleOpen] = useState(false);
  const [teacherRoleError, setTeacherRoleError] = useState('');
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [subjectRevision, setSubjectRevision] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(true);
  const [unreadNotifications, setUnreadNotifications] = useState<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const teacherFormHeadingRef = useRef<HTMLHeadingElement>(null);
  const teacherRoleButtonRef = useRef<HTMLButtonElement>(null);
  const aliveRef = useRef(false);
  const sessionChangedRef = useRef(onSessionChanged);
  useEffect(() => { sessionChangedRef.current = onSessionChanged; }, [onSessionChanged]);
  const notificationsPage = section === 'account-notifications-section';
  useEffect(() => {
    if (notificationsPage) return;
    const reader = new NotificationFeedLoader(offset => accountApi.notifications(account.id, offset, true),
      state => setUnreadNotifications(state.unreadTotal), () => sessionChangedRef.current());
    const refresh = () => { void reader.reload(); };
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void reader.reload(true); };
    refresh();
    const unsubscribe = accountApi.subscribeOverview(account.id, refresh);
    window.addEventListener('focus', visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 60_000);
    return () => { reader.dispose(); unsubscribe(); window.clearInterval(timer); window.removeEventListener('focus', visibleRefresh); };
  }, [account.id, notificationsPage]);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => { if (teacherRoleOpen) teacherFormHeadingRef.current?.focus(); }, [teacherRoleOpen]);
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

  async function addRole(data: AddAccountRoleInput) {
    if (busy) return;
    setBusy(true); setError(''); setTeacherRoleError('');
    try {
      const updated = await accountApi.addRole(account.id, data);
      if (!aliveRef.current) return;
      onAccountChange(updated); setRole(data.role); setCopied(false); setTeacherRoleOpen(false);
      headingRef.current?.focus();
    } catch (failure) {
      if (data.role === 'teacher' && aliveRef.current && !isStaleAccountRequest(failure) && !accountSessionChanged(failure)) {
        setTeacherRoleError(accountErrorMessage(failure));
      } else fail(failure);
    }
    finally { if (aliveRef.current) setBusy(false); }
  }

  function submitTeacherRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    try { void addRole({ role: 'teacher', ...readTeacherProfile(new FormData(event.currentTarget)) }); }
    catch (failure) {
      setTeacherRoleError(failure instanceof RegistrationValidationError ? failure.message : accountErrorMessage(failure));
    }
  }

  function closeTeacherRole() {
    if (busy) return;
    setTeacherRoleOpen(false); setTeacherRoleError(''); teacherRoleButtonRef.current?.focus();
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(account.profiles.student!.publicId);
      if (aliveRef.current) setCopied(true);
    } catch {
      if (aliveRef.current) setError(t("Не получилось скопировать ID. Выделите его и скопируйте вручную."));
    }
  }

  return <div className="account-dashboard">
    {navigationHost && createPortal(<>
      <AccountNavigation role={role} isAdmin={account.isAdmin} active={section} unreadNotifications={unreadNotifications} />
      <button data-account-logout className="button secondary account-header-logout" onClick={() => void logout()} disabled={busy}><LogOut size={18} aria-hidden="true" />{t("Выйти")}</button>
    </>, navigationHost)}
    <header className="account-dashboard-heading">
      <div><h1 ref={headingRef} tabIndex={-1}>{account.name}</h1><p className="account-email">{account.email}</p></div>
    </header>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    {!account.isAdmin && section === 'account-admin-section' && <section className="account-role-content"><h2>{t("Раздел недоступен")}</h2><p>{t("У вашего аккаунта нет прав администратора.")}</p></section>}
    {account.isAdmin && section === 'account-admin-section' && <section id="account-admin-section" className="account-admin account-section-target" tabIndex={-1} aria-labelledby="admin-title">
      <div className="admin-section-heading"><h2 id="admin-title">{t("Администрирование")}</h2></div>
      <AccountAdmin key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} />
    </section>}
    {section === 'account-notifications-section' && <AccountNotifications key={`notifications:${account.id}`} accountId={account.id} open={notificationsOpen} onOpenChange={setNotificationsOpen} onSessionChanged={onSessionChanged} onUnreadCount={setUnreadNotifications} onNavigate={(nextRole, target) => {
      if (!account.roles.includes(nextRole)) { setError(t("Эта роль больше недоступна. Обновите кабинет.")); return; }
      setRole(nextRole);
      router.push(accountSectionHref(target === 'lessons' ? 'account-lessons-section' : 'account-tests-section'));
    }} />}
    <section className="account-role-content" aria-label={t("Кабинет: {value0}", { value0: t(ACCOUNT_ROLE_LABELS[role]) })}>
      {section === 'account-overview-section' && <div id="account-overview-section" className="account-section-target" tabIndex={-1}><AccountOverview key={`overview:${account.id}:${role}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} /></div>}
      {section === 'account-lessons-section' && <div id="account-lessons-section" className="account-section-target" tabIndex={-1}>
      <AccountLessons key={`lessons:${account.id}:${role}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} />
      </div>}
      {section === 'account-groups-section' && <div id="account-groups-section" className="account-section-target" tabIndex={-1}>
        {role === 'teacher' ? <AccountGroups key={`groups:${account.id}`} accountId={account.id} timezone={account.profiles.teacher?.timezone ?? 'Asia/Baku'} onSessionChanged={onSessionChanged} />
          : <><h2>{t("Группы учеников")}</h2><p>{t("Создание групп доступно преподавателю. Ваши групповые занятия отображаются в расписании.")}</p></>}
      </div>}
      {section === 'account-tests-section' && <div id="account-tests-section" className="account-section-target" tabIndex={-1}>
      <AccountTests key={`tests:${account.id}:${role}:${subjectRevision}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} />
      </div>}
      {section === 'account-payments-section' && <div id="account-payments-section" className="account-section-target" tabIndex={-1}>
      <AccountPayments key={`payments:${account.id}:${role}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} />
      </div>}
      {section === 'account-packages-section' && <div id="account-packages-section" className="account-section-target" tabIndex={-1}>
      <AccountPackages key={`packages:${account.id}:${role}`} accountId={account.id} role={role} onSessionChanged={onSessionChanged} />
      </div>}
      {section === 'account-connections-section' && <div id="account-connections-section" className="account-section-target" tabIndex={-1}>
      {role === 'teacher' && <>
        <TeacherSubjects key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} onSubjectCreated={() => setSubjectRevision((value) => value + 1)} />
        <TeacherConnections key={`${account.id}:${subjectRevision}`} accountId={account.id} onSessionChanged={onSessionChanged} />
        <TeacherInvitations key={`invitations:${account.id}:${subjectRevision}`} accountId={account.id} onSessionChanged={onSessionChanged} />
      </>}
      {role === 'student' && <>
        <div className="account-section-heading"><div className="subject-icon"><GraduationCap size={25} aria-hidden="true" /></div><div><h2>{t("Ваш Student ID")}</h2><p className="muted">{t("Один идентификатор для всех преподавателей.")}</p></div></div>
        <div className="student-id-panel"><div><span>{t("Постоянный ID ученика")}</span><strong>{account.profiles.student?.publicId ?? t("ID пока не доступен")}</strong></div>
          <button className="button secondary" onClick={() => void copyId()} disabled={!account.profiles.student?.publicId}><Copy size={17} aria-hidden="true" />{copied ? t("Скопировано") : t("Скопировать ID")}</button></div>
        <span className="sr-only" role="status">{copied ? t("Student ID скопирован") : ''}</span>
        <StudentConnections key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} />
      </>}
      {role === 'parent' && <ParentConnections key={account.id} accountId={account.id} onSessionChanged={onSessionChanged} />}
      </div>}
    </section>
    {section === 'account-settings-section' && <section id="account-settings-section" tabIndex={-1} className="account-settings account-section-target" aria-labelledby="account-settings-title">
      <h2 id="account-settings-title">{t("Ваш аккаунт")}</h2>
      {account.roles.length > 1 && <div className="account-context">
        <label htmlFor="account-context">{t("Активная роль")}</label>
        <select id="account-context" value={role} disabled={busy} onChange={(event) => { setRole(event.target.value as AccountRole); setCopied(false); setError(''); }}>
          {account.roles.map((item) => <option key={item} value={item}>{t(ACCOUNT_ROLE_LABELS[item])}</option>)}
        </select>
      </div>}
      {role === 'teacher' && account.profiles.teacher && <div className="teacher-account-profile">
        <h3>{t("Данные преподавателя")}</h3>
        <dl className="teacher-account-details">
          <div><dt>{t("ФИО")}</dt><dd>{account.name}</dd></div>
          <div><dt>{t("Номер телефона")}</dt><dd>{account.profiles.teacher.phone ?? t("Не указан")}</dd></div>
          <div><dt>{t("Дата рождения")}</dt><dd>{account.profiles.teacher.birthDate ? new Intl.DateTimeFormat(localeTag(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${account.profiles.teacher.birthDate}T00:00:00Z`)) : t("Не указана")}</dd></div>
        </dl>
      </div>}
      {availableRoles.length > 0 && <div className="account-setting-row"><div><h3>{t("Добавить ещё одну роль")}</h3><p className="muted">{t("Все ваши роли используют один email и пароль.")}</p></div><div className="account-role-actions">
        {availableRoles.map((item) => <button key={item} className="button secondary" ref={item === 'teacher' ? teacherRoleButtonRef : undefined}
          aria-expanded={item === 'teacher' ? teacherRoleOpen : undefined} aria-controls={item === 'teacher' ? 'add-teacher-role' : undefined}
          onClick={() => { if (item === 'teacher') { setTeacherRoleOpen(true); setTeacherRoleError(''); } else void addRole({ role: item }); }}
          disabled={busy}><Plus size={16} aria-hidden="true" />{t(ACCOUNT_ROLE_LABELS[item])}</button>)}
      </div></div>}
      {teacherRoleOpen && !account.roles.includes('teacher') && <form id="add-teacher-role" className="account-form teacher-role-form"
        onSubmit={submitTeacherRole} aria-busy={busy} aria-labelledby="add-teacher-role-title" aria-describedby={teacherRoleError ? 'add-teacher-role-error' : undefined}>
        <h3 id="add-teacher-role-title" ref={teacherFormHeadingRef} tabIndex={-1}>{t("Стать преподавателем")}</h3>
        <label htmlFor="teacher-role-name">{t("ФИО")}</label><input id="teacher-role-name" value={account.name} readOnly autoComplete="name" />
        <TeacherProfileFields disabled={busy} />
        {teacherRoleError && <p id="add-teacher-role-error" className="form-error" role="alert">{t(teacherRoleError)}</p>}
        <div className="form-actions">
          <button type="submit" className="button" disabled={busy}>{busy ? t("Добавляем…") : t("Добавить роль преподавателя")}</button>
          <button type="button" className="button secondary" disabled={busy} onClick={closeTeacherRole}>{t("Отмена")}</button>
        </div>
      </form>}
      <div className="account-setting-row"><div><h3>{t("Завершить все сессии")}</h3><p className="muted">{t("Выйти из аккаунта на всех устройствах, включая это.")}</p></div><button className="text-button" onClick={() => setConfirmLogoutAll(true)} disabled={busy}>{t("Выйти везде")}</button></div>
    </section>}
    {confirmLogoutAll && <ConfirmDialog title={t("Выйти на всех устройствах?")} description={t("Все текущие сессии будут завершены. Для продолжения понадобится снова ввести email и пароль.")} action={busy ? t("Выходим…") : t("Выйти везде")} onConfirm={() => { if (!busy) void logout(true); }} onClose={() => { if (!busy) setConfirmLogoutAll(false); }} />}
  </div>;
}

function TeacherSubjects({ accountId, onSessionChanged, onSubjectCreated }: { accountId: string; onSessionChanged: () => void; onSubjectCreated: () => void }) {
  const { t } = useI18n();
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
    if (!name) { setError(t("Введите название предмета.")); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const subject = await accountApi.createSubject(accountId, name);
      if (!aliveRef.current) return;
      setPage((current) => ({
        items: [...current.items, subject], total: current.total + 1,
        // A newly created item is after any unloaded pages; it must not skip their first row.
        nextOffset: current.nextOffset === current.total ? current.nextOffset + 1 : current.nextOffset,
      }));
      form.reset(); setMessage(t("Предмет «{value0}» добавлен.", { value0: String(subject.name) })); onSubjectCreated();
    } catch (failure) {
      if (!aliveRef.current || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) onSessionChanged();
      else setError(accountErrorMessage(failure));
    } finally { if (aliveRef.current) setBusy(false); }
  }

  return <>
    <div className="account-section-heading"><div className="subject-icon"><BookOpen size={24} aria-hidden="true" /></div><div><h2>{t("Мои предметы")}</h2><p className="muted">{t("Ваши направления преподавания. Новый предмет можно добавить в любое время.")}</p></div></div>
    {loading ? <p role="status" className="muted">{t("Загружаем ваши предметы…")}</p> : loadError ? <div className="form-error"><p role="alert">{t(loadError)}</p><button className="text-button" onClick={() => { setLoading(true); setRevision((current) => current + 1); }}>{t("Повторить загрузку")}</button></div>
      : page.items.length ? <ul className="account-subject-list">{page.items.map((subject) => <li key={subject.id}><BookOpen size={20} aria-hidden="true" /><strong>{subject.name}</strong><span className="status status-active">{t("Активен")}</span></li>)}</ul>
        : <div className="empty-state"><h3>{t("Добавьте первый предмет")}</h3><p>{t("Например, математику или физику. Здесь будут только предметы, которые создали вы.")}</p></div>}
    {!loading && !loadError && page.nextOffset < page.total && <button className="text-button" onClick={() => void loadMore()} disabled={loadingMore || busy}>{loadingMore ? t("Загружаем…") : t("Показать ещё · отображается {value0} из {value1}", { value0: String(page.items.length), value1: String(page.total) })}</button>}
    <form className="account-subject-form account-form" onSubmit={submit} aria-busy={busy} aria-describedby={error ? 'subject-error' : undefined}>
      <label htmlFor="new-account-subject">{t("Название предмета")}</label>
      <div><input id="new-account-subject" name="subject" placeholder={t("Например, математика")} required maxLength={100} disabled={busy || loading || loadingMore || !!loadError} /><button className="button" type="submit" disabled={busy || loading || loadingMore || !!loadError}><Plus size={18} aria-hidden="true" />{busy ? t("Добавляем…") : t("Добавить предмет")}</button></div>
      {error && <p id="subject-error" className="form-error" role="alert">{t(error)}</p>}
      {message && <p className="success-message" role="status">{t(message)}</p>}
    </form>
  </>;
}
