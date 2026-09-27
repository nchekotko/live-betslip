import { describe, expect, it } from 'vitest';
import type { DeltaMsg } from '@live-betslip/protocol';
import { Sequencer } from '../src/feed/sequencer';
import { backoffDelay } from '../src/feed/backoff';
import { FrameBatcher, type FrameScheduler } from '../src/feed/frameBatcher';

function d(seq: number): DeltaMsg {
  return { type: 'event_removed', seq, ts: 0, eventId: `e${seq}` };
}

function make() {
  const clock = { t: 0 };
  const s = new Sequencer({ gapTimeoutMs: 500, maxBuffer: 4 }, () => clock.t);
  return { s, clock };
}

describe('Sequencer', () => {
  it('applies contiguous deltas after a snapshot and drops duplicates / stale frames', () => {
    const { s } = make();
    s.reset(10);
    expect(s.push(d(11)).apply.map((x) => x.seq)).toEqual([11]);
    expect(s.push(d(11)).dropped).toBe('stale');
    expect(s.push(d(9)).dropped).toBe('stale');
    expect(s.push(d(12)).apply.map((x) => x.seq)).toEqual([12]);
    expect(s.stats.dropped).toBe(2);
    expect(s.lastSeq).toBe(12);
  });

  it('reorders a swapped pair inside the reorder window', () => {
    const { s } = make();
    s.reset(0);
    const r1 = s.push(d(2));
    expect(r1.apply).toEqual([]);
    expect(s.inGap).toBe(true);
    const r2 = s.push(d(1));
    expect(r2.apply.map((x) => x.seq)).toEqual([1, 2]);
    expect(s.inGap).toBe(false);
    expect(s.stats.reordered).toBe(1);
  });

  it('asks for a resync if a gap is not filled within the timeout', () => {
    const { s, clock } = make();
    s.reset(0);
    s.push(d(2));
    clock.t = 499;
    expect(s.shouldResync()).toBe(false);
    clock.t = 500;
    expect(s.shouldResync()).toBe(true);
    // Snapshot at seq 5 clears the gap and keeps nothing older.
    expect(s.reset(5)).toEqual([]);
    expect(s.shouldResync()).toBe(false);
  });

  it('requests a resync immediately on buffer overflow', () => {
    const { s } = make();
    s.reset(0);
    let need = false;
    for (let i = 2; i < 10; i++) need = s.push(d(i)).needResync || need;
    expect(need).toBe(true);
  });

  it('detects a lost tail frame through the heartbeat head seq', () => {
    const { s, clock } = make();
    s.reset(3);
    s.noteHead(4); // frame 4 was lost, nothing buffered
    expect(s.inGap).toBe(true);
    clock.t = 600;
    expect(s.shouldResync()).toBe(true);
  });

  it('buffers frames that arrive before the first snapshot and drains the tail', () => {
    const { s } = make();
    s.push(d(5));
    s.push(d(6));
    s.push(d(7));
    expect(s.reset(5).map((x) => x.seq)).toEqual([6, 7]);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially, is capped, and keeps half the window as a floor', () => {
    const opts = { baseMs: 500, maxMs: 8000 };
    expect(backoffDelay(0, () => 0, opts)).toBe(250);
    expect(backoffDelay(0, () => 1, opts)).toBe(500);
    expect(backoffDelay(3, () => 0, opts)).toBe(2000);
    expect(backoffDelay(3, () => 1, opts)).toBe(4000);
    expect(backoffDelay(20, () => 1, opts)).toBe(8000);
    expect(backoffDelay(20, () => 0, opts)).toBe(4000);
  });
});

describe('FrameBatcher', () => {
  it('flushes all items added within one frame in a single call', () => {
    const cbs: (() => void)[] = [];
    const scheduler: FrameScheduler = { request: (cb) => cbs.push(cb), cancel: () => {} };
    const flushed: number[][] = [];
    const b = new FrameBatcher<number>((items) => flushed.push(items), scheduler);
    b.add([1, 2]);
    b.add([3]);
    expect(cbs).toHaveLength(1);
    cbs[0]?.();
    expect(flushed).toEqual([[1, 2, 3]]);
    b.add([4]);
    b.clear();
    b.flush();
    expect(flushed).toHaveLength(1);
  });
});
