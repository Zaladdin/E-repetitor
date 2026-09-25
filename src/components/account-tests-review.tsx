'use client';

import { useI18n } from './locale-provider';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountApi } from '@/lib/account-api';
import { ATTEMPT_LABELS, type TestAttempt, type TestGrade } from '@/lib/account-tests';
import { ActionFeedback } from './account-connections';
import { useConnectionActions } from './account-connections-state';
import { useTestResource } from './account-tests-state';
import { Modal } from './ui';
import { TestResultSummary } from './test-result-summary';

export function TeacherAttemptReview({ accountId, attemptId, onSessionChanged, onClose, onChanged }: {
  accountId: string; attemptId: string; onSessionChanged: () => void; onClose: () => void; onChanged: () => void;
}) {
  const { t } = useI18n();
  const load = useCallback(() => accountApi.testAttempt(accountId, attemptId, 'teacher'), [accountId, attemptId]);
  const resource = useTestResource(load, onSessionChanged);
  if (!resource.data) return <Modal title={t("Проверка попытки")} onClose={onClose}>{resource.loading ? <p role="status">{t("Загружаем ответы…")}</p> : <div className="form-error"><p role="alert">{t(resource.error)}</p><button className="button secondary" onClick={resource.reload}>{t("Повторить")}</button></div>}</Modal>;
  return <ReviewForm key={`${resource.data.id}:${resource.data.version}`} accountId={accountId} attempt={resource.data} onSessionChanged={onSessionChanged} onClose={onClose} onSaved={() => { resource.reload(); onChanged(); }} onReload={resource.reload} />;
}

function ReviewForm({ accountId, attempt, onSessionChanged, onClose, onSaved, onReload }: {
  accountId: string; attempt: TestAttempt; onSessionChanged: () => void; onClose: () => void; onSaved: () => void; onReload: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const actions = useConnectionActions(onSessionChanged, () => {});
  const [publishConfirmation, setPublishConfirmation] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaveConfirmation, setLeaveConfirmation] = useState<'close' | 'reload' | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (publishConfirmation || leaveConfirmation) confirmationRef.current?.focus(); }, [publishConfirmation, leaveConfirmation]);
  const canReview = attempt.status === 'waiting_review' || attempt.status === 'completed';
  const questions = attempt.questions ?? [];
  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const grades: TestGrade[] = questions.filter(question => question.type === 'text').map(question => ({ questionId: question.id, points: Number(data.get(`points-${question.id}`)), comment: String(data.get(`comment-${question.id}`) ?? '').trim() }));
    if (await actions.run(() => accountApi.reviewTestAttempt(accountId, attempt.id, { version: attempt.version, grades, comment: String(data.get('comment') ?? '').trim() }), t("Оценки сохранены. Теперь можно опубликовать результат."))) onSaved();
  }
  async function publish() {
    if (await actions.run(() => accountApi.publishTestResult(accountId, attempt.id, attempt.version), t("Результат опубликован."))) onSaved();
    setPublishConfirmation(false);
  }
  function close() { if (!actions.busy) { if (dirty) setLeaveConfirmation('close'); else onClose(); } }
  return <Modal title={t("Ответы и проверка")} onClose={close}><div className="test-review">
    <h3>{attempt.title}</h3><p className="muted">{attempt.studentName} · {attempt.subjectName} {t(" · попытка ")}{attempt.number}</p><p className="test-status-line"><span className="status">{t(ATTEMPT_LABELS[attempt.status])}</span></p>
    <TestResultSummary attempt={attempt} teacher />
    {canReview && <p className="account-list-help muted">{attempt.resultPolicy === 'after_submission' ? t('После сохранения проверки ученик увидит итоговые баллы и комментарии. Родители увидят их после публикации.') : t('Ученик и родители увидят итоговые баллы и комментарии после публикации результата.')}</p>}
    {attempt.status === 'started' && <p className="account-next-note">{t("Ученик ещё проходит тест. Оценивание будет доступно после сдачи.")}</p>}
    {(attempt.status === 'expired' || attempt.status === 'abandoned') && <p className="account-next-note">{t("Попытка завершена без сдачи. Сохранённые ответы доступны как история и не изменяются.")}</p>}
    <form className="account-form test-builder-form" onSubmit={event => void review(event)} onChange={() => setDirty(true)}>
      <fieldset className="test-form-fieldset" disabled={actions.busy || !canReview}>
        {questions.map((question, index) => {
          const answer = attempt.answers?.find(item => item.questionId === question.id);
          const grade = attempt.grades?.find(item => item.questionId === question.id);
          return <fieldset key={question.id} className="test-question-editor"><legend>{t("Вопрос ")}{index + 1} {t(" · максимум ")}{question.points} {t(" балл.")}</legend><p className="test-preserve-text">{question.prompt}</p>
            <p className="account-list-help muted">{t("Ответ ученика")}</p>
            {question.type === 'text' ? <p className="test-answer-text">{answer?.text || t("Ответ не дан")}</p> : <ul className="test-review-options">{question.options.map(option => <li key={option.id}><span>{answer?.selectedOptionIds?.includes(option.id) ? t("Выбран") : t("Не выбран")}</span><span>{option.text}</span>{question.correctOptionIds?.includes(option.id) && <strong>{t("Правильный")}</strong>}</li>)}</ul>}
            {question.type === 'text' && <><label htmlFor={`${id}-${question.id}-points`}>{t("Балл за ответ")}</label><input id={`${id}-${question.id}-points`} name={`points-${question.id}`} type="number" min={0} max={question.points} step={0.01} required defaultValue={grade?.points ?? ''} className="test-number-input" /><label htmlFor={`${id}-${question.id}-comment`}>{t("Комментарий к ответу · необязательно")}</label><textarea id={`${id}-${question.id}-comment`} name={`comment-${question.id}`} rows={2} maxLength={1000} defaultValue={grade?.comment ?? ''} /></>}
            {question.type !== 'text' && grade && <p className="account-list-help">{t("Автоматическая оценка: ")}{grade.points} / {question.points}</p>}
          </fieldset>;
        })}
        <label htmlFor={`${id}-comment`}>{t('Общий комментарий к результату')}</label><textarea id={`${id}-comment`} name="comment" rows={3} maxLength={2000} defaultValue={attempt.comment ?? ''} />
        {canReview && <div className="form-actions"><button type="submit" className="button secondary">{t("Сохранить проверку")}</button></div>}
      </fieldset>
    </form>
    <ActionFeedback actions={actions} />
    {actions.error && <button className="text-button" disabled={actions.busy} onClick={() => { if (dirty) setLeaveConfirmation('reload'); else onReload(); }}>{t("Обновить попытку с сервера")}</button>}
    {attempt.status === 'completed' && <><p className="account-list-help muted">{attempt.resultPolicy === 'after_submission' ? t('Результат уже доступен ученику. Публикация также откроет его связанным родителям.') : t("Проверенный результат пока виден только вам. Публикация откроет баллы и комментарии ученику и связанным родителям.")}</p><button className="button" disabled={actions.busy || dirty} onClick={() => setPublishConfirmation(true)}>{t("Опубликовать результат")}</button>{dirty && <p className="muted account-list-help">{t("Сначала сохраните изменённые оценки и комментарии.")}</p>}</>}
    {attempt.status === 'published' && <p className="account-next-note">{t("Результат опубликован. Ответы и оценки сохранены в истории.")}</p>}
    {publishConfirmation && <div className="test-confirmation" role="group" aria-label={t("Публикация результата")} tabIndex={-1} ref={confirmationRef}><p>{t("Опубликовать результат для ученика и родителей?")}</p><div className="form-actions"><button className="button secondary" disabled={actions.busy} onClick={() => setPublishConfirmation(false)}>{t("Отмена")}</button><button className="button" disabled={actions.busy} onClick={() => void publish()}>{t("Опубликовать")}</button></div></div>}
    {leaveConfirmation && <div className="test-confirmation" role="group" aria-label={t("Несохранённая проверка")} tabIndex={-1} ref={confirmationRef}><p>{t("Изменённые оценки и комментарии не сохранены. Продолжить без сохранения?")}</p><div className="form-actions"><button className="button secondary" disabled={actions.busy} onClick={() => setLeaveConfirmation(null)}>{t("Остаться")}</button><button className="button" disabled={actions.busy} onClick={() => { if (leaveConfirmation === 'close') onClose(); else onReload(); }}>{t("Продолжить")}</button></div></div>}
  </div></Modal>;
}
