/**
 * Scenario engine: simulates live football events and their markets.
 *
 * - Expected-goal intensities follow a log random walk; prices come from the
 *   Poisson model in pricing.ts, so a price move always has a cause.
 * - Goals put every market of the event on a 'goal' hold (suspended), then the
 *   markets are repriced and reopened after `goalSuspendMs`.
 * - Market-ops suspensions are a separate 'ops' hold: a goal resume never
 *   reopens a market that a trader suspended.
 * - Decided markets (Over 2.5 reached, both teams scored) settle early; the
 *   rest close at full time and settle after `settleDelayMs`.
 * - Each market updates at random (exponential inter-arrival); occasionally a
 *   market gets "stuck" to emulate a stale upstream feed.
 */
import type {
  AuditAction,
  DeltaMsg,
  Market,
  MarketKind,
  MarketStatus,
  Quote,
  SportEvent,
} from '@live-betslip/protocol';
import { fairProbabilities, priceFromProbability } from './pricing';
import { exponential, normal, pick, type Rng } from './rng';

type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq' | 'ts'> : never;
export type DeltaPayload = WithoutSeq<DeltaMsg>;

export interface EngineConfig {
  eventCount: number;
  simSecondsPerTick: number;
  margin: number;
  goalSuspendMs: number;
  settleDelayMs: number;
  removeDelayMs: number;
  marketUpdateMeanMs: number;
  stuckProbability: number;
  stuckMinMs: number;
  stuckMaxMs: number;
  lambdaVolatility: number;
  cashOutCutoffMinute: number;
}

export const defaultEngineConfig: EngineConfig = {
  eventCount: 12,
  simSecondsPerTick: 20,
  margin: 0.06,
  goalSuspendMs: 4000,
  settleDelayMs: 3000,
  removeDelayMs: 10000,
  marketUpdateMeanMs: 1500,
  stuckProbability: 0.01,
  stuckMinMs: 12000,
  stuckMaxMs: 25000,
  lambdaVolatility: 0.04,
  cashOutCutoffMinute: 85,
};

export interface EngineDeps {
  rng: Rng;
  now: () => number;
  emit: (delta: DeltaPayload) => void;
  audit: (entry: { actor: string; action: AuditAction; marketIds: string[]; reason: string }) => void;
}

type HoldKind = 'goal' | 'ops';

interface SimSelection {
  id: string;
  name: string;
  price: number;
  priceVersion: number;
  result: 'win' | 'lose' | null;
}

interface SimMarket {
  id: string;
  eventId: string;
  name: string;
  kind: MarketKind;
  holds: Map<HoldKind, string>;
  closed: boolean;
  settled: boolean;
  cashOutAvailable: boolean;
  selections: SimSelection[];
  updatedAt: number;
  nextUpdateAt: number;
}

interface SimEvent {
  id: string;
  competition: string;
  home: string;
  away: string;
  score: { home: number; away: number };
  minute: number;
  status: 'live' | 'ended';
  lambdaHome: number;
  lambdaAway: number;
  marketIds: string[];
  goalHoldUntil: number | null;
  endedAt: number | null;
  settledAll: boolean;
}

const TEAMS = [
  'Northbridge', 'Riverside', 'Old Harbour', 'Kingsfield', 'Westmoor', 'Ashford',
  'Redcliff', 'Stonegate', 'Lakeside', 'Eastwick', 'Highbury Vale', 'Southport Town',
  'Greenhill', 'Ironworks', 'Blackwater', 'Silverton', 'Marlow City', 'Fenwick',
  'Dunmore', 'Hollowbrook', 'Crestwood', 'Bayview', 'Oakham', 'Thornbury',
];
const COMPETITIONS = ['Mock Premier', 'Mock Championship', 'Mock Cup', 'Mock Liga'];

export function marketStatus(m: { settled: boolean; closed: boolean; holds: Map<HoldKind, string> }): MarketStatus {
  if (m.settled) return 'settled';
  if (m.closed) return 'closed';
  return m.holds.size > 0 ? 'suspended' : 'open';
}

function suspendReason(m: SimMarket): string | null {
  if (m.closed || m.settled) return null;
  return m.holds.get('ops') ?? m.holds.get('goal') ?? null;
}

export class OddsEngine {
  private readonly events = new Map<string, SimEvent>();
  private readonly markets = new Map<string, SimMarket>();
  private eventCounter = 0;

  constructor(
    private readonly config: EngineConfig,
    private readonly deps: EngineDeps,
  ) {}

  init(): void {
    for (let i = 0; i < this.config.eventCount; i++) {
      this.createEvent(Math.floor(this.deps.rng() * 70), false);
    }
  }

  // ---------------------------------------------------------------- queries

  snapshot(): { events: SportEvent[]; markets: Market[] } {
    const events: SportEvent[] = [];
    const markets: Market[] = [];
    for (const ev of this.events.values()) {
      events.push(this.toEvent(ev));
      for (const id of ev.marketIds) {
        const m = this.markets.get(id);
        if (m) markets.push(this.toMarket(m));
      }
    }
    return { events, markets };
  }

  getMarket(marketId: string): Market | null {
    const m = this.markets.get(marketId);
    return m ? this.toMarket(m) : null;
  }

  quote(marketId: string, selectionId: string): Quote {
    const m = this.markets.get(marketId);
    const s = m?.selections.find((x) => x.id === selectionId);
    return {
      marketId,
      selectionId,
      price: s ? s.price : null,
      priceVersion: s ? s.priceVersion : null,
      marketStatus: m ? marketStatus(m) : null,
    };
  }

  marketIds(): string[] {
    return [...this.markets.keys()];
  }

  // ---------------------------------------------------------------- ops

  opsSuspend(marketIds: string[], reason: string, actor: string) {
    const affected: string[] = [];
    const skipped: { marketId: string; reason: string }[] = [];
    for (const id of new Set(marketIds)) {
      const m = this.markets.get(id);
      if (!m) {
        skipped.push({ marketId: id, reason: 'not_found' });
        continue;
      }
      if (m.closed || m.settled) {
        skipped.push({ marketId: id, reason: marketStatus(m) });
        continue;
      }
      if (m.holds.has('ops')) {
        skipped.push({ marketId: id, reason: 'already_suspended' });
        continue;
      }
      m.holds.set('ops', reason);
      this.emitStatus(m);
      affected.push(id);
    }
    return { affected, skipped, actor };
  }

  opsResume(marketIds: string[], _reason: string, actor: string) {
    const affected: string[] = [];
    const skipped: { marketId: string; reason: string }[] = [];
    for (const id of new Set(marketIds)) {
      const m = this.markets.get(id);
      if (!m) {
        skipped.push({ marketId: id, reason: 'not_found' });
        continue;
      }
      if (!m.holds.has('ops')) {
        skipped.push({ marketId: id, reason: 'not_ops_suspended' });
        continue;
      }
      m.holds.delete('ops');
      if (m.holds.size === 0 && !m.closed && !m.settled) {
        // Reprice before reopening: clients must never see a reopened market with prices from before the hold.
        this.reprice(m, true);
      }
      this.emitStatus(m);
      affected.push(id);
    }
    return { affected, skipped, actor };
  }

  // ---------------------------------------------------------------- simulation

  tick(): void {
    const now = this.deps.now();
    const dtMin = this.config.simSecondsPerTick / 60;
    for (const ev of [...this.events.values()]) {
      if (ev.status === 'live') {
        this.advanceLive(ev, dtMin, now);
      } else if (ev.endedAt !== null) {
        if (!ev.settledAll && now - ev.endedAt >= this.config.settleDelayMs) {
          this.settleEvent(ev);
        }
        if (now - ev.endedAt >= this.config.settleDelayMs + this.config.removeDelayMs) {
          this.removeEvent(ev);
          this.createEvent(0, true);
        }
      }
    }
  }

  /** Test/demo hook: force a goal for the given side. */
  forceGoal(eventId: string, side: 'home' | 'away'): void {
    const ev = this.events.get(eventId);
    if (!ev || ev.status !== 'live') return;
    this.scoreGoal(ev, side, this.deps.now());
  }

  /** Test/demo hook: jump an event to full time. */
  forceFullTime(eventId: string): void {
    const ev = this.events.get(eventId);
    if (!ev || ev.status !== 'live') return;
    this.endEvent(ev, this.deps.now());
  }

  private advanceLive(ev: SimEvent, dtMin: number, now: number): void {
    const { rng } = this.deps;
    const prevMinute = Math.floor(ev.minute);
    ev.minute = Math.min(90, ev.minute + dtMin);

    // Log random walk on scoring intensities (form, red cards, pressure...).
    const vol = this.config.lambdaVolatility;
    ev.lambdaHome = clamp(ev.lambdaHome * Math.exp(vol * normal(rng)), 0.2, 4);
    ev.lambdaAway = clamp(ev.lambdaAway * Math.exp(vol * normal(rng)), 0.2, 4);

    let scored = false;
    if (rng() < (ev.lambdaHome * dtMin) / 90) {
      this.scoreGoal(ev, 'home', now);
      scored = true;
    }
    if (rng() < (ev.lambdaAway * dtMin) / 90) {
      this.scoreGoal(ev, 'away', now);
      scored = true;
    }

    if (!scored && Math.floor(ev.minute) !== prevMinute) {
      this.emitEvent(ev);
      this.refreshCashOut(ev);
    }

    if (ev.minute >= 90) {
      this.endEvent(ev, now);
      return;
    }

    if (ev.goalHoldUntil !== null && now >= ev.goalHoldUntil) {
      ev.goalHoldUntil = null;
      const reopened: string[] = [];
      for (const id of ev.marketIds) {
        const m = this.markets.get(id);
        if (!m || !m.holds.has('goal')) continue;
        m.holds.delete('goal');
        if (m.holds.size === 0 && !m.closed && !m.settled) {
          this.reprice(m, true);
          reopened.push(id);
        }
        this.emitStatus(m);
      }
      if (reopened.length > 0) {
        this.deps.audit({ actor: 'system', action: 'auto_resume', marketIds: reopened, reason: 'goal review complete, repriced' });
      }
    }

    for (const id of ev.marketIds) {
      const m = this.markets.get(id);
      if (!m || marketStatus(m) !== 'open' || now < m.nextUpdateAt) continue;
      this.reprice(m, false);
      let wait = exponential(rng, this.config.marketUpdateMeanMs);
      if (rng() < this.config.stuckProbability) {
        wait += this.config.stuckMinMs + rng() * (this.config.stuckMaxMs - this.config.stuckMinMs);
      }
      m.nextUpdateAt = now + wait;
    }
  }

  private scoreGoal(ev: SimEvent, side: 'home' | 'away', now: number): void {
    ev.score = { ...ev.score, [side]: ev.score[side] + 1 };
    this.emitEvent(ev);
    const held: string[] = [];
    for (const id of ev.marketIds) {
      const m = this.markets.get(id);
      if (!m || m.closed || m.settled) continue;
      m.holds.set('goal', `goal ${ev.score.home}-${ev.score.away}`);
      this.emitStatus(m);
      held.push(id);
    }
    ev.goalHoldUntil = now + this.config.goalSuspendMs;
    if (held.length > 0) {
      this.deps.audit({ actor: 'system', action: 'auto_suspend', marketIds: held, reason: `goal (${side}) ${ev.score.home}-${ev.score.away}` });
    }
    // Early settlement of markets that the goal has decided.
    const total = ev.score.home + ev.score.away;
    for (const id of ev.marketIds) {
      const m = this.markets.get(id);
      if (!m || m.settled) continue;
      if (m.kind === 'total_goals' && total > 2.5) this.settleMarket(m, ev, 'over');
      if (m.kind === 'btts' && ev.score.home > 0 && ev.score.away > 0) this.settleMarket(m, ev, 'yes');
    }
  }

  private endEvent(ev: SimEvent, now: number): void {
    ev.status = 'ended';
    ev.minute = 90;
    ev.endedAt = now;
    ev.goalHoldUntil = null;
    this.emitEvent(ev);
    for (const id of ev.marketIds) {
      const m = this.markets.get(id);
      if (!m || m.settled) continue;
      m.closed = true;
      m.holds.clear();
      this.emitStatus(m);
    }
  }

  private settleEvent(ev: SimEvent): void {
    const { home, away } = ev.score;
    for (const id of ev.marketIds) {
      const m = this.markets.get(id);
      if (!m || m.settled) continue;
      if (m.kind === 'match_result') this.settleMarket(m, ev, home > away ? 'home' : home === away ? 'draw' : 'away');
      if (m.kind === 'total_goals') this.settleMarket(m, ev, home + away > 2.5 ? 'over' : 'under');
      if (m.kind === 'btts') this.settleMarket(m, ev, home > 0 && away > 0 ? 'yes' : 'no');
    }
    ev.settledAll = true;
  }

  private settleMarket(m: SimMarket, ev: SimEvent, winnerKey: string): void {
    const winnerId = `${m.id}:${winnerKey}`;
    m.closed = true;
    m.settled = true;
    m.holds.clear();
    for (const s of m.selections) s.result = s.id === winnerId ? 'win' : 'lose';
    this.emitStatus(m);
    this.deps.emit({ type: 'settle', marketId: m.id, winningSelectionId: winnerId });
    this.deps.audit({
      actor: 'system',
      action: 'settle',
      marketIds: [m.id],
      reason: `result ${ev.score.home}-${ev.score.away}: ${winnerKey}`,
    });
  }

  private removeEvent(ev: SimEvent): void {
    for (const id of ev.marketIds) this.markets.delete(id);
    this.events.delete(ev.id);
    this.deps.emit({ type: 'event_removed', eventId: ev.id });
  }

  private createEvent(minute: number, announce: boolean): SimEvent {
    const { rng } = this.deps;
    this.eventCounter += 1;
    const id = `ev-${this.eventCounter}`;
    const home = pick(rng, TEAMS);
    let away = pick(rng, TEAMS);
    while (away === home) away = pick(rng, TEAMS);
    const ev: SimEvent = {
      id,
      competition: pick(rng, COMPETITIONS),
      home,
      away,
      score: { home: 0, away: 0 },
      minute,
      status: 'live',
      lambdaHome: 0.8 + rng() * 1.4,
      lambdaAway: 0.6 + rng() * 1.2,
      marketIds: [],
      goalHoldUntil: null,
      endedAt: null,
      settledAll: false,
    };
    // Pre-seed a plausible score for events that start mid-game.
    const played = minute / 90;
    for (let g = 0; g < 4; g++) {
      if (rng() < (ev.lambdaHome * played) / 4) ev.score.home += 1;
      if (rng() < (ev.lambdaAway * played) / 4) ev.score.away += 1;
    }
    this.events.set(id, ev);

    const now = this.deps.now();
    const defs: { key: string; name: string; kind: MarketKind; sels: [string, string][] }[] = [
      { key: '1x2', name: 'Исход матча', kind: 'match_result', sels: [['home', 'П1'], ['draw', 'X'], ['away', 'П2']] },
      { key: 'ou25', name: 'Тотал 2.5', kind: 'total_goals', sels: [['over', 'ТБ 2.5'], ['under', 'ТМ 2.5']] },
      { key: 'btts', name: 'Обе забьют', kind: 'btts', sels: [['yes', 'Да'], ['no', 'Нет']] },
    ];
    for (const d of defs) {
      const mid = `${id}:${d.key}`;
      const m: SimMarket = {
        id: mid,
        eventId: id,
        name: d.name,
        kind: d.kind,
        holds: new Map(),
        closed: false,
        settled: false,
        cashOutAvailable: true,
        selections: d.sels.map(([k, n]) => ({ id: `${mid}:${k}`, name: n, price: 2, priceVersion: 0, result: null })),
        updatedAt: now,
        nextUpdateAt: now + exponential(rng, this.config.marketUpdateMeanMs),
      };
      this.markets.set(mid, m);
      ev.marketIds.push(mid);
      this.reprice(m, true, false);
      m.cashOutAvailable = this.cashOutFor(m, ev);
    }
    // Markets decided by the pre-seeded score settle straight away.
    for (const mid of ev.marketIds) {
      const m = this.markets.get(mid);
      if (!m) continue;
      const total = ev.score.home + ev.score.away;
      if (m.kind === 'total_goals' && total > 2.5) this.settleSilently(m, 'over');
      if (m.kind === 'btts' && ev.score.home > 0 && ev.score.away > 0) this.settleSilently(m, 'yes');
    }
    if (announce) {
      this.deps.emit({
        type: 'event_added',
        event: this.toEvent(ev),
        markets: ev.marketIds.flatMap((mid) => {
          const m = this.markets.get(mid);
          return m ? [this.toMarket(m)] : [];
        }),
      });
    }
    return ev;
  }

  private settleSilently(m: SimMarket, winnerKey: string): void {
    m.closed = true;
    m.settled = true;
    m.cashOutAvailable = false;
    for (const s of m.selections) s.result = s.id === `${m.id}:${winnerKey}` ? 'win' : 'lose';
  }

  /** Recomputes prices from the model; emits a price delta for every selection that moved on the ladder. */
  private reprice(m: SimMarket, force: boolean, emit = true): void {
    const ev = this.events.get(m.eventId);
    if (!ev) return;
    const p = fairProbabilities({
      lambdaHome: ev.lambdaHome,
      lambdaAway: ev.lambdaAway,
      minute: ev.minute,
      score: ev.score,
    });
    const probs: Record<string, number> = {
      home: p.home, draw: p.draw, away: p.away,
      over: p.over25, under: p.under25,
      yes: p.bttsYes, no: p.bttsNo,
    };
    const now = this.deps.now();
    let changed = false;
    for (const s of m.selections) {
      const key = s.id.slice(s.id.lastIndexOf(':') + 1);
      const next = priceFromProbability(probs[key] ?? 0, this.config.margin);
      if (next !== s.price) {
        s.price = next;
        s.priceVersion += 1;
        changed = true;
        if (emit) {
          this.deps.emit({ type: 'price', marketId: m.id, selectionId: s.id, price: s.price, priceVersion: s.priceVersion });
        }
      }
    }
    if (changed || force) m.updatedAt = now;
  }

  private cashOutFor(m: SimMarket, ev: SimEvent): boolean {
    return marketStatus(m) === 'open' && ev.minute < this.config.cashOutCutoffMinute;
  }

  private refreshCashOut(ev: SimEvent): void {
    for (const id of ev.marketIds) {
      const m = this.markets.get(id);
      if (!m) continue;
      if (this.cashOutFor(m, ev) !== m.cashOutAvailable) this.emitStatus(m);
    }
  }

  private emitStatus(m: SimMarket): void {
    const ev = this.events.get(m.eventId);
    m.cashOutAvailable = ev ? this.cashOutFor(m, ev) : false;
    m.updatedAt = this.deps.now();
    this.deps.emit({
      type: 'market_status',
      marketId: m.id,
      status: marketStatus(m),
      suspendReason: suspendReason(m),
      cashOutAvailable: m.cashOutAvailable,
    });
  }

  private emitEvent(ev: SimEvent): void {
    this.deps.emit({
      type: 'event_update',
      eventId: ev.id,
      score: { ...ev.score },
      minute: Math.floor(ev.minute),
      status: ev.status,
    });
  }

  private toEvent(ev: SimEvent): SportEvent {
    return {
      id: ev.id,
      competition: ev.competition,
      home: ev.home,
      away: ev.away,
      score: { ...ev.score },
      minute: Math.floor(ev.minute),
      status: ev.status,
    };
  }

  private toMarket(m: SimMarket): Market {
    return {
      id: m.id,
      eventId: m.eventId,
      name: m.name,
      kind: m.kind,
      status: marketStatus(m),
      suspendReason: suspendReason(m),
      cashOutAvailable: m.cashOutAvailable,
      selections: m.selections.map((s) => ({ ...s })),
      updatedAt: Math.floor(m.updatedAt),
    };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
