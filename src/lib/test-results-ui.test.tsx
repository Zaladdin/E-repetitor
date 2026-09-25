import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TestResultSummary } from '@/components/test-result-summary';
import type { TestAttemptSummary } from './account-tests';

const base: TestAttemptSummary = {
  id: 'attempt', number: 1, status: 'completed', version: 3, startedAt: '2026-09-25T10:00:00Z',
  maxPoints: 20, score: 8, totalQuestions: 10, correctAnswers: 4, percentage: 40, passed: false, resultVisibility: 'visible',
};
const render = (overrides: Partial<TestAttemptSummary> = {}, teacher = false) => renderToStaticMarkup(<TestResultSummary attempt={{ ...base, ...overrides }} teacher={teacher} />);

describe('attempt result summary', () => {
  it('shows question accuracy separately from weighted points and the server pass decision', () => {
    const html = render();
    expect(html).toContain('4/10');
    expect(html).toContain('Верных ответов');
    expect(html).toContain('8 из 20');
    expect(html).toContain('Не пройден');
    expect(render({ passed: true, score: 15, correctAnswers: 6, percentage: 75 })).toContain('Пройден');
  });
  it.each(['pending_review', 'pending_publication', 'unavailable'] as const)('does not reveal score, count or pass/fail for a hidden result: %s', resultVisibility => {
    const html = render({ resultVisibility });
    expect(html).not.toContain('4/10');
    expect(html).not.toContain('8 из 20');
    expect(html).not.toContain('Не пройден');
    expect(html).toContain(resultVisibility === 'pending_review' ? 'Ожидает проверки' : resultVisibility === 'pending_publication' ? 'Ожидает публикации' : 'Результат недоступен');
  });
  it('shows the teacher only the provisional score while written answers await review', () => {
    const html = render({ status: 'waiting_review', resultVisibility: 'pending_review' }, true);
    expect(html).toContain('Автоматическая часть');
    expect(html).not.toContain('4/10');
    expect(html).not.toContain('Не пройден');
    expect(render({ status: 'waiting_review', resultVisibility: 'pending_review' })).not.toContain('Автоматическая часть');
  });
  it('keeps incomplete or expired attempts from displaying a final result', () => {
    for (const status of ['started', 'waiting_review', 'expired', 'abandoned'] as const) {
      expect(render({ status })).not.toContain('4/10');
      expect(render({ status })).not.toContain('Не пройден');
    }
  });
});
