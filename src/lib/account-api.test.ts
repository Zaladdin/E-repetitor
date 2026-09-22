import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_SESSION_SOURCE, AccountApiError, createAccountApi, isExternalAccountSessionChange } from './account-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const unauthorized = () => json({ error: { code: 'UNAUTHORIZED', message: 'Войдите в аккаунт.' } }, 401);

describe('account HTTP client', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('ignores session notifications from this tab and accepts another tab', () => {
    expect(isExternalAccountSessionChange({ type: 'changed', source: ACCOUNT_SESSION_SOURCE })).toBe(false);
    expect(isExternalAccountSessionChange({ type: 'changed', source: 'another-tab' })).toBe(true);
    expect(isExternalAccountSessionChange('changed')).toBe(false);
  });
  it('sends credentials and the CSRF request header, without a client token store', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ user: { id: 'account-1' } }));
    await createAccountApi('https://api.example/api/v1/', fetcher).login('me@example.test', 'password123');
    expect(fetcher).toHaveBeenCalledWith('https://api.example/api/v1/auth/login', expect.objectContaining({
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: expect.objectContaining({ 'X-Requested-With': 'ERepetitor' }),
      body: JSON.stringify({ email: 'me@example.test', password: 'password123' }),
    }));
  });

  it('does not refresh on an incorrect login password', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(unauthorized());
    await expect(createAccountApi('https://api.example', fetcher).login('me@example.test', 'incorrect')).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares a rotating refresh request between simultaneous expired requests', async () => {
    let finishRefresh!: (response: Response) => void;
    let refreshed = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith('/auth/refresh')) {
        return new Promise<Response>((resolve) => { finishRefresh = resolve; });
      }
      return refreshed ? json({ items: [] }) : unauthorized();
    });
    const api = createAccountApi('https://api.example', fetcher);
    const requests = [api.subjects('account-1'), api.subjects('account-1')];
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    refreshed = true;
    finishRefresh(json({ message: 'ok' }));
    await expect(Promise.all(requests)).resolves.toEqual([{ items: [] }, { items: [] }]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('retries only once even when the renewed session is rejected', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ message: 'ok' }))
      .mockResolvedValueOnce(unauthorized());
    await expect(createAccountApi('https://api.example', fetcher).subjects('account-1')).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('coordinates refresh across tabs and rechecks the session inside the browser lock', async () => {
    let lockQueue = Promise.resolve();
    vi.stubGlobal('navigator', { locks: {
      request: (_name: string, callback: () => Promise<void>) => {
        const result = lockQueue.then(callback);
        lockQueue = result.catch(() => undefined);
        return result;
      },
    } });
    let refreshed = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshed = true;
        return json({ message: 'ok' });
      }
      return refreshed ? json(url.endsWith('/me') ? { id: 'account-1' } : { items: [] }) : unauthorized();
    });
    const firstTab = createAccountApi('https://api.example', fetcher);
    const secondTab = createAccountApi('https://api.example', fetcher);
    await expect(Promise.all([firstTab.subjects('account-1'), secondTab.subjects('account-1')])).resolves.toEqual([{ items: [] }, { items: [] }]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/me'))).toHaveLength(2);
  });

  it('treats an absent session as signed out but does not hide a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => unauthorized());
    await expect(createAccountApi('https://api.example', fetcher).current()).resolves.toBeNull();
    fetcher.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createAccountApi('https://api.example', fetcher).current()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('reports invalid server responses without exposing raw HTML', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<h1>Gateway error</h1>', { status: 502 }));
    await expect(createAccountApi('https://api.example', fetcher).current()).rejects.toBeInstanceOf(AccountApiError);
  });

  it('binds a mutation to the displayed account even after a refresh retry', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ message: 'ok' }))
      .mockResolvedValueOnce(json({ error: { code: 'account_changed', message: 'Аккаунт изменился.' } }, 409));
    const api = createAccountApi('https://api.example', fetcher);
    await expect(api.createSubject('account-a', 'Математика')).rejects.toMatchObject({ code: 'account_changed' });
    const calls = fetcher.mock.calls;
    expect(calls[0]![1]!.headers).toMatchObject({ 'X-Account-ID': 'account-a' });
    expect(calls[1]![1]!.headers).not.toHaveProperty('X-Account-ID');
    expect(calls[2]![1]!.headers).toMatchObject({ 'X-Account-ID': 'account-a' });
    expect(calls).toHaveLength(3);
  });

  it('discards a response from before a session change', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const api = createAccountApi('https://api.example', fetcher);
    const pending = api.subjects('account-a');
    api.invalidatePendingRequests();
    finish(json({ items: [{ id: 'old-subject' }], total: 1 }));
    await expect(pending).rejects.toMatchObject({ code: 'STALE_SESSION' });
  });

  it('does not retry a mutation if the session changed while refresh was pending', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(unauthorized())
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const api = createAccountApi('https://api.example', fetcher);
    const pending = api.createSubject('account-a', 'Математика');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    api.invalidatePendingRequests();
    finish(json({ message: 'ok' }));
    await expect(pending).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends the page offset and account precondition on subject reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [], total: 100, offset: 100, limit: 100 }));
    await createAccountApi('https://api.example', fetcher).subjects('account-a', 100);
    expect(fetcher).toHaveBeenCalledWith('https://api.example/subjects?limit=100&offset=100', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Account-ID': 'account-a' }),
    }));
  });

  it('binds role changes and both logout actions without binding session discovery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ message: 'ok' }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.addRole('account-a', 'parent');
    await api.logout('account-a');
    await api.logoutAll('account-a');
    await api.current();
    for (const [, options] of fetcher.mock.calls.slice(0, 3)) expect(options!.headers).toHaveProperty('X-Account-ID', 'account-a');
    expect(fetcher.mock.calls[3]![1]!.headers).not.toHaveProperty('X-Account-ID');
  });

  it('keeps PATCH, body, and account precondition when retrying an enrollment update', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ message: 'ok' }))
      .mockResolvedValueOnce(json({ id: 'enrollment-1', status: 'paused' }));
    await expect(createAccountApi('https://api.example', fetcher).updateEnrollment('account-a', 'enrollment-1', 'paused')).resolves.toEqual({ id: 'enrollment-1', status: 'paused' });
    for (const index of [0, 2]) expect(fetcher.mock.calls[index]).toEqual(['https://api.example/enrollments/enrollment-1', expect.objectContaining({
      method: 'PATCH', credentials: 'include', body: JSON.stringify({ status: 'paused' }),
      headers: expect.objectContaining({ 'X-Account-ID': 'account-a', 'X-Requested-With': 'ERepetitor', 'Content-Type': 'application/json' }),
    })]);
  });

  it('passes role and pagination explicitly for private connection lists', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [], total: 0 }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.enrollments('account-a', 'teacher', 50);
    await api.enrollments('account-a', 'student');
    await api.parentConnections('account-a', 'student', 100);
    await api.parentConnections('account-a', 'parent');
    await api.parentChildren('account-a', 50);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example/enrollments?role=teacher&limit=50&offset=50',
      'https://api.example/enrollments?role=student&limit=50&offset=0',
      'https://api.example/parent-connections?role=student&limit=50&offset=100',
      'https://api.example/parent-connections?role=parent&limit=50&offset=0',
      'https://api.example/parent-children?limit=50&offset=50',
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ method: 'GET', headers: { 'X-Account-ID': 'account-a' } });
  });

  it('binds every connection action to the displayed account with minimal request bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'connection-1', status: 'active' }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.requestEnrollment('account-a', 'STU-K7M4-P92X', 'subject-1');
    await api.decideEnrollment('account-a', 'enrollment-1', 'accept');
    await api.decideEnrollment('account-a', 'enrollment-1', 'reject');
    await api.requestParentConnection('account-a', 'STU-K7M4-P92X');
    await api.decideParentConnection('account-a', 'connection-1', 'approve');
    await api.decideParentConnection('account-a', 'connection-1', 'reject');
    await api.decideParentConnection('account-a', 'connection-1', 'revoke');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example/enrollments', 'https://api.example/enrollments/enrollment-1/accept', 'https://api.example/enrollments/enrollment-1/reject',
      'https://api.example/parent-connections', 'https://api.example/parent-connections/connection-1/approve', 'https://api.example/parent-connections/connection-1/reject', 'https://api.example/parent-connections/connection-1/revoke',
    ]);
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse(String(options!.body)))).toEqual([
      { publicId: 'STU-K7M4-P92X', subjectId: 'subject-1' }, {}, {}, { publicId: 'STU-K7M4-P92X' }, {}, {}, {},
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ method: 'POST', headers: { 'X-Account-ID': 'account-a', 'X-Requested-With': 'ERepetitor' } });
  });
});
