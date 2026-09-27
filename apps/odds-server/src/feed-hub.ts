/**
 * Fan-out of sequenced deltas to WebSocket clients.
 *
 * Server-side the feed is gap-free: every delta gets seq = previous + 1 and is
 * kept in a ring buffer so that a reconnecting client can be replayed from its
 * `lastSeq` instead of receiving a full snapshot.
 *
 * The chaos layer is applied per client, *after* sequencing, to emulate what a
 * real network/upstream does to a feed: duplicates, reordering, loss, stalls
 * and dropped connections.
 */
import { randomUUID } from 'node:crypto';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessage,
  PROTOCOL_VERSION,
  type ChaosConfig,
  type ChaosState,
  type ChaosUpdate,
  type DeltaMsg,
  type ServerMessage,
  type SnapshotMsg,
} from '@live-betslip/protocol';
import type { DeltaPayload } from './engine';
import { exponential, type Rng } from './rng';

export interface FeedHubOptions {
  now: () => number;
  rng: Rng;
  heartbeatMs: number;
  replayBufferSize: number;
  chaos: ChaosConfig;
  snapshot: () => Omit<SnapshotMsg, 'type' | 'seq' | 'ts'>;
}

interface Client {
  id: string;
  socket: WebSocket;
  subscribed: boolean;
  heldBack: string | null;
  disconnectTimer: NodeJS.Timeout | null;
}

export class FeedHub {
  private seq = 0;
  private readonly buffer: { seq: number; frame: string }[] = [];
  private readonly clients = new Set<Client>();
  private chaos: ChaosConfig;
  private frozenUntil: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: FeedHubOptions) {
    this.chaos = { ...opts.chaos };
  }

  get headSeq(): number {
    return this.seq;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  attach(wss: WebSocketServer): void {
    wss.on('connection', (socket) => this.onConnection(socket));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const c of this.clients) {
      if (c.disconnectTimer) clearTimeout(c.disconnectTimer);
      c.socket.terminate();
    }
    this.clients.clear();
  }

  /** Assigns the next seq, stores the frame for replay and fans it out. */
  publish(delta: DeltaPayload): DeltaMsg {
    this.seq += 1;
    const msg = { ...delta, seq: this.seq, ts: Math.floor(this.opts.now()) } as DeltaMsg;
    const frame = JSON.stringify(msg);
    this.buffer.push({ seq: msg.seq, frame });
    if (this.buffer.length > this.opts.replayBufferSize) this.buffer.shift();
    for (const c of this.clients) {
      if (c.subscribed) this.deliver(c, frame);
    }
    return msg;
  }

  snapshotMessage(): SnapshotMsg {
    return { type: 'snapshot', seq: this.seq, ts: Math.floor(this.opts.now()), ...this.opts.snapshot() };
  }

  getChaos(): ChaosState {
    const frozen = this.frozenUntil !== null && this.frozenUntil > this.opts.now();
    return { ...this.chaos, frozenUntil: frozen ? this.frozenUntil : null };
  }

  setChaos(update: ChaosUpdate): ChaosState {
    const { freezeForMs, ...rest } = update;
    const prevDisconnect = this.chaos.disconnectMeanMs;
    this.chaos = { ...this.chaos, ...rest };
    if (freezeForMs !== undefined) {
      this.frozenUntil = freezeForMs > 0 ? this.opts.now() + freezeForMs : null;
    }
    if (this.chaos.disconnectMeanMs !== prevDisconnect) {
      for (const c of this.clients) this.scheduleDisconnect(c);
    }
    return this.getChaos();
  }

  // ------------------------------------------------------------------ internals

  private isFrozen(): boolean {
    return this.frozenUntil !== null && this.opts.now() < this.frozenUntil;
  }

  private onConnection(socket: WebSocket): void {
    const client: Client = { id: randomUUID(), socket, subscribed: false, heldBack: null, disconnectTimer: null };
    this.clients.add(client);
    this.send(client, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: client.id,
      serverTime: Math.floor(this.opts.now()),
      heartbeatMs: this.opts.heartbeatMs,
    });
    this.scheduleDisconnect(client);

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        this.send(client, { type: 'error', code: 'BAD_JSON', message: 'message is not valid JSON' });
        return;
      }
      const result = ClientMessage.safeParse(parsed);
      if (!result.success) {
        this.send(client, { type: 'error', code: 'BAD_MESSAGE', message: result.error.message });
        return;
      }
      const msg = result.data;
      if (msg.type === 'subscribe') this.subscribe(client, msg.lastSeq);
      else this.sendSnapshot(client);
    });
    socket.on('close', () => {
      if (client.disconnectTimer) clearTimeout(client.disconnectTimer);
      this.clients.delete(client);
    });
    socket.on('error', () => socket.terminate());
  }

  private subscribe(client: Client, lastSeq: number | null): void {
    client.heldBack = null;
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    const canReplay = lastSeq !== null && lastSeq <= this.seq && lastSeq + 1 >= oldest;
    if (canReplay) {
      // Replay is sent verbatim, without chaos: it is the recovery path.
      for (const entry of this.buffer) {
        if (entry.seq > lastSeq) this.sendRaw(client, entry.frame);
      }
      client.subscribed = true;
      this.send(client, { type: 'heartbeat', seq: this.seq, ts: Math.floor(this.opts.now()) });
    } else {
      this.sendSnapshot(client);
    }
  }

  private sendSnapshot(client: Client): void {
    client.heldBack = null;
    client.subscribed = true;
    this.send(client, this.snapshotMessage());
  }

  private deliver(client: Client, frame: string): void {
    if (this.isFrozen()) return;
    const { rng } = this.opts;
    if (rng() < this.chaos.gapRate) return; // lost on the wire
    if (client.heldBack !== null) {
      // Previously held frame goes out *after* this one: out-of-order delivery.
      this.sendRaw(client, frame);
      this.sendRaw(client, client.heldBack);
      client.heldBack = null;
      return;
    }
    if (rng() < this.chaos.reorderRate) {
      client.heldBack = frame;
      return;
    }
    this.sendRaw(client, frame);
    if (rng() < this.chaos.duplicateRate) this.sendRaw(client, frame);
  }

  private heartbeat(): void {
    if (this.isFrozen()) return;
    for (const c of this.clients) {
      if (!c.subscribed) continue;
      if (c.heldBack !== null) {
        this.sendRaw(c, c.heldBack);
        c.heldBack = null;
      }
      this.send(c, { type: 'heartbeat', seq: this.seq, ts: Math.floor(this.opts.now()) });
    }
  }

  private scheduleDisconnect(client: Client): void {
    if (client.disconnectTimer) clearTimeout(client.disconnectTimer);
    client.disconnectTimer = null;
    const mean = this.chaos.disconnectMeanMs;
    if (mean <= 0) return;
    const wait = Math.max(1000, exponential(this.opts.rng, mean));
    client.disconnectTimer = setTimeout(() => client.socket.terminate(), wait);
  }

  private send(client: Client, msg: ServerMessage): void {
    this.sendRaw(client, JSON.stringify(msg));
  }

  private sendRaw(client: Client, frame: string): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(frame);
  }
}
