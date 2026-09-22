import { describe, expect, it, vi } from 'vitest';
import { createAccountApi } from './account-api';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('tests account client', () => {
  it('scopes paged reads and attempt details to the chosen role and account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [], total: 0 }));
    const api = createAccountApi('https://api.example', fetcher);
    await api.tests('account-a', 50);
    await api.test('account-a', 'test/1');
    await api.testVersions('account-a', 'test/1', 100);
    await api.testVersion('account-a', 'version/1');
    await api.testAssignments('account-a', 'parent', 50);
    await api.testAttempt('account-a', 'attempt/1', 'student');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.example/tests?limit=50&offset=50', 'https://api.example/tests/test%2F1',
      'https://api.example/tests/test%2F1/versions?limit=50&offset=100', 'https://api.example/test-versions/version%2F1',
      'https://api.example/test-assignments?role=parent&limit=50&offset=50', 'https://api.example/attempts/attempt%2F1?role=student',
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'include', cache: 'no-store', headers: { 'X-Account-ID': 'account-a' } });
  });

  it('keeps answers and optimistic version intact when refresh retries autosave', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 'unauthenticated', message: 'Войдите' } }, 401))
      .mockResolvedValueOnce(json({ message: 'ok' })).mockResolvedValueOnce(json({ id: 'a', status: 'started', version: 8 }));
    const answers = [{ questionId: 'q', text: 'Мой ответ' }];
    await createAccountApi('https://api.example', fetcher).saveTestAnswers('account-a', 'a', 7, answers);
    for (const index of [0, 2]) expect(fetcher.mock.calls[index]).toEqual(['https://api.example/attempts/a/answers', expect.objectContaining({ method: 'PATCH',
      body: JSON.stringify({ version: 7, answers }), headers: expect.objectContaining({ 'X-Requested-With': 'ERepetitor', 'X-Account-ID': 'account-a' }),
    })]);
  });

  it('preserves retry keys, versions and review inputs across mutation routes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ id: 'a', status: 'completed', version: 2 }));
    const api = createAccountApi('https://api.example', fetcher);
    const draft = { title: 'Алгебра', questions: [] };
    const create = { ...draft, subjectId: 's', requestId: 'create-key' };
    const assignment = { versionId: 'v', enrollmentId: 'e', requestId: 'assign-key', maxAttempts: 2, answerPolicy: 'never' as const };
    const review = { version: 5, grades: [{ questionId: 'q', points: 0.5, comment: 'Верное начало' }], comment: 'Продолжайте' };
    await api.createTest('account-a', create);
    await api.saveTest('account-a', 't', { ...draft, revision: 3 });
    await api.publishTest('account-a', 't', 4);
    await api.archiveTest('account-a', 't', 5);
    await api.assignTest('account-a', assignment);
    await api.startTestAttempt('account-a', 'assignment', 'start-key');
    await api.submitTestAttempt('account-a', 'a', 2);
    await api.abandonTestAttempt('account-a', 'a', 2);
    await api.reviewTestAttempt('account-a', 'a', review);
    await api.publishTestResult('account-a', 'a', 6);
    expect(fetcher.mock.calls.map(([url, options]) => [String(url).replace('https://api.example', ''), options!.method, JSON.parse(String(options!.body))])).toEqual([
      ['/tests', 'POST', create], ['/tests/t', 'PATCH', { ...draft, revision: 3 }], ['/tests/t/publish', 'POST', { revision: 4 }], ['/tests/t/archive', 'POST', { revision: 5 }],
      ['/test-assignments', 'POST', assignment], ['/test-assignments/assignment/attempts', 'POST', { requestId: 'start-key' }],
      ['/attempts/a/submit', 'POST', { version: 2 }], ['/attempts/a/abandon', 'POST', { version: 2 }],
      ['/attempts/a/review', 'POST', review], ['/attempts/a/publish-result', 'POST', { version: 6 }],
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options!.headers).toMatchObject({ 'X-Account-ID': 'account-a', 'X-Requested-With': 'ERepetitor' });
  });
});
