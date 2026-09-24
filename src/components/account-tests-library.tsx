'use client';

import { useI18n } from './locale-provider';
import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { AccountApiError, accountApi } from '@/lib/account-api';
import { ANSWER_POLICY_LABELS, type AnswerPolicy, type TestDetail, type TestSummary } from '@/lib/account-tests';
import { localInputToIso } from '@/lib/account-lessons';
import { ActionConfirmation, ActionFeedback, ConnectionHeading, PageContent } from './account-connections';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { TestBuilder } from './test-builder';
import { Modal } from './ui';

interface TeacherTestsProps { accountId: string; onSessionChanged: () => void; onAssigned: () => void }

export function TeacherTestLibrary({ accountId, onSessionChanged, onAssigned }: TeacherTestsProps) {
  const { t } = useI18n();
  const id = useId();
  const fetchTests = useCallback((offset: number) => accountApi.tests(accountId, offset), [accountId]);
  const fetchSubjects = useCallback((offset: number) => accountApi.subjects(accountId, offset), [accountId]);
  const page = useAccountPage(fetchTests, onSessionChanged);
  const subjects = useAccountPage(fetchSubjects, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, page.reload);
  const [builderId, setBuilderId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<TestSummary | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = { subjectId: String(data.get('subjectId')), title: String(data.get('title')).trim(), questions: [] };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    let created: TestDetail | undefined;
    if (await actions.run(async () => { created = await accountApi.createTest(accountId, { ...input, requestId: request.current!.id }); }, t("Черновик создан. Добавьте вопросы в конструкторе."))) {
      request.current = null; form.reset(); if (created) setBuilderId(created.id);
    }
  }
  const blocked = actions.busy || page.loading || page.loadingMore;
  return <section className="account-test-library" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={t("Мои тесты")} description={t("Создавайте вопросы, публикуйте версии и назначайте тесты своим ученикам.")} onRefresh={() => { page.reload(); subjects.reload(); }} disabled={blocked} />
    <details className="account-invitation-create"><summary>{t("Создать тест")}</summary>
      <form className="account-form" onSubmit={event => void create(event)}><fieldset className="test-form-fieldset" disabled={actions.busy || subjects.loading || !!subjects.error}>
        <label htmlFor={`${id}-name`}>{t("Название")}</label><input id={`${id}-name`} name="title" required maxLength={200} placeholder={t("Например, квадратные уравнения")} />
        <label htmlFor={`${id}-subject`}>{t("Предмет")}</label><select id={`${id}-subject`} name="subjectId" required defaultValue=""><option value="">{t("Выберите свой предмет")}</option>{subjects.items.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>
        <div className="form-actions"><button className="button" type="submit" disabled={!subjects.items.length}><Plus size={17} aria-hidden="true" />{t("Создать черновик")}</button></div>
      </fieldset></form>
      {subjects.loading && <p role="status">{t("Загружаем предметы…")}</p>}
      {subjects.error && <div className="form-error"><p role="alert">{t(subjects.error)}</p><button className="text-button" onClick={subjects.reload}>{t("Повторить загрузку предметов")}</button></div>}
      {!subjects.loading && !subjects.error && !subjects.items.length && <p className="muted account-list-help">{t("Сначала добавьте предмет в разделе «Мои предметы».")}</p>}
      {subjects.nextOffset < subjects.total && <button className="text-button" disabled={subjects.loadingMore || actions.busy} onClick={() => void subjects.loadMore()}>{t("Загрузить ещё предметы · ")}{subjects.items.length} {t(" из ")}{subjects.total}</button>}
    </details>
    <ActionFeedback actions={actions} />
    <PageContent page={page} emptyTitle={t("Создайте первый тест")} emptyText={t("Вопросы с выбором ответа проверяются автоматически, текстовые ответы — вами.")} disabled={actions.busy}>
      <ul className="account-connection-list">{page.items.map(test => <li key={test.id}><div className="account-connection-main"><h3>{test.title}</h3><p>{test.subjectName}{test.topic ? ` · ${test.topic}` : ''}</p><small>{test.questionCount} {t(" вопросов · ")}{test.maxPoints} {t(" балл. ")}{test.latestVersion ? t("· опубликована версия {number}", { number: test.latestVersion.number }) : t("· нет опубликованных версий")}</small></div>
        <div className="account-connection-side"><span className="status">{test.status === 'archived' ? t("В архиве") : test.status === 'published' ? t("Опубликован") : t("Черновик")}</span><div className="account-connection-actions">
          <button className="text-button" disabled={blocked} onClick={() => setBuilderId(test.id)}>{test.status === 'archived' ? t("Посмотреть") : t("Открыть конструктор")}</button>
          {test.latestVersion && test.status !== 'archived' && <button className="button secondary small" disabled={blocked} onClick={() => setAssigning(test)}>{t("Назначить ученику")}</button>}
          {test.status !== 'archived' && <button className="text-button danger-text" disabled={blocked} onClick={() => actions.setConfirmation({ title: t("Архивировать тест?"), description: t("Новые назначения будут недоступны. Уже выданные тесты, ответы и результаты сохранятся."), action: t("Архивировать"), success: t("Тест перенесён в архив."), execute: () => accountApi.archiveTest(accountId, test.id, test.revision) })}>{t("В архив")}</button>}
        </div></div></li>)}</ul>
    </PageContent>
    <ActionConfirmation actions={actions} />
    {builderId && <TestBuilder key={builderId} accountId={accountId} testId={builderId} onSessionChanged={onSessionChanged} onChanged={page.reload} onClose={() => { setBuilderId(null); page.reload(); }} />}
    {assigning && <AssignTestDialog key={assigning.id} accountId={accountId} test={assigning} onSessionChanged={onSessionChanged} onClose={() => setAssigning(null)} onSaved={() => { setAssigning(null); onAssigned(); }} />}
  </section>;
}

function AssignTestDialog({ accountId, test, onSessionChanged, onClose, onSaved }: {
  accountId: string; test: TestSummary; onSessionChanged: () => void; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const fetchVersions = useCallback((offset: number) => accountApi.testVersions(accountId, test.id, offset), [accountId, test.id]);
  const fetchEnrollments = useCallback((offset: number) => accountApi.enrollments(accountId, 'teacher', offset), [accountId]);
  const versions = useAccountPage(fetchVersions, onSessionChanged);
  const enrollments = useAccountPage(fetchEnrollments, onSessionChanged);
  const [policy, setPolicy] = useState<AnswerPolicy>('never');
  const [versionId, setVersionId] = useState(test.latestVersion?.id ?? '');
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const actions = useConnectionActions(onSessionChanged, () => {});
  const eligible = enrollments.items.filter(item => item.status === 'active' && item.subjectName === test.subjectName);
  const blocked = actions.busy || versions.loading || enrollments.loading || !!versions.error || !!enrollments.error;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (await actions.run(async () => {
      const due = String(data.get('dueAt') ?? '');
      let dueAt: string | undefined;
      try { dueAt = due ? localInputToIso(due) : undefined; } catch (error) { throw new AccountApiError(error instanceof Error ? error.message : t("Проверьте дату."), 400, 'validation_error'); }
      const timer = String(data.get('timeLimitMin') ?? '');
      const input = { versionId: String(data.get('versionId')), enrollmentId: String(data.get('enrollmentId')), maxAttempts: Number(data.get('maxAttempts')), answerPolicy: policy, ...(dueAt ? { dueAt } : {}), ...(timer ? { timeLimitMin: Number(timer) } : {}) };
      const fingerprint = JSON.stringify(input);
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      await accountApi.assignTest(accountId, { ...input, requestId: request.current.id });
    }, t("Тест назначен ученику."))) onSaved();
  }
  return <Modal title={t("Назначить тест")} onClose={() => { if (!actions.busy) onClose(); }}><p className="test-preserve-text">{test.title} · {test.subjectName}</p>
    <form className="account-form test-builder-form" onSubmit={event => void submit(event)}><fieldset className="test-form-fieldset" disabled={blocked}>
      <label htmlFor={`${id}-version`}>{t("Опубликованная версия")}</label><select id={`${id}-version`} name="versionId" required value={versionId} onChange={event => setVersionId(event.target.value)}><option value="">{t("Выберите версию")}</option>{versions.items.map(version => <option key={version.id} value={version.id}>{t("Версия ")}{version.number} · {version.title} · {version.maxPoints} {t(" балл.")}</option>)}</select>
      <label htmlFor={`${id}-student`}>{t("Ученик по этому предмету")}</label><select id={`${id}-student`} name="enrollmentId" required defaultValue=""><option value="">{t("Выберите ученика")}</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.studentName ?? item.studentPublicId} · {item.studentPublicId}</option>)}</select>
      <div className="test-form-grid"><div><label htmlFor={`${id}-attempts`}>{t("Количество попыток")}</label><input id={`${id}-attempts`} name="maxAttempts" type="number" min={1} max={10} step={1} defaultValue={1} required /></div><div><label htmlFor={`${id}-timer`}>{t("Время на попытку, мин.")}</label><input id={`${id}-timer`} name="timeLimitMin" type="number" min={1} max={180} step={1} placeholder={t("Без ограничения")} /></div></div>
      <label htmlFor={`${id}-due`}>{t("Срок сдачи ")}{policy === 'after_deadline' ? '' : t("· необязательно")}</label><input id={`${id}-due`} name="dueAt" type="datetime-local" required={policy === 'after_deadline'} />
      <p className="account-list-help muted">{t("Часовой пояс: ")}{Intl.DateTimeFormat().resolvedOptions().timeZone}{t(". После срока тест остаётся доступен с пометкой о просрочке. Лимит времени отсчитывается отдельно с начала каждой попытки.")}</p>
      <label htmlFor={`${id}-policy`}>{t("Когда показывать правильные ответы ученику")}</label><select id={`${id}-policy`} value={policy} onChange={event => setPolicy(event.target.value as AnswerPolicy)}>{Object.entries(ANSWER_POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
      <p className="account-list-help muted">{t("Баллы и комментарии станут доступны ученику и родителю после вашей публикации результата. Открытые правильные ответы могут использоваться при повторной попытке.")}</p>
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>{t("Отмена")}</button><button type="submit" className="button" disabled={!eligible.length || !versions.items.length}>{t("Назначить")}</button></div>
    </fieldset></form>
    {(versions.loading || enrollments.loading) && <p role="status">{t("Загружаем версии и учеников…")}</p>}
    {(versions.error || enrollments.error) && <div className="form-error"><p role="alert">{t(versions.error || enrollments.error)}</p><button className="text-button" onClick={() => { versions.reload(); enrollments.reload(); }}>{t("Повторить загрузку")}</button></div>}
    {!enrollments.loading && !eligible.length && <p className="account-list-help muted">{t("В загруженном списке нет активных учеников по этому предмету. Загрузите остальные подключения или подтвердите обучение в разделе учеников.")}</p>}
    {enrollments.nextOffset < enrollments.total && <button className="text-button" disabled={enrollments.loadingMore || actions.busy} onClick={() => void enrollments.loadMore()}>{t("Загрузить ещё учеников · ")}{enrollments.items.length} {t(" из ")}{enrollments.total}</button>}
    {versions.nextOffset < versions.total && <button className="text-button" disabled={versions.loadingMore || actions.busy} onClick={() => void versions.loadMore()}>{t("Загрузить ещё версии")}</button>}
    <ActionFeedback actions={actions} />
  </Modal>;
}
