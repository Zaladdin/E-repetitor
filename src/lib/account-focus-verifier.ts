interface VerificationCallbacks<T> {
  checking: (value: boolean) => void;
  result: (account: T | null, expectedId: string) => void;
  error: (failure: unknown) => void;
}

/** Soft verification must not unmount drafts or invalidate unrelated in-flight saves. */
export class AccountFocusVerifier<T> {
  private generation = 0;
  private pending: Promise<void> | null = null;

  constructor(private readonly fetch: () => Promise<T | null>, private readonly callbacks: VerificationCallbacks<T>) {}

  check(expectedId: string): Promise<void> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.callbacks.checking(true);
    const request = async () => {
      try {
        const account = await this.fetch();
        if (generation === this.generation) this.callbacks.result(account, expectedId);
      } catch (failure) {
        if (generation === this.generation) this.callbacks.error(failure);
      } finally {
        if (generation === this.generation) { this.pending = null; this.callbacks.checking(false); }
      }
    };
    this.pending = request();
    return this.pending;
  }

  invalidate() { this.generation += 1; this.pending = null; }
}
