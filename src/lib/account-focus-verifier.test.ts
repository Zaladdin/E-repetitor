import { describe, expect, it, vi } from 'vitest';
import { AccountFocusVerifier } from './account-focus-verifier';

function fixture() {
  const requests: Array<{ resolve: (value: { id: string } | null) => void; reject: (error: Error) => void }> = [];
  const fetch = vi.fn(() => new Promise<{ id: string } | null>((resolve, reject) => requests.push({ resolve, reject })));
  const callbacks = { checking: vi.fn(), result: vi.fn(), error: vi.fn() };
  return { verifier: new AccountFocusVerifier(fetch, callbacks), requests, fetch, callbacks };
}

describe('account focus verification', () => {
  it('coalesces focus events and returns the identity without clearing the current account', async () => {
    const { verifier, requests, fetch, callbacks } = fixture();
    const first = verifier.check('student');
    const second = verifier.check('student');
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(callbacks.result).not.toHaveBeenCalled();
    requests[0]!.resolve({ id: 'student' });
    await first;
    expect(callbacks.result).toHaveBeenCalledWith({ id: 'student' }, 'student');
    expect(callbacks.checking.mock.calls).toEqual([[true], [false]]);
  });

  it('cannot restore an old account after logout or a broadcast account change', async () => {
    const { verifier, requests, callbacks } = fixture();
    const old = verifier.check('old'); verifier.invalidate();
    const current = verifier.check('new');
    requests[0]!.resolve({ id: 'old' }); await old;
    expect(callbacks.result).not.toHaveBeenCalled();
    expect(callbacks.checking.mock.calls).toEqual([[true], [true]]);
    requests[1]!.resolve({ id: 'new' }); await current;
    expect(callbacks.result).toHaveBeenCalledOnce();
    expect(callbacks.result).toHaveBeenCalledWith({ id: 'new' }, 'new');
  });

  it('reports connection failure and permits retry without changing account identity', async () => {
    const { verifier, requests, callbacks } = fixture();
    const first = verifier.check('student');
    const error = new Error('offline'); requests[0]!.reject(error); await first;
    expect(callbacks.error).toHaveBeenCalledWith(error);
    expect(callbacks.result).not.toHaveBeenCalled();
    const retry = verifier.check('student'); requests[1]!.resolve(null); await retry;
    expect(callbacks.result).toHaveBeenCalledWith(null, 'student');
  });

  it('discards errors and completion notifications from invalidated checks', async () => {
    const { verifier, requests, callbacks } = fixture();
    const first = verifier.check('student'); verifier.invalidate();
    requests[0]!.reject(new Error('late failure')); await first;
    expect(callbacks.error).not.toHaveBeenCalled();
    expect(callbacks.checking.mock.calls).toEqual([[true]]);
  });
});
