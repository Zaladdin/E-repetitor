'use client';

import { createContext, useContext, useEffect, useId, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { getLocale, getServerLocale, isLocale, LOCALE_STORAGE_KEY, restoreLocale, setLocale, subscribeLocale, translate, type Locale, type MessageValues } from '@/lib/i18n';
import { accountSectionFromPath, accountSections } from '@/lib/account-navigation';

export const LocaleContext = createContext<Locale | null>(null);
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getServerLocale);
  const pathname = usePathname();
  useEffect(() => {
    restoreLocale();
    const sync = (event: StorageEvent) => { if (event.key === LOCALE_STORAGE_KEY && isLocale(event.newValue)) setLocale(event.newValue); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const section = accountSectionFromPath(pathname);
  const source = pathname.includes('/demo') ? 'Демо интерфейса' : accountSections('teacher', true).find(item => item.id === section)?.label ?? 'Рабочее пространство';
  return <LocaleContext.Provider value={locale}>
    <title>{`${translate(source, undefined, locale)} · E-repetitor`}</title>
    <meta name="description" content={translate('Аккаунты и рабочее пространство преподавателя, ученика и родителя.', undefined, locale)} />
    {children}
  </LocaleContext.Provider>;
}

export function useI18n() {
  const context = useContext(LocaleContext);
  const snapshot = useSyncExternalStore(subscribeLocale, getLocale, getServerLocale);
  const locale = context ?? snapshot;
  return useMemo(() => ({ locale, t: (source: string, values?: MessageValues) => translate(source, values, locale) }), [locale]);
}

export function LanguageSwitcher() {
  const id = useId();
  const { locale, t } = useI18n();
  return <div className="language-switcher"><label htmlFor={id} className="sr-only">{t('Язык интерфейса')}</label>
    <select id={id} value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }} title={t('Язык интерфейса')}>
      <option value="ru" lang="ru">Русский</option><option value="az" lang="az">Azərbaycan</option><option value="en" lang="en">English</option>
    </select>
  </div>;
}
