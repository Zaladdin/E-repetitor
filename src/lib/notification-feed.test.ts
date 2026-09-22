import { describe, expect, it, vi } from 'vitest';
import { AccountApiError } from './account-api';
import { NotificationFeedLoader, emptyNotificationFeed } from './notification-feed';
import type { NotificationPage } from './account-notifications';

function page(ids: string[], total = ids.length, unreadTotal = total): NotificationPage {
  return { items: ids.map(id => ({ id, type: 'lesson_reminder', recipientRole: 'student', target: 'lessons', title: id, body: '', createdAt: '2026-09-23T00:00:00Z', readAt: null })), total, unreadTotal, limit: 20, offset: 0 };
}
function deferred() { let resolve!: (value: NotificationPage) => void; const promise = new Promise<NotificationPage>(done => { resolve = done; }); return { promise, resolve }; }

describe('notification feed lifecycle', () => {
  it('uses the server unread total rather than the current page and serializes load-more clicks', async () => {
    const pending = deferred(); const fetcher = vi.fn<(offset: number) => Promise<NotificationPage>>().mockResolvedValueOnce(page(['a'], 3, 12)).mockReturnValueOnce(pending.promise);
    let state = emptyNotificationFeed();
    const loader = new NotificationFeedLoader(fetcher, value => { state = value; }, vi.fn());
    await loader.reload(); expect(state.unreadTotal).toBe(12);
    const more = loader.more(); await loader.more();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenLastCalledWith(1);
    pending.resolve(page(['b', 'c'], 3, 11)); await more;
    expect(state.items.map(item => item.id)).toEqual(['a', 'b', 'c']); expect(state.unreadTotal).toBe(11);
  });

  it('does not restore an old page or unread count after a reload', async () => {
    const old = deferred();
    const fetcher = vi.fn<(offset: number) => Promise<NotificationPage>>().mockResolvedValueOnce(page(['old'], 2, 2)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(['fresh'], 1, 1));
    let state = emptyNotificationFeed(); const loader = new NotificationFeedLoader(fetcher, value => { state = value; }, vi.fn());
    await loader.reload(); const more = loader.more(); await loader.reload();
    old.resolve(page(['revoked'], 2, 9)); await more;
    expect(state.items.map(item => item.id)).toEqual(['fresh']); expect(state.unreadTotal).toBe(1);
  });

  it('does not update a disposed account or report its obsolete error', async () => {
    const pending = deferred(); const update = vi.fn(), sessionChanged = vi.fn();
    const loader = new NotificationFeedLoader(() => pending.promise, update, sessionChanged);
    const reload = loader.reload(); update.mockClear(); loader.dispose(); pending.resolve(page(['old-account'])); await reload;
    expect(update).not.toHaveBeenCalled(); expect(sessionChanged).not.toHaveBeenCalled();
  });

  it('reloads from the start if a page reports fewer visible messages after access changes', async () => {
    const fetcher = vi.fn<(offset: number) => Promise<NotificationPage>>().mockResolvedValueOnce(page(['revoked-child'], 2)).mockResolvedValueOnce(page([], 0)).mockResolvedValueOnce(page([], 0));
    let state = emptyNotificationFeed(); const loader = new NotificationFeedLoader(fetcher, value => { state = value; }, vi.fn());
    await loader.reload(); await loader.more();
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([0, 1, 0]);
    expect(state.items).toEqual([]); expect(state.unreadTotal).toBe(0);
  });

  it('keeps rows mounted while polling, but clears private stale content when refresh fails', async () => {
    const next = deferred();
    const fetcher = vi.fn<(offset: number) => Promise<NotificationPage>>().mockResolvedValueOnce(page(['a'])).mockReturnValueOnce(next.promise).mockRejectedValueOnce(new AccountApiError('Нет соединения', 0, 'NETWORK_ERROR'));
    let state = emptyNotificationFeed(); const loader = new NotificationFeedLoader(fetcher, value => { state = value; }, vi.fn());
    await loader.reload(); const polling = loader.reload(true);
    expect(state.items[0].id).toBe('a'); expect(state.loading).toBe(false); expect(state.refreshing).toBe(true);
    next.resolve(page(['a'], 1, 0)); await polling; await loader.reload(true);
    expect(state.items).toEqual([]); expect(state.unreadTotal).toBeNull(); expect(state.error).toBe('Нет соединения');
  });

  it('hands an account switch to the existing session reset flow', async () => {
    const changed = vi.fn(); const loader = new NotificationFeedLoader(async () => { throw new AccountApiError('Аккаунт изменился', 409, 'account_changed'); }, vi.fn(), changed);
    await loader.reload(); expect(changed).toHaveBeenCalledOnce();
  });

  it('retains expanded history on background refresh and discards revoked rows', async () => {
    const fetcher = vi.fn<(offset: number) => Promise<NotificationPage>>()
      .mockResolvedValueOnce(page(['a'], 3)).mockResolvedValueOnce(page(['b'], 3))
      .mockResolvedValueOnce(page(['a'], 3)).mockResolvedValueOnce(page(['b'], 3))
      .mockResolvedValueOnce(page(['b'], 1));
    let state = emptyNotificationFeed();
    const loader = new NotificationFeedLoader(fetcher, value => { state = value; }, vi.fn());
    await loader.reload(); await loader.more(); await loader.reload(true);
    expect(state.items.map(item => item.id)).toEqual(['a', 'b']); expect(state.nextOffset).toBe(2);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([0, 1, 0, 1]);
    await loader.reload(true); expect(state.items.map(item => item.id)).toEqual(['b']);
  });
});
