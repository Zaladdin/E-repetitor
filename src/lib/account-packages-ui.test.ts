import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PackageList } from '@/components/account-packages';
import { PackageHistoryList } from '@/components/package-history';
import type { AccountRole } from './account-api';
import type { LessonPackage, PackageHistoryEvent } from './account-packages';

const record: LessonPackage = { id: 'package', enrollmentId: 'enrollment', studentName: 'Ученик', studentPublicId: 'STU-1234-5678',
  teacherName: 'Учитель', subjectName: 'Математика', title: '8 занятий', lessonCount: 8, balance: 7, amountMinor: 20000, currency: 'AZN',
  paid: false, cancelled: false, closed: false, version: 2, paymentVersion: 1, createdAt: '2026-09-23T09:00:00Z' };
const debit: PackageHistoryEvent = { id: 'debit', type: 'charged', delta: -1, lessonId: 'lesson', lessonStartsAt: '2026-09-22T09:00:00Z',
  occurredAt: '2026-09-23T09:00:00Z', reversed: false, reason: 'PRIVATE_REASON', actorName: 'PRIVATE_ACTOR' };
const list = (role: AccountRole, overrides: Partial<LessonPackage> = {}) => renderToStaticMarkup(createElement(PackageList, {
  role, items: [{ ...record, ...overrides }], disabled: false, onHistory: () => {}, onCharge: () => {}, onClosePackage: () => {},
}));
const history = (role: AccountRole, overrides: Partial<PackageHistoryEvent> = {}) => renderToStaticMarkup(createElement(PackageHistoryList, {
  role, items: [{ ...debit, ...overrides }], disabled: false, onReverse: () => {},
}));

describe('package role projections', () => {
  it.each(['student', 'parent'] as const)('renders balances and history without write controls or private reasons for %s', role => {
    const html = list(role);
    expect(html).toContain('Осталось занятий');
    expect(html).toContain('История занятий');
    expect(html).not.toContain('Списать занятие');
    expect(html).not.toContain('Закрыть пакет');
    const log = history(role);
    expect(log).toContain('Занятие списано');
    expect(log).not.toContain('PRIVATE_');
    expect(log).not.toContain('Вернуть занятие');
  });
  it('allows explicit teacher charging on credit but blocks empty, closed or cancelled packages', () => {
    expect(list('teacher')).toContain('Списать занятие');
    expect(list('teacher')).toContain('Не оплачено');
    for (const state of [{ balance: 0 }, { closed: true }, { cancelled: true }]) {
      expect(list('teacher', state)).not.toContain('Списать занятие');
    }
    expect(list('teacher', { closed: true })).not.toContain('Закрыть пакет');
  });
  it('keeps the original debit visible but removes its reversal action once corrected', () => {
    expect(history('teacher')).toContain('PRIVATE_REASON');
    expect(history('teacher')).toContain('Вернуть занятие');
    const corrected = history('teacher', { reversed: true });
    expect(corrected).toContain('Занятие списано');
    expect(corrected).toContain('Это списание исправлено');
    expect(corrected).not.toContain('Вернуть занятие');
    expect(history('teacher', { type: 'created', delta: 8 })).not.toContain('Вернуть занятие');
  });
});
