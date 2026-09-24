'use client';

import { useI18n } from './locale-provider';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Eye, Plus, Save } from 'lucide-react';
import { accountApi } from '@/lib/account-api';
import type { TestDetail, TestDraftInput, TestQuestion, QuestionType } from '@/lib/account-tests';
import { useConnectionActions } from './account-connections-state';
import { ActionFeedback } from './account-connections';
import { useTestResource } from './account-tests-state';
import { newTestQuestion, TestPreview, TestQuestionEditor } from './test-builder-questions';
import { Modal } from './ui';

export function TestBuilder({ accountId, testId, onSessionChanged, onChanged, onClose }: {
  accountId: string; testId: string; onSessionChanged: () => void; onChanged: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const load = useCallback(() => accountApi.test(accountId, testId), [accountId, testId]);
  const resource = useTestResource(load, onSessionChanged);
  if (!resource.data) return <Modal title={t("Конструктор теста")} onClose={onClose}>{resource.loading ? <p role="status">{t("Загружаем тест…")}</p> : <div className="form-error"><p role="alert">{t(resource.error)}</p><button className="button secondary" onClick={resource.reload}>{t("Повторить")}</button></div>}</Modal>;
  return <DraftEditor key={`${resource.data.id}:${resource.data.revision}`} accountId={accountId} initial={resource.data} onSessionChanged={onSessionChanged} onSaved={detail => { resource.setData(detail); onChanged(); }} onPublished={() => { onChanged(); onClose(); }} onClose={onClose} onReload={resource.reload} />;
}

function DraftEditor({ accountId, initial, onSessionChanged, onSaved, onPublished, onClose, onReload }: {
  accountId: string; initial: TestDetail; onSessionChanged: () => void; onSaved: (detail: TestDetail) => void;
  onPublished: () => void; onClose: () => void; onReload: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState<TestDraftInput>(() => draftOf(initial));
  const [passInput, setPassInput] = useState(initial.passPoints === undefined ? '' : String(initial.passPoints));
  const [preview, setPreview] = useState(false);
  const [confirmation, setConfirmation] = useState<'close' | 'reload' | 'publish' | null>(null);
  const alive = useRef(false);
  const confirmationRef = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (confirmation) confirmationRef.current?.focus(); }, [confirmation]);
  const actions = useConnectionActions(onSessionChanged, () => {});
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(baseline));
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const archived = initial.status === 'archived';
  const maxPoints = draft.questions.reduce((sum, question) => sum + question.points, 0);
  function close() { if (!actions.busy) { if (dirty) setConfirmation('close'); else onClose(); } }
  function updateQuestion(value: TestQuestion) { setDraft(current => ({ ...current, questions: current.questions.map(question => question.id === value.id ? value : question) })); }
  function moveQuestion(index: number, direction: -1 | 1) {
    setDraft(current => { const questions = [...current.questions]; [questions[index], questions[index + direction]] = [questions[index + direction], questions[index]]; return { ...current, questions }; });
  }
  async function save(publish = false) {
    let saved: TestDetail | undefined;
    const success = await actions.run(async () => {
      saved = dirty ? await accountApi.saveTest(accountId, initial.id, { ...draft, revision: baseline.revision }) : baseline;
      // A failed publish must not lose the revision acknowledged by a successful save.
      if (alive.current) setBaseline(saved);
      if (publish) await accountApi.publishTest(accountId, initial.id, saved.revision);
    }, publish ? t("Версия опубликована.") : t("Черновик сохранён."));
    if (success && saved) { if (publish) onPublished(); else onSaved(saved); }
    if (alive.current) setConfirmation(null);
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(); }
  function addQuestion(type: QuestionType) { setDraft(current => ({ ...current, questions: [...current.questions, newTestQuestion(type)] })); }

  return <Modal title={archived ? t("Архивный тест") : t("Конструктор теста")} onClose={close}>
    <div className="test-builder"><p className="muted">{initial.subjectName} · {draft.questions.length} {t(" вопросов · максимум ")}{maxPoints} {t(" балл.")}</p>
      <p className="account-list-help muted">{t("Изменения сохраняются в черновике. Каждая публикация создаёт отдельную версию; уже выданные тесты сохраняют прежние вопросы.")}</p>
      <div className="test-toolbar"><button type="button" className="button secondary small" onClick={() => setPreview(value => !value)} disabled={actions.busy}><Eye size={16} aria-hidden="true" />{preview ? t("Вернуться в конструктор") : t("Предпросмотр")}</button><span className="muted" role="status">{dirty ? t("Есть несохранённые изменения") : t("Черновик сохранён")}</span></div>
      {preview ? <TestPreview draft={draft} /> : <form className="account-form test-builder-form" onSubmit={submit}>
        <fieldset disabled={actions.busy || archived} className="test-form-fieldset">
          <label htmlFor={`${id}-title`}>{t("Название")}</label><input id={`${id}-title`} value={draft.title} maxLength={200} required onChange={event => setDraft({ ...draft, title: event.target.value })} />
          <label htmlFor={`${id}-topic`}>{t("Тема · необязательно")}</label><input id={`${id}-topic`} value={draft.topic ?? ''} maxLength={200} onChange={event => setDraft({ ...draft, topic: event.target.value })} />
          <label htmlFor={`${id}-instruction`}>{t("Инструкция ученику · необязательно")}</label><textarea id={`${id}-instruction`} rows={3} maxLength={4000} value={draft.instruction ?? ''} onChange={event => setDraft({ ...draft, instruction: event.target.value })} />
          <label htmlFor={`${id}-pass`}>{t("Проходной балл · необязательно")}</label><input id={`${id}-pass`} className="test-number-input" type="number" min={0} max={3000} step={0.01} value={passInput} onChange={event => { setPassInput(event.target.value); setDraft({ ...draft, passPoints: event.target.value === '' ? undefined : Number(event.target.value) }); }} />
          {draft.questions.map((question, index) => <TestQuestionEditor key={question.id} question={question} index={index} count={draft.questions.length} disabled={actions.busy || archived} onChange={updateQuestion} onMove={direction => moveQuestion(index, direction)} onRemove={() => setDraft({ ...draft, questions: draft.questions.filter(item => item.id !== question.id) })} />)}
          {!draft.questions.length && <p className="account-next-note">{t("Начните с первого вопроса. Для публикации понадобится хотя бы один заполненный вопрос.")}</p>}
          <div className="test-add-questions">{(['single_choice', 'multiple_choice', 'text'] as const).map(type => <button key={type} type="button" className="button secondary small" disabled={draft.questions.length >= 30} onClick={() => addQuestion(type)}><Plus size={15} aria-hidden="true" />{type === 'single_choice' ? t("Один вариант") : type === 'multiple_choice' ? t("Несколько вариантов") : t("Текстовый ответ")}</button>)}</div>
          <div className="form-actions"><button type="submit" className="button secondary" disabled={!dirty}><Save size={17} aria-hidden="true" />{t("Сохранить черновик")}</button><button type="button" className="button" disabled={!draft.questions.length || (!dirty && baseline.status === 'published')} onClick={() => setConfirmation('publish')}>{!dirty && baseline.status === 'published' ? t("Эта версия уже опубликована") : t("Опубликовать версию")}</button></div>
        </fieldset>
      </form>}
      <ActionFeedback actions={actions} />
      {actions.error && <button className="text-button" disabled={actions.busy} onClick={() => setConfirmation('reload')}>{t("Загрузить актуальный черновик")}</button>}
      {confirmation && <div className="test-confirmation" role="group" aria-label={t("Подтверждение действия")} tabIndex={-1} ref={confirmationRef}><p>{confirmation === 'publish' ? t("Сохранить изменения и опубликовать неизменяемую версию? После этого её можно назначить ученикам.") : confirmation === 'close' ? t("Закрыть конструктор и потерять несохранённые изменения?") : t("Загрузить черновик с сервера? Несохранённые изменения будут потеряны.")}</p><div className="form-actions"><button className="button secondary" disabled={actions.busy} onClick={() => setConfirmation(null)}>{t("Отмена")}</button><button className="button" disabled={actions.busy} onClick={() => { if (confirmation === 'publish') void save(true); else if (confirmation === 'close') onClose(); else onReload(); }}>{confirmation === 'publish' ? t("Опубликовать") : confirmation === 'close' ? t("Закрыть без сохранения") : t("Загрузить")}</button></div></div>}
    </div>
  </Modal>;
}

function draftOf(detail: TestDetail): TestDraftInput {
  return { title: detail.title, instruction: detail.instruction, topic: detail.topic ?? '', passPoints: detail.passPoints, questions: detail.questions };
}
