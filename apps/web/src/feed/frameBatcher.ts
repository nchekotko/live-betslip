/**
 * Collects items and flushes them once per animation frame. A burst of 200
 * WebSocket deltas therefore costs one store update and one React commit.
 */
export interface FrameScheduler {
  request: (cb: () => void) => number;
  cancel: (handle: number) => void;
}

export const rafScheduler: FrameScheduler = {
  request: (cb) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => cb()) : (setTimeout(cb, 16) as unknown as number),
  cancel: (h) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h)),
};

export class FrameBatcher<T> {
  private items: T[] = [];
  private handle: number | null = null;

  constructor(
    private readonly flushFn: (items: T[]) => void,
    private readonly scheduler: FrameScheduler = rafScheduler,
  ) {}

  get pending(): number {
    return this.items.length;
  }

  add(items: readonly T[]): void {
    if (items.length === 0) return;
    this.items.push(...items);
    if (this.handle === null) this.handle = this.scheduler.request(() => this.flush());
  }

  flush(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
    if (this.items.length === 0) return;
    const batch = this.items;
    this.items = [];
    this.flushFn(batch);
  }

  /** Discard pending items (used when a snapshot supersedes them). */
  clear(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
    this.items = [];
  }
}
