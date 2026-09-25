import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDashboard } from '@/components/account-dashboard';
import { TestEditorPage } from '@/components/test-editor-page';
import { LocaleContext } from '@/components/locale-provider';
import { TeacherTestLibrary } from '@/components/account-tests-library';
import { accountSectionFromPath } from './account-navigation';

const route = vi.hoisted(() => ({ pathname: '/account/tests/new/', search: '' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname, useSearchParams: () => new URLSearchParams(route.search), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
const props = { accountId: 'account', role: 'teacher' as const, onSessionChanged: () => {} };

describe('test editor pages', () => {
  beforeEach(() => { route.pathname = '/account/tests/new/'; route.search = ''; });
  it('maps both editor URLs to the tests section', () => {
    for (const path of ['/account/tests/new/', '/account/tests/edit/', '/account/tests/edit']) expect(accountSectionFromPath(path)).toBe('account-tests-section');
    expect(accountSectionFromPath('/account/tests/unrecognized/')).toBeNull();
  });
  it('offers creation as a page link and removes the inline form from the library', () => {
    const html = renderToStaticMarkup(<TeacherTestLibrary {...props} onAssigned={() => {}} />);
    expect(html).toContain('href="/account/tests/new/"');
    expect(html).not.toContain('name="subjectId"');
  });
  it('renders required title and subject fields with a return action outside a dialog', () => {
    const html = renderToStaticMarkup(<TestEditorPage {...props} />);
    expect(html).toMatch(/<input[^>]*required=""[^>]*name="title"/);
    expect(html).toContain('name="subjectId" required=""');
    expect(html).toContain('К списку тестов');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('Импорт');
  });
  it('rejects missing or malformed edit ids without opening a builder', () => {
    route.pathname = '/account/tests/edit/';
    for (const search of ['', 'test=invalid']) {
      route.search = search;
      expect(renderToStaticMarkup(<TestEditorPage {...props} />)).toContain('Выберите тест в библиотеке.');
    }
  });
  it('restores an edit loading view from a valid URL and keeps it nonmodal', () => {
    route.pathname = '/account/tests/edit/'; route.search = 'test=12345678-1234-1234-1234-123456789abc';
    const html = renderToStaticMarkup(<TestEditorPage {...props} />);
    expect(html).toContain('Конструктор теста');
    expect(html).toContain('Загружаем тест…');
    expect(html).not.toContain('role="dialog"');
  });
  it('does not expose a creation form to student or parent roles', () => {
    for (const role of ['student', 'parent'] as const) {
      const html = renderToStaticMarkup(<TestEditorPage {...props} role={role} />);
      expect(html).toContain('Создавать тесты может только преподаватель.');
      expect(html).not.toContain('<form');
    }
  });
  it('opens the teacher editor for an account whose first role is student', () => {
    const html = renderToStaticMarkup(<AccountDashboard account={{ id: 'multi', name: 'Teacher', email: 'teacher@example.test', status: 'active', roles: ['student', 'teacher'], profiles: {} }} section="account-tests-section" onAccountChange={() => {}} onLogout={() => {}} onSessionChanged={() => {}} />);
    expect(html).toContain('name="subjectId"');
    expect(html).not.toContain('Создавать тесты может только преподаватель.');
  });
  it('localizes the new page in English and Azerbaijani', () => {
    for (const locale of ['en', 'az'] as const) {
      const html = renderToStaticMarkup(<LocaleContext.Provider value={locale}><TestEditorPage {...props} /></LocaleContext.Provider>);
      expect(html).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
});
