'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { accountErrorMessage, accountSessionChanged, isStaleAccountRequest, type AccountPage } from '@/lib/account-api';

export function useAccountPage<T extends { id: string }>(fetchPage: (offset: number) => Promise<AccountPage<T>>, onSessionChanged: () => void) {
  const [page, setPage] = useState({ items: [] as T[], total: 0, nextOffset: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const paging = useRef(false);
  const sessionChanged = useRef(onSessionChanged);
  useEffect(() => { sessionChanged.current = onSessionChanged; }, [onSessionChanged]);

  useEffect(() => {
    const request = ++generation.current;
    fetchPage(0).then((result) => {
      if (generation.current !== request) return;
      setPage({ items: result.items, total: result.total, nextOffset: result.items.length });
      setError('');
    }).catch((failure: unknown) => {
      if (generation.current !== request || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) sessionChanged.current();
      else setError(accountErrorMessage(failure));
    }).finally(() => { if (generation.current === request) setLoading(false); });
    return invalidate;
  }, [fetchPage, revision, invalidate]);

  const reload = useCallback(() => {
    invalidate();
    paging.current = false;
    setPage({ items: [], total: 0, nextOffset: 0 });
    setError(''); setLoading(true); setLoadingMore(false);
    setRevision((value) => value + 1);
  }, [invalidate]);

  async function loadMore() {
    if (loading || paging.current || page.nextOffset >= page.total) return;
    const request = generation.current;
    const offset = page.nextOffset;
    paging.current = true; setLoadingMore(true); setError('');
    try {
      const result = await fetchPage(offset);
      if (generation.current !== request) return;
      setPage((current) => ({
        items: [...new Map([...current.items, ...result.items].map((item) => [item.id, item])).values()],
        total: result.total, nextOffset: offset + result.items.length,
      }));
    } catch (failure) {
      if (generation.current !== request || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) sessionChanged.current();
      else setError(accountErrorMessage(failure));
    } finally {
      if (generation.current === request) { paging.current = false; setLoadingMore(false); }
    }
  }

  return { ...page, loading, loadingMore, error, reload, loadMore };
}

export interface ConnectionConfirmation {
  title: string; description: string; action: string; success: string; execute: () => Promise<unknown>;
}

export function useConnectionActions(onSessionChanged: () => void, onSuccess: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<ConnectionConfirmation | null>(null);
  const alive = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function run(execute: () => Promise<unknown>, success: string) {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await execute();
      if (!alive.current) return false;
      onSuccess(); setMessage(success);
      return true;
    } catch (failure) {
      if (!alive.current || isStaleAccountRequest(failure)) return false;
      if (accountSessionChanged(failure)) onSessionChanged();
      else setError(accountErrorMessage(failure));
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current) { setBusy(false); setConfirmation(null); }
    }
  }

  return { busy, error, message, confirmation, setConfirmation, run };
}

export type ConnectionActions = ReturnType<typeof useConnectionActions>;
export type AccountPageState<T extends { id: string }> = ReturnType<typeof useAccountPage<T>>;
