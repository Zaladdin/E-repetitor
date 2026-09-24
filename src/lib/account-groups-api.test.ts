import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';
import type { CreateGroupInput } from './account-groups';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const input: CreateGroupInput = { requestId: 'request', name: 'Математика 9 класс', subjectId: 'subject', timezone: 'Asia/Baku', enrollmentIds: ['enrollment'], slots: [{ weekday: 1, startTime: '16:00', endTime: '17:30' }] };

describe('group account API', () => {
  it('binds group reads and weekly family schedules to the displayed account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [], total: 0 }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.groups('teacher-a', 20);
    await api.groupCandidates('teacher-a', 'subject/id', 50);
    await api.groupSchedule('parent-a', 'parent', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z', 50);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.example/groups?limit=20&offset=20');
    expect(fetcher.mock.calls[1][0]).toBe('https://api.example/groups/candidates?subjectId=subject%2Fid&limit=50&offset=50');
    const scheduleUrl = new URL(String(fetcher.mock.calls[2][0]));
    expect(scheduleUrl.searchParams.get('role')).toBe('parent');
    expect(scheduleUrl.searchParams.get('from')).toBe('2026-10-01T00:00:00Z');
    expect(fetcher.mock.calls[2][1]?.headers).toHaveProperty('X-Account-ID', 'parent-a');
  });

  it('preserves create request identity on authentication retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'Войдите.' } }, 401))
      .mockResolvedValueOnce(json({ message: 'ok' })).mockResolvedValueOnce(json({ id: 'group' }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.createGroup('teacher-a', input);
    for (const call of [fetcher.mock.calls[0], fetcher.mock.calls[2]]) {
      expect(call[1]).toMatchObject({ body: JSON.stringify(input), method: 'POST', credentials: 'include', headers: { 'X-Account-ID': 'teacher-a' } });
    }
  });

  it('sends optimistic versions and refreshes only the correct account after success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'group' }));
    const api = createAccountApi('https://api.example', fetcher);
    const changed = vi.fn(), other = vi.fn();
    api.subscribeOverview('teacher-a', changed); api.subscribeOverview('teacher-b', other);
    await api.updateGroup('teacher-a', 'group/id', { name: input.name, subjectId: input.subjectId, timezone: input.timezone, enrollmentIds: input.enrollmentIds, slots: input.slots, version: 2 });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.example/groups/group%2Fid');
    expect(fetcher.mock.calls[0][1]?.method).toBe('PATCH');
    await api.archiveGroup('teacher-a', 'group/id', 3);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ version: 3 });
    expect(changed).toHaveBeenCalledTimes(2); expect(other).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(json({ error: { code: 'stale_version', message: 'Обновите группу.' } }, 409));
    await expect(api.archiveGroup('teacher-a', 'group/id', 3)).rejects.toMatchObject({ status: 409 });
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
