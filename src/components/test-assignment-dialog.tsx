'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountApi, AccountApiError } from '@/lib/account-api';
import { ANSWER_POLICY_LABELS, type AnswerPolicy, type ResultPolicy, type TestSummary } from '@/lib/account-tests';
import { localInputToIso } from '@/lib/account-lessons';
import { useI18n } from './locale-provider';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionFeedback } from './account-connections';
import { Modal } from './ui';

export function AssignTestDialog({ accountId, test, onSessionChanged, onClose, onSaved }: {
  accountId: string; test: TestSummary; onSessionChanged: () => void; onClose: () => void; onSaved: (message: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [target, setTarget] = useState<'student' | 'group'>('student');
  const [policy, setPolicy] = useState<AnswerPolicy>('never');
  const [resultPolicy, setResultPolicy] = useState<ResultPolicy>('after_submission');
  const [versionId, setVersionId] = useState(test.latestVersion?.id ?? '');
  const [groupId, setGroupId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const confirmationRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (confirmClose) confirmationRef.current?.focus(); }, [confirmClose]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const fetchVersions = useCallback((offset: number) => accountApi.testVersions(accountId, test.id, offset), [accountId, test.id]);
  const fetchEnrollments = useCallback((offset: number) => accountApi.enrollments(accountId, 'teacher', offset), [accountId]);
  const fetchGroups = useCallback((offset: number) => accountApi.groups(accountId, offset), [accountId]);
  const versions = useAccountPage(fetchVersions, onSessionChanged);
  const enrollments = useAccountPage(fetchEnrollments, onSessionChanged);
  const groups = useAccountPage(fetchGroups, onSessionChanged);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const actions = useConnectionActions(onSessionChanged, () => {});
  const eligible = enrollments.items.filter(item => item.status === 'active' && item.subjectName === test.subjectName);
  const matchingGroups = groups.items.filter(group => group.status === 'active' && group.subjectId === test.subjectId);
  const selectedGroup = matchingGroups.find(group => group.id === groupId);
  const activeMembers = selectedGroup?.members.filter(member => member.status === 'active') ?? [];
  const targetPage = target === 'student' ? enrollments : groups;
  const blocked = actions.busy || confirmClose || versions.loading || targetPage.loading || !!versions.error || !!targetPage.error;
  const close = () => { if (!actions.busy) { if (dirty) setConfirmClose(true); else onClose(); } };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const data = new FormData(event.currentTarget);
    let assignedCount: number | undefined;
    if (await actions.run(async () => {
      const due = String(data.get('dueAt') ?? '');
      let dueAt: string | undefined;
      try { dueAt = due ? localInputToIso(due) : undefined; } catch (error) { throw new AccountApiError(error instanceof Error ? error.message : t('Проверьте дату.'), 400, 'validation_error'); }
      const timer = String(data.get('timeLimitMin') ?? '');
      const settings = { versionId, maxAttempts: Number(data.get('maxAttempts')), answerPolicy: policy, resultPolicy, ...(dueAt ? { dueAt } : {}), ...(timer ? { timeLimitMin: Number(timer) } : {}) };
      const input = target === 'group' ? { ...settings, groupId } : { ...settings, enrollmentId: String(data.get('enrollmentId')) };
      const fingerprint = JSON.stringify({ target, ...input });
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      if ('groupId' in input) assignedCount = (await accountApi.assignGroupTest(accountId, { ...input, requestId: request.current.id })).total;
      else await accountApi.assignTest(accountId, { ...input, requestId: request.current.id });
    }, target === 'group' ? t('Тест назначен группе.') : t('Тест назначен ученику.'))) onSaved(assignedCount === undefined ? t('Тест назначен ученику.') : t('Тест назначен группе. Получателей: {count}.', { count: assignedCount }));
  }
  return <Modal title={t('Назначить тест')} onClose={close}>
    <p className="test-preserve-text">{test.title} · {t('Вариант {code}', { code: test.variantCode })} · {test.subjectName}</p>
    <form className="account-form test-builder-form" onSubmit={event => void submit(event)} onChange={() => setDirty(true)} aria-busy={actions.busy}>
      <fieldset className="test-form-fieldset" disabled={actions.busy || confirmClose}>
        <fieldset className="test-assignment-target"><legend>{t('Кому назначить')}</legend><label><input type="radio" name="target" value="student" checked={target === 'student'} onChange={() => setTarget('student')} />{t('Одному ученику')}</label><label><input type="radio" name="target" value="group" checked={target === 'group'} onChange={() => setTarget('group')} />{t('Всей группе')}</label></fieldset>
        <label htmlFor={`${id}-version`}>{t('Опубликованная версия')}</label><select id={`${id}-version`} name="versionId" required value={versionId} disabled={versions.loading} onChange={event => setVersionId(event.target.value)}><option value="">{t('Выберите версию')}</option>{versions.items.map(version => <option key={version.id} value={version.id}>{t('Вариант {code} · версия {number}', { code: version.variantCode, number: version.number })} · {version.maxPoints}{t(' балл.')}</option>)}</select>
        {target === 'student' ? <><label htmlFor={`${id}-student`}>{t('Ученик по этому предмету')}</label><select id={`${id}-student`} name="enrollmentId" required defaultValue="" disabled={enrollments.loading}><option value="">{t('Выберите ученика')}</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.studentName ?? item.studentPublicId} · {item.studentPublicId}</option>)}</select></>
          : <><label htmlFor={`${id}-group`}>{t('Группа по этому предмету')}</label><select id={`${id}-group`} name="groupId" required value={groupId} disabled={groups.loading} onChange={event => setGroupId(event.target.value)}><option value="">{t('Выберите группу')}</option>{matchingGroups.map(group => <option key={group.id} value={group.id}>{group.name} · {t('Участников: {count}', { count: group.members.length })}</option>)}</select>
            {selectedGroup && <div className="test-group-recipient-summary"><strong>{t('Активных участников: {active} из {total}', { active: activeMembers.length, total: selectedGroup.members.length })}</strong><p className="muted">{t('Этот вариант получат участники с активным обучением и доступным аккаунтом. У каждого будут собственные попытки. Изменение состава группы после назначения не изменит выданные тесты.')}</p><ul>{selectedGroup.members.map(member => <li key={member.enrollmentId}>{member.studentName}{member.status !== 'active' && <span className="muted"> · {t('Не получит тест: обучение не активно')}</span>}</li>)}</ul></div>}
          </>}
        <div className="test-form-grid"><div><label htmlFor={`${id}-attempts`}>{t('Количество попыток')}</label><input id={`${id}-attempts`} name="maxAttempts" type="number" min={1} max={10} step={1} defaultValue={1} required /></div><div><label htmlFor={`${id}-timer`}>{t('Время на попытку, мин.')}</label><input id={`${id}-timer`} name="timeLimitMin" type="number" min={1} max={180} step={1} placeholder={t('Без ограничения')} /></div></div>
        <label htmlFor={`${id}-due`}>{t('Срок сдачи ')}{policy === 'after_deadline' ? '' : t('· необязательно')}</label><input id={`${id}-due`} name="dueAt" type="datetime-local" required={policy === 'after_deadline'} />
        <p className="account-list-help muted">{t('Часовой пояс: ')}{Intl.DateTimeFormat().resolvedOptions().timeZone}{t('. После срока тест остаётся доступен с пометкой о просрочке. Лимит времени отсчитывается отдельно с начала каждой попытки.')}</p>
        <label htmlFor={`${id}-result-policy`}>{t('Когда показывать результат')}</label><select id={`${id}-result-policy`} value={resultPolicy} onChange={event => setResultPolicy(event.target.value as ResultPolicy)}><option value="after_submission">{t('Сразу после завершения проверки')}</option><option value="after_teacher_publish">{t('После публикации преподавателем')}</option></select>
        <p className="account-list-help muted">{t('Варианты ответов проверяются автоматически. Если есть текстовые вопросы, итоговый результат появится после их проверки. Родители увидят результат после публикации.')}</p>
        <label htmlFor={`${id}-policy`}>{t('Когда показывать правильные ответы ученику')}</label><select id={`${id}-policy`} value={policy} onChange={event => setPolicy(event.target.value as AnswerPolicy)}>{Object.entries(ANSWER_POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
        <p className="account-list-help muted">{t('Это отдельная настройка для правильных ответов и объяснений. Открытые ответы могут использоваться при повторной попытке.')}</p>
        <div className="form-actions"><button type="button" className="button secondary" onClick={close}>{t('Отмена')}</button><button type="submit" className="button" disabled={blocked || !versionId || (target === 'student' ? !eligible.length : !activeMembers.length)}>{target === 'group' ? t('Назначить группе') : t('Назначить')}</button></div>
      </fieldset>
    </form>
    {(versions.loading || targetPage.loading) && <p role="status">{t('Загружаем варианты и получателей…')}</p>}
    {(versions.error || targetPage.error) && <div className="form-error"><p role="alert">{t(versions.error || targetPage.error)}</p><button className="text-button" disabled={actions.busy} onClick={() => { versions.reload(); targetPage.reload(); }}>{t('Повторить загрузку')}</button></div>}
    {!targetPage.loading && !targetPage.error && !(target === 'student' ? eligible.length : matchingGroups.length) && <p className="account-list-help muted">{target === 'student' ? t('В загруженном списке нет активных учеников по этому предмету. Загрузите остальные подключения или подтвердите обучение в разделе учеников.') : t('В загруженном списке нет групп по этому предмету. Загрузите остальные группы или создайте новую в разделе «Группы».')}</p>}
    {targetPage.nextOffset < targetPage.total && <button className="text-button" disabled={targetPage.loadingMore || actions.busy} onClick={() => void targetPage.loadMore()}>{targetPage.loadingMore ? t('Загружаем…') : target === 'student' ? t('Загрузить ещё учеников') : t('Загрузить ещё группы')}</button>}
    {versions.nextOffset < versions.total && <button className="text-button" disabled={versions.loadingMore || actions.busy} onClick={() => void versions.loadMore()}>{t('Загрузить ещё версии')}</button>}
    <ActionFeedback actions={actions} />
    {confirmClose && <div className="test-confirmation" role="group" tabIndex={-1} ref={confirmationRef} aria-label={t('Несохранённое назначение')}><p>{t('Настройки назначения ещё не отправлены. Закрыть окно?')}</p><div className="form-actions"><button className="button secondary" onClick={() => setConfirmClose(false)}>{t('Остаться')}</button><button className="button" onClick={onClose}>{t('Закрыть без сохранения')}</button></div></div>}
  </Modal>;
}
