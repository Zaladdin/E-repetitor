'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

import { Suspense, useCallback, useId, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { TestEditorPage } from './test-editor-page';
import { ClipboardList } from 'lucide-react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import { ATTEMPT_LABELS, type AttemptMutation, type TestAssignment } from '@/lib/account-tests';
import { ActionFeedback, ConnectionHeading, PageContent } from './account-connections';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { TeacherTestLibrary } from './account-tests-library';
import { TeacherAttemptReview } from './account-tests-review';
import { TestAttemptRunner } from './test-attempt-runner';
import { Modal } from './ui';
import { TestResultSummary } from './test-result-summary';

interface AccountTestsProps { accountId: string; role: AccountRole; onSessionChanged: () => void }

export function AccountTests(props: AccountTestsProps) {
  const { t } = useI18n();
  const id = useId();
  const [revision, setRevision] = useState(0);
  const pathname = usePathname();
  if (pathname?.replace(/\/$/, '') === '/account/tests/new' || pathname?.replace(/\/$/, '') === '/account/tests/edit') {
    return <Suspense fallback={<p role="status">{t("Загружаем тест…")}</p>}><TestEditorPage {...props} /></Suspense>;
  }
  return <section className="account-tests" aria-labelledby={`${id}-title`}>
    <div className="account-section-heading"><div className="subject-icon"><ClipboardList size={24} aria-hidden="true" /></div><div><h2 id={`${id}-title`}>{t("Тесты и результаты")}</h2><p className="muted">{props.role === 'teacher' ? t("Ваши вопросы, проверка знаний и обратная связь.") : props.role === 'parent' ? t("Опубликованные результаты детей по всем предметам.") : t("Назначенные тесты, попытки и обратная связь преподавателей.")}</p></div></div>
    {props.role === 'teacher' && <TeacherTestLibrary accountId={props.accountId} onSessionChanged={props.onSessionChanged} onAssigned={() => setRevision(value => value + 1)} />}
    <Assignments key={revision} {...props} />
  </section>;
}

function Assignments({ accountId, role, onSessionChanged }: AccountTestsProps) {
  const { t } = useI18n();
  const id = useId();
  const fetchPage = useCallback((offset: number) => accountApi.testAssignments(accountId, role, offset), [accountId, role]);
  const page = useAccountPage(fetchPage, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, page.reload);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [starting, setStarting] = useState<TestAssignment | null>(null);
  const requestIds = useRef(new Map<string, string>());
  async function start(assignment: TestAssignment) {
    if (!requestIds.current.has(assignment.id)) requestIds.current.set(assignment.id, crypto.randomUUID());
    let attempt: AttemptMutation | undefined;
    if (await actions.run(async () => { attempt = await accountApi.startTestAttempt(accountId, assignment.id, requestIds.current.get(assignment.id)!); }, t("Попытка открыта."))) {
      requestIds.current.delete(assignment.id); setStarting(null); if (attempt) setAttemptId(attempt.id);
    }
  }
  return <section className="account-test-assignments" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={role === 'parent' ? t("Результаты детей") : role === 'teacher' ? t("Назначения и проверка") : t("Назначенные тесты")} description={role === 'parent' ? t("Результаты появляются после публикации преподавателем.") : role === 'teacher' ? t("Проверьте текстовые ответы и опубликуйте итоговый результат.") : t("Начатый тест можно продолжить с сохранёнными ответами, пока не истёк лимит времени.")} onRefresh={page.reload} disabled={page.loading || page.loadingMore || actions.busy} />
    <ActionFeedback actions={actions} />
    <PageContent page={page} emptyTitle={role === 'parent' ? t("Опубликованных результатов пока нет") : t("Назначенных тестов пока нет")} emptyText={role === 'teacher' ? t("Опубликуйте тест и назначьте его ученику с активным обучением.") : role === 'parent' ? t("После подтверждения связи с ребёнком здесь появятся результаты, которые опубликуют его преподаватели.") : t("Здесь появятся тесты, которые назначат ваши преподаватели.")} disabled={actions.busy}>
      <ul className="account-test-assignment-list">{page.items.map(assignment => {
        const attempts = role === 'parent' ? assignment.attempts.filter(attempt => attempt.status === 'published') : assignment.attempts;
        const current = attempts.find(attempt => attempt.status === 'started');
        return <li key={assignment.id}><div className="test-assignment-heading"><div><h3>{assignment.title}</h3><p>{assignment.subjectName} · {role === 'teacher' ? assignment.studentName : role === 'parent' ? `${assignment.studentName} · ${assignment.teacherName}` : assignment.teacherName}</p><small>{t('Вариант {code} · версия {number}', { code: assignment.variantCode, number: assignment.versionNumber })}{role !== 'parent' ? t(" · использовано попыток {length} из {maxAttempts}", { length: attempts.length, maxAttempts: assignment.maxAttempts }) : ''}</small>{assignment.groupName && <p className="muted">{t('Группа: {name}', { name: assignment.groupName })}</p>}</div>
          {role === 'student' && <div className="test-assignment-actions">{current ? <button className="button" disabled={actions.busy} onClick={() => setAttemptId(current.id)}>{t("Продолжить")}</button> : attempts.length < assignment.maxAttempts ? <button className="button" disabled={actions.busy} onClick={() => setStarting(assignment)}>{attempts.length ? t("Новая попытка") : t("Начать тест")}</button> : <span className="status">{t("Попытки использованы")}</span>}</div>}
        </div>
        {role !== 'parent' && <p className="test-assignment-settings">{assignment.timeLimitMin ? t("{timeLimitMin} мин. на попытку", { timeLimitMin: assignment.timeLimitMin }) : t("Без ограничения времени")}{assignment.dueAt ? t(" · срок сдачи {value}", { value: dateTime(assignment.dueAt) }) : t(" · без срока сдачи")}{assignment.isLate && <strong> {t(" · срок сдачи прошёл")}</strong>}</p>}
        {attempts.length ? <ol className="test-attempt-list">{attempts.map(attempt => <li key={attempt.id}><div><h4>{t("Попытка ")}{attempt.number}</h4><p className="muted">{t(ATTEMPT_LABELS[attempt.status])} · {dateTime(attempt.startedAt)}</p><TestResultSummary attempt={attempt} teacher={role === 'teacher'} />{attempt.comment && (role === 'teacher' || attempt.resultVisibility === 'visible') && <p className="test-preserve-text">{attempt.comment}</p>}</div>
          {role !== 'parent' && <button className="text-button" disabled={actions.busy} onClick={() => setAttemptId(attempt.id)}>{role === 'teacher' && attempt.status === 'waiting_review' ? t("Проверить ответы") : role === 'teacher' && attempt.status === 'completed' ? t("Проверить и опубликовать") : attempt.status === 'started' && role === 'student' ? t("Продолжить") : t("Открыть попытку")}</button>}
        </li>)}</ol> : <p className="account-list-help muted">{t("Ученик ещё не начинал тест.")}</p>}
      </li>; })}</ul>
    </PageContent>
    {starting && <Modal title={t("Начать «{title}»?", { title: starting.title })} onClose={() => { if (!actions.busy) setStarting(null); }}><p>{starting.timeLimitMin ? t("Сразу начнётся отсчёт {timeLimitMin} мин. Закрытие окна или выход из аккаунта не остановит таймер.", { timeLimitMin: starting.timeLimitMin }) : t("Ответы будут сохраняться во время работы. Начатая попытка учитывается в общем лимите.")}</p><p className="muted account-list-help">{t("Для нового начала требуется активное обучение у преподавателя.")}</p><ActionFeedback actions={actions} /><div className="form-actions"><button className="button secondary" disabled={actions.busy} onClick={() => setStarting(null)}>{t("Отмена")}</button><button className="button" disabled={actions.busy} onClick={() => void start(starting)}>{t("Начать попытку")}</button></div></Modal>}
    {attemptId && role === 'teacher' && <TeacherAttemptReview key={attemptId} accountId={accountId} attemptId={attemptId} onSessionChanged={onSessionChanged} onClose={() => setAttemptId(null)} onChanged={page.reload} />}
    {attemptId && role === 'student' && <TestAttemptRunner key={attemptId} accountId={accountId} attemptId={attemptId} onSessionChanged={onSessionChanged} onClose={() => { setAttemptId(null); page.reload(); }} onChanged={page.reload} />}
  </section>;
}

function dateTime(value: string) { return new Date(value).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }); }
