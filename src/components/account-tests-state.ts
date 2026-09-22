'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { accountErrorMessage, accountSessionChanged, isStaleAccountRequest } from '@/lib/account-api';

/** Callers key the detail component by account/resource, keeping private state scoped. */
export function useTestResource<T>(load: () => Promise<T>, onSessionChanged: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const sessionChanged = useRef(onSessionChanged);
  useEffect(() => { sessionChanged.current = onSessionChanged; }, [onSessionChanged]);
  useEffect(() => {
    let active = true;
    load().then(value => { if (active) setData(value); }).catch((failure: unknown) => {
      if (!active || isStaleAccountRequest(failure)) return;
      if (accountSessionChanged(failure)) sessionChanged.current();
      else setError(accountErrorMessage(failure));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, revision]);
  const reload = useCallback(() => { setData(null); setError(''); setLoading(true); setRevision(value => value + 1); }, []);
  return { data, setData, error, loading, reload };
}
