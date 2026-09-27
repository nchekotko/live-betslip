/**
 * Contract tests: run the real server on an ephemeral port and validate every
 * frame / response against the shared zod schemas from @live-betslip/protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AuditListResponse,
  ChaosState,
  OpsActionResponse,
  PlaceBetResponse,
  ServerMessage,
  type Market,
  type ServerMessage as ServerMessageT,
} from '@live-betslip/protocol';
import { createOddsServer, type OddsServer } from '../src/app';
import { defaultEngineConfig } from '../src/engine';

let app: OddsServer;
let base: string;
let wsUrl: string;

beforeAll(async () => {
  app = createOddsServer({
    seed: 1,
    tickMs: 20,
    heartbeatMs: 100,
    betDelayMs: 5,
    engine: { ...defaultEngineConfig, eventCount: 5, marketUpdateMeanMs: 50, simSecondsPerTick: 5 },
    chaos: { duplicateRate: 0, reorderRate: 0, gapRate: 0, disconnectMeanMs: 0 },
  });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await app.close();
});

interface Collected {
  raw: unknown[];
  parsed: ServerMessageT[];
  ws: WebSocket;
}

function collect(first: object, ms: number): Promise<Collected> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const raw: unknown[] = [];
    const parsed: ServerMessageT[] = [];
    ws.on('open', () => ws.send(JSON.stringify(first)));
    ws.on('message', (data) => {
      const obj: unknown = JSON.parse(String(data));
      raw.push(obj);
      const r = ServerMessage.safeParse(obj);
      if (r.success) parsed.push(r.data);
    });
    ws.on('error', reject);
    setTimeout(() => resolve({ raw, parsed, ws }), ms);
  });
}

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as unknown };
}

describe('WebSocket feed contract', () => {
  it('every frame matches ServerMessage; hello, snapshot, then gap-free deltas', async () => {
    const { raw, parsed, ws } = await collect({ type: 'subscribe', lastSeq: null }, 800);
    ws.close();
    expect(raw.length).toBeGreaterThan(5);
    for (const frame of raw) {
      const r = ServerMessage.safeParse(frame);
      expect(r.success, JSON.stringify(frame)).toBe(true);
    }
    expect(parsed[0]?.type).toBe('hello');
    const snap = parsed[1];
    expect(snap?.type).toBe('snapshot');
    if (snap?.type !== 'snapshot') return;
    let expected = snap.seq + 1;
    let deltas = 0;
    for (const m of parsed.slice(2)) {
      if (m.type === 'heartbeat' || m.type === 'hello' || m.type === 'snapshot' || m.type === 'error') continue;
      expect(m.seq).toBe(expected);
      expected += 1;
      deltas += 1;
    }
    expect(deltas).toBeGreaterThan(0);
  });

  it('resubscribe with lastSeq replays missed deltas instead of a snapshot', async () => {
    const first = await collect({ type: 'subscribe', lastSeq: null }, 300);
    first.ws.close();
    const snap = first.parsed.find((m) => m.type === 'snapshot');
    if (snap?.type !== 'snapshot') throw new Error('no snapshot');
    await new Promise((r) => setTimeout(r, 200));
    const second = await collect({ type: 'subscribe', lastSeq: snap.seq }, 300);
    second.ws.close();
    expect(second.parsed.some((m) => m.type === 'snapshot')).toBe(false);
    const firstDelta = second.parsed.find((m) => m.type !== 'hello' && m.type !== 'heartbeat');
    expect(firstDelta && 'seq' in firstDelta ? firstDelta.seq : -1).toBe(snap.seq + 1);
  });

  it('answers malformed client messages with an error frame', async () => {
    const { parsed, ws } = await collect({ type: 'subscribe', lastSeq: 'x' }, 200);
    ws.close();
    expect(parsed.some((m) => m.type === 'error' && m.code === 'BAD_MESSAGE')).toBe(true);
  });

  it('chaos duplicateRate produces repeated seqs that the client must drop', async () => {
    await fetch(`${base}/api/chaos`, { method: 'PUT', body: JSON.stringify({ duplicateRate: 0.5 }) });
    const { parsed, ws } = await collect({ type: 'subscribe', lastSeq: null }, 600);
    ws.close();
    await fetch(`${base}/api/chaos`, { method: 'PUT', body: JSON.stringify({ duplicateRate: 0 }) });
    const seqs = parsed.filter((m) => m.type !== 'heartbeat' && m.type !== 'snapshot' && 'seq' in m).map((m) => ('seq' in m ? m.seq : 0));
    expect(new Set(seqs).size).toBeLessThan(seqs.length);
  });
});

describe('REST contract', () => {
  function openMarket(): Market {
    const m = app.engine.snapshot().markets.find((x) => x.status === 'open');
    if (!m) throw new Error('no open market');
    return m;
  }

  it('POST /api/bets returns a PlaceBetResponse', async () => {
    const m = openMarket();
    const s = m.selections[0];
    if (!s) throw new Error('fixture');
    const r = await post('/api/bets', {
      idempotencyKey: 'contract-test-1',
      betType: 'single',
      stake: 5,
      legs: [{ marketId: m.id, selectionId: s.id, price: s.price, priceVersion: s.priceVersion }],
      acceptHigherOdds: true,
    });
    expect(r.status).toBe(200);
    expect(PlaceBetResponse.safeParse(r.body).success).toBe(true);
  });

  it('ops suspend/resume require a reason and are written to the audit trail', async () => {
    const m = openMarket();
    const bad = await post('/api/ops/suspend', { marketIds: [m.id], reason: '', actor: 'ops-1' });
    expect(bad.status).toBe(400);

    const ok = await post('/api/ops/suspend', { marketIds: [m.id], reason: 'suspicious volume', actor: 'ops-1' });
    expect(ok.status).toBe(200);
    const parsed = OpsActionResponse.parse(ok.body);
    expect(parsed.affected).toEqual([m.id]);
    expect(app.engine.getMarket(m.id)?.status).toBe('suspended');

    const resumed = OpsActionResponse.parse((await post('/api/ops/resume', { marketIds: [m.id], reason: 'volume verified', actor: 'ops-1' })).body);
    expect(resumed.affected).toEqual([m.id]);

    const audit = AuditListResponse.parse(await (await fetch(`${base}/api/ops/audit?actor=ops-1`)).json());
    expect(audit.entries.map((e) => e.action)).toEqual(['resume', 'suspend']);
  });

  it('GET/PUT /api/chaos round-trips a ChaosState and validates input', async () => {
    const state = ChaosState.parse(await (await fetch(`${base}/api/chaos`)).json());
    expect(state.frozenUntil).toBeNull();
    const bad = await fetch(`${base}/api/chaos`, { method: 'PUT', body: JSON.stringify({ gapRate: 5 }) });
    expect(bad.status).toBe(400);
  });
});
