'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { accountApi, accountErrorMessage, accountSessionChanged, isStaleAccountRequest } from '@/lib/account-api';
import { ADMIN_ACTION_LABELS, USER_STATUSES, USER_STATUS_LABELS, adminStatusOptions, type AdminStatusInput, type AdminUser, type AdminUserFilters } from '@/lib/account-admin';
import { ACCOUNT_ROLE_LABELS } from './account-auth';
import { useAccountPage } from './account-connections-state';
import { AdminAudit } from './account-admin-audit';
import { adminDate, useAdminValue, type AdminContextProps } from './account-admin-state';
import { Modal } from './ui';

const emptyFilters: AdminUserFilters = { query: '', role: '', status: '' };

export function AdminUsers(props: AdminContextProps & { onChanged: () => void }) {
  const [filters, setFilters] = useState(emptyFilters);
  const [revision, setRevision] = useState(0);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTarget) (document.getElementById(`admin-user-open-${focusTarget}`) ?? heading.current)?.focus();
  }, [focusTarget]);
  const changed = () => { setRevision(value => value + 1); props.onChanged(); };
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    setFilters({ query: String(data.get('query') ?? '').trim(), role: String(data.get('role') ?? '') as AdminUserFilters['role'], status: String(data.get('status') ?? '') as AdminUserFilters['status'] });
    setRevision(value => value + 1);
  }
  return <section className="admin-users" aria-labelledby="admin-users-title"><h3 id="admin-users-title" ref={heading} tabIndex={-1}>Пользователи</h3>
    <form className="admin-search" onSubmit={search} aria-label="Поиск пользователей">
      <label>Поиск по email или Student ID<input type="search" name="query" maxLength={254} placeholder="email@example.com или STU-…" /></label>
      <label>Роль<select name="role" defaultValue=""><option value="">Все роли</option>{Object.entries(ACCOUNT_ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}<option value="admin">Администратор</option></select></label>
      <label>Статус<select name="status" defaultValue=""><option value="">Все статусы</option>{USER_STATUSES.map(status => <option key={status} value={status}>{USER_STATUS_LABELS[status]}</option>)}</select></label>
      <button className="button secondary" type="submit"><Search size={17} aria-hidden="true" />Найти</button>
    </form>
    <AdminUserPage key={JSON.stringify([filters, revision])} {...props} filters={filters} onOpen={id => { setFocusTarget(null); setTargetId(id); }} />
    {targetId && <Modal title="Карточка пользователя" onClose={() => { if (!busy) { setFocusTarget(targetId); setTargetId(null); } }}>
      <AdminUserCard key={targetId} {...props} targetId={targetId} onChanged={changed} onBusy={setBusy} />
    </Modal>}
  </section>;
}

function AdminUserPage(props: AdminContextProps & { filters: AdminUserFilters; onOpen: (id: string) => void }) {
  const { guard, accountId, filters } = props;
  const fetchPage = useCallback((offset: number) => guard(accountApi.adminUsers(accountId, filters, offset)), [guard, accountId, filters]);
  const page = useAccountPage(fetchPage, props.onSessionChanged);
  return <div aria-busy={page.loading}>
    <div className="admin-section-heading"><p className="muted">Найдено: {page.total}</p><button className="text-button" disabled={page.loading || page.loadingMore} onClick={page.reload}>Обновить пользователей</button></div>
    {page.error && <p role="alert" className="form-error">{page.error}</p>}
    {page.loading ? <p role="status">Загружаем пользователей…</p> : <>
      {!page.items.length && !page.error && <p>Пользователи по этим условиям не найдены.</p>}
      <AdminUserList items={page.items} onOpen={props.onOpen} />
      {page.nextOffset < page.total && <button className="text-button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? 'Загружаем…' : 'Показать ещё пользователей'}</button>}
    </>}
  </div>;
}

export function AdminUserList({ items, onOpen }: { items: AdminUser[]; onOpen: (id: string) => void }) {
  return <ul className="admin-user-list">{items.map(user => <li key={user.id}>
    <div><h4>{user.name}</h4><p>{user.email}</p><p className="muted">{user.roles.map(role => ACCOUNT_ROLE_LABELS[role]).join(' · ')}{user.isAdmin && ' · Администратор'}</p>{user.publicId && <p className="admin-public-id">{user.publicId}</p>}</div>
    <div className="admin-user-actions"><span className={`status status-${user.status}`}>{USER_STATUS_LABELS[user.status]}</span><button id={`admin-user-open-${user.id}`} className="button secondary small" onClick={() => onOpen(user.id)} aria-label={`Открыть пользователя ${user.email}`}>Карточка пользователя</button></div>
  </li>)}</ul>;
}

function AdminUserCard(props: AdminContextProps & { targetId: string; onChanged: () => void; onBusy: (value: boolean) => void }) {
  const { guard, accountId, targetId } = props;
  const fetchUser = useCallback(() => guard(accountApi.adminUser(accountId, targetId)), [guard, accountId, targetId]);
  const detail = useAdminValue(fetchUser, props.onSessionChanged);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [message, setMessage] = useState('');
  const feedback = useRef<HTMLParagraphElement>(null);
  return <div className="admin-user-card" aria-busy={detail.loading}>
    <p className="admin-status-feedback" ref={feedback} tabIndex={-1} role="status">{message}</p>
    {detail.loading && <p role="status">Загружаем карточку…</p>}
    {detail.error && <div><p role="alert" className="form-error">{detail.error}</p><button className="text-button" onClick={detail.reload}>Повторить загрузку</button></div>}
    {detail.value && <>
      <h3>{detail.value.user.name}</h3><p>{detail.value.user.email}</p>
      <dl className="admin-user-metadata"><div><dt>ID аккаунта</dt><dd>{detail.value.user.id}</dd></div>
        <div><dt>Student ID</dt><dd>{detail.value.user.publicId ?? 'Нет профиля ученика'}</dd></div>
        <div><dt>Роли</dt><dd>{detail.value.user.roles.map(role => ACCOUNT_ROLE_LABELS[role]).join(', ')}{detail.value.user.isAdmin && ', администратор'}</dd></div>
        <div><dt>Регистрация</dt><dd>{adminDate(detail.value.user.createdAt)}</dd></div><div><dt>Обновление аккаунта</dt><dd>{adminDate(detail.value.updatedAt)}</dd></div>
        <div><dt>Действующие сессии</dt><dd>{detail.value.activeSessions}</dd></div>
      </dl>
      <AdminStatusEditor key={detail.value.user.statusVersion} {...props} user={detail.value.user} onChanged={() => { setMessage('Доступ пользователя изменён. Действие сохранено в журнале.'); detail.reload(); setHistoryRevision(value => value + 1); props.onChanged(); feedback.current?.focus(); }} />
      <h3>История пользователя</h3><AdminAudit key={historyRevision} {...props} userId={props.targetId} />
    </>}
  </div>;
}

function AdminStatusEditor(props: AdminContextProps & { user: AdminUser; onChanged: () => void; onBusy: (value: boolean) => void }) {
  const [user, setUser] = useState(props.user);
  const [status, setStatus] = useState<AdminStatusInput['status'] | ''>('');
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inFlight = useRef(false), alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const options = adminStatusOptions(user, props.accountId);
  const valid = status !== '' && options.includes(status) && reason.trim().length >= 3 && (status !== 'deactivated' || acknowledged);
  async function run(refresh: boolean) {
    if (inFlight.current || (!refresh && !valid)) return;
    inFlight.current = true; setBusy(true); props.onBusy(true); setError(''); setMessage('');
    try {
      if (refresh) {
        const result = await props.guard(accountApi.adminUser(props.accountId, user.id));
        if (!alive.current) return;
        setUser(result.user); setStatus(''); setAcknowledged(false); setMessage('Статус обновлён. Причина сохранена; выберите действие заново.');
      } else {
        await props.guard(accountApi.adminChangeStatus(props.accountId, user.id, { status: status as AdminStatusInput['status'], reason: reason.trim(), version: user.statusVersion }));
        if (alive.current) props.onChanged();
      }
    } catch (failure) {
      if (!alive.current || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) props.onSessionChanged(); else setError(accountErrorMessage(failure));
    } finally { inFlight.current = false; props.onBusy(false); if (alive.current) setBusy(false); }
  }
  return <section className="admin-status-editor" aria-label="Управление доступом">
    <h3>Доступ к платформе</h3><p>Текущий статус: <strong>{USER_STATUS_LABELS[user.status]}</strong></p>
    {!options.length ? <p className="muted">{user.id === props.accountId || user.isAdmin ? 'Изменение доступа администраторов выполняет оператор системы.' : 'Изменение этого статуса в кабинете недоступно.'}</p> :
      <form onSubmit={event => { event.preventDefault(); void run(false); }} aria-busy={busy}>
        <fieldset disabled={busy}><legend className="sr-only">Изменить доступ пользователя</legend>
          <label>Действие<select value={status} required onChange={event => { setStatus(event.target.value as typeof status); setAcknowledged(false); setMessage(''); }}><option value="">Выберите действие</option>{options.map(value => <option value={value} key={value}>{ADMIN_ACTION_LABELS[value]}</option>)}</select></label>
          <label>Причина изменения<textarea value={reason} required minLength={3} maxLength={500} rows={3} onChange={event => setReason(event.target.value)} aria-describedby="admin-reason-help" /></label>
          <p id="admin-reason-help" className="muted">От 3 до 500 символов. Причина будет видна администраторам в журнале.</p>
          {status === 'suspended' && <p>Все сессии пользователя завершатся. После восстановления доступа потребуется новый вход.</p>}
          {status === 'active' && <p>Пользователь сможет войти заново. Прежние сессии не восстанавливаются.</p>}
          {status === 'deactivated' && <label className="admin-deactivate-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />Подтверждаю отключение аккаунта. Восстановление через этот кабинет недоступно; история сохранится.</label>}
          <button className="button" type="submit" disabled={!valid}>{busy ? 'Сохраняем…' : status ? ADMIN_ACTION_LABELS[status] : 'Выберите действие'}</button>
        </fieldset>
      </form>}
    {error && <div><p className="form-error" role="alert">{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => void run(true)}>Обновить статус пользователя</button></div>}
    <p role="status">{message}</p>
  </section>;
}
