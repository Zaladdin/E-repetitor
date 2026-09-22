import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('invitation HTTP contract', () => {
  it('binds draft lists and all teacher mutations to the displayed account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'draft', status: 'pending' }));
    const api = createAccountApi('https://api.example', fetcher);
    const draft = { name: 'Новый ученик', email: 'student@example.test', subjectId: 'subject', noAccountConfirmed: true as const };
    await api.temporaryStudents('teacher', 50);
    await api.createTemporaryStudent('teacher', draft);
    await api.resendInvitation('teacher', 'draft/escaped');
    await api.revokeInvitation('teacher', 'draft/escaped');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example/temporary-students?limit=50&offset=50',
      'https://api.example/temporary-students',
      'https://api.example/temporary-students/draft%2Fescaped/resend',
      'https://api.example/temporary-students/draft%2Fescaped/revoke',
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options?.headers).toHaveProperty('X-Account-ID', 'teacher');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual(draft);
  });

  it('puts invitation secrets in POST bodies and never refreshes a public activation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: 'invitation_unavailable', message: 'Ссылка недоступна.' } }, 401));
    const api = createAccountApi('https://api.example', fetcher);
    await expect(api.previewInvitation('secret-preview')).rejects.toMatchObject({ code: 'invitation_unavailable' });
    const data = { token: 'secret-activation', name: 'Имя ученика', password: 'Test-password-2026', acceptTerms: true as const, acceptPrivacy: true as const, acceptEnrollment: true as const };
    await expect(api.activateInvitation(data)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://api.example/invitations/preview', 'https://api.example/invitations/activate']);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.method).toBe('POST');
      expect(options?.headers).not.toHaveProperty('X-Account-ID');
      expect(options?.headers).toHaveProperty('X-Requested-With', 'ERepetitor');
    }
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual(data);
  });

  it('drops an invitation-list response after the browser changes accounts', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const api = createAccountApi('https://api.example', fetcher);
    const pending = api.temporaryStudents('old-teacher');
    api.invalidatePendingRequests();
    complete(json({ items: [{ id: 'private-draft', email: 'private@example.test' }], total: 1 }));
    await expect(pending).rejects.toMatchObject({ code: 'STALE_SESSION' });
  });
});
