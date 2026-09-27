/**
 * Wires engine + feed hub + bet service + REST into one HTTP server.
 * `createOddsServer` is used by main.ts and by the contract tests.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
  AuditAction,
  ChaosUpdate,
  OpsActionRequest,
  type ChaosConfig,
  type OpsActionResponse,
} from '@live-betslip/protocol';
import { AuditLog } from './audit';
import { BetService } from './bet-service';
import { defaultEngineConfig, OddsEngine, type EngineConfig } from './engine';
import { FeedHub } from './feed-hub';
import { mulberry32 } from './rng';

export interface ServerConfig {
  seed: number;
  tickMs: number;
  heartbeatMs: number;
  betDelayMs: number;
  replayBufferSize: number;
  engine: EngineConfig;
  chaos: ChaosConfig;
  /** Start the simulation ticker on listen (tests may drive ticks manually). */
  autoTick: boolean;
}

export const defaultServerConfig: ServerConfig = {
  seed: 42,
  tickMs: 500,
  heartbeatMs: 1000,
  betDelayMs: 1200,
  replayBufferSize: 5000,
  engine: defaultEngineConfig,
  chaos: { duplicateRate: 0.02, reorderRate: 0.02, gapRate: 0.002, disconnectMeanMs: 0 },
  autoTick: true,
};

const MAX_BODY = 64 * 1024;

export function createOddsServer(partial: Partial<ServerConfig> = {}) {
  const config: ServerConfig = { ...defaultServerConfig, ...partial };
  const now = () => Date.now();
  const rng = mulberry32(config.seed);
  const audit = new AuditLog(now);

  // The engine emits deltas into the hub; the hub is created right after.
  let hub: FeedHub | null = null;
  const engine = new OddsEngine(config.engine, {
    rng,
    now,
    emit: (d) => hub?.publish(d),
    audit: (e) => audit.append(e),
  });
  engine.init();

  hub = new FeedHub({
    now,
    rng: mulberry32(config.seed + 1),
    heartbeatMs: config.heartbeatMs,
    replayBufferSize: config.replayBufferSize,
    chaos: config.chaos,
    snapshot: () => engine.snapshot(),
  });
  const feed = hub;

  const bets = new BetService(engine, { delayMs: config.betDelayMs, now, newId: () => `bet-${randomUUID()}` });

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      console.error('request failed', err);
      if (!res.headersSent) json(res, 500, { error: 'INTERNAL', message: 'internal error' });
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, { ok: true, seq: feed.headSeq, clients: feed.clientCount, bets: bets.stats() });
    }
    if (req.method === 'POST' && path === '/api/bets') {
      const body = await readJson(req);
      if (body === INVALID) return json(res, 400, { error: 'BAD_JSON', message: 'body must be JSON' });
      const result = await bets.place(body);
      return json(res, result.status, result.body);
    }
    const betMatch = /^\/api\/bets\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && betMatch?.[1]) {
      const bet = bets.getBet(decodeURIComponent(betMatch[1]));
      return bet ? json(res, 200, bet) : json(res, 404, { error: 'NOT_FOUND', message: 'bet not found' });
    }
    const opsMatch = /^\/api\/ops\/(suspend|resume)$/.exec(path);
    if (req.method === 'POST' && opsMatch?.[1]) {
      const action = opsMatch[1] as 'suspend' | 'resume';
      const body = await readJson(req);
      const parsed = OpsActionRequest.safeParse(body === INVALID ? null : body);
      if (!parsed.success) {
        return json(res, 400, { error: 'VALIDATION_ERROR', message: 'invalid ops request', details: parsed.error.issues });
      }
      const { marketIds, reason, actor } = parsed.data;
      const r = action === 'suspend' ? engine.opsSuspend(marketIds, reason, actor) : engine.opsResume(marketIds, reason, actor);
      const entry = audit.append({ actor, action, marketIds: r.affected, reason });
      const response: OpsActionResponse = { auditId: entry.id, action, affected: r.affected, skipped: r.skipped };
      return json(res, 200, response);
    }
    if (req.method === 'GET' && path === '/api/ops/audit') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
      const actionParam = AuditAction.safeParse(url.searchParams.get('action'));
      const actor = url.searchParams.get('actor') ?? undefined;
      return json(res, 200, {
        entries: audit.list(limit, { actor, action: actionParam.success ? actionParam.data : undefined }),
      });
    }
    if (path === '/api/chaos') {
      if (req.method === 'GET') return json(res, 200, feed.getChaos());
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const parsed = ChaosUpdate.safeParse(body === INVALID ? null : body);
        if (!parsed.success) {
          return json(res, 400, { error: 'VALIDATION_ERROR', message: 'invalid chaos config', details: parsed.error.issues });
        }
        return json(res, 200, feed.setChaos(parsed.data));
      }
    }
    return json(res, 404, { error: 'NOT_FOUND', message: `${req.method} ${path} not found` });
  }

  const wss = new WebSocketServer({ server, path: '/ws' });
  feed.attach(wss);

  let ticker: NodeJS.Timeout | null = null;

  return {
    config,
    engine,
    hub: feed,
    bets,
    audit,
    server,
    async listen(port: number, host = '127.0.0.1'): Promise<number> {
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      if (config.autoTick) ticker = setInterval(() => engine.tick(), config.tickMs);
      return (server.address() as AddressInfo).port;
    },
    async close(): Promise<void> {
      if (ticker) clearInterval(ticker);
      feed.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type OddsServer = ReturnType<typeof createOddsServer>;

const INVALID = Symbol('invalid');

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) return INVALID;
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return INVALID;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
