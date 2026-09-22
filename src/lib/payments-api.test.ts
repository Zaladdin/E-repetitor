import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';
import { parsePaymentAmount } from './account-payments';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('manual payments account client', () => {
  it('scopes filtered lists and private history to the current account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [], total: 0 }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.paymentRecords('parent-account', 'parent', 50, 'unpaid');
    await api.paymentRecords('student-account', 'student');
    await api.paymentHistory('teacher-account', 'record/1', 100);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.example/payment-records?role=parent&limit=50&offset=50&status=unpaid',
      'https://api.example/payment-records?role=student&limit=50&offset=0',
      'https://api.example/payment-records/record%2F1/history?limit=50&offset=100',
    ]);
    for (const [index, accountId] of ['parent-account', 'student-account', 'teacher-account'].entries()) {
      expect(fetcher.mock.calls[index]![1]).toMatchObject({ credentials: 'include', cache: 'no-store', headers: { 'X-Account-ID': accountId } });
    }
  });

  it('sends desired status and CAS unchanged when authentication refresh retries a mark', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 'unauthenticated', message: 'Войдите' } }, 401))
      .mockResolvedValueOnce(json({ message: 'ok' })).mockResolvedValueOnce(json({ id: 'p', paid: false, version: 3 }));
    const input = { version: 2, paid: false, reason: 'Ошибочная отметка' };
    await createAccountApi('https://api.example', fetcher).markPayment('teacher', 'p', input);
    for (const index of [0, 2]) expect(fetcher.mock.calls[index]).toEqual(['https://api.example/payment-records/p', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify(input), headers: expect.objectContaining({ 'X-Account-ID': 'teacher', 'X-Requested-With': 'ERepetitor' }),
    })]);
  });

  it('preserves creation key, integer amount and cancellation reason', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'p' }));
    const api = createAccountApi('https://api.example', fetcher);
    const input = { requestId: 'retry-key', enrollmentId: 'e', title: 'Сентябрь', amountMinor: 12005, currency: 'AZN' as const };
    await api.createPaymentRecord('teacher', input);
    await api.cancelPaymentRecord('teacher', 'p/1', { version: 4, reason: 'Запись создана дважды' });
    expect(fetcher.mock.calls.map(([url, options]) => [String(url), options!.method, JSON.parse(String(options!.body))])).toEqual([
      ['https://api.example/payment-records', 'POST', input],
      ['https://api.example/payment-records/p%2F1/cancel', 'POST', { version: 4, reason: 'Запись создана дважды' }],
    ]);
  });
});

describe('manual amount input', () => {
  it('converts dot or comma decimals to exact integer minor units', () => {
    expect(parsePaymentAmount('120,05')).toBe(12005);
    expect(parsePaymentAmount(' 0.29 ')).toBe(29);
    expect(parsePaymentAmount('1.1')).toBe(110);
    expect(parsePaymentAmount('9999999.99')).toBe(999999999);
    expect(parsePaymentAmount('')).toBeUndefined();
  });

  it('rejects rounding, zero, negative, overflow and nondecimal input', () => {
    for (const value of ['0', '0.00', '-2', '0.001', '10000000', '1e3', 'NaN', 'Infinity', '1,2.3', '1 000', '1.']) {
      expect(() => parsePaymentAmount(value), value).toThrow();
    }
  });
});
