import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('package account boundary and shared payment refresh', () => {
  it('binds package reads, eligible lessons and family history to the displayed account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [], total: 0 }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.packageRecords('parent-a', 'parent', 50);
    await api.packageHistory('parent-a', 'package/id', 'parent', 100);
    await api.packageLessons('teacher-a', 'package/id', 50);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example/packages?role=parent&limit=50&offset=50',
      'https://api.example/packages/package%2Fid/history?role=parent&limit=50&offset=100',
      'https://api.example/packages/package%2Fid/lessons?limit=50&offset=50',
    ]);
    expect(fetcher.mock.calls[1]![1]!.headers).toHaveProperty('X-Account-ID', 'parent-a');
    expect(fetcher.mock.calls[2]![1]!.headers).toHaveProperty('X-Account-ID', 'teacher-a');
  });

  it('preserves command IDs and both version preconditions across authentication retry', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'Войдите.' } }, 401))
      .mockResolvedValueOnce(json({ message: 'ok' }))
      .mockResolvedValueOnce(json({ id: 'package', balance: 7 }));
    const api = createAccountApi('https://api.example', fetcher);
    const input = { requestId: 'command', version: 3, lessonId: 'lesson', lessonVersion: 2, reason: 'Пропуск подтверждён' };
    await api.chargePackage('teacher-a', 'package', input);
    for (const call of [fetcher.mock.calls[0]!, fetcher.mock.calls[2]!]) {
      expect(call[1]).toMatchObject({ method: 'POST', body: JSON.stringify(input), credentials: 'include',
        headers: { 'X-Account-ID': 'teacher-a', 'X-Requested-With': 'ERepetitor' } });
    }
  });

  it('refreshes both views only for successful financial mutations in their own account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'package' }));
    const api = createAccountApi('https://api.example', fetcher);
    const payments = vi.fn(); const overview = vi.fn(); const other = vi.fn();
    const unsubscribe = api.subscribePayments('teacher-a', payments);
    api.subscribePayments('teacher-b', other);
    api.subscribeOverview('teacher-a', overview);
    await api.createPackage('teacher-a', { requestId: 'create', enrollmentId: 'enrollment', title: '8 занятий', lessonCount: 8, amountMinor: 20000, currency: 'AZN' });
    await api.markPayment('teacher-a', 'package', { version: 1, paid: true });
    await api.reversePackageCharge('teacher-a', 'package', { requestId: 'reverse', version: 2, entryId: 'debit', reason: 'Ошибка списания' });
    expect(payments).toHaveBeenCalledTimes(3);
    expect(overview).toHaveBeenCalledTimes(3);
    expect(other).not.toHaveBeenCalled();
    await api.packageRecords('teacher-a', 'teacher');
    fetcher.mockResolvedValueOnce(json({ error: { code: 'conflict', message: 'Обновите пакет.' } }, 409));
    await expect(api.closePackage('teacher-a', 'package', { version: 1, reason: 'Завершение' })).rejects.toMatchObject({ status: 409 });
    expect(payments).toHaveBeenCalledTimes(3);
    unsubscribe();
    await api.closePackage('teacher-a', 'package', { version: 3, reason: 'Завершение' });
    expect(payments).toHaveBeenCalledTimes(3);
    expect(overview).toHaveBeenCalledTimes(4);
  });
});
