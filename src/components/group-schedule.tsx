'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

import { useCallback, useId } from 'react';
import { Users } from 'lucide-react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import type { GroupOccurrence } from '@/lib/account-groups';
import { useAccountPage } from './account-connections-state';
import { ConnectionHeading, PageContent } from './account-connections';

export function GroupSchedule({ accountId, role, onSessionChanged, from, to, timezone }: {
  accountId: string; role: AccountRole; onSessionChanged: () => void; from: string; to: string; timezone: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const fetchSchedule = useCallback((offset: number) => accountApi.groupSchedule(accountId, role, from, to, offset), [accountId, role, from, to]);
  const page = useAccountPage(fetchSchedule, onSessionChanged);
  return <section className="group-schedule" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={t("Занятия групп")} description={t("Еженедельный план групп на выбранную неделю.")} onRefresh={page.reload} disabled={page.loading || page.loadingMore} />
    <PageContent page={page} emptyTitle={t("Групповых занятий на эту неделю нет")} emptyText={role === 'teacher' ? t("Создайте группу и выберите дни занятий в разделе «Группы».") : role === 'parent' ? t("Расписание появится, когда преподаватель добавит ребёнка в группу.") : t("Расписание появится, когда преподаватель добавит вас в группу.")} disabled={false}>
      <GroupOccurrenceList items={page.items} role={role} timezone={timezone} />
    </PageContent>
  </section>;
}

export function GroupOccurrenceList({ items, role, timezone }: { items: GroupOccurrence[]; role: AccountRole; timezone: string }) {
  const { t } = useI18n();
  const time = (value: string) => new Intl.DateTimeFormat(localeTag(), { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const date = (value: string) => new Intl.DateTimeFormat(localeTag(), { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(value));
  return <ul className="group-occurrence-list">{items.map(item => <li key={item.id}>
    <div className="group-occurrence-time"><span>{date(item.startsAt)}</span><strong><time dateTime={item.startsAt}>{time(item.startsAt)}</time>–<time dateTime={item.endsAt}>{time(item.endsAt)}</time></strong></div>
    <div className="group-occurrence-main"><h3>{item.groupName}</h3><p>{item.subjectName}{role !== 'teacher' ? ` · ${item.teacherName}` : ''}{role === 'parent' && item.studentName ? ` · ${item.studentName}` : ''}</p>{item.timezone !== timezone && <small>{t("Часовой пояс группы:")}{' '}{item.timezone}</small>}</div>
    <span className="group-occurrence-label"><Users size={15} aria-hidden="true" />{t("Группа")}</span>
  </li>)}</ul>;
}
