import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotificationList } from '@/components/account-notifications';
import type { AccountNotification } from './account-notifications';

const item: AccountNotification = { id: 'n', type: 'result_published', recipientRole: 'parent', target: 'tests', title: '<script>title</script>', body: '<img src=x onerror=alert(1)>', createdAt: '2026-09-23T00:00:00Z', readAt: null };
describe('notification rendering', () => {
  it('escapes event content and identifies the destination role', () => {
    const html = renderToStaticMarkup(createElement(NotificationList, { items: [item], disabled: false, onRead: () => {}, onNavigate: () => {} }));
    expect(html).toContain('&lt;script&gt;title&lt;/script&gt;'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<script>');
    expect(html).toContain('Родитель'); expect(html).toContain('К тестам и результатам'); expect(html).toContain('Новое');
    expect(html).toContain('aria-label="Отметить прочитанным:');
  });
  it('removes the read action for already read notifications', () => {
    const html = renderToStaticMarkup(createElement(NotificationList, { items: [{ ...item, readAt: item.createdAt }], disabled: false, onRead: () => {}, onNavigate: () => {} }));
    expect(html).toContain('Прочитано'); expect(html).not.toContain('Отметить прочитанным:');
  });
});
