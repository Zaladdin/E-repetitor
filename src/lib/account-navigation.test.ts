import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountNavigation } from '@/components/account-navigation';
import { ACCOUNT_SECTION_IDS, accountSectionHref, accountSectionFromPath, accountSectionAtScroll, accountSectionFromHash, accountSections } from './account-navigation';

describe('cabinet navigation', () => {
  it('gives every section a distinct deep link that survives a trailing slash', () => {
    const paths = ACCOUNT_SECTION_IDS.map(accountSectionHref);
    expect(new Set(paths).size).toBe(ACCOUNT_SECTION_IDS.length);
    for (const id of ACCOUNT_SECTION_IDS) {
      expect(accountSectionFromPath(accountSectionHref(id))).toBe(id);
      expect(accountSectionFromPath(accountSectionHref(id).slice(0, -1))).toBe(id);
    }
    expect(accountSectionFromPath('/account/unknown/')).toBeNull();
    expect(accountSectionFromPath('/account/')).toBe('account-overview-section');
  });
  it('accepts only known section links and never opens admin for non-admin accounts', () => {
    expect(accountSectionFromHash('#account-notifications-section')).toBe('account-notifications-section');
    expect(accountSectionFromHash('#account-admin-section')).toBeNull();
    expect(accountSectionFromHash('#account-admin-section', true)).toBe('account-admin-section');
    expect(accountSectionFromHash('#verify=private-token')).toBeNull();
    expect(accountSectionFromHash('#unknown')).toBeNull();
  });

  it('tracks the last section above the sticky navigation in document order', () => {
    const sections = [
      { id: 'account-overview-section' as const, top: 340 },
      { id: 'account-notifications-section' as const, top: 40 },
      { id: 'account-settings-section' as const, top: 920 },
    ];
    expect(accountSectionAtScroll(sections, 80)).toBe('account-notifications-section');
    expect(accountSectionAtScroll(sections, 360)).toBe('account-overview-section');
    expect(accountSectionAtScroll(sections, 80, true)).toBe('account-settings-section');
    expect(accountSectionAtScroll([], 80)).toBe('account-overview-section');
    expect(sections[0].id).toBe('account-overview-section');
  });

  it('uses role-specific connection labels and native links with one current location', () => {
    expect(accountSections('student').find(section => section.id === 'account-connections-section')?.label).toBe('Мои подключения');
    expect(accountSections('parent').find(section => section.id === 'account-connections-section')?.label).toBe('Дети и подключения');
    expect(accountSections('teacher').some(section => section.id === 'account-groups-section')).toBe(true);
    expect(accountSections('student').some(section => section.id === 'account-groups-section')).toBe(false);
    expect(accountSections('parent').some(section => section.id === 'account-groups-section')).toBe(false);
    const html = renderToStaticMarkup(createElement(AccountNavigation, { role: 'teacher', unreadNotifications: 3, active: 'account-overview-section' }));
    expect(html).toContain('Ученики и предметы');
    expect(html).not.toContain('Администрирование');
    expect(html).toContain('aria-current="page" href="/account/overview"');
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toContain('Непрочитанных: 3');
  });
});
