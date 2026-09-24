'use client';

import { useI18n } from './locale-provider';

import Link from 'next/link';
import { useCallback, useId, useState } from 'react';
import { Archive, CalendarDays, Plus, Users } from 'lucide-react';
import { accountApi } from '@/lib/account-api';
import { GROUP_WEEKDAYS, type AccountGroup } from '@/lib/account-groups';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionConfirmation, ActionFeedback, ConnectionHeading, PageContent } from './account-connections';
import { GroupForm, groupRulesFromSlots } from './group-form';

interface GroupProps { accountId: string; timezone: string; onSessionChanged: () => void }

export function AccountGroups({ accountId, timezone, onSessionChanged }: GroupProps) {
  const { t } = useI18n();
  const id = useId();
  const fetchGroups = useCallback((offset: number) => accountApi.groups(accountId, offset), [accountId]);
  const page = useAccountPage(fetchGroups, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, page.reload);
  const [editor, setEditor] = useState<{ group?: AccountGroup } | null>(null);
  const [notice, setNotice] = useState('');
  const blocked = actions.busy || page.loading || page.loadingMore;

  function archive(group: AccountGroup) {
    actions.setConfirmation({
      title: t("Архивировать группу?"),
      description: t("«{value1}» исчезнет из списка активных групп, а её еженедельные занятия — из расписания. Подключения учеников к предмету сохранятся.", { value1: group.name }),
      action: t("Архивировать"), success: t("Группа архивирована."),
      execute: () => accountApi.archiveGroup(accountId, group.id, group.version),
    });
  }

  return <section className="account-groups" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={t("Группы учеников")} description={t("Объединяйте учеников по предмету и выбирайте удобные дни занятий.")} onRefresh={page.reload} disabled={blocked} />
    <div className="group-page-toolbar"><p className="muted">{t("Один состав. Общее расписание на каждую неделю.")}</p><button className="button" disabled={actions.busy} onClick={() => { setNotice(''); setEditor({}); }}><Plus size={18} aria-hidden="true" />{t("Создать группу")}</button></div>
    <ActionFeedback actions={actions} />
    {notice && <p className="group-notice" role="status">{t(notice)}</p>}
    <PageContent page={page} disabled={actions.busy} emptyTitle={t("Соберите первую группу")} emptyText={t("Выберите предмет, добавьте своих учеников и задайте дни недели с временем начала и окончания.")} >
      <GroupCards groups={page.items} disabled={blocked} onEdit={group => { setNotice(''); setEditor({ group }); }} onArchive={archive} />
    </PageContent>
    <p className="group-page-help muted">{t("В группу можно добавить учеников с активным обучением по выбранному предмету. Подключить учеников можно в разделе")}{' '}<Link href="/account/connections/">{t("«Ученики и предметы»")}</Link>.</p>
    <ActionConfirmation actions={actions} />
    {editor && <GroupForm accountId={accountId} timezone={timezone} group={editor.group} onSessionChanged={onSessionChanged} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setNotice(editor.group ? t("Изменения группы сохранены.") : t("Группа создана. Её занятия уже доступны в расписании.")); page.reload(); }} />}
  </section>;
}

export function GroupCards({ groups, disabled, onEdit, onArchive }: { groups: AccountGroup[]; disabled: boolean; onEdit: (group: AccountGroup) => void; onArchive: (group: AccountGroup) => void }) {
  const { t } = useI18n();
  return <ul className="group-card-grid">{groups.map(group => <li key={group.id} className={`group-card${group.status === 'archived' ? ' group-card-archived' : ''}`}>
    <div className="group-card-heading"><div className="group-card-symbol"><Users size={22} aria-hidden="true" /></div><div><p className="group-subject">{group.subjectName}</p><h3>{group.name}</h3></div>{group.status === 'archived' && <span className="status">{t("В архиве")}</span>}</div>
    <div className="group-card-schedule"><p className="group-card-label"><CalendarDays size={15} aria-hidden="true" />{t("Каждую неделю")}</p><ul>{groupRulesFromSlots(group.slots).map(rule => <li key={rule.key}><span>{rule.days.map(day => t(GROUP_WEEKDAYS[day - 1].short)).join(', ')}</span><strong>{rule.startTime}–{rule.endTime}</strong></li>)}</ul><small>{group.timezone}</small></div>
    <div className="group-card-members"><p className="group-card-label">{t("Участники ·")}{' '}{group.members.length}</p><ul>{group.members.map(member => <li key={member.enrollmentId}>{member.studentName}<span>{member.status !== 'active' ? t(" · обучение не активно") : ''}</span></li>)}</ul></div>
    {group.status === 'active' && <div className="group-card-actions"><button className="text-button" disabled={disabled} onClick={() => onEdit(group)}>{t("Изменить группу")}</button><button className="text-button" disabled={disabled} onClick={() => onArchive(group)} aria-label={t("Архивировать группу {value1}", { value1: group.name })}><Archive size={15} aria-hidden="true" />{t("В архив")}</button></div>}
  </li>)}</ul>;
}
