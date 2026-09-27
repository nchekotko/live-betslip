/**
 * Orders sequenced feed deltas and decides when state can no longer be trusted.
 *
 *  seq <= lastSeq            -> duplicate or late (out-of-order) frame: drop
 *  seq == lastSeq + 1        -> apply, then drain any buffered successors
 *  seq >  lastSeq + 1        -> gap: buffer and wait up to `gapTimeoutMs`
 *                               for the missing frames (short reorder window)
 *  gap not filled in time,
 *  or buffer overflow        -> needResync (client asks for a snapshot)
 *
 * The heartbeat carries the server head seq, so a lost *last* frame is also
 * detected (head > lastSeq with nothing buffered).
 */
import type { DeltaMsg } from '@live-betslip/protocol';

export interface SequencerOptions {
  gapTimeoutMs: number;
  maxBuffer: number;
}

export interface PushResult {
  apply: DeltaMsg[];
  dropped: 'duplicate' | 'stale' | null;
  needResync: boolean;
}

export interface SequencerStats {
  applied: number;
  /** Frames with seq <= lastSeq (duplicates or late arrivals) plus buffered duplicates. */
  dropped: number;
  /** Times a reorder window was closed by a late frame without needing a resync. */
  reordered: number;
  gaps: number;
}

export class Sequencer {
  private last: number | null = null;
  private readonly buffer = new Map<number, DeltaMsg>();
  private gapSince: number | null = null;
  private head = 0;
  readonly stats: SequencerStats = { applied: 0, dropped: 0, reordered: 0, gaps: 0 };

  constructor(
    private readonly opts: SequencerOptions = { gapTimeoutMs: 1000, maxBuffer: 256 },
    private readonly now: () => number = () => Date.now(),
  ) {}

  get lastSeq(): number | null {
    return this.last;
  }

  get buffered(): number {
    return this.buffer.size;
  }

  get inGap(): boolean {
    return this.gapSince !== null;
  }

  /** Called with the seq of an authoritative snapshot. Returns buffered deltas that follow it. */
  reset(seq: number): DeltaMsg[] {
    this.last = seq;
    this.head = Math.max(this.head, seq);
    for (const k of this.buffer.keys()) if (k <= seq) this.buffer.delete(k);
    this.gapSince = null;
    return this.drain();
  }

  /** Forget position entirely (e.g. protocol reset). */
  clear(): void {
    this.last = null;
    this.buffer.clear();
    this.gapSince = null;
    this.head = 0;
  }

  push(msg: DeltaMsg): PushResult {
    this.head = Math.max(this.head, msg.seq);
    if (this.last === null) {
      // Not synced yet (waiting for snapshot): keep a bounded backlog.
      if (this.buffer.size < this.opts.maxBuffer) this.buffer.set(msg.seq, msg);
      return { apply: [], dropped: null, needResync: false };
    }
    if (msg.seq <= this.last) {
      this.stats.dropped += 1;
      return { apply: [], dropped: 'stale', needResync: false };
    }
    if (this.buffer.has(msg.seq)) {
      this.stats.dropped += 1;
      return { apply: [], dropped: 'duplicate', needResync: false };
    }
    this.buffer.set(msg.seq, msg);
    const hadGap = this.gapSince !== null;
    const apply = this.drain();
    if (hadGap && apply.length > 1) this.stats.reordered += 1;
    if (this.buffer.size > this.opts.maxBuffer) {
      return { apply, dropped: null, needResync: true };
    }
    return { apply, dropped: null, needResync: false };
  }

  /** Heartbeat with the server head seq. */
  noteHead(seq: number): void {
    this.head = Math.max(this.head, seq);
    if (this.last !== null && this.head > this.last && this.gapSince === null) {
      this.gapSince = this.now();
      this.stats.gaps += 1;
    }
  }

  /** Periodic check: true if a gap has been open longer than the reorder window. */
  shouldResync(): boolean {
    return this.gapSince !== null && this.now() - this.gapSince >= this.opts.gapTimeoutMs;
  }

  private drain(): DeltaMsg[] {
    const out: DeltaMsg[] = [];
    if (this.last === null) return out;
    for (;;) {
      const next = this.buffer.get(this.last + 1);
      if (!next) break;
      this.buffer.delete(next.seq);
      this.last = next.seq;
      out.push(next);
    }
    this.stats.applied += out.length;
    const gapOpen = this.buffer.size > 0 || this.head > this.last;
    if (gapOpen && this.gapSince === null) {
      this.gapSince = this.now();
      this.stats.gaps += 1;
    } else if (!gapOpen) {
      this.gapSince = null;
    }
    return out;
  }
}
