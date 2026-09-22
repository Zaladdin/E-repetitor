import { describe, expect, it, vi } from 'vitest';
import { consumeAccountLink, subscribeAccountLinks } from './account-link';

function fakeBrowser() {
  const events = new EventTarget();
  const location = { hash: '', pathname: '/account/', search: '?lang=ru' };
  const history = {
    state: { __NA: true, tree: ['account'] },
    replaceState: vi.fn<History['replaceState']>(() => { location.hash = ''; }),
  };
  return {
    location, history,
    addEventListener: (type: 'hashchange', listener: () => void) => events.addEventListener(type, listener),
    removeEventListener: (type: 'hashchange', listener: () => void) => events.removeEventListener(type, listener),
    navigateHash(hash: string) { location.hash = hash; events.dispatchEvent(new Event('hashchange')); },
  };
}

describe('account email link navigation', () => {
  it('opens successive confirmation/reset links in an already mounted page and removes tokens', () => {
    const browser = fakeBrowser();
    const onLink = vi.fn();
    const unsubscribe = subscribeAccountLinks(browser, onLink);
    browser.navigateHash('#verify=first-token');
    browser.navigateHash('#reset=second-token');
    expect(onLink.mock.calls).toEqual([
      [{ kind: 'verify', token: 'first-token' }],
      [{ kind: 'reset', token: 'second-token' }],
    ]);
    expect(browser.location.hash).toBe('');
    expect(browser.history.replaceState).toHaveBeenLastCalledWith(browser.history.state, '', '/account/?lang=ru');
    unsubscribe();
    browser.navigateHash('#verify=after-unmount');
    expect(onLink).toHaveBeenCalledTimes(2);
  });

  it('consumes an initial link while preserving router history state', () => {
    const browser = fakeBrowser();
    browser.location.hash = '#verify=initial-token';
    expect(consumeAccountLink(browser)).toEqual({ kind: 'verify', token: 'initial-token' });
    expect(browser.history.replaceState).toHaveBeenCalledWith(browser.history.state, '', '/account/?lang=ru');
    expect(consumeAccountLink(browser)).toBeNull();
  });

  it('leaves ordinary in-page anchors alone', () => {
    const browser = fakeBrowser();
    const onLink = vi.fn();
    const unsubscribe = subscribeAccountLinks(browser, onLink);
    browser.navigateHash('#account-main');
    expect(onLink).not.toHaveBeenCalled();
    expect(browser.history.replaceState).not.toHaveBeenCalled();
    expect(browser.location.hash).toBe('#account-main');
    unsubscribe();
  });

  it('consumes an invitation and switches to another email action without retaining its URL token', () => {
    const browser = fakeBrowser();
    browser.location.hash = '#invite=invitation-token';
    expect(consumeAccountLink(browser)).toEqual({ kind: 'invite', token: 'invitation-token' });
    expect(browser.location.hash).toBe('');
    const onLink = vi.fn();
    const unsubscribe = subscribeAccountLinks(browser, onLink);
    browser.navigateHash('#invite=second-invitation');
    browser.navigateHash('#reset=password-token');
    expect(onLink.mock.calls).toEqual([
      [{ kind: 'invite', token: 'second-invitation' }],
      [{ kind: 'reset', token: 'password-token' }],
    ]);
    expect(browser.location.hash).toBe('');
    expect(browser.history.replaceState).toHaveBeenLastCalledWith(browser.history.state, '', '/account/?lang=ru');
    unsubscribe();
  });
});
