'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { accountErrorMessage, accountSessionChanged, isStaleAccountRequest } from '@/lib/account-api';
import { localeTag } from '@/lib/i18n';

export type AdminRequest = <T>(request: Promise<T>) => Promise<T>;
export interface AdminContextProps { accountId: string; guard: AdminRequest; onSessionChanged: () => void }

export function useAdminValue<T>(fetchValue: () => Promise<T>, onSessionChanged: () => void) {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const sessionChanged = useRef(onSessionChanged);
  useEffect(() => { sessionChanged.current = onSessionChanged; }, [onSessionChanged]);
  useEffect(() => {
    const current = ++generation.current;
    fetchValue().then(result => { if (current === generation.current) { setValue(result); setError(''); } }).catch((failure: unknown) => {
      if (current !== generation.current || isStaleAccountRequest(failure)) return;
      setValue(null);
      if (accountSessionChanged(failure)) sessionChanged.current(); else setError(accountErrorMessage(failure));
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return invalidate;
  }, [fetchValue, revision, invalidate]);
  const reload = useCallback(() => { generation.current++; setLoading(true); setError(''); setValue(null); setRevision(v => v + 1); }, []);
  return { value, loading, error, reload };
}

export const adminDate = (value: string) => new Date(value).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' });
