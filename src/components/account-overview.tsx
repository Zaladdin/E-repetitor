'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';


import Link from 'next/link';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { accountApi, accountErrorMessage, accountSessionChanged, isStaleAccountRequest, type AccountRole } from '@/lib/account-api';
import { overviewChildSelection, type AccountOverviewData } from '@/lib/account-overview';
import { useAccountPage } from './account-connections-state';
import { AccountOverviewSummary } from './account-overview-summary';

interface OverviewProps { accountId: string; role: AccountRole; onSessionChanged: () => void }

function useOverviewRefresh(accountId: string, reload: () => void) {
  useEffect(() => {
    const unsubscribe = accountApi.subscribeOverview(accountId, reload);
    const focus = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', focus);
    return () => { unsubscribe(); window.removeEventListener('focus', focus); };
  }, [accountId, reload]);
}

export function AccountOverview(props: OverviewProps) {
  const { t } = useI18n();
  return <section className="account-overview" aria-labelledby="account-overview-title">
    <div className="account-section-heading"><div><h2 id="account-overview-title">{t("Обзор кабинета")}</h2><p className="muted">{props.role === 'teacher' ? t("Занятия, результаты учеников и ручной учёт оплаты.") : props.role === 'parent' ? t("Общая картина обучения у всех преподавателей.") : t("Ваши занятия, тесты и результаты по всем предметам.")}</p></div></div>
    {props.role === 'parent' ? <ParentOverview {...props} /> : <OverviewContent {...props} />}
  </section>;
}

function ParentOverview(props: OverviewProps) {
  const { t } = useI18n();
  const id = useId();
  const fetchChildren = useCallback((offset: number) => accountApi.parentChildren(props.accountId, offset), [props.accountId]);
  const children = useAccountPage(fetchChildren, props.onSessionChanged);
  const [selected, setSelected] = useState<string | null>(null);
  useOverviewRefresh(props.accountId, children.reload);
  const studentId = overviewChildSelection(selected, children.items, children.total);
  const missingSelection = !!studentId && !children.items.some(child => child.id === studentId);

  return <>
    <div className="overview-child-toolbar">
      <div><label htmlFor={`${id}-child`}>{t("Обзор по ребёнку")}</label><select id={`${id}-child`} value={studentId} disabled={children.loading} onChange={event => setSelected(event.target.value)}>
        <option value="">{t("Все дети")}</option>
        {children.items.map(child => <option key={child.id} value={child.id}>{child.name} · {child.publicId}</option>)}
        {missingSelection && <option value={studentId} disabled>{t("Ранее выбранный ребёнок")}</option>}
      </select></div>
      <button className="text-button" disabled={children.loading || children.loadingMore} onClick={children.reload}>{t("Обновить список детей")}</button>
      {children.nextOffset < children.total && <button className="text-button" disabled={children.loading || children.loadingMore} onClick={() => void children.loadMore()}>{children.loadingMore ? t("Загружаем…") : t("Ещё дети · {value0} из {value1}", { value0: String(children.items.length), value1: String(children.total) })}</button>}
    </div>
    <p className="overview-preview-note">{t("Выбор ребёнка применяется к обзору. Остальные страницы кабинета содержат данные всех ваших детей.")}</p>
    {children.loading ? <p role="status" className="overview-empty">{t("Загружаем список детей…")}</p> : children.error ? <p role="alert" className="form-error">{t(children.error)}</p> : children.total === 0 ? <div className="overview-empty"><p>{t("Подтверждённых связей с детьми пока нет.")}</p><Link className="overview-section-link" href="/account/connections/">{t("Подключить ребёнка по Student ID")}</Link></div>
      : <OverviewContent key={studentId || 'all'} {...props} studentId={studentId || undefined} />}
  </>;
}

function OverviewContent({ accountId, role, studentId, onSessionChanged }: OverviewProps & { studentId?: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<AccountOverviewData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const sessionChanged = useRef(onSessionChanged);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { sessionChanged.current = onSessionChanged; }, [onSessionChanged]);
  const reload = useCallback(() => {
    invalidate();
    setData(null); setError(''); setLoading(true); setRevision(value => value + 1);
  }, [invalidate]);
  useOverviewRefresh(accountId, reload);

  useEffect(() => {
    const request = ++generation.current;
    accountApi.overview(accountId, role, studentId).then(result => {
      if (generation.current === request) setData(result);
    }).catch((failure: unknown) => {
      if (generation.current !== request || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) sessionChanged.current();
      else setError(accountErrorMessage(failure));
    }).finally(() => { if (generation.current === request) setLoading(false); });
    return invalidate;
  }, [accountId, role, studentId, revision, invalidate]);

  return <div className="overview-content" aria-busy={loading}>
    <div className="overview-refresh-bar"><p className="muted">{data ? <>{t("Данные на")}{' '}<time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' })}</time> · {timezone}</> : t("Сводка по данным преподавателей")}</p><button className="button secondary small" disabled={loading} onClick={reload}><RefreshCw size={16} aria-hidden="true" />{t("Обновить обзор")}</button></div>
    {loading ? <p role="status" className="overview-empty">{t("Загружаем обзор…")}</p> : error ? <p role="alert" className="form-error">{t(error)}</p> : data && <AccountOverviewSummary data={data} />}
  </div>;
}
