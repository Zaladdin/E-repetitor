import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountOverviewSummary } from '@/components/account-overview-summary';
import { overviewChildSelection, overviewPaymentLabel, type AccountOverviewData } from './account-overview';

function overview(): AccountOverviewData {
  return {
    role: 'parent', asOf: '2026-09-22T09:00:00.000Z', lessonUntil: '2026-09-29T09:00:00.000Z', attendanceSince: '2026-08-23T09:00:00.000Z',
    counts: { activeEnrollments: 0, upcomingLessons: 0, unmarkedPayments: 0 }, payments: { paid: 0, unpaid: 0 },
    upcomingLessons: { items: [], total: 0 }, latestResults: { items: [], total: 0 }, subjects: { items: [], total: 0 },
  };
}

describe('overview selection and rendering', () => {
  it('selects the only child automatically, respects all-children choice and never silently replaces a revoked child', () => {
    expect(overviewChildSelection(null, [{ id: 'a' }], 1)).toBe('a');
    expect(overviewChildSelection('', [{ id: 'a' }], 1)).toBe('');
    expect(overviewChildSelection(null, [{ id: 'a' }], 51)).toBe('');
    expect(overviewChildSelection('revoked', [{ id: 'b' }], 1)).toBe('revoked');
  });

  it('distinguishes absent payment records from paid records', () => {
    expect(overviewPaymentLabel({ paid: 0, unpaid: 0 })).toBe('Записей об оплате пока нет');
    expect(overviewPaymentLabel({ paid: 2, unpaid: 1 })).toBe('Оплачено: 2 · без отметки: 1');
    const html = renderToStaticMarkup(createElement(AccountOverviewSummary, { data: overview() }));
    expect(html).toContain('Записей об оплате пока нет');
    expect(html).toContain('Опубликованных результатов пока нет');
    expect(html).toContain('Активных предметов пока нет');
  });

  it('shows server totals independently of bounded previews and escapes names and titles', () => {
    const data = overview();
    data.counts.upcomingLessons = 101;
    data.upcomingLessons = { total: 101, items: [{ id: 'l', enrollmentId: 'e', studentName: '<script>unsafe</script>', studentPublicId: 'ST-1', teacherName: 'Учитель', subjectName: '<b>Math</b>', startsAt: data.asOf, durationMin: 60, format: 'online' }] };
    const html = renderToStaticMarkup(createElement(AccountOverviewSummary, { data }));
    expect(html).toContain('<strong>101</strong>');
    expect(html).toContain('Показано 1 из 101');
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('href="#account-lessons-section"');
  });

  it('shows teacher work counts but omits unpublished actions in parent rendering', () => {
    const data = overview();
    data.role = 'teacher'; data.counts.waitingReview = 7; data.counts.readyToPublish = 3;
    data.testAttention = { total: 10, items: [{ assignmentId: 'assignment', attemptId: 'attempt', enrollmentId: 'e', studentName: 'Ученик', studentPublicId: 'ST-1', subjectName: 'Физика', teacherName: 'Учитель', title: 'Неопубликованная работа', action: 'review', dueAt: null }] };
    let html = renderToStaticMarkup(createElement(AccountOverviewSummary, { data }));
    expect(html).toContain('Проверить: 7 · опубликовать: 3');
    expect(html).toContain('Неопубликованная работа');
    data.role = 'parent';
    html = renderToStaticMarkup(createElement(AccountOverviewSummary, { data }));
    expect(html).not.toContain('Неопубликованная работа');
    expect(html).not.toContain('Проверить:');
  });

  it('does not turn unmarked attendance into absences or invent a result', () => {
    const data = overview();
    data.subjects = { total: 1, items: [{ enrollmentId: 'e', studentName: 'Ученик', studentPublicId: 'ST-1', subjectName: 'Физика', teacherName: 'Учитель', nextLesson: null, latestResult: null, attendance: { present: 0, absent: 0, excused: 0 }, payment: { paid: 0, unpaid: 0 } }] };
    const html = renderToStaticMarkup(createElement(AccountOverviewSummary, { data }));
    expect(html).toContain('За 30 дней отметок нет');
    expect(html).toContain('Пока не опубликован');
    expect(html).not.toContain('пропущено:');
    expect(html).not.toContain('NaN');
  });
});
