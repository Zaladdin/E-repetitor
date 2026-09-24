'use client';

import { useI18n } from './locale-provider';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { accountApi, accountErrorMessage, accountSessionChanged, isStaleAccountRequest } from '@/lib/account-api';
import { ATTEMPT_LABELS, type PublicTestQuestion, type TestAnswer, type TestAttempt } from '@/lib/account-tests';
import { TestAnswerAutosave } from '@/lib/test-answer-autosave';
import { Modal } from './ui';

interface RunnerProps {
  accountId: string; attemptId: string; onSessionChanged: () => void; onClose: () => void; onChanged: () => void;
}

export function TestAttemptRunner(props: RunnerProps) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState<TestAttempt | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const { accountId, attemptId, onSessionChanged } = props;
  useEffect(() => {
    let current = true;
    accountApi.testAttempt(accountId, attemptId, 'student').then(value => {
      if (current) { setAttempt(value); setError(''); }
    }).catch((failure: unknown) => {
      if (!current || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) onSessionChanged();
      else setError(accountErrorMessage(failure));
    });
    return () => { current = false; };
  }, [accountId, attemptId, onSessionChanged, revision]);
  const reload = useCallback(() => { setAttempt(null); setError(''); setRevision(value => value + 1); }, []);
  return attempt ? <AttemptEditor key={`${attempt.id}:${revision}`} {...props} initial={attempt} onReload={reload} />
    : <Modal title={t("Тест")} onClose={props.onClose}>{error ? <><p role="alert" className="form-error">{t(error)}</p><button className="button secondary" onClick={reload}>{t("Повторить загрузку")}</button></> : <p role="status">{t("Загружаем попытку…")}</p>}</Modal>;
}

function AttemptEditor({ accountId, initial, onSessionChanged, onClose, onChanged, onReload }: RunnerProps & { initial: TestAttempt; onReload: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [answers, setAnswers] = useState<TestAnswer[]>(initial.answers ?? []);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<'submit' | 'abandon' | 'close' | 'reload' | null>(null);
  const [remaining, setRemaining] = useState(() => remainingSeconds(initial));
  const [timerOrigin] = useState(() => ({ server: Date.parse(initial.serverNow), client: Date.now() }));
  const queue = useRef<TestAnswerAutosave | null>(null);
  const alive = useRef(false);
  const mutation = useRef(false);
  const expiryRequested = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const isStarted = initial.status === 'started';
  const editing = isStarted && (remaining === null || remaining > 0);

  const fail = useCallback((failure: unknown) => {
    if (!alive.current || isStaleAccountRequest(failure)) return;
    if (accountSessionChanged(failure)) onSessionChanged();
    else { setError(accountErrorMessage(failure)); setSaveState('error'); }
  }, [onSessionChanged]);

  useEffect(() => {
    alive.current = true;
    const current = new TestAnswerAutosave(initial.version, initial.answers ?? [],
      (version, snapshot) => accountApi.saveTestAnswers(accountId, initial.id, version, snapshot));
    queue.current = current;
    return () => { alive.current = false; current.dispose(); };
  }, [accountId, initial]);

  const flush = useCallback(async () => {
    const current = queue.current;
    if (!current) return false;
    if (!current.dirty && !current.saving) return true;
    setSaveState('saving'); setError('');
    try {
      await current.flush();
      if (!alive.current) return false;
      setSaveState(current.dirty ? 'dirty' : 'saved');
      return true;
    } catch (failure) { fail(failure); return false; }
  }, [fail]);

  useEffect(() => {
    if (!isStarted) return;
    const timer = setTimeout(() => { if (!mutation.current) void flush(); }, 800);
    return () => clearTimeout(timer);
  }, [answers, isStarted, flush]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (queue.current?.dirty || queue.current?.saving) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (confirmation) confirmationRef.current?.focus(); }, [confirmation]);

  useEffect(() => {
    if (!isStarted || !initial.expiresAt) return;
    const timer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((Date.parse(initial.expiresAt!) - timerOrigin.server - (Date.now() - timerOrigin.client)) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && !expiryRequested.current && !mutation.current) {
        expiryRequested.current = true;
        // Read synchronizes the server's authoritative expiry and retains only accepted answers.
        accountApi.testAttempt(accountId, initial.id, 'student').then(() => {
          if (alive.current) { onChanged(); onReload(); }
        }).catch(fail);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [accountId, initial, isStarted, fail, onChanged, onReload, timerOrigin]);

  function change(question: PublicTestQuestion, next: Partial<TestAnswer>) {
    if (!editing || mutation.current || confirmation) return;
    const value: TestAnswer = question.type === 'text'
      ? { questionId: question.id, text: next.text ?? '' }
      : { questionId: question.id, selectedOptionIds: next.selectedOptionIds ?? [] };
    const updated = [...answers.filter(answer => answer.questionId !== question.id), value];
    queue.current?.replace(updated); setAnswers(updated); setSaveState('dirty');
  }
  function requestClose() {
    if (mutation.current) return;
    if (queue.current?.dirty || queue.current?.saving) setConfirmation('close');
    else onClose();
  }
  function requestReload() {
    if (mutation.current) return;
    if (queue.current?.dirty || queue.current?.saving) setConfirmation('reload');
    else onReload();
  }
  async function finish(action: 'submit' | 'abandon' | 'close') {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError('');
    try {
      // Never submit an earlier snapshot while the last answer is still being saved.
      if (!await flush() || !alive.current) return;
      if (action === 'close') { onClose(); return; }
      const version = queue.current!.version;
      if (action === 'submit') await accountApi.submitTestAttempt(accountId, initial.id, version);
      else await accountApi.abandonTestAttempt(accountId, initial.id, version);
      if (alive.current) { onChanged(); onReload(); }
    } catch (failure) { fail(failure); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); setConfirmation(null); } }
  }

  const answered = answers.filter(answer => (answer.text?.trim().length ?? 0) > 0 || (answer.selectedOptionIds?.length ?? 0) > 0).length;
  const total = initial.questions?.length ?? 0;
  return <Modal title={initial.title} onClose={requestClose}>
    <div className="account-test-runner">
      <p className="muted">{initial.subjectName} · {initial.teacherName} {t(" · Попытка ")}{initial.number}</p>
      <p><strong>{t(ATTEMPT_LABELS[initial.status])}</strong>{initial.topic ? ` · ${initial.topic}` : ''}</p>
      {initial.instruction && <p className="account-test-instruction">{initial.instruction}</p>}
      {isStarted && <div className="account-test-save-bar"><span>{t("Отвечено: ")}{answered} {t(" из ")}{total}</span>{remaining !== null && <span role="timer" aria-label={t("Осталось времени")}>{clock(remaining)}</span>}<span role="status">{saveState === 'saved' ? t("Все ответы сохранены") : saveState === 'saving' ? t("Сохраняем…") : saveState === 'dirty' ? t("Есть несохранённые изменения") : t("Не удалось сохранить ответы")}</span></div>}
      {isStarted && remaining === 0 && <p role="status" className="form-error">{t("Время вышло. Проверяем состояние попытки на сервере. Сохраняются только ответы, принятые до окончания времени.")}</p>}
      {(initial.status === 'expired' || initial.status === 'abandoned') && <p className="account-next-note">{t("Попытка закрыта и учитывается в лимите. Сохранённые ответы остаются в истории.")}</p>}
      {!isStarted && initial.status !== 'published' && initial.status !== 'expired' && initial.status !== 'abandoned' && <p className="account-next-note">{t("Ответы сданы. Итоговые баллы и комментарии появятся после публикации преподавателем.")}</p>}
      {initial.status === 'published' && initial.score !== undefined && <div className="account-test-result"><strong>{initial.score} {t(" из ")}{initial.maxPoints} · {initial.percentage}%</strong>{initial.passed !== undefined && <p>{initial.passed ? t("Проходной балл набран") : t("Проходной балл не набран")}</p>}{initial.comment && <p>{initial.comment}</p>}</div>}

      <div className="account-test-answer-list">{initial.questions?.map((question, index) => {
        const answer = answers.find(value => value.questionId === question.id);
        const selected = answer?.selectedOptionIds ?? [];
        const grade = initial.grades?.find(value => value.questionId === question.id);
        return <fieldset key={question.id} className="account-test-answer" disabled={!editing || busy || !!confirmation}>
          <legend>{index + 1}. {question.prompt} <span className="muted">· {question.points} {t(" балл.")}</span></legend>
          {question.type === 'text' ? <><label className="sr-only" htmlFor={`${id}-${question.id}`}>{t("Ответ на вопрос ")}{index + 1}</label><textarea id={`${id}-${question.id}`} value={answer?.text ?? ''} maxLength={4000} rows={5} onChange={event => change(question, { text: event.target.value })} /></>
            : question.options.map(option => <label key={option.id} className="account-test-choice"><input type={question.type === 'single_choice' ? 'radio' : 'checkbox'} name={`${id}-${question.id}`} value={option.id} checked={selected.includes(option.id)} onChange={event => change(question, { selectedOptionIds: question.type === 'single_choice' ? [option.id] : event.target.checked ? [...selected, option.id] : selected.filter(value => value !== option.id) })} /><span>{option.text}</span></label>)}
          {editing && question.type === 'single_choice' && selected.length > 0 && <button type="button" className="text-button" onClick={() => change(question, { selectedOptionIds: [] })}>{t("Очистить выбор")}</button>}
          {question.correctOptionIds !== undefined && <p className="account-test-key">{t("Правильный ответ: ")}{question.options.filter(option => question.correctOptionIds!.includes(option.id)).map(option => option.text).join('; ') || t("Текстовый ответ проверяет преподаватель")}</p>}
          {question.explanation && <p className="account-test-explanation">{question.explanation}</p>}
          {initial.status === 'published' && grade && <p className="account-test-grade">{t("Баллы: ")}{grade.points} {t(" из ")}{question.points}{grade.comment ? ` · ${grade.comment}` : ''}</p>}
        </fieldset>;
      })}</div>
      {error && <div><p ref={errorRef} tabIndex={-1} className="form-error" role="alert">{t(error)}</p><button className="text-button" disabled={busy} onClick={requestReload}>{t("Обновить попытку с сервера")}</button></div>}

      {confirmation && <div className="account-test-confirm" role="group" aria-labelledby={`${id}-confirm-title`} tabIndex={-1} ref={confirmationRef}>
        <h3 id={`${id}-confirm-title`}>{confirmation === 'submit' ? t("Сдать тест?") : confirmation === 'abandon' ? t("Прекратить попытку?") : confirmation === 'reload' ? t("Загрузить сохранённые ответы?") : t("Закрыть тест?")}</h3>
        <p>{confirmation === 'submit' ? t("После сдачи ответы изменить нельзя. Отвечено {answered} из {total}; пропущенные вопросы также попадут на проверку.", { answered: answered, total: total }) : confirmation === 'abandon' ? t("Эта попытка будет использована. Продолжить её позже будет нельзя.") : confirmation === 'reload' ? t("Несохранённые изменения в этом окне будут заменены последними ответами с сервера.") : t("Есть изменения, которые ещё не сохранены. Можно сохранить их перед выходом и продолжить попытку позже, пока не истекло время.")}</p>
        <div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmation(null)}>{t("Остаться")}</button>
          {confirmation === 'reload' ? <button className="button" disabled={busy || saveState === 'saving'} onClick={onReload}>{t("Загрузить с сервера")}</button>
            : <button className="button" disabled={busy} onClick={() => void finish(confirmation)}>{busy ? t("Подождите…") : confirmation === 'submit' ? t("Сдать тест") : confirmation === 'abandon' ? t("Прекратить") : t("Сохранить и закрыть")}</button>}
          {confirmation === 'close' && <button className="text-button danger-text" disabled={busy || saveState === 'saving'} onClick={onClose}>{t("Закрыть без сохранения")}</button>}
        </div>
      </div>}
      {!confirmation && <div className="form-actions"><button className="button secondary" disabled={busy} onClick={requestClose}>{t("Закрыть")}</button>
        {editing && <><button className="button secondary" disabled={busy || saveState === 'saving'} onClick={() => void flush()}>{t("Сохранить ответы")}</button><button className="button" disabled={busy} onClick={() => setConfirmation('submit')}>{t("Сдать тест")}</button><button className="text-button danger-text" disabled={busy} onClick={() => setConfirmation('abandon')}>{t("Прекратить попытку")}</button></>}
      </div>}
    </div>
  </Modal>;
}

function remainingSeconds(attempt: TestAttempt): number | null {
  return attempt.expiresAt ? Math.max(0, Math.ceil((Date.parse(attempt.expiresAt) - Date.parse(attempt.serverNow)) / 1000)) : null;
}
function clock(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
