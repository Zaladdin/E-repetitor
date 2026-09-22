'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, ChevronDown, RefreshCw } from 'lucide-react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import { NOTIFICATION_TARGETS, type AccountNotification, type NotificationTarget } from '@/lib/account-notifications';
import { emptyNotificationFeed, NotificationFeedLoader } from '@/lib/notification-feed';
import { useConnectionActions } from './account-connections-state';
import { ActionFeedback } from './account-connections';
import { AccountNotificationPreferences } from './account-notification-preferences';
import { ACCOUNT_ROLE_LABELS } from './account-auth';

interface NotificationProps {
  accountId: string; open: boolean; onOpenChange: (value: boolean) => void; onSessionChanged: () => void;
  onUnreadCount: (value: number | null) => void; onNavigate: (role: AccountRole, target: NotificationTarget) => void;
}

export function AccountNotifications(props: NotificationProps) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [preferencesOpened, setPreferencesOpened] = useState(false);
  return <section id="account-notifications-section" tabIndex={-1} className="account-notifications account-section-target" aria-labelledby="notifications-title">
    <div className="notifications-heading"><div><Bell size={23} aria-hidden="true" /><h2 id="notifications-title">Уведомления</h2></div>
      <button className="button secondary small" aria-expanded={props.open} aria-controls="notifications-content" onClick={() => props.onOpenChange(!props.open)}>{props.open ? 'Свернуть' : 'Открыть'}<ChevronDown size={17} aria-hidden="true" /></button>
    </div>
    <div id="notifications-content" hidden={!props.open}>
      <p className="account-list-help muted">События всех ваших ролей. Переход из уведомления откроет нужный кабинет и раздел.</p>
      <div className="notification-filters"><label><input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} />Только непрочитанные</label></div>
      <NotificationFeed key={`${props.accountId}:${unreadOnly}`} {...props} unreadOnly={unreadOnly} />
      <details className="notification-settings" onToggle={event => { if (event.currentTarget.open) setPreferencesOpened(true); }}>
      <summary>Настроить уведомления и письма</summary>
      {preferencesOpened && <AccountNotificationPreferences accountId={props.accountId} onSessionChanged={props.onSessionChanged} />}
      </details>
    </div>
  </section>;
}

function NotificationFeed({ accountId, unreadOnly, onUnreadCount, onSessionChanged, onNavigate }: NotificationProps & { unreadOnly: boolean }) {
  const [page, setPage] = useState(emptyNotificationFeed);
  const loader = useRef<NotificationFeedLoader | null>(null);
  const sessionChanged = useRef(onSessionChanged), unreadCount = useRef(onUnreadCount);
  useEffect(() => { sessionChanged.current = onSessionChanged; unreadCount.current = onUnreadCount; }, [onSessionChanged, onUnreadCount]);
  useEffect(() => {
    const reader = new NotificationFeedLoader(offset => accountApi.notifications(accountId, offset, unreadOnly), state => {
      setPage(state); unreadCount.current(state.unreadTotal);
    }, () => sessionChanged.current());
    loader.current = reader;
    void reader.reload();
    const refresh = () => { void reader.reload(); };
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void reader.reload(true); };
    const unsubscribe = accountApi.subscribeOverview(accountId, refresh);
    window.addEventListener('focus', visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 60_000);
    return () => { reader.dispose(); if (loader.current === reader) loader.current = null; unsubscribe(); window.clearInterval(timer); window.removeEventListener('focus', visibleRefresh); };
  }, [accountId, unreadOnly]);
  const reload = useCallback(() => { void loader.current?.reload(); }, []);
  const actions = useConnectionActions(onSessionChanged, reload);
  const blocked = actions.busy || page.loading || page.loadingMore || page.refreshing;

  return <div className="notification-feed" aria-busy={page.loading || page.refreshing}>
    <div className="notification-toolbar"><p className="muted">{page.unreadTotal === null ? 'Проверяем новые события…' : `Непрочитанных: ${page.unreadTotal} · в списке: ${page.total}`}</p>
      <button className="text-button" disabled={blocked} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Обновить</button></div>
    <ActionFeedback actions={actions} />
    {page.loading ? <p className="account-list-loading muted" role="status">Загружаем уведомления…</p> : <>
      {page.error && <p role="alert" className="form-error">{page.error}</p>}
      {page.items.length ? <NotificationList items={page.items} disabled={blocked} onNavigate={onNavigate} onRead={item => void actions.run(() => accountApi.readNotification(accountId, item.id), 'Уведомление отмечено как прочитанное.')} />
        : !page.error && <div className="notification-empty"><Bell size={26} aria-hidden="true" /><h3>{unreadOnly ? 'Непрочитанных уведомлений нет' : 'Здесь появятся новые события'}</h3><p>{unreadOnly ? 'Все доступные уведомления прочитаны.' : 'Напоминания о занятиях, изменения расписания, новые тесты и опубликованные результаты.'}</p></div>}
      {page.nextOffset < page.total && <button className="text-button account-load-more" disabled={blocked} onClick={() => void loader.current?.more()}>{page.loadingMore ? 'Загружаем…' : `Показать ещё · ${page.items.length} из ${page.total}`}</button>}
    </>}
  </div>;
}

export function NotificationList({ items, disabled, onRead, onNavigate }: {
  items: AccountNotification[]; disabled: boolean; onRead: (item: AccountNotification) => void;
  onNavigate: (role: AccountRole, target: NotificationTarget) => void;
}) {
  return <ul className="notification-list">{items.map(item => <li key={item.id} className={item.readAt ? 'notification-read' : 'notification-unread'}>
    <div className="notification-main"><div className="notification-item-heading"><h3>{item.title}</h3><span className={`status status-${item.readAt ? 'active' : 'pending'}`}>{item.readAt ? 'Прочитано' : 'Новое'}</span></div><p className="notification-body">{item.body}</p>
      <p className="notification-meta">{ACCOUNT_ROLE_LABELS[item.recipientRole]} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })}</time></p></div>
    <div className="notification-actions"><button className="text-button" onClick={() => onNavigate(item.recipientRole, item.target)}>{NOTIFICATION_TARGETS[item.target].label}</button>
      {!item.readAt && <button className="text-button" disabled={disabled} onClick={() => onRead(item)} aria-label={`Отметить прочитанным: ${item.title}`}><Check size={15} aria-hidden="true" />Отметить прочитанным</button>}</div>
  </li>)}</ul>;
}
