export class PackageDeadlineExceededError extends Error {
  constructor() {
    super('Scanner package analysis deadline exceeded');
    this.name = 'PackageDeadlineExceededError';
  }
}

export class PackageDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number) {
    this.deadlineAt = Date.now() + timeoutMs;
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(), timeoutMs);
    this.timer.unref?.();
  }

  get expired(): boolean {
    return this.signal.aborted || Date.now() >= this.deadlineAt;
  }

  remainingMs(): number {
    return Math.max(1, this.deadlineAt - Date.now());
  }

  throwIfExpired(): void {
    if (this.expired) throw new PackageDeadlineExceededError();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
