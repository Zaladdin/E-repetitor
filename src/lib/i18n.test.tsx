import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { getLocale, getServerLocale, localeTag, LOCALE_STORAGE_KEY, messages, restoreLocale, setLocale, subscribeLocale, translate } from './i18n';
import { LocaleContext } from '@/components/locale-provider';
import { AccountAuth } from '@/components/account-auth';
import { AccountNavigation } from '@/components/account-navigation';
import { localizeNotificationBody } from '@/components/account-notifications';

afterEach(() => { vi.unstubAllGlobals(); setLocale('ru'); });

describe('interface languages', () => {
  it('renders login and role navigation in all three languages', () => {
    const labels = { ru: ['С возвращением', 'Группы'], en: ['Welcome back', 'Groups'], az: ['Yenidən xoş gəlmisiniz', 'Qruplar'] };
    for (const locale of ['ru', 'az', 'en'] as const) {
      const html = renderToStaticMarkup(<LocaleContext.Provider value={locale}><AccountAuth onLogin={() => {}} /><AccountNavigation role="teacher" active="account-groups-section" unreadNotifications={2} /></LocaleContext.Provider>);
      for (const label of labels[locale]) expect(html).toContain(label);
      expect(html).toContain('/account/groups');
      if (locale !== 'ru') expect(html).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('preserves every interpolation parameter in both translations', () => {
    const parameters = (source: string) => [...source.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
    for (const [source, translations] of Object.entries(messages)) {
      expect(translations.length, source).toBe(2);
      for (const text of translations) {
        expect(text.trim(), source).not.toBe('');
        expect(text, source).not.toMatch(/[А-Яа-яЁё]/);
        expect(parameters(text), source).toEqual(parameters(source));
      }
    }
  });

  it('keeps inserted user content intact and updates existing feedback', () => {
    const name = 'Алгебра {value0} · Məryəm';
    const en = translate('Предмет «{value0}» добавлен.', { value0: name }, 'en');
    expect(en).toBe(`Subject “${name}” added.`);
    expect(translate(en, undefined, 'az')).toBe(`“${name}” fənni əlavə edildi.`);
    expect(translate('Моя собственная группа', undefined, 'en')).toBe('Моя собственная группа');
    expect(translate('toString', undefined, 'en')).toBe('toString');
    expect(translate('Непрочитанных: 2 · в списке: 3', undefined, 'en')).toBe('Unread: 2 · listed: 3');
    const body = 'Математика · Алия. Проверьте расписание занятия.';
    expect(localizeNotificationBody(body, source => translate(source, undefined, 'en'))).toBe('Математика · Алия. Check the lesson schedule.');
  });

  it('persists valid preferences and tolerates unavailable or invalid storage', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { setItem: (key: string, value: string) => storage.set(key, value), getItem: (key: string) => storage.get(key) } });
    const listener = vi.fn(); const unsubscribe = subscribeLocale(listener);
    setLocale('az'); expect(storage.get(LOCALE_STORAGE_KEY)).toBe('az'); expect(listener).toHaveBeenCalledOnce();
    setLocale('az'); expect(listener).toHaveBeenCalledOnce();
    storage.set(LOCALE_STORAGE_KEY, 'en'); restoreLocale(); expect(getLocale()).toBe('en');
    storage.set(LOCALE_STORAGE_KEY, 'unexpected'); restoreLocale(); expect(getLocale()).toBe('en');
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage blocked'); } });
    setLocale('az'); expect(getLocale()).toBe('az'); expect(() => restoreLocale()).not.toThrow();
    expect(getServerLocale()).toBe('ru'); expect(localeTag()).toBe('az-AZ');
    unsubscribe();
  });

  it('has translations for every literal application translation call', () => {
    const missing: string[] = [];
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'i18n') scan(path); continue; }
        if (!/\.tsx?$/.test(path) || /\.test\./.test(path)) continue;
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'translate'].includes(node.expression.text)) {
            const key = node.arguments[0];
            if (key && ts.isStringLiteralLike(key) && /[А-Яа-яЁё]/.test(key.text) && !Object.hasOwn(messages, key.text)) missing.push(`${path}: ${key.text}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    };
    scan('src'); expect(missing).toEqual([]);
  });
});
