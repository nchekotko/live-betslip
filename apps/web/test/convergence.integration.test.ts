// @vitest-environment node
/**
 * End-to-end robustness check without a browser: the real odds server with
 * aggressive chaos (duplicates, reordering, loss, forced disconnects) feeds the
 * real FeedClient + reducers. After the feed quiesces, the client state must
 * equal the server's authoritative snapshot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createOddsServer, type OddsServer } from '@live-betslip/odds-server/app';
import { defaultEngineConfig } from '@live-betslip/odds-server/engine';
import { FeedClient, type ConnectionStatus, type WebSocketLike } from '../src/feed/feedClient';
import { applyDeltas, applySnapshot, emptyFeed, type FeedData } from '../src/store/feedReducer';
import { Metrics } from '../src/telemetry/metrics';

let app: OddsServer;
let url: string;

beforeAll(async () => {
  app = createOddsServer({
    seed: 3,
    autoTick: false,
    heartbeatMs: 100,
    betDelayMs: 1,
    engine: { ...defaultEngineConfig, eventCount: 6, marketUpdateMeanMs: 40, simSecondsPerTick: 3, goalSuspendMs: 150 },
    chaos: { duplicateRate: 0.15, reorderRate: 0.15, gapRate: 0.02, disconnectMeanMs: 700 },
  });
  const port = await app.listen(0);
  url = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await app.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('feed convergence under chaos', () => {
  it('client state converges to the server snapshot', async () => {
    let state: FeedData = emptyFeed;
    let status = 'idle' as ConnectionStatus;
    const metrics = new Metrics();
    const client = new FeedClient({
      url,
      createSocket: (u) => new WebSocket(u) as unknown as WebSocketLike,
      scheduler: { request: (cb) => setTimeout(cb, 5) as unknown as number, cancel: (h) => clearTimeout(h) },
      backoff: { baseMs: 20, maxMs: 200 },
      gapTimeoutMs: 150,
      deadAfterMs: 2000,
      checkIntervalMs: 25,
      metrics,
      handlers: {
        onSnapshot: (m, now) => {
          state = applySnapshot(state, m, now);
        },
        onDeltas: (ds, now) => {
          state = applyDeltas(state, ds, now);
        },
        onStatus: (s) => {
          status = s;
        },
      },
    });
    client.start();

    // Drive the simulation for ~2.5 s of chaos.
    for (let i = 0; i < 125; i++) {
      app.engine.tick();
      await sleep(20);
    }
    // Quiesce: no new deltas, no more disconnects; let the client heal.
    app.hub.setChaos({ duplicateRate: 0, reorderRate: 0, gapRate: 0, disconnectMeanMs: 0 });
    for (let i = 0; i < 60 && !(status === 'live' && state.lastSeq === app.hub.headSeq); i++) await sleep(50);
    const finalStatus = status;
    client.stop();

    const snap = app.engine.snapshot();
    expect(finalStatus).toBe('live');
    expect(state.lastSeq).toBe(app.hub.headSeq);
    expect([...state.eventOrder].sort()).toEqual(snap.events.map((e) => e.id).sort());
    for (const m of snap.markets) {
      const cm = state.markets[m.id];
      expect(cm?.status, m.id).toBe(m.status);
      for (const s of m.selections) {
        expect(state.selections[s.id]?.price, s.id).toBe(s.price);
        expect(state.selections[s.id]?.priceVersion, s.id).toBe(s.priceVersion);
      }
    }
    const ms = metrics.snapshot();
    // The chaos actually happened and was handled.
    expect(ms.droppedDeltas).toBeGreaterThan(0);
    expect(ms.reconnects).toBeGreaterThan(0);
  }, 20_000);
});
