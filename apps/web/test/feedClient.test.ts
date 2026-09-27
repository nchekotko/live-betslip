import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeltaMsg, ServerMessage, SnapshotMsg } from '@live-betslip/protocol';
import { FeedClient, type ConnectionStatus, type WebSocketLike } from '../src/feed/feedClient';
import type { FrameScheduler } from '../src/feed/frameBatcher';
import { Metrics } from '../src/telemetry/metrics';
import { snapshot } from './fixtures';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: ServerMessage | string) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
}

const syncScheduler: FrameScheduler = {
  request: (cb) => {
    queueMicrotask(cb);
    return 1;
  },
  cancel: () => {},
};

function price(seq: number, p = 2.2, v = seq): DeltaMsg {
  return { type: 'price', seq, ts: Date.now(), marketId: 'ev-1:1x2', selectionId: 'ev-1:1x2:home', price: p, priceVersion: v };
}

function setup() {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const snapshots: SnapshotMsg[] = [];
  const applied: number[] = [];
  const metrics = new Metrics();
  const client = new FeedClient({
    url: 'ws://test',
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    scheduler: syncScheduler,
    random: () => 0.5,
    backoff: { baseMs: 100, maxMs: 1000 },
    gapTimeoutMs: 300,
    deadAfterMs: 2000,
    checkIntervalMs: 50,
    metrics,
    handlers: {
      onSnapshot: (m) => snapshots.push(m),
      onDeltas: (ds) => applied.push(...ds.map((d) => d.seq)),
      onStatus: (s) => statuses.push(s),
    },
  });
  return { client, sockets, statuses, snapshots, applied, metrics };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FeedClient', () => {
  it('subscribes on open, goes live on snapshot and applies ordered deltas once', async () => {
    const t = setup();
    t.client.start();
    const s = t.sockets[0]!;
    s.open();
    expect(s.sent[0]).toEqual({ type: 'subscribe', lastSeq: null });
    s.receive(snapshot(10));
    expect(t.statuses.at(-1)).toBe('live');
    s.receive(price(12));
    s.receive(price(11));
    s.receive(price(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.applied).toEqual([11, 12]);
    expect(t.metrics.snapshot().droppedDeltas).toBe(1);
    t.client.stop();
  });

  it('drops frames that violate the contract', () => {
    const t = setup();
    t.client.start();
    const s = t.sockets[0]!;
    s.open();
    s.receive('not json');
    s.receive(JSON.stringify({ type: 'price', seq: 1 }));
    expect(t.metrics.snapshot().invalidMessages).toBe(2);
    t.client.stop();
  });

  it('requests a snapshot when a gap is not filled in time', async () => {
    const t = setup();
    t.client.start();
    const s = t.sockets[0]!;
    s.open();
    s.receive(snapshot(10));
    s.receive(price(12));
    await vi.advanceTimersByTimeAsync(400);
    expect(s.sent).toContainEqual({ type: 'resync' });
    expect(t.statuses.at(-1)).toBe('syncing');
    s.receive(snapshot(20));
    expect(t.statuses.at(-1)).toBe('live');
    expect(t.metrics.snapshot().resyncs).toBe(1);
    t.client.stop();
  });

  it('reconnects with backoff and resubscribes from lastSeq', async () => {
    const t = setup();
    t.client.start();
    const s1 = t.sockets[0]!;
    s1.open();
    s1.receive(snapshot(10));
    s1.receive(price(11));
    await vi.advanceTimersByTimeAsync(0);
    s1.close();
    expect(t.statuses.at(-1)).toBe('reconnecting');
    // attempt 0: 100ms window, random 0.5 -> 75ms
    await vi.advanceTimersByTimeAsync(74);
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(t.sockets).toHaveLength(2);
    const s2 = t.sockets[1]!;
    s2.close(); // fails before opening -> next attempt waits longer (200ms window -> 150ms)
    await vi.advanceTimersByTimeAsync(149);
    expect(t.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    const s3 = t.sockets[2]!;
    s3.open();
    expect(s3.sent[0]).toEqual({ type: 'subscribe', lastSeq: 11 });
    // Server replays 12 then heartbeat with head 12 -> live without a snapshot.
    s3.receive(price(12));
    s3.receive({ type: 'heartbeat', seq: 12, ts: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.statuses.at(-1)).toBe('live');
    expect(t.applied).toEqual([11, 12]);
    expect(t.metrics.snapshot().reconnects).toBe(2);
    t.client.stop();
  });

  it('drops a silent (half-open) connection after deadAfterMs', async () => {
    const t = setup();
    t.client.start();
    const s = t.sockets[0]!;
    s.open();
    s.receive(snapshot(1));
    await vi.advanceTimersByTimeAsync(2100);
    expect(s.readyState).toBe(3);
    expect(t.statuses).toContain('reconnecting');
    t.client.stop();
  });
});
