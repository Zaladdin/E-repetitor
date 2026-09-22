import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('account overview client', () => {
  it('encodes the child filter and keeps account preconditions on reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    const api = createAccountApi('https://api.example', fetcher);
    await api.overview('parent-account', 'parent', 'child/a&b');
    await api.overview('teacher-account', 'teacher');
    expect(fetcher.mock.calls[0]).toEqual(['https://api.example/overview?role=parent&studentId=child%2Fa%26b', expect.objectContaining({
      credentials: 'include', cache: 'no-store', headers: expect.objectContaining({ 'X-Account-ID': 'parent-account' }),
    })]);
    expect(fetcher.mock.calls[1]![0]).toBe('https://api.example/overview?role=teacher');
  });

  it('refreshes only the affected account after successful changes and unsubscribes', async () => {
    const api = createAccountApi('https://api.example', vi.fn<typeof fetch>().mockImplementation(async () => json({})));
    const changed = vi.fn(), otherAccount = vi.fn();
    const unsubscribe = api.subscribeOverview('teacher', changed);
    api.subscribeOverview('other-teacher', otherAccount);
    await api.markPayment('teacher', 'p', { version: 1, paid: true });
    await api.updateEnrollment('teacher', 'e', 'paused');
    await api.reviewTestAttempt('teacher', 'a', { version: 1, grades: [], comment: '' });
    expect(changed).toHaveBeenCalledTimes(3);
    expect(otherAccount).not.toHaveBeenCalled();
    unsubscribe();
    await api.markPayment('teacher', 'p', { version: 2, paid: true });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('does not reload on read, answer autosave or a failed mutation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    const api = createAccountApi('https://api.example', fetcher);
    const changed = vi.fn(); api.subscribeOverview('a', changed);
    await api.overview('a', 'student');
    await api.saveTestAnswers('a', 'attempt', 1, []);
    fetcher.mockResolvedValueOnce(json({ error: { code: 'conflict', message: 'Обновите запись' } }, 409));
    await expect(api.markPayment('a', 'p', { version: 1, paid: true })).rejects.toMatchObject({ status: 409 });
    expect(changed).not.toHaveBeenCalled();
  });

  it('emits once after an authentication retry and never for a stale account response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}));
    const api = createAccountApi('https://api.example', fetcher);
    const changed = vi.fn(); api.subscribeOverview('a', changed);
    await api.markPayment('a', 'p', { version: 1, paid: true });
    expect(changed).toHaveBeenCalledTimes(1);
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = api.markPayment('a', 'p', { version: 2, paid: true });
    api.invalidatePendingRequests(); finish(json({}));
    await expect(pending).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
