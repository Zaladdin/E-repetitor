import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('lesson HTTP client', () => {
  it('encodes date offsets and explicitly scopes the role and pages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [], total: 0 }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.lessons('account-a', 'parent', '2026-09-21T00:00:00+04:00', '2026-09-28T00:00:00+04:00', 50);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe('/lessons');
    expect(Object.fromEntries(url.searchParams)).toEqual({ role: 'parent', from: '2026-09-21T00:00:00+04:00', to: '2026-09-28T00:00:00+04:00', limit: '50', offset: '50' });
    await api.lessonHistory('account-a', 'lesson/id', 100);
    expect(fetcher.mock.calls[1]![0]).toBe('https://api.example/lessons/lesson%2Fid/history?limit=50&offset=100');
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'include', cache: 'no-store', headers: { 'X-Account-ID': 'account-a' } });
  });

  it('keeps the booking idempotency key and account binding through session refresh', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'UNAUTHORIZED', message: 'Войдите.' } }, 401))
      .mockResolvedValueOnce(json({ message: 'ok' }))
      .mockResolvedValueOnce(json({ id: 'lesson-1', status: 'scheduled', version: 1 }));
    const input = { enrollmentId: 'enrollment-1', requestId: crypto.randomUUID(), startsAt: '2026-09-22T14:00:00Z', durationMin: 60, format: 'online' as const };
    await createAccountApi('https://api.example', fetcher).createLesson('account-a', input);
    for (const index of [0, 2]) expect(fetcher.mock.calls[index]).toEqual(['https://api.example/lessons', expect.objectContaining({
      method: 'POST', body: JSON.stringify(input), headers: expect.objectContaining({ 'X-Account-ID': 'account-a', 'X-Requested-With': 'ERepetitor' }),
    })]);
  });

  it('sends versioned cancellation, rescheduling and attendance with their intended verbs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'lesson-1', status: 'scheduled', version: 2 }));
    const api = createAccountApi('https://api.example', fetcher);
    const cancel = { status: 'student_cancelled' as const, reason: 'Ученик заболел', version: 1 };
    const reschedule = { startsAt: '2026-09-24T14:00:00Z', durationMin: 90, reason: 'По просьбе ученика', version: 2 };
    const attendance = { status: 'present' as const, comment: 'Пришёл', correctionReason: 'Исправление отметки', version: 3 };
    await api.cancelLesson('account-a', 'lesson-1', cancel);
    await api.rescheduleLesson('account-a', 'lesson-1', reschedule);
    await api.markAttendance('account-a', 'lesson-1', attendance);
    expect(fetcher.mock.calls.map(([url, options]) => [String(url), options!.method, JSON.parse(String(options!.body))])).toEqual([
      ['https://api.example/lessons/lesson-1', 'PATCH', cancel],
      ['https://api.example/lessons/lesson-1/reschedule', 'POST', reschedule],
      ['https://api.example/lessons/lesson-1/attendance', 'POST', attendance],
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options!.headers).toMatchObject({ 'X-Account-ID': 'account-a', 'X-Requested-With': 'ERepetitor' });
  });
});
