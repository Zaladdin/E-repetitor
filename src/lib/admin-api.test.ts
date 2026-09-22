import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';
import { adminStatusOptions, type AdminUser } from './account-admin';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe('admin client boundaries', () => {
  it('encodes search and target IDs, and binds every request to the displayed administrator', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [] }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.adminOverview('actor');
    await api.adminUsers('actor', { query: 'a+b@example.test&role=admin', role: 'student', status: 'active' }, 20);
    await api.adminUser('actor', 'target/1'); await api.adminAudit('actor', 'target/1', 20);
    const urls = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[1].searchParams.get('query')).toBe('a+b@example.test&role=admin');
    expect(urls[1].searchParams.get('role')).toBe('student'); expect(urls[1].searchParams.get('offset')).toBe('20');
    expect(urls[2].pathname).toBe('/admin/users/target%2F1'); expect(urls[3].searchParams.get('userId')).toBe('target/1');
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'include', cache: 'no-store', headers: { 'X-Account-ID': 'actor' } });
  });
  it('sends an explicit desired status, reason and version, never retries a conflict', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: 'stale_version', message: 'Обновите запись' } }, 409));
    const input = { status: 'suspended' as const, reason: 'Причина проверки', version: 7 };
    await expect(createAccountApi('https://api.example', fetcher).adminChangeStatus('actor', 'target', input)).rejects.toMatchObject({ code: 'stale_version' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual(['https://api.example/admin/users/target/status', expect.objectContaining({ method: 'POST', body: JSON.stringify(input), headers: expect.objectContaining({ 'X-Requested-With': 'ERepetitor' }) })]);
  });
  it('rejects responses after an account switch and preserves authorization errors', async () => {
    let complete!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const api = createAccountApi('https://api.example', fetcher);
    const request = api.adminUser('old', 'target'); api.invalidatePendingRequests(); complete(json({ user: { name: 'PRIVATE' } }));
    await expect(request).rejects.toMatchObject({ code: 'STALE_SESSION' });
    fetcher.mockResolvedValueOnce(json({ error: { code: 'admin_required', message: 'Нет доступа' } }, 403));
    await expect(api.adminOverview('new')).rejects.toMatchObject({ status: 403, code: 'admin_required' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never offers self/admin changes or activation of an unverified or terminal account', () => {
    const user = { id: 'target', status: 'active', isAdmin: false } as AdminUser;
    expect(adminStatusOptions(user, 'actor')).toEqual(['suspended', 'deactivated']);
    expect(adminStatusOptions(user, 'target')).toEqual([]);
    expect(adminStatusOptions({ ...user, isAdmin: true }, 'actor')).toEqual([]);
    expect(adminStatusOptions({ ...user, status: 'suspended' }, 'actor')).toEqual(['active', 'deactivated']);
    expect(adminStatusOptions({ ...user, status: 'pending_verification' }, 'actor')).toEqual(['deactivated']);
    for (const status of ['deactivated', 'deleted'] as const) expect(adminStatusOptions({ ...user, status }, 'actor')).toEqual([]);
  });
});
