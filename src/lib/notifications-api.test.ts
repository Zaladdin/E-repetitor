import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('notifications client', () => {
  it('loads an account-wide filtered feed and preferences without actor IDs in the URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [], total: 0, unreadTotal: 0 }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.notifications('account', 20, true);
    await api.notificationPreferences('account');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.example/notifications?limit=20&offset=20&unreadOnly=true', 'https://api.example/notification-preferences',
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({
      credentials: 'include', cache: 'no-store', headers: { 'X-Account-ID': 'account' },
    });
  });

  it('encodes the notification ID and marks only the requested record', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'n', readAt: '2026-09-22T12:00:00Z' }));
    await createAccountApi('https://api.example', fetcher).readNotification('account', 'n/1');
    expect(fetcher.mock.calls[0]).toEqual(['https://api.example/notifications/n%2F1/read', expect.objectContaining({
      method: 'POST', body: '{}', headers: expect.objectContaining({ 'X-Account-ID': 'account', 'X-Requested-With': 'ERepetitor' }),
    })]);
  });

  it('preserves desired preferences and their version through an authentication retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}));
    const value = { inApp: true, email: false, version: 3 };
    await createAccountApi('https://api.example', fetcher).saveNotificationPreference('account', 'lesson_reminder', value);
    for (const index of [0, 2]) expect(fetcher.mock.calls[index]).toEqual(['https://api.example/notification-preferences/lesson_reminder', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify(value), headers: expect.objectContaining({ 'X-Account-ID': 'account' }),
    })]);
  });

  it('does not retry a stale preference version or accept a response from a previous account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 'stale_version', message: 'Обновите настройки' } }, 409));
    const api = createAccountApi('https://api.example', fetcher);
    await expect(api.saveNotificationPreference('a', 'lesson_reminder', { inApp: false, email: true, version: 1 })).rejects.toMatchObject({ code: 'stale_version' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    let complete!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const request = api.notifications('a'); api.invalidatePendingRequests(); complete(json({ items: [] }));
    await expect(request).rejects.toMatchObject({ code: 'STALE_SESSION' });
  });
});
