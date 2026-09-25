import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';
import type { AssignGroupTestInput } from './account-tests';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const groupInput: AssignGroupTestInput = {
  requestId: 'group-request', groupId: 'group-1', versionId: 'variant-b-version-2', maxAttempts: 3,
  answerPolicy: 'after_deadline', resultPolicy: 'after_submission', timeLimitMin: 40, dueAt: '2026-12-20T16:00:00Z',
};

describe('test family and group assignment API', () => {
  it('pages families and variants on the server and encodes variant identifiers', async () => {
    const page = { items: [], total: 0, limit: 50, offset: 50 };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(page));
    const api = createAccountApi('https://api.example', fetcher);
    await expect(api.testFamilies('teacher', 50)).resolves.toEqual(page);
    await expect(api.testVariants('teacher', 'variant/a&b', 50)).resolves.toEqual(page);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example/test-families?limit=50&offset=50',
      'https://api.example/tests/variant%2Fa%26b/variants?limit=50&offset=50',
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ headers: { 'X-Account-ID': 'teacher' }, cache: 'no-store', credentials: 'include' });
  });

  it('creates an independent variant from the selected source and preserves the retry key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'variant-c', familyId: 'family', variantCode: 'C' }));
    const api = createAccountApi('https://api.example', fetcher);
    const input = { requestId: 'copy-request', variantCode: 'C' };
    await expect(api.createTestVariant('teacher', 'variant/a', input)).resolves.toMatchObject({ id: 'variant-c', variantCode: 'C' });
    expect(fetcher).toHaveBeenCalledWith('https://api.example/tests/variant%2Fa/variants', expect.objectContaining({
      method: 'POST', body: JSON.stringify(input), headers: expect.objectContaining({ 'X-Account-ID': 'teacher' }),
    }));
  });

  it('assigns one selected immutable version to the group with independent result and answer release policies', async () => {
    const result = { groupId: 'group-1', groupName: 'Алгебра', total: 2, items: [{ id: 'assignment-a' }, { id: 'assignment-b' }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(result));
    const api = createAccountApi('https://api.example', fetcher);
    const changed = vi.fn(), other = vi.fn();
    api.subscribeOverview('teacher', changed); api.subscribeOverview('other', other);
    await expect(api.assignGroupTest('teacher', groupInput)).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledWith('https://api.example/test-group-assignments', expect.objectContaining({
      method: 'POST', body: JSON.stringify(groupInput), headers: expect.objectContaining({ 'X-Account-ID': 'teacher' }),
    }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).not.toHaveProperty('enrollmentId');
    expect(changed).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled();
  });

  it('does not announce a failed group assignment and preserves the retry payload', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: 'conflict', message: 'Нет активных участников.' } }, 409));
    const api = createAccountApi('https://api.example', fetcher);
    const changed = vi.fn(); api.subscribeOverview('teacher', changed);
    await expect(api.assignGroupTest('teacher', groupInput)).rejects.toMatchObject({ status: 409 });
    expect(changed).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]![1]!.body).toBe(JSON.stringify(groupInput));
  });

  it('also sends an explicit result release policy when assigning an individual', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'assignment' }));
    const api = createAccountApi('https://api.example', fetcher);
    const input = { requestId: 'individual-request', enrollmentId: 'enrollment', versionId: 'version', maxAttempts: 1, answerPolicy: 'never' as const, resultPolicy: 'after_teacher_publish' as const };
    await api.assignTest('teacher', input);
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.example/test-assignments');
    expect(fetcher.mock.calls[0]![1]!.body).toBe(JSON.stringify(input));
  });
});
