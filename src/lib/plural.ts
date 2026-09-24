import { getLocale, translate } from './i18n';

export function plural(value: number, one: string, few: string, many: string) {
  const locale = getLocale();
  const category = new Intl.PluralRules(locale).select(value);
  const word = locale === 'az' || category === 'one' ? one : locale === 'ru' && category === 'few' ? few : many;
  return translate(word);
}
