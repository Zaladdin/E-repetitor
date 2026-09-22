export interface AccountEmailLink { kind: 'verify' | 'reset' | 'invite'; token: string }

interface AccountLinkBrowser {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'state' | 'replaceState'>;
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

export function consumeAccountLink(browser: Pick<AccountLinkBrowser, 'location' | 'history'>): AccountEmailLink | null {
  const hash = new URLSearchParams(browser.location.hash.slice(1));
  const kind = hash.has('verify') ? 'verify' : hash.has('reset') ? 'reset' : hash.has('invite') ? 'invite' : null;
  if (!kind) return null;
  const link: AccountEmailLink = { kind, token: hash.get(kind) ?? '' };
  browser.history.replaceState(browser.history.state, '', `${browser.location.pathname}${browser.location.search}`);
  return link;
}

export function subscribeAccountLinks(browser: AccountLinkBrowser, onLink: (link: AccountEmailLink) => void): () => void {
  const onHashChange = () => {
    const link = consumeAccountLink(browser);
    if (link) onLink(link);
  };
  browser.addEventListener('hashchange', onHashChange);
  return () => browser.removeEventListener('hashchange', onHashChange);
}
