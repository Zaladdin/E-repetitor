import { coreMessages } from './i18n/core';
import { schedulingMessages } from './i18n/scheduling';
import { learningMessages } from './i18n/learning';
import { workspaceMessages } from './i18n/workspace';
import { serverMessages } from './i18n/server';
import { testFeatureMessages } from './i18n/test-features';

export type Locale = 'ru' | 'az' | 'en';
export type MessageValues = Record<string, string | number>;
export const LOCALE_STORAGE_KEY = 'e-repetitor-language';
export const LOCALES: readonly Locale[] = ['ru', 'az', 'en'];
export const messages: Readonly<Record<string, readonly [string, string]>> = {
  ...workspaceMessages, ...learningMessages, ...schedulingMessages, ...serverMessages, ...coreMessages, ...testFeatureMessages,
};

let currentLocale: Locale = 'ru';
const listeners = new Set<() => void>();
export function isLocale(value: unknown): value is Locale { return LOCALES.includes(value as Locale); }
export function getLocale(): Locale { return currentLocale; }
export function getServerLocale(): Locale { return 'ru'; }
export function localeTag(locale: Locale = getLocale()): string {
  return { ru: 'ru-RU', az: 'az-AZ', en: 'en-GB' }[locale];
}
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) return;
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Language still works without storage. */ }
  }
  if (currentLocale === locale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}
export function restoreLocale(): void {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) setLocale(stored);
  } catch { /* Restricted storage keeps the current language. */ }
}

const reverse = new Map<string, string>();
const templates: { source: string; names: string[]; expression: RegExp; specificity: number }[] = [];
const placeholder = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [source, translations] of Object.entries(messages)) {
  for (const text of [source, ...translations]) {
    if (!reverse.has(text)) reverse.set(text, source);
    const matches = [...text.matchAll(placeholder)];
    if (!matches.length) continue;
    const names: string[] = []; let expression = '^'; let end = 0;
    for (const match of matches) {
      expression += escapePattern(text.slice(end, match.index)) + '([\\s\\S]+?)';
      names.push(match[1]); end = match.index! + match[0].length;
    }
    templates.push({ source, names, expression: new RegExp(expression + escapePattern(text.slice(end)) + '$'), specificity: text.replace(placeholder, '').length });
  }
}
// A short label such as “Unread: {count}” must not capture an entire longer message.
templates.sort((left, right) => right.specificity - left.specificity);

/** Translate only application-owned copy. Names, questions and other user content stay untouched. */
export function translate(source: string, values?: MessageValues, locale: Locale = getLocale()): string {
  let key = Object.hasOwn(messages, source) ? source : reverse.get(source);
  let parameters = values;
  // Known templates also cover API feedback and messages stored before a language switch.
  if (!key && source.length <= 8000 && !values) {
    for (const template of templates) {
      const match = template.expression.exec(source);
      if (!match) continue;
      key = template.source;
      parameters = Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]]));
      break;
    }
  }
  const translated = key ? (locale === 'ru' ? key : messages[key][locale === 'en' ? 0 : 1]) : source;
  return parameters ? translated.replace(placeholder, (match, name: string) => Object.hasOwn(parameters, name) ? String(parameters![name]) : match) : translated;
}
