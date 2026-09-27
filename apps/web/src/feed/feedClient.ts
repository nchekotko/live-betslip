/**
 * Resilient WebSocket client for the odds feed.
 *
 *  connect ──open──▶ send subscribe{lastSeq} ──▶ syncing
 *  syncing ──snapshot | replay+heartbeat──▶ live
 *  live ──gap not filled in time──▶ send resync ──▶ syncing
 *  any ──close/error/watchdog──▶ reconnecting ──backoff+jitter──▶ connect
 *
 * Every inbound frame is validated against the shared zod contract; invalid
 * frames are counted and dropped. Deltas pass through the Sequencer (dedupe,
 * reorder window, gap detection) and are flushed to the store once per frame.
 */
import { ServerMessage, isDelta, type DeltaMsg, type SnapshotMsg } from '@live-betslip/protocol';
import { metrics as defaultMetrics, type Metrics } from '../telemetry/metrics';
import { backoffDelay, defaultBackoff, type BackoffOptions } from './backoff';
import { FrameBatcher, rafScheduler, type FrameScheduler } from './frameBatcher';
import { Sequencer } from './sequencer';

export type ConnectionStatus = 'idle' | 'connecting' | 'syncing' | 'live' | 'reconnecting' | 'stopped';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface StatusInfo {
  attempt: number;
  nextRetryAt: number | null;
}

export interface FeedHandlers {
  onSnapshot: (msg: SnapshotMsg, receivedAt: number) => void;
  onDeltas: (deltas: DeltaMsg[], receivedAt: number) => void;
  onStatus: (status: ConnectionStatus, info: StatusInfo) => void;
  onHeartbeat?: (receivedAt: number, headSeq: number) => void;
}

export interface Timers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface FeedClientOptions {
  url: string;
  handlers: FeedHandlers;
  createSocket?: (url: string) => WebSocketLike;
  scheduler?: FrameScheduler;
  random?: () => number;
  now?: () => number;
  timers?: Timers;
  backoff?: BackoffOptions;
  /** How long to wait for a missing seq before asking for a snapshot. */
  gapTimeoutMs?: number;
  /** No frames at all for this long (heartbeats included) -> drop the socket. */
  deadAfterMs?: number;
  checkIntervalMs?: number;
  metrics?: Metrics;
}

const OPEN = 1;

export class FeedClient {
  private socket: WebSocketLike | null = null;
  private status: ConnectionStatus = 'idle';
  private attempt = 0;
  private stopped = true;
  private retryTimer: unknown = null;
  private watchdog: unknown = null;
  private resyncRequestedAt: number | null = null;
  private lastFrameAt = 0;
  readonly sequencer: Sequencer;
  private readonly batcher: FrameBatcher<DeltaMsg>;
  private readonly o: Required<Omit<FeedClientOptions, 'handlers' | 'url'>>;

  constructor(private readonly opts: FeedClientOptions) {
    this.o = {
      createSocket: opts.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike),
      scheduler: opts.scheduler ?? rafScheduler,
      random: opts.random ?? Math.random,
      now: opts.now ?? (() => Date.now()),
      timers: opts.timers ?? realTimers,
      backoff: opts.backoff ?? defaultBackoff,
      gapTimeoutMs: opts.gapTimeoutMs ?? 1000,
      deadAfterMs: opts.deadAfterMs ?? 8000,
      checkIntervalMs: opts.checkIntervalMs ?? 250,
      metrics: opts.metrics ?? defaultMetrics,
    };
    this.sequencer = new Sequencer({ gapTimeoutMs: this.o.gapTimeoutMs, maxBuffer: 256 }, this.o.now);
    this.batcher = new FrameBatcher<DeltaMsg>((items) => {
      this.o.metrics.recordFrame(items.length);
      this.opts.handlers.onDeltas(items, this.o.now());
    }, this.o.scheduler);
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchdog = this.o.timers.setInterval(() => this.check(), this.o.checkIntervalMs);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) this.o.timers.clearTimeout(this.retryTimer);
    if (this.watchdog !== null) this.o.timers.clearInterval(this.watchdog);
    this.retryTimer = null;
    this.watchdog = null;
    this.batcher.clear();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.setStatus('stopped', null);
  }

  /** Test/debug hook: drop the connection as if the network failed. */
  simulateDrop(): void {
    this.socket?.close();
  }

  private open(): void {
    if (this.stopped) return;
    this.retryTimer = null;
    this.setStatus('connecting', null);
    const socket = this.o.createSocket(this.opts.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.o.now();
      this.resyncRequestedAt = null;
      this.send({ type: 'subscribe', lastSeq: this.sequencer.lastSeq });
      this.setStatus('syncing', null);
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.onFrame(ev.data);
    };
    socket.onerror = () => {
      // onclose follows; nothing else to do here.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onClosed();
    };
  }

  private onClosed(): void {
    this.batcher.flush();
    if (this.stopped) return;
    this.o.metrics.inc('reconnects');
    const delay = backoffDelay(this.attempt, this.o.random, this.o.backoff);
    this.attempt += 1;
    this.setStatus('reconnecting', this.o.now() + delay);
    this.retryTimer = this.o.timers.setTimeout(() => this.open(), delay);
  }

  private onFrame(data: unknown): void {
    const receivedAt = this.o.now();
    let obj: unknown;
    try {
      obj = JSON.parse(String(data));
    } catch {
      this.o.metrics.inc('invalidMessages');
      return;
    }
    const parsed = ServerMessage.safeParse(obj);
    if (!parsed.success) {
      this.o.metrics.inc('invalidMessages');
      return;
    }
    const msg = parsed.data;
    this.lastFrameAt = receivedAt;

    if (isDelta(msg)) {
      this.o.metrics.recordMessage(msg.ts);
      const res = this.sequencer.push(msg);
      this.batcher.add(res.apply);
      this.o.metrics.setSequencerStats(this.sequencer.stats);
      if (res.needResync) this.requestResync();
      return;
    }
    switch (msg.type) {
      case 'snapshot': {
        this.o.metrics.recordMessage(msg.ts);
        this.o.metrics.inc('snapshots');
        this.batcher.clear();
        const follow = this.sequencer.reset(msg.seq);
        this.resyncRequestedAt = null;
        this.opts.handlers.onSnapshot(msg, receivedAt);
        this.batcher.add(follow);
        this.markLive();
        return;
      }
      case 'heartbeat': {
        this.o.metrics.recordMessage(msg.ts);
        this.sequencer.noteHead(msg.seq);
        this.opts.handlers.onHeartbeat?.(receivedAt, msg.seq);
        if (this.status === 'syncing' && this.sequencer.lastSeq !== null && !this.sequencer.inGap) this.markLive();
        return;
      }
      case 'hello':
        this.o.metrics.recordMessage();
        return;
      case 'error':
        console.warn(`feed error ${msg.code}: ${msg.message}`);
        return;
    }
  }

  private markLive(): void {
    this.attempt = 0;
    this.setStatus('live', null);
  }

  private requestResync(): void {
    if (this.resyncRequestedAt !== null) return;
    this.resyncRequestedAt = this.o.now();
    this.o.metrics.inc('resyncs');
    this.send({ type: 'resync' });
    this.setStatus('syncing', null);
  }

  private check(): void {
    if (this.stopped || !this.socket) return;
    const now = this.o.now();
    if (this.socket.readyState === OPEN && now - this.lastFrameAt > this.o.deadAfterMs) {
      // Half-open connection: nothing (not even heartbeats) for too long.
      this.socket.close();
      return;
    }
    if (this.resyncRequestedAt !== null && now - this.resyncRequestedAt > this.o.deadAfterMs) {
      this.socket.close();
      return;
    }
    if (this.sequencer.shouldResync()) this.requestResync();
  }

  private send(msg: { type: 'subscribe'; lastSeq: number | null } | { type: 'resync' }): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private setStatus(status: ConnectionStatus, nextRetryAt: number | null): void {
    this.status = status;
    this.opts.handlers.onStatus(status, { attempt: this.attempt, nextRetryAt });
  }
}
