import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocale, localeTag, setLocale, translate } from './i18n';
import { schedulingMessages } from './i18n/scheduling';
import { GroupCards } from '@/components/account-groups';
import { expandGroupRules } from '@/components/group-form';
import { PackageHistoryList } from '@/components/package-history';
import { formatPaymentAmount, parsePaymentAmount } from './account-payments';
import { lessonWeek, localInputToIso } from './account-lessons';

// SSR intentionally defaults to Russian. This suite checks the selected client locale.
vi.mock('@/components/locale-provider', async () => {
  const i18n = await import('./i18n');
  return { useI18n: () => ({ locale: i18n.getLocale(), t: i18n.translate }) };
});

afterEach(() => { setLocale('ru'); });

describe('scheduling and billing translations', () => {
  it('provides both languages and preserves every template parameter', () => {
    for (const [source, variants] of Object.entries(schedulingMessages)) {
      const parameters = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
      expect(variants).toHaveLength(2);
      for (const text of variants) {
        expect(text.trim(), source).not.toBe('');
        expect(text, source).not.toMatch(/[А-Яа-яЁё]/);
        expect(parameters(text), source).toEqual(parameters(source));
      }
    }
  });

  it.each(['en', 'az'] as const)('translates group controls and weekdays without changing user content in %s', locale => {
    setLocale(locale);
    const html = renderToStaticMarkup(createElement(GroupCards, {
      groups: [{ id: 'g', name: 'Особая группа', subjectId: 's', subjectName: 'Авторский предмет', timezone: 'Asia/Baku',
        status: 'active', version: 1, members: [{ enrollmentId: 'e', studentName: 'Имя ученика', studentPublicId: 'STU-1234-5678', status: 'paused' }],
        slots: [{ weekday: 1, startTime: '16:00', endTime: '17:00' }] }],
      disabled: false, onEdit: () => {}, onArchive: () => {},
    }));
    expect(html).toContain(translate('Изменить группу'));
    expect(html).toContain(translate('Каждую неделю'));
    expect(html).toContain(translate('Пн'));
    expect(html).not.toContain('обучение не активно');
    expect(html).toContain('Особая группа');
    expect(html).toContain('Авторский предмет');
    expect(html).toContain('Имя ученика');
  });

  it.each(['en', 'az'] as const)('uses locale-specific numbers, dates and client validation in %s', locale => {
    setLocale(locale);
    const amount = { amountMinor: 123456, currency: 'AZN' as const };
    expect(formatPaymentAmount(amount)).toBe(new Intl.NumberFormat(localeTag(), {
      style: 'currency', currency: 'AZN', currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(1234.56));
    expect(formatPaymentAmount({})).toBe(translate('Сумма не указана'));
    expect(lessonWeek('2026-09-28').label).not.toMatch(/[А-Яа-яЁё]/);
    expect(() => parsePaymentAmount('bad')).toThrow(translate('Укажите сумму от 0,01 до 9 999 999,99, не более двух знаков после запятой.'));
    expect(() => localInputToIso('not-a-date')).toThrow(translate('Укажите корректные дату и время.'));
    expect(() => expandGroupRules([])).toThrow(translate('Добавьте хотя бы одно время занятий.'));
    expect(getLocale()).toBe(locale);
  });

  it.each(['en', 'az'] as const)('uses local lesson-count grammar in package history in %s', locale => {
    setLocale(locale);
    const html = renderToStaticMarkup(createElement(PackageHistoryList, {
      items: [{ id: 'e', type: 'created', delta: 21, occurredAt: '2026-09-28T12:00:00Z' }],
      role: 'teacher', disabled: false, onReverse: () => {},
    }));
    expect(html).toContain(translate('Пакет создан'));
    expect(html).toContain(locale === 'en' ? '21 lessons' : '21 dərs');
    expect(html).not.toMatch(/[А-Яа-яЁё]/);
  });
});
