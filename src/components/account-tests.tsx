'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import { ATTEMPT_LABELS, type AttemptMutation, type TestAssignment, type TestAttemptSummary } from '@/lib/account-tests';
import { ActionFeedback, ConnectionHeading, PageContent } from './account-connections';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { TeacherTestLibrary } from './account-tests-library';
import { TeacherAttemptReview } from './account-tests-review';
import { TestAttemptRunner } from './test-attempt-runner';
import { Modal } from './ui';

interface AccountTestsProps { accountId: string; role: AccountRole; onSessionChanged: () => void }

export function AccountTests(props: AccountTestsProps) {
  const id = useId();
  const [revision, setRevision] = useState(0);
  return <section className="account-tests" aria-labelledby={`${id}-title`}>
    <div className="account-section-heading"><div className="subject-icon"><ClipboardList size={24} aria-hidden="true" /></div><div><h2 id={`${id}-title`}>Тесты и результаты</h2><p className="muted">{props.role === 'teacher' ? 'Ваши вопросы, проверка знаний и обратная связь.' : props.role === 'parent' ? 'Опубликованные результаты детей по всем предметам.' : 'Назначенные тесты, попытки и обратная связь преподавателей.'}</p></div></div>
    {props.role === 'teacher' && <TeacherTestLibrary accountId={props.accountId} onSessionChanged={props.onSessionChanged} onAssigned={() => setRevision(value => value + 1)} />}
    <Assignments key={revision} {...props} />
  </section>;
}

function Assignments({ accountId, role, onSessionChanged }: AccountTestsProps) {
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
    if (await actions.run(async () => { attempt = await accountApi.startTestAttempt(accountId, assignment.id, requestIds.current.get(assignment.id)!); }, 'Попытка открыта.')) {
      requestIds.current.delete(assignment.id); setStarting(null); if (attempt) setAttemptId(attempt.id);
    }
  }
  return <section className="account-test-assignments" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={role === 'parent' ? 'Результаты детей' : role === 'teacher' ? 'Назначения и проверка' : 'Назначенные тесты'} description={role === 'parent' ? 'Результаты появляются после публикации преподавателем.' : role === 'teacher' ? 'Проверьте текстовые ответы и опубликуйте итоговый результат.' : 'Начатый тест можно продолжить с сохранёнными ответами, пока не истёк лимит времени.'} onRefresh={page.reload} disabled={page.loading || page.loadingMore || actions.busy} />
    <ActionFeedback actions={actions} />
    <PageContent page={page} emptyTitle={role === 'parent' ? 'Опубликованных результатов пока нет' : 'Назначенных тестов пока нет'} emptyText={role === 'teacher' ? 'Опубликуйте тест и назначьте его ученику с активным обучением.' : role === 'parent' ? 'После подтверждения связи с ребёнком здесь появятся результаты, которые опубликуют его преподаватели.' : 'Здесь появятся тесты, которые назначат ваши преподаватели.'} disabled={actions.busy}>
      <ul className="account-test-assignment-list">{page.items.map(assignment => {
        const attempts = role === 'parent' ? assignment.attempts.filter(attempt => attempt.status === 'published') : assignment.attempts;
        const current = attempts.find(attempt => attempt.status === 'started');
        return <li key={assignment.id}><div className="test-assignment-heading"><div><h3>{assignment.title}</h3><p>{assignment.subjectName} · {role === 'teacher' ? assignment.studentName : role === 'parent' ? `${assignment.studentName} · ${assignment.teacherName}` : assignment.teacherName}</p><small>Версия {assignment.versionNumber}{role !== 'parent' ? ` · использовано попыток ${attempts.length} из ${assignment.maxAttempts}` : ''}</small></div>
          {role === 'student' && <div className="test-assignment-actions">{current ? <button className="button" disabled={actions.busy} onClick={() => setAttemptId(current.id)}>Продолжить</button> : attempts.length < assignment.maxAttempts ? <button className="button" disabled={actions.busy} onClick={() => setStarting(assignment)}>{attempts.length ? 'Новая попытка' : 'Начать тест'}</button> : <span className="status">Попытки использованы</span>}</div>}
        </div>
        {role !== 'parent' && <p className="test-assignment-settings">{assignment.timeLimitMin ? `${assignment.timeLimitMin} мин. на попытку` : 'Без ограничения времени'}{assignment.dueAt ? ` · срок сдачи ${dateTime(assignment.dueAt)}` : ' · без срока сдачи'}{assignment.isLate && <strong> · срок сдачи прошёл</strong>}</p>}
        {attempts.length ? <ol className="test-attempt-list">{attempts.map(attempt => <li key={attempt.id}><div><h4>Попытка {attempt.number}</h4><p className="muted">{ATTEMPT_LABELS[attempt.status]} · {dateTime(attempt.startedAt)}</p><AttemptScore attempt={attempt} />{attempt.comment && <p className="test-preserve-text">{attempt.comment}</p>}</div>
          {role !== 'parent' && <button className="text-button" disabled={actions.busy} onClick={() => setAttemptId(attempt.id)}>{role === 'teacher' && attempt.status === 'waiting_review' ? 'Проверить ответы' : role === 'teacher' && attempt.status === 'completed' ? 'Проверить и опубликовать' : attempt.status === 'started' && role === 'student' ? 'Продолжить' : 'Открыть попытку'}</button>}
        </li>)}</ol> : <p className="account-list-help muted">Ученик ещё не начинал тест.</p>}
      </li>; })}</ul>
    </PageContent>
    {starting && <Modal title={`Начать «${starting.title}»?`} onClose={() => { if (!actions.busy) setStarting(null); }}><p>{starting.timeLimitMin ? `Сразу начнётся отсчёт ${starting.timeLimitMin} мин. Закрытие окна или выход из аккаунта не остановит таймер.` : 'Ответы будут сохраняться во время работы. Начатая попытка учитывается в общем лимите.'}</p><p className="muted account-list-help">Для нового начала требуется активное обучение у преподавателя.</p><ActionFeedback actions={actions} /><div className="form-actions"><button className="button secondary" disabled={actions.busy} onClick={() => setStarting(null)}>Отмена</button><button className="button" disabled={actions.busy} onClick={() => void start(starting)}>Начать попытку</button></div></Modal>}
    {attemptId && role === 'teacher' && <TeacherAttemptReview key={attemptId} accountId={accountId} attemptId={attemptId} onSessionChanged={onSessionChanged} onClose={() => setAttemptId(null)} onChanged={page.reload} />}
    {attemptId && role === 'student' && <TestAttemptRunner key={attemptId} accountId={accountId} attemptId={attemptId} onSessionChanged={onSessionChanged} onClose={() => { setAttemptId(null); page.reload(); }} onChanged={page.reload} />}
  </section>;
}

function AttemptScore({ attempt }: { attempt: TestAttemptSummary }) {
  if (attempt.score === undefined) return null;
  return <p className="test-score">{attempt.status === 'waiting_review' ? 'Автоматическая часть: ' : ''}{attempt.score} / {attempt.maxPoints} балл.{attempt.status !== 'waiting_review' && attempt.percentage !== undefined ? ` · ${attempt.percentage}%` : ''}{attempt.passed === undefined ? '' : attempt.passed ? ' · проходной балл набран' : ' · проходной балл не набран'}</p>;
}

function dateTime(value: string) { return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }); }
