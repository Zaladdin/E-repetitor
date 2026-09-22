import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountDashboard } from '@/components/account-dashboard';
import { AdminAuditList } from '@/components/account-admin-audit';
import { AdminUserList } from '@/components/account-admin-users';
import type { AdminAuditEvent, AdminUser } from './account-admin';
import type { Account } from './account-api';

describe('admin rendering boundaries', () => {
  it('only offers the administrator section with a server capability, separate from normal roles', () => {
    const account: Account = { id: 'me', name: 'Teacher', email: 'teacher@example.test', status: 'active', roles: ['teacher'], profiles: {} };
    const props = { account, onAccountChange: () => undefined, onLogout: () => undefined, onSessionChanged: () => undefined };
    expect(renderToStaticMarkup(createElement(AccountDashboard, props))).not.toContain('Администрирование');
    const html = renderToStaticMarkup(createElement(AccountDashboard, { ...props, account: { ...account, isAdmin: true } }));
    expect(html).toContain('Администрирование'); expect(html).not.toContain('<option value="admin"');
    expect(html).not.toContain('Найдено:');
  });
  it('escapes user data and audit reasons and renders no credential fields', () => {
    const user: AdminUser = { id: 'id', name: '<img src=x onerror=alert(1)>', email: 'qa@example.test', publicId: 'STU-ABCD-1234', status: 'suspended', statusVersion: 2, roles: ['student'], isAdmin: false, createdAt: '2026-09-23T00:00:00Z' };
    const html = renderToStaticMarkup(createElement(AdminUserList, { items: [{ ...user, password_hash: 'PRIVATE HASH' } as AdminUser], onOpen: () => undefined }));
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('PRIVATE HASH');
    expect(html).toContain('Заблокирован'); expect(html).toContain('Открыть пользователя qa@example.test');
    const item: AdminAuditEvent = { id: 'event', action: 'admin.user.suspended', actorId: 'admin', actorName: 'Admin', entityId: 'id', createdAt: user.createdAt, reason: '<script>danger</script>', fromStatus: 'active', toStatus: 'suspended' };
    const audit = renderToStaticMarkup(createElement(AdminAuditList, { items: [item] }));
    expect(audit).toContain('&lt;script&gt;'); expect(audit).not.toContain('<script>'); expect(audit).toContain('Аккаунт заблокирован');
  });
});
