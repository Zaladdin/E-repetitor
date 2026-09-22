import { describe, expect, it, vi } from 'vitest';
import { TestAnswerAutosave } from './test-answer-autosave';
import type { AttemptMutation, TestAnswer } from './account-tests';

const answer = (text: string): TestAnswer[] => [{ questionId: 'q', text }];
const saved = (version: number): AttemptMutation => ({ id: 'a', status: 'started', version });

describe('serial test answer autosave', () => {
  it('serializes snapshots, uses acknowledged versions and flushes edits made during a request', async () => {
    let finish!: (value: AttemptMutation) => void;
    const save = vi.fn<(version: number, values: TestAnswer[]) => Promise<AttemptMutation>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(saved(9));
    const queue = new TestAnswerAutosave(7, [], save);
    queue.replace(answer('первый'));
    const pending = queue.flush();
    queue.replace(answer('последний'));
    const submitFlush = queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
    finish(saved(8));
    await Promise.all([pending, submitFlush]);
    expect(save.mock.calls).toEqual([[7, answer('первый')], [8, answer('последний')]]);
    expect(queue.version).toBe(9);
    expect(queue.dirty).toBe(false);
  });

  it('keeps unsaved answers and the last known version after an error, then retries', async () => {
    const failure = new Error('network');
    const save = vi.fn<(version: number, values: TestAnswer[]) => Promise<AttemptMutation>>()
      .mockRejectedValueOnce(failure).mockResolvedValueOnce(saved(2));
    const queue = new TestAnswerAutosave(1, [], save);
    queue.replace(answer('не потерять'));
    await expect(queue.flush()).rejects.toBe(failure);
    expect(queue.dirty).toBe(true);
    expect(queue.version).toBe(1);
    await queue.flush();
    expect(save.mock.calls).toEqual([[1, answer('не потерять')], [1, answer('не потерять')]]);
    expect(queue.dirty).toBe(false);
  });

  it('does not send unchanged answers and isolates snapshots from caller mutation', async () => {
    const save = vi.fn<(version: number, values: TestAnswer[]) => Promise<AttemptMutation>>().mockResolvedValue(saved(3));
    const initial = answer('сохранено');
    const queue = new TestAnswerAutosave(2, initial, save);
    initial[0]!.text = 'mutated';
    queue.replace(answer('сохранено'));
    await queue.flush();
    expect(save).not.toHaveBeenCalled();
    const edited = answer('новое'); queue.replace(edited); edited[0]!.text = 'mutated again';
    await queue.flush();
    expect(save).toHaveBeenCalledWith(2, answer('новое'));
  });

  it('stops queued follow-up writes after disposal without calling the server again', async () => {
    let finish!: (value: AttemptMutation) => void;
    const save = vi.fn<(version: number, values: TestAnswer[]) => Promise<AttemptMutation>>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const queue = new TestAnswerAutosave(1, [], save);
    queue.replace(answer('один')); const pending = queue.flush();
    queue.replace(answer('два')); queue.dispose(); finish(saved(2));
    await expect(pending).rejects.toThrow(/закрыт/);
    expect(save).toHaveBeenCalledTimes(1);
    await expect(queue.flush()).rejects.toThrow(/закрыт/);
  });

  it('flushes an edit immediately after an already-clean flush in the same turn', async () => {
    const save = vi.fn<(version: number, values: TestAnswer[]) => Promise<AttemptMutation>>().mockResolvedValue(saved(2));
    const queue = new TestAnswerAutosave(1, [], save);
    void queue.flush(); queue.replace(answer('новое'));
    await queue.flush();
    expect(save).toHaveBeenCalledWith(1, answer('новое'));
    expect(queue.dirty).toBe(false);
  });
});
