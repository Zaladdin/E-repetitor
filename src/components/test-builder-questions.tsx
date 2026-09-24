'use client';

import { useI18n } from './locale-provider';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { QuestionType, TestDraftInput, TestQuestion } from '@/lib/account-tests';

const QUESTION_LABELS: Record<QuestionType, string> = { single_choice: 'Один вариант', multiple_choice: 'Несколько вариантов', text: 'Текстовый ответ' };

export function newTestQuestion(type: QuestionType): TestQuestion {
  const options = type === 'text' ? [] : [1, 2].map(() => ({ id: crypto.randomUUID(), text: '' }));
  return { id: crypto.randomUUID(), type, prompt: '', points: 1, options, correctOptionIds: [] };
}

export function TestQuestionEditor({ question, index, count, disabled, onChange, onMove, onRemove }: {
  question: TestQuestion; index: number; count: number; disabled: boolean;
  onChange: (question: TestQuestion) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void;
}) {
  const { t } = useI18n();
  const id = `question-${question.id}`;
  function choose(optionId: string, checked: boolean) {
    onChange({ ...question, correctOptionIds: question.type === 'single_choice' ? [optionId] : checked ? [...question.correctOptionIds, optionId] : question.correctOptionIds.filter(value => value !== optionId) });
  }
  function moveOption(index: number, direction: -1 | 1) {
    const options = [...question.options];
    [options[index], options[index + direction]] = [options[index + direction], options[index]];
    onChange({ ...question, options });
  }
  return <fieldset className="test-question-editor" disabled={disabled}>
    <legend>{t("Вопрос ")}{index + 1} · {t(QUESTION_LABELS[question.type])}</legend>
    <div className="test-question-tools">
      <button type="button" className="icon-button" aria-label={t("Переместить вопрос {value} выше", { value: index + 1 })} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={17} aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-label={t("Переместить вопрос {value} ниже", { value: index + 1 })} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown size={17} aria-hidden="true" /></button>
      <button type="button" className="text-button danger-text" onClick={onRemove}><Trash2 size={15} aria-hidden="true" />{t("Удалить вопрос")}</button>
    </div>
    <label htmlFor={`${id}-prompt`}>{t("Текст вопроса")}</label><textarea id={`${id}-prompt`} value={question.prompt} maxLength={1000} rows={3} onChange={event => onChange({ ...question, prompt: event.target.value })} />
    <label htmlFor={`${id}-points`}>{t("Максимальный балл")}</label><input id={`${id}-points`} className="test-number-input" type="number" min={1} max={100} step={1} value={question.points} onChange={event => onChange({ ...question, points: Number(event.target.value) })} />
    {question.type !== 'text' && <fieldset className="test-options-editor"><legend>{question.type === 'single_choice' ? t("Отметьте один правильный вариант") : t("Отметьте все правильные варианты")}</legend>
      {question.options.map((option, optionIndex) => <div className="test-option-editor" key={option.id}>
        <input id={`${id}-${option.id}-correct`} type={question.type === 'single_choice' ? 'radio' : 'checkbox'} name={`${id}-correct`} checked={question.correctOptionIds.includes(option.id)} onChange={event => choose(option.id, event.target.checked)} />
        <label className="sr-only" htmlFor={`${id}-${option.id}-correct`}>{t("Правильный вариант ")}{optionIndex + 1}</label>
        <label className="sr-only" htmlFor={`${id}-${option.id}-text`}>{t("Текст варианта ")}{optionIndex + 1}</label><input id={`${id}-${option.id}-text`} value={option.text} maxLength={300} placeholder={t("Вариант {value}", { value: optionIndex + 1 })} onChange={event => onChange({ ...question, options: question.options.map(item => item.id === option.id ? { ...item, text: event.target.value } : item) })} />
        <button type="button" className="icon-button danger-text" aria-label={t("Удалить вариант {value}", { value: optionIndex + 1 })} disabled={question.options.length <= 2} onClick={() => onChange({ ...question, options: question.options.filter(item => item.id !== option.id), correctOptionIds: question.correctOptionIds.filter(value => value !== option.id) })}><Trash2 size={17} aria-hidden="true" /></button>
        <div className="test-option-order"><button type="button" className="text-button" disabled={optionIndex === 0} aria-label={t("Переместить вариант {value} выше", { value: optionIndex + 1 })} onClick={() => moveOption(optionIndex, -1)}><ArrowUp size={14} aria-hidden="true" />{t("Выше")}</button><button type="button" className="text-button" disabled={optionIndex === question.options.length - 1} aria-label={t("Переместить вариант {value} ниже", { value: optionIndex + 1 })} onClick={() => moveOption(optionIndex, 1)}><ArrowDown size={14} aria-hidden="true" />{t("Ниже")}</button></div>
      </div>)}
      <button type="button" className="text-button" disabled={question.options.length >= 8} onClick={() => onChange({ ...question, options: [...question.options, { id: crypto.randomUUID(), text: '' }] })}><Plus size={15} aria-hidden="true" />{t("Добавить вариант")}</button>
    </fieldset>}
    {question.type === 'text' && <p className="muted account-list-help">{t("После сдачи вы выставите балл вручную. Ответ ученика может получить часть максимального балла.")}</p>}
    <label htmlFor={`${id}-explanation`}>{t("Объяснение ответа · необязательно")}</label><textarea id={`${id}-explanation`} rows={2} maxLength={1000} value={question.explanation ?? ''} onChange={event => onChange({ ...question, explanation: event.target.value })} />
  </fieldset>;
}

export function TestPreview({ draft }: { draft: TestDraftInput }) {
  const { t } = useI18n();
  return <div className="test-preview"><p className="account-eyebrow">{t("Предпросмотр · попытка не создаётся")}</p><h3>{draft.title || t("Без названия")}</h3>
    {draft.instruction && <p className="test-preserve-text">{draft.instruction}</p>}
    {!draft.questions.length && <p className="muted">{t("Добавьте вопросы в конструкторе.")}</p>}
    {draft.questions.map((question, index) => <fieldset key={question.id} className="test-question-editor"><legend>{t("Вопрос ")}{index + 1} · {question.points} {t(" балл.")}</legend><p className="test-preserve-text">{question.prompt || t("Текст вопроса")}</p>
      {question.type === 'text' ? <><label htmlFor={`preview-${question.id}`} className="sr-only">{t("Ответ на вопрос ")}{index + 1}</label><textarea id={`preview-${question.id}`} rows={3} placeholder={t("Ответ ученика")} maxLength={4000} /></> : question.options.map(option => <label className="test-choice" key={option.id}><input type={question.type === 'single_choice' ? 'radio' : 'checkbox'} name={`preview-${question.id}`} />{option.text || t("Вариант ответа")}</label>)}
    </fieldset>)}
  </div>;
}
