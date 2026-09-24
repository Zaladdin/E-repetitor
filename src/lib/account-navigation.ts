import type { AccountRole } from './account-api';

export const ACCOUNT_SECTION_IDS = [
  'account-admin-section', 'account-overview-section', 'account-lessons-section',
  'account-groups-section', 'account-tests-section', 'account-payments-section', 'account-packages-section', 'account-connections-section',
  'account-notifications-section', 'account-settings-section',
] as const;

export type AccountSectionId = typeof ACCOUNT_SECTION_IDS[number];

export function accountSectionHref(id: AccountSectionId): string {
  return `/account/${id.slice('account-'.length, -'-section'.length)}/`;
}

export function accountSectionFromPath(path: string): AccountSectionId | null {
  if (path === '/' || path.replace(/\/$/, '') === '/account') return 'account-overview-section';
  return ACCOUNT_SECTION_IDS.find(id => accountSectionHref(id).replace(/\/$/, '') === path.replace(/\/$/, '')) ?? null;
}

export function accountSections(role: AccountRole, isAdmin = false) {
  const labels: Record<AccountSectionId, string> = {
    'account-admin-section': 'Администрирование',
    'account-overview-section': 'Обзор',
    'account-lessons-section': 'Расписание',
    'account-groups-section': 'Группы',
    'account-tests-section': 'Тесты и результаты',
    'account-payments-section': 'Оплата',
    'account-packages-section': 'Пакеты занятий',
    'account-connections-section': role === 'teacher' ? 'Ученики и предметы' : role === 'parent' ? 'Дети и подключения' : 'Мои подключения',
    'account-notifications-section': 'Уведомления',
    'account-settings-section': 'Аккаунт',
  };
  return ACCOUNT_SECTION_IDS.filter(id => (isAdmin || id !== 'account-admin-section') && (role === 'teacher' || id !== 'account-groups-section')).map(id => ({ id, label: labels[id] }));
}

export function accountSectionFromHash(hash: string, isAdmin = false): AccountSectionId | null {
  return ACCOUNT_SECTION_IDS.find(id => `#${id}` === hash && (isAdmin || id !== 'account-admin-section')) ?? null;
}

export function accountSectionAtScroll(
  sections: { id: AccountSectionId; top: number }[], offset: number, atBottom = false,
): AccountSectionId {
  // Navigation order differs from document order: notifications appear before the overview.
  const ordered = [...sections].sort((a, b) => a.top - b.top);
  if (atBottom && ordered.length) return ordered[ordered.length - 1].id;
  return ordered.filter(section => section.top <= offset).at(-1)?.id ?? 'account-overview-section';
}
