'use client';

import type { TestAttemptSummary } from '@/lib/account-tests';
import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

export function TestResultSummary({ attempt, teacher = false }: { attempt: TestAttemptSummary; teacher?: boolean }) {
  const { t, locale } = useI18n();
  const final = attempt.status === 'completed' || attempt.status === 'published';
  const visible = final && attempt.resultVisibility === 'visible';
  const number = (value: number) => new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 2 }).format(value);
  if (!visible) {
    const label = attempt.resultVisibility === 'pending_review' || attempt.status === 'waiting_review'
      ? t('Ожидает проверки') : attempt.resultVisibility === 'pending_publication'
        ? t('Ожидает публикации') : attempt.status === 'started' ? t('Тест ещё не завершён') : t('Результат недоступен');
    return <div className="test-result-summary test-result-pending"><span className="status status-pending">{label}</span>
      {teacher && attempt.status === 'waiting_review' && attempt.score !== undefined && <p className="test-result-points">{t('Автоматическая часть: {score} из {maximum} балл.', { score: number(attempt.score), maximum: number(attempt.maxPoints) })}</p>}
    </div>;
  }
  return <div className="test-result-summary">
    <div className="test-result-outcome">
      {attempt.correctAnswers !== undefined && <div className="test-result-accuracy"><strong aria-label={t('Верных ответов: {correct} из {total}', { correct: attempt.correctAnswers, total: attempt.totalQuestions })}>{attempt.correctAnswers}/{attempt.totalQuestions}</strong><span>{t('Верных ответов')}</span></div>}
      {attempt.passed !== undefined && <span className={`status ${attempt.passed ? 'status-active' : 'status-cancelled'}`}>{attempt.passed ? t('Пройден') : t('Не пройден')}</span>}
    </div>
    {attempt.score !== undefined && <p className="test-result-points">{t('Баллы: {score} из {maximum}', { score: number(attempt.score), maximum: number(attempt.maxPoints) })}{attempt.percentage !== undefined ? ` · ${number(attempt.percentage)}%` : ''}</p>}
  </div>;
}
