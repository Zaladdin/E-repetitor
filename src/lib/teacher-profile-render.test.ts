import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccountDashboard } from '@/components/account-dashboard';
import { TeacherProfileFields } from '@/components/teacher-profile-fields';
import type { Account } from './account-api';
import { ACCOUNT_SECTION_IDS, type AccountSectionId } from './account-navigation';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/account/tests/' }));

const account: Account = { id: 'me', name: 'Анна Иванова', email: 'teacher@example.test', status: 'active', roles: ['teacher'],
  profiles: { teacher: { id: 'teacher-1', timezone: 'Asia/Baku', phone: '+994501234567', birthDate: '1990-02-28' } } };
const dashboard = (value: Account, section: AccountSectionId = 'account-settings-section') => renderToStaticMarkup(createElement(AccountDashboard, {
  account: value, section, onAccountChange: () => {}, onLogout: () => {}, onSessionChanged: () => {},
}));

describe('teacher profile rendering', () => {
  it('shows personal data only in teacher settings and subject creation on its own page', () => {
    const html = dashboard(account);
    expect(html).toContain('Данные преподавателя');
    expect(html).toContain('+994501234567');
    expect(html).toContain('28.02.1990');
    expect(html).not.toContain('Мои предметы');
    const connections = dashboard(account, 'account-connections-section');
    expect(connections).toContain('Мои предметы');
    expect(connections).toContain('Добавить предмет');
    expect(connections).not.toContain('Данные преподавателя');
  });

  it.each(ACCOUNT_SECTION_IDS)('renders only the requested section: %s', section => {
    const html = dashboard({ ...account, isAdmin: true }, section);
    expect(html).toContain(`id="${section}"`);
    for (const other of ACCOUNT_SECTION_IDS.filter(id => id !== section)) {
      expect(html).not.toContain(`id="${other}"`);
    }
    expect(html).not.toContain('Сейчас я');
    expect(html).not.toContain('Почта подтверждена');
  });

  it('retains multi-role selection only on the account settings page', () => {
    const multiRole: Account = { ...account, roles: ['teacher', 'parent'] };
    expect(dashboard(multiRole)).toContain('Активная роль');
    expect(dashboard(multiRole, 'account-overview-section')).not.toContain('Активная роль');
    expect(dashboard(account)).not.toContain('Активная роль');
  });

  it('handles legacy teacher profiles without phone or birth date', () => {
    const html = dashboard({ ...account, profiles: { teacher: { id: 'legacy', timezone: 'Asia/Baku', phone: null, birthDate: null } } });
    expect(html).toContain('Не указан');
    expect(html).toContain('Не указана');
    expect(html).not.toContain('Invalid Date');
  });

  it.each(['parent', 'student'] as const)('does not render teacher details while in the %s cabinet', role => {
    const html = dashboard({ ...account, roles: [role, 'teacher'] });
    expect(html).not.toContain('Данные преподавателя');
    expect(html).not.toContain('+994501234567');
    expect(html).not.toContain('28.02.1990');
  });

  it('gives native field semantics and unique label targets to reusable forms', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(TeacherProfileFields), createElement(TeacherProfileFields, { disabled: true })));
    expect(html).toContain('type="tel"');
    expect(html).toContain('type="date"');
    expect(html).toContain('autoComplete="bday"');
    expect(html).toContain('Первый предмет');
    const targets = Array.from(html.matchAll(/<label for="([^"]+)"/g), match => match[1]);
    expect(targets).toHaveLength(6);
    expect(new Set(targets).size).toBe(6);
    for (const target of targets) expect(html).toContain(`id="${target}"`);
  });
});
