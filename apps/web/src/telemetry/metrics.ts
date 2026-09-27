/**
 * Minimal client-side telemetry. Kept outside React on purpose: recording a
 * metric must never trigger a render. The debug panel polls `snapshot()`.
 *
 * WS lag = client receive time - server `ts`. Both processes run on the same
 * machine in the demo; across machines this includes clock skew (see README).
 */

export interface MetricsSnapshot {
  lagLastMs: number | null;
  lagP50Ms: number | null;
  lagP95Ms: number | null;
  messagesTotal: number;
  messagesPerSec: number;
  reconnects: number;
  resyncs: number;
  snapshots: number;
  invalidMessages: number;
  droppedDeltas: number;
  reorderedWindows: number;
  placementAttempts: number;
  priceChangedRejections: number;
  requotePrompts: number;
  /** Share of bet requests the server rejected with PRICE_CHANGED. */
  requoteRate: number | null;
  frames: number;
  avgBatchSize: number | null;
}

type Counter =
  | 'reconnects'
  | 'resyncs'
  | 'snapshots'
  | 'invalidMessages'
  | 'placementAttempts'
  | 'priceChangedRejections'
  | 'requotePrompts';

export class Metrics {
  private readonly lags: number[] = [];
  private lagIdx = 0;
  private lagLast: number | null = null;
  private counters: Record<Counter, number> = {
    reconnects: 0,
    resyncs: 0,
    snapshots: 0,
    invalidMessages: 0,
    placementAttempts: 0,
    priceChangedRejections: 0,
    requotePrompts: 0,
  };
  private messages = 0;
  private rate = 0;
  private rateMark: { t: number; n: number } | null = null;
  private frames = 0;
  private batchedItems = 0;
  private dropped = 0;
  private reordered = 0;

  constructor(
    private readonly capacity = 512,
    private readonly now: () => number = () => Date.now(),
  ) {}

  recordMessage(serverTs?: number): void {
    this.messages += 1;
    if (serverTs !== undefined) {
      const lag = Math.max(0, this.now() - serverTs);
      this.lagLast = lag;
      if (this.lags.length < this.capacity) this.lags.push(lag);
      else this.lags[this.lagIdx] = lag;
      this.lagIdx = (this.lagIdx + 1) % this.capacity;
    }
  }

  recordFrame(batchSize: number): void {
    this.frames += 1;
    this.batchedItems += batchSize;
  }

  setSequencerStats(stats: { dropped: number; reordered: number }): void {
    this.dropped = stats.dropped;
    this.reordered = stats.reordered;
  }

  inc(counter: Counter, by = 1): void {
    this.counters[counter] += by;
  }

  get(counter: Counter): number {
    return this.counters[counter];
  }

  reset(): void {
    this.lags.length = 0;
    this.lagIdx = 0;
    this.lagLast = null;
    for (const k of Object.keys(this.counters) as Counter[]) this.counters[k] = 0;
    this.messages = 0;
    this.rate = 0;
    this.rateMark = null;
    this.frames = 0;
    this.batchedItems = 0;
    this.dropped = 0;
    this.reordered = 0;
  }

  snapshot(): MetricsSnapshot {
    const t = this.now();
    if (this.rateMark) {
      const dt = (t - this.rateMark.t) / 1000;
      if (dt >= 0.5) {
        this.rate = (this.messages - this.rateMark.n) / dt;
        this.rateMark = { t, n: this.messages };
      }
    } else {
      this.rateMark = { t, n: this.messages };
    }
    const sorted = [...this.lags].sort((a, b) => a - b);
    const c = this.counters;
    return {
      lagLastMs: this.lagLast,
      lagP50Ms: percentile(sorted, 0.5),
      lagP95Ms: percentile(sorted, 0.95),
      messagesTotal: this.messages,
      messagesPerSec: Math.round(this.rate * 10) / 10,
      reconnects: c.reconnects,
      resyncs: c.resyncs,
      snapshots: c.snapshots,
      invalidMessages: c.invalidMessages,
      droppedDeltas: this.dropped,
      reorderedWindows: this.reordered,
      placementAttempts: c.placementAttempts,
      priceChangedRejections: c.priceChangedRejections,
      requotePrompts: c.requotePrompts,
      requoteRate: c.placementAttempts > 0 ? c.priceChangedRejections / c.placementAttempts : null,
      frames: this.frames,
      avgBatchSize: this.frames > 0 ? Math.round((this.batchedItems / this.frames) * 10) / 10 : null,
    };
  }
}

/** Nearest-rank percentile on a sorted array. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export const metrics = new Metrics();
