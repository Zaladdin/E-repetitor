const plurals = new Intl.PluralRules('ru');

export function plural(value: number, one: string, few: string, many: string) {
  const category = plurals.select(value);
  return category === 'one' ? one : category === 'few' ? few : many;
}
