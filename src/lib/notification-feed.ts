import { accountErrorMessage, accountSessionChanged, isStaleAccountRequest } from './account-api';
import type { AccountNotification, NotificationPage } from './account-notifications';

export interface NotificationFeedState {
  items: AccountNotification[]; total: number; unreadTotal: number | null; nextOffset: number;
  loading: boolean; loadingMore: boolean; refreshing: boolean; error: string;
}
export const emptyNotificationFeed = (): NotificationFeedState => ({
  items: [], total: 0, unreadTotal: null, nextOffset: 0, loading: true, loadingMore: false, refreshing: false, error: '',
});

/** A reload invalidates both old page requests and old unread counts. */
export class NotificationFeedLoader {
  private state = emptyNotificationFeed();
  private generation = 0;
  private disposed = false;
  constructor(
    private readonly fetchPage: (offset: number) => Promise<NotificationPage>,
    private readonly update: (state: NotificationFeedState) => void,
    private readonly sessionChanged: () => void,
  ) {}

  reload(background = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const depth = background ? this.state.nextOffset : 0;
    this.generation++;
    this.state = background && !this.state.loading
      ? { ...this.state, refreshing: true, loadingMore: false, error: '' } : emptyNotificationFeed();
    this.update(this.state);
    return this.read(0, this.generation, depth);
  }

  more(): Promise<void> {
    if (this.disposed || this.state.loading || this.state.loadingMore || this.state.refreshing || this.state.nextOffset >= this.state.total) return Promise.resolve();
    this.state = { ...this.state, loadingMore: true, error: '' }; this.update(this.state);
    return this.read(this.state.nextOffset, this.generation);
  }

  dispose(): void { this.disposed = true; this.generation++; }

  private async read(offset: number, generation: number, depth = 0): Promise<void> {
    const current = () => !this.disposed && generation === this.generation;
    try {
      const page = await this.fetchPage(offset);
      if (!current()) return;
      // Poll the entire expanded window without unmounting its existing rows.
      let nextOffset = offset + page.items.length;
      const refreshedItems = [...page.items];
      while (offset === 0 && page.items.length > 0 && nextOffset < Math.min(depth, page.total)) {
        const next = await this.fetchPage(nextOffset);
        if (!current()) return;
        refreshedItems.push(...next.items);
        nextOffset += next.items.length;
        page.total = next.total; page.unreadTotal = next.unreadTotal;
        if (!next.items.length) break;
      }
      // An older loaded page may now contain revoked/hidden messages.
      if (offset > 0 && page.total < this.state.total) { await this.reload(); return; }
      this.state = {
        items: [...new Map([...(offset === 0 ? [] : this.state.items), ...refreshedItems].map(item => [item.id, item])).values()],
        total: page.total, unreadTotal: page.unreadTotal, nextOffset,
        loading: false, loadingMore: false, refreshing: false, error: '',
      };
    } catch (failure) {
      if (!current() || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) { this.sessionChanged(); return; }
      this.state = { ...(offset === 0 ? emptyNotificationFeed() : this.state), loading: false, loadingMore: false, refreshing: false, error: accountErrorMessage(failure) };
    }
    if (current()) this.update(this.state);
  }
}
