'use client';

import { useI18n } from './locale-provider';
import { translate, localeTag } from '@/lib/i18n';

import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { accountApi, AccountApiError } from '@/lib/account-api';
import { GROUP_WEEKDAYS, type AccountGroup, type GroupSlot, type CreateGroupInput } from '@/lib/account-groups';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionFeedback } from './account-connections';
import { Modal } from './ui';

export interface GroupRule { key: string; days: number[]; startTime: string; endTime: string }

export function groupRulesFromSlots(slots: GroupSlot[]): GroupRule[] {
  const rules = new Map<string, GroupRule>();
  for (const slot of [...slots].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime))) {
    const key = `${slot.startTime}-${slot.endTime}`;
    const existing = rules.get(key);
    if (existing) existing.days.push(slot.weekday);
    else rules.set(key, { key, days: [slot.weekday], startTime: slot.startTime, endTime: slot.endTime });
  }
  return [...rules.values()];
}

export function expandGroupRules(rules: GroupRule[]): GroupSlot[] {
  const slots: GroupSlot[] = [];
  const invalid = (message: string): never => { throw new AccountApiError(message, 400, 'INVALID_GROUP_SCHEDULE'); };
  if (!rules.length) invalid(translate("Добавьте хотя бы одно время занятий."));
  for (const rule of rules) {
    if (!rule.days.length) invalid(translate("Для каждого времени занятий выберите хотя бы один день недели."));
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.endTime)) invalid(translate("Укажите время начала и окончания занятий."));
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const duration = minutes(rule.endTime) - minutes(rule.startTime);
    if (duration <= 0) invalid(translate("Время окончания должно быть позже начала в тот же день."));
    if (duration > 480) invalid(translate("Занятие не может длиться больше 8 часов."));
    for (const weekday of rule.days) {
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) invalid(translate("Выберите корректный день недели."));
      slots.push({ weekday, startTime: rule.startTime, endTime: rule.endTime });
    }
  }
  if (slots.length > 14) invalid(translate("В группе можно запланировать до 14 занятий в неделю."));
  slots.sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
  for (let index = 1; index < slots.length; index++) {
    if (slots[index].weekday === slots[index - 1].weekday && slots[index].startTime < slots[index - 1].endTime) invalid(translate("Время занятий одной группы не должно пересекаться."));
  }
  return slots;
}

export function GroupForm({ accountId, timezone, group, onSessionChanged, onClose, onSaved }: {
  accountId: string; timezone: string; group?: AccountGroup; onSessionChanged: () => void; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [subjectId, setSubjectId] = useState(group?.subjectId ?? '');
  const [selected, setSelected] = useState<string[]>(group?.members.map(member => member.enrollmentId) ?? []);
  const [rules, setRules] = useState<GroupRule[]>(() => group ? groupRulesFromSlots(group.slots) : [{ key: 'first', days: [], startTime: '16:00', endTime: '17:00' }]);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const fetchSubjects = useCallback((offset: number) => accountApi.subjects(accountId, offset), [accountId]);
  const subjects = useAccountPage(fetchSubjects, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, () => {});
  const close = () => { if (!actions.busy) onClose(); };
  const changeRule = (key: string, changes: Partial<GroupRule>) => setRules(current => current.map(rule => rule.key === key ? { ...rule, ...changes } : rule));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actions.busy) return;
    const data = new FormData(event.currentTarget);
    const ok = await actions.run(async () => {
      const name = String(data.get('name') ?? '').trim();
      const zone = String(data.get('timezone') ?? '').trim();
      if (!name) throw new AccountApiError(t("Введите название группы."), 400, 'INVALID_GROUP');
      if (!subjectId) throw new AccountApiError(t("Выберите предмет группы."), 400, 'INVALID_GROUP');
      if (!selected.length) throw new AccountApiError(t("Добавьте хотя бы одного ученика в группу."), 400, 'INVALID_GROUP');
      if (selected.length > 50) throw new AccountApiError(t("В группу можно добавить до 50 учеников."), 400, 'INVALID_GROUP');
      try { new Intl.DateTimeFormat(localeTag(), { timeZone: zone }).format(); } catch { throw new AccountApiError(t("Укажите существующий часовой пояс, например Asia/Baku."), 400, 'INVALID_GROUP'); }
      const payload: Omit<CreateGroupInput, 'requestId'> = { name, subjectId, timezone: zone, enrollmentIds: selected, slots: expandGroupRules(rules) };
      if (group) await accountApi.updateGroup(accountId, group.id, { ...payload, version: group.version });
      else {
        const fingerprint = JSON.stringify(payload);
        if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
        await accountApi.createGroup(accountId, { ...payload, requestId: request.current.id });
        request.current = null;
      }
    }, t("Группа сохранена."));
    if (ok) onSaved();
  }

  return <Modal title={group ? t("Изменить группу") : t("Новая группа")} onClose={close}>
    <p className="group-form-intro muted">{t("Выберите учеников и настройте общее расписание.")}</p>
    <form className="account-form group-form" onSubmit={event => void submit(event)} aria-busy={actions.busy} aria-describedby={`${id}-feedback`}>
      <fieldset disabled={actions.busy} className="group-form-section"><legend>{t("О группе")}</legend><div className="group-form-columns">
        <div><label htmlFor={`${id}-name`}>{t("Название группы")}</label><input id={`${id}-name`} name="name" autoComplete="off" required maxLength={100} defaultValue={group?.name ?? ''} placeholder={t("Например, Математика · 9 класс")} /></div>
        <div><label htmlFor={`${id}-subject`}>{t("Предмет")}</label><select id={`${id}-subject`} required value={subjectId} disabled={actions.busy || subjects.loading} onChange={event => { setSubjectId(event.target.value); setSelected([]); }}><option value="">{t("Выберите предмет")}</option>{group && !subjects.items.some(subject => subject.id === group.subjectId) && <option value={group.subjectId}>{group.subjectName}</option>}{subjects.items.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></div>
      </div>
        {subjects.loading && <p role="status" className="muted group-form-help">{t("Загружаем предметы…")}</p>}
        {subjects.error && <div className="form-error"><p role="alert">{t(subjects.error)}</p><button type="button" className="text-button" onClick={subjects.reload}>{t("Повторить загрузку предметов")}</button></div>}
        {!subjects.loading && !subjects.error && !subjects.items.length && !group && <p className="muted group-form-help">{t("Сначала добавьте предмет в разделе «Ученики и предметы».")}</p>}
        {subjects.nextOffset < subjects.total && <button type="button" className="text-button" disabled={subjects.loadingMore} onClick={() => void subjects.loadMore()}>{subjects.loadingMore ? t("Загружаем…") : t("Ещё предметы · {value1} из {value2}", { value1: subjects.items.length, value2: subjects.total })}</button>}
      </fieldset>
      <fieldset disabled={actions.busy} className="group-form-section"><legend>{t("Ученики")}{' '}<span className="group-selection-count">{selected.length}</span></legend>
        <p className="muted group-form-help">{t("Выберите до 50 участников с активным обучением по этому предмету.")}</p>
        {subjectId ? <GroupMembers key={subjectId} accountId={accountId} subjectId={subjectId} onSessionChanged={onSessionChanged} selected={selected} onSelect={setSelected} disabled={actions.busy} previous={subjectId === group?.subjectId ? group.members : []} /> : <p className="group-member-placeholder muted">{t("Список учеников появится после выбора предмета.")}</p>}
      </fieldset>
      <fieldset disabled={actions.busy} className="group-form-section"><legend>{t("Еженедельное расписание")}</legend><p className="muted group-form-help">{t("Выберите дни недели и время с начала до конца занятия.")}</p>
        <div className="group-rule-list">{rules.map((rule, index) => <fieldset className="group-rule" key={rule.key}><legend>{t("Время занятий")}{' '}{index + 1}</legend>
          <div className="group-rule-heading"><span>{t("Дни недели")}</span>{rules.length > 1 && <button type="button" className="icon-button" aria-label={t("Удалить время занятий {value1}", { value1: index + 1 })} onClick={() => setRules(current => current.filter(item => item.key !== rule.key))}><Trash2 size={17} aria-hidden="true" /></button>}</div>
          <div className="group-weekdays">{GROUP_WEEKDAYS.map(day => <button type="button" key={day.value} aria-label={t("{value1}, время занятий {value2}", { value1: t(day.label), value2: index + 1 })} aria-pressed={rule.days.includes(day.value)} onClick={() => changeRule(rule.key, { days: rule.days.includes(day.value) ? rule.days.filter(value => value !== day.value) : [...rule.days, day.value].sort((a, b) => a - b) })}>{t(day.short)}</button>)}</div>
          <div className="group-time-range"><div><label htmlFor={`${id}-start-${rule.key}`}>{t("С")}</label><input id={`${id}-start-${rule.key}`} type="time" aria-label={t("Начало занятий {value1}", { value1: index + 1 })} required value={rule.startTime} onChange={event => changeRule(rule.key, { startTime: event.target.value })} /></div><span aria-hidden="true">—</span><div><label htmlFor={`${id}-end-${rule.key}`}>{t("До")}</label><input id={`${id}-end-${rule.key}`} type="time" aria-label={t("Окончание занятий {value1}", { value1: index + 1 })} required value={rule.endTime} onChange={event => changeRule(rule.key, { endTime: event.target.value })} /></div></div>
        </fieldset>)}</div>
        <button type="button" className="text-button group-add-time" disabled={rules.length >= 14} onClick={() => setRules(current => [...current, { key: crypto.randomUUID(), days: [], startTime: '16:00', endTime: '17:00' }])}><Plus size={16} aria-hidden="true" />{t("Добавить другое время")}</button>
        <div className="group-timezone"><label htmlFor={`${id}-timezone`}>{t("Часовой пояс расписания")}</label><input id={`${id}-timezone`} name="timezone" required maxLength={100} defaultValue={group?.timezone ?? timezone} placeholder="Asia/Baku" aria-describedby={`${id}-timezone-help`} /><small id={`${id}-timezone-help`}>{t("Занятия повторяются каждую неделю по местному времени этого часового пояса.")}</small></div>
      </fieldset>
      <ActionFeedback actions={actions} id={`${id}-feedback`} />
      {actions.error && group && <p className="group-form-help muted">{t("Если группа уже изменена в другой вкладке, закройте окно, обновите список и откройте группу заново.")}</p>}
      <div className="form-actions"><button type="button" className="button secondary" disabled={actions.busy} onClick={close}>{t("Отмена")}</button><button type="submit" className="button" disabled={actions.busy || !subjectId}>{actions.busy ? t("Сохраняем…") : group ? t("Сохранить изменения") : t("Создать группу")}</button></div>
    </form>
  </Modal>;
}

function GroupMembers({ accountId, subjectId, selected, onSelect, disabled, previous, onSessionChanged }: {
  accountId: string; subjectId: string; selected: string[]; onSelect: (selected: string[]) => void; disabled: boolean; previous: AccountGroup['members']; onSessionChanged: () => void;
}) {
  const { t } = useI18n();
  const fetchCandidates = useCallback(async (offset: number) => {
    const result = await accountApi.groupCandidates(accountId, subjectId, offset);
    return { ...result, items: result.items.map(item => ({ ...item, id: item.enrollmentId, status: 'active' })) };
  }, [accountId, subjectId]);
  const page = useAccountPage(fetchCandidates, onSessionChanged);
  const members = [...new Map([...previous, ...page.items].map(member => [member.enrollmentId, member])).values()];
  return <div className="group-members-selector">
    {page.loading && <p className="muted" role="status">{t("Загружаем учеников…")}</p>}
    {page.error && <div className="form-error"><p role="alert">{t(page.error)}</p><button type="button" className="text-button" disabled={disabled} onClick={page.reload}>{t("Повторить загрузку учеников")}</button></div>}
    {!page.loading && !page.error && !members.length && <p className="muted">{t("Активных учеников по этому предмету пока нет.")}</p>}
    {!!members.length && <ul>{members.map(member => <li key={member.enrollmentId}><label><input type="checkbox" checked={selected.includes(member.enrollmentId)} disabled={disabled || (!selected.includes(member.enrollmentId) && (member.status !== 'active' || selected.length >= 50))} onChange={event => onSelect(event.target.checked ? [...selected, member.enrollmentId] : selected.filter(value => value !== member.enrollmentId))} /><span><strong>{member.studentName}</strong><small>{member.studentPublicId}{member.status !== 'active' ? t(" · обучение не активно — уберите из группы") : ''}</small></span></label></li>)}</ul>}
    {page.nextOffset < page.total && <button type="button" className="text-button group-load-members" disabled={disabled || page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? t("Загружаем…") : t("Ещё ученики · {value1} из {value2}", { value1: page.items.length, value2: page.total })}</button>}
  </div>;
}
