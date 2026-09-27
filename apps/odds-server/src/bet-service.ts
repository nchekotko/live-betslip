/**
 * Bet placement with idempotency and price-version checks.
 *
 * Acceptance rules for each leg (evaluated twice: on receipt and again after
 * the in-play bet delay, the second evaluation is authoritative):
 *   - market must exist and be `open`;
 *   - same priceVersion                      -> accept at requested price;
 *   - different version, same price          -> accept (terms unchanged);
 *   - price moved up and acceptHigherOdds    -> accept at the *current* price;
 *   - anything else                          -> reject PRICE_CHANGED with quotes.
 *
 * Idempotency: the first request with a key owns the outcome. Retries with the
 * same key and the same body get the same response (even while in flight);
 * the same key with a different body is a 409.
 */
import {
  MAX_POTENTIAL_RETURN,
  PlaceBetRequest,
  type AcceptedBet,
  type BetLegRequest,
  type PlaceBetResponse,
  type RejectReason,
  type RejectedBet,
} from '@live-betslip/protocol';
import type { OddsEngine } from './engine';

export interface BetServiceOptions {
  /** In-play bet delay: the window in which prices can still move. */
  delayMs: number;
  now: () => number;
  newId: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export type HttpResult = { status: number; body: unknown };

type LegCheck =
  | { ok: true; legs: BetLegRequest[] }
  | { ok: false; reason: RejectReason; message: string };

export class BetService {
  private readonly byKey = new Map<string, { fingerprint: string; result: Promise<PlaceBetResponse> }>();
  private readonly bets = new Map<string, AcceptedBet>();
  private readonly sleep: (ms: number) => Promise<void>;
  private attempts = 0;
  private priceChangedRejections = 0;

  constructor(
    private readonly engine: OddsEngine,
    private readonly opts: BetServiceOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  stats() {
    return { attempts: this.attempts, accepted: this.bets.size, priceChangedRejections: this.priceChangedRejections };
  }

  getBet(id: string): AcceptedBet | undefined {
    return this.bets.get(id);
  }

  async place(raw: unknown): Promise<HttpResult> {
    const parsed = PlaceBetRequest.safeParse(raw);
    if (!parsed.success) {
      return { status: 400, body: { error: 'VALIDATION_ERROR', message: 'invalid bet request', details: parsed.error.issues } };
    }
    const req = parsed.data;
    const { idempotencyKey, ...rest } = req;
    const fingerprint = JSON.stringify(rest);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          status: 409,
          body: { error: 'IDEMPOTENCY_CONFLICT', message: 'idempotency key was already used with a different request' },
        };
      }
      return { status: 200, body: await existing.result };
    }
    const result = this.process(req);
    this.byKey.set(idempotencyKey, { fingerprint, result });
    return { status: 200, body: await result };
  }

  private async process(req: PlaceBetRequest): Promise<PlaceBetResponse> {
    this.attempts += 1;
    const structural = this.checkStructure(req);
    if (structural) return this.reject(req, structural.reason, structural.message);

    const first = this.checkLegs(req);
    if (!first.ok) return this.reject(req, first.reason, first.message);

    await this.sleep(this.opts.delayMs);

    const second = this.checkLegs(req);
    if (!second.ok) return this.reject(req, second.reason, second.message);

    const combined = round2(second.legs.reduce((acc, l) => acc * l.price, 1));
    const potentialReturn = round2(req.stake * combined);
    if (potentialReturn > MAX_POTENTIAL_RETURN) {
      return this.reject(req, 'LIMIT_EXCEEDED', `potential return exceeds ${MAX_POTENTIAL_RETURN}`);
    }
    const bet: AcceptedBet = {
      status: 'accepted',
      betId: this.opts.newId(),
      betType: req.betType,
      stake: req.stake,
      legs: second.legs,
      combinedPrice: combined,
      potentialReturn,
      acceptedAt: Math.floor(this.opts.now()),
    };
    this.bets.set(bet.betId, bet);
    return bet;
  }

  private checkStructure(req: PlaceBetRequest): { reason: RejectReason; message: string } | null {
    if (req.betType === 'single' && req.legs.length !== 1) {
      return { reason: 'INVALID_COMBINATION', message: 'a single must have exactly one leg' };
    }
    if (req.betType === 'acca') {
      if (req.legs.length < 2) return { reason: 'INVALID_COMBINATION', message: 'an accumulator needs at least two legs' };
      const events = new Set<string>();
      for (const leg of req.legs) {
        const market = this.engine.getMarket(leg.marketId);
        if (!market) return { reason: 'SELECTION_NOT_FOUND', message: `market ${leg.marketId} not found` };
        if (events.has(market.eventId)) {
          return { reason: 'INVALID_COMBINATION', message: 'legs from the same event are correlated and cannot be combined' };
        }
        events.add(market.eventId);
      }
    }
    const maxReturn = req.stake * req.legs.reduce((acc, l) => acc * l.price, 1);
    if (maxReturn > MAX_POTENTIAL_RETURN) {
      return { reason: 'LIMIT_EXCEEDED', message: `potential return exceeds ${MAX_POTENTIAL_RETURN}` };
    }
    return null;
  }

  private checkLegs(req: PlaceBetRequest): LegCheck {
    const out: BetLegRequest[] = [];
    for (const leg of req.legs) {
      const q = this.engine.quote(leg.marketId, leg.selectionId);
      if (q.marketStatus === null || q.price === null || q.priceVersion === null) {
        return { ok: false, reason: 'SELECTION_NOT_FOUND', message: `selection ${leg.selectionId} not found` };
      }
      if (q.marketStatus === 'suspended') {
        return { ok: false, reason: 'MARKET_SUSPENDED', message: `market ${leg.marketId} is suspended` };
      }
      if (q.marketStatus !== 'open') {
        return { ok: false, reason: 'MARKET_CLOSED', message: `market ${leg.marketId} is ${q.marketStatus}` };
      }
      if (q.priceVersion === leg.priceVersion || q.price === leg.price) {
        out.push({ ...leg, price: q.price, priceVersion: q.priceVersion });
        continue;
      }
      if (req.acceptHigherOdds && q.price > leg.price) {
        out.push({ ...leg, price: q.price, priceVersion: q.priceVersion });
        continue;
      }
      return {
        ok: false,
        reason: 'PRICE_CHANGED',
        message: `price for ${leg.selectionId} moved ${leg.price} -> ${q.price}`,
      };
    }
    return { ok: true, legs: out };
  }

  private reject(req: PlaceBetRequest, reason: RejectReason, message: string): RejectedBet {
    if (reason === 'PRICE_CHANGED') this.priceChangedRejections += 1;
    return {
      status: 'rejected',
      reason,
      message,
      quotes: req.legs.map((l) => this.engine.quote(l.marketId, l.selectionId)),
      rejectedAt: Math.floor(this.opts.now()),
    };
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
