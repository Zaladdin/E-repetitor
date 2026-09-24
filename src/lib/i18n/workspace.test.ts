import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState, DomainError, executeCommand, getTeacherEnrollments } from '@/domain';
import { setLocale, translate } from '../i18n';
import { workspaceMessages } from './workspace';

afterEach(() => setLocale('ru'));

describe('workspace localization', () => {
  it.each(['en', 'az'] as const)('preserves a user name when interpolating a translated action in %s', locale => {
    const name = 'Пользователи <Ali> {name}';
    const text = translate('Принять запрос {name}', { name }, locale);
    expect(text).toContain(name);
    expect(text).not.toContain('Принять запрос');
    expect(text).not.toContain('Users');
  });

  it.each(['en', 'az'] as const)('localizes demo validation in %s without rewriting subjects or API status values', locale => {
    setLocale(locale);
    const now = new Date('2030-01-01T10:00:00Z');
    const state = createDemoState(now);
    const original = JSON.stringify(state);
    const actor = { userId: 'user-murad', role: 'teacher' as const };
    const context = { now, id: () => 'generated-subject' };
    expect(() => executeCommand(state, actor, { type: 'create_subject', name: ' ' }, context))
      .toThrow(new DomainError(translate('Название предмета должно содержать от 1 до 100 символов.'), 'INVALID_SUBJECT_NAME'));
    const updated = executeCommand(state, actor, { type: 'create_subject', name: 'Пользователи' }, context);
    expect(updated.subjects.at(-1)).toMatchObject({ name: 'Пользователи', status: 'active' });
    expect(JSON.stringify(state)).toBe(original);
    const rows = getTeacherEnrollments(state, { userId: 'user-anna', role: 'teacher' }, now);
    expect(rows.some(row => row.subjectName === 'Математика' && row.status === 'active')).toBe(true);
  });

  it('keeps named parameters intact in both workspace translations', () => {
    const parameters = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
    for (const [source, translations] of Object.entries(workspaceMessages)) {
      for (const translated of translations) {
        expect(translated.trim(), source).not.toBe('');
        expect(parameters(translated), source).toEqual(parameters(source));
      }
    }
  });
});
