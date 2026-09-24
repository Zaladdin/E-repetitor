import { translate } from '@/lib/i18n';
import type { AttemptMutation, TestAnswer } from './account-tests';

/** One in-flight snapshot at a time. Flush also drains edits made while saving. */
export class TestAnswerAutosave {
  private current: TestAnswer[];
  private persisted: string;
  private pending: Promise<void> | null = null;
  private disposed = false;
  private revision: number;

  constructor(version: number, answers: TestAnswer[], private readonly save: (version: number, answers: TestAnswer[]) => Promise<AttemptMutation>) {
    this.revision = version;
    this.current = structuredClone(answers);
    this.persisted = JSON.stringify(this.current);
  }
  get version() { return this.revision; }
  get dirty() { return JSON.stringify(this.current) !== this.persisted; }
  get saving() { return this.pending !== null; }
  replace(answers: TestAnswer[]) {
    this.assertActive();
    this.current = structuredClone(answers);
  }
  dispose() { this.disposed = true; }

  flush(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(translate("Редактор ответов закрыт.")));
    if (this.pending) return this.pending;
    if (!this.dirty) return Promise.resolve();
    const pending = this.drain();
    this.pending = pending;
    // Clear on both success and failure without creating an unhandled rejected promise.
    void pending.then(() => { if (this.pending === pending) this.pending = null; }, () => { if (this.pending === pending) this.pending = null; });
    return pending;
  }
  private assertActive() { if (this.disposed) throw new Error(translate("Редактор ответов закрыт.")); }
  private async drain() {
    this.assertActive();
    while (this.dirty) {
      const snapshot = structuredClone(this.current);
      const result = await this.save(this.revision, snapshot);
      this.assertActive();
      this.revision = result.version;
      this.persisted = JSON.stringify(snapshot);
    }
  }
}
