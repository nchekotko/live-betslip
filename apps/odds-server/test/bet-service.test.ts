import { describe, expect, it } from 'vitest';
import { PlaceBetResponse, type PlaceBetRequest } from '@live-betslip/protocol';
import { BetService } from '../src/bet-service';
import { makeEngine } from './helpers';

type Ctx = ReturnType<typeof makeEngine> & { service: BetService; open: ReturnType<ReturnType<typeof makeEngine>['engine']['snapshot']>['markets'] };

function setup(duringDelay?: (ctx: Ctx) => void): Ctx {
  const base = makeEngine({ marketUpdateMeanMs: 1e9 });
  let n = 0;
  const ctx = {} as Ctx;
  const service = new BetService(base.engine, {
    delayMs: 10,
    now: () => base.clock.t,
    newId: () => `bet-${++n}`,
    sleep: async () => {
      duringDelay?.(ctx);
    },
  });
  const open = base.engine.snapshot().markets.filter((m) => m.status === 'open');
  Object.assign(ctx, base, { service, open });
  return ctx;
}

function leg(m: { id: string; selections: { id: string; price: number; priceVersion: number }[] }, i = 0) {
  const s = m.selections[i];
  if (!s) throw new Error('fixture');
  return { marketId: m.id, selectionId: s.id, price: s.price, priceVersion: s.priceVersion };
}

let keyN = 0;
function single(l: ReturnType<typeof leg>, extra: Partial<PlaceBetRequest> = {}): PlaceBetRequest {
  keyN += 1;
  return { idempotencyKey: `key-${keyN}-abcdef`, betType: 'single', stake: 10, legs: [l], acceptHigherOdds: false, ...extra };
}

describe('BetService', () => {
  it('accepts a bet at the confirmed price and returns a contract-valid response', async () => {
    const { service, open } = setup();
    const m = open[0];
    if (!m) throw new Error('fixture');
    const r = await service.place(single(leg(m)));
    expect(r.status).toBe(200);
    const body = PlaceBetResponse.parse(r.body);
    expect(body.status).toBe('accepted');
    if (body.status === 'accepted') expect(body.potentialReturn).toBeCloseTo(10 * leg(m).price, 2);
  });

  it('is idempotent: same key + body returns the same bet, different body is a 409', async () => {
    const { service, open } = setup();
    const m = open[0];
    if (!m) throw new Error('fixture');
    const req = single(leg(m), { idempotencyKey: 'fixed-key-1' });
    const [a, b] = await Promise.all([service.place(req), service.place(req)]);
    expect(a.body).toEqual(b.body);
    expect(service.stats().accepted).toBe(1);
    const retry = await service.place(req);
    expect(retry.body).toEqual(a.body);
    const conflict = await service.place({ ...req, stake: 20 });
    expect(conflict.status).toBe(409);
  });

  it('rejects with PRICE_CHANGED and fresh quotes when the price moves during the bet delay', async () => {
    const ctx = setup((c) => {
      const target = c.open.find((x) => x.kind === 'match_result');
      if (!target) return;
      // Late goal + time passing: guaranteed reprice of the 1X2 market.
      c.engine.forceGoal(target.eventId, 'away');
      c.clock.t += 60_000;
      c.engine.tick();
    });
    const m = ctx.open.find((x) => x.kind === 'match_result');
    if (!m) throw new Error('fixture');
    const r = await ctx.service.place(single(leg(m)));
    const body = PlaceBetResponse.parse(r.body);
    expect(body.status).toBe('rejected');
    if (body.status === 'rejected') {
      expect(['PRICE_CHANGED', 'MARKET_SUSPENDED']).toContain(body.reason);
      expect(body.quotes[0]?.selectionId).toBe(leg(m).selectionId);
    }
  });

  it('acceptHigherOdds takes a better price but never a worse one', async () => {
    const { service, open } = setup();
    const m = open.find((x) => x.selections[0] && x.selections[0].price > 1.2 && x.selections[0].priceVersion > 0);
    if (!m) throw new Error('fixture');
    const l = leg(m);
    const stale = { ...l, price: Number((l.price - 0.05).toFixed(2)), priceVersion: l.priceVersion - 1 };
    const up = PlaceBetResponse.parse((await service.place(single(stale, { acceptHigherOdds: true }))).body);
    expect(up.status).toBe('accepted');
    if (up.status === 'accepted') expect(up.legs[0]?.price).toBe(l.price);

    const noPref = PlaceBetResponse.parse((await service.place(single(stale))).body);
    expect(noPref.status === 'rejected' && noPref.reason).toBe('PRICE_CHANGED');

    const optimistic = { ...l, price: Number((l.price + 0.5).toFixed(2)), priceVersion: l.priceVersion - 1 };
    const down = PlaceBetResponse.parse((await service.place(single(optimistic, { acceptHigherOdds: true }))).body);
    expect(down.status === 'rejected' && down.reason).toBe('PRICE_CHANGED');
  });

  it('rejects suspended markets and same-event accumulators', async () => {
    const { service, open, engine } = setup();
    const m = open[0];
    if (!m) throw new Error('fixture');
    engine.opsSuspend([m.id], 'manual check', 'ops');
    const susp = PlaceBetResponse.parse((await service.place(single(leg(m)))).body);
    expect(susp.status === 'rejected' && susp.reason).toBe('MARKET_SUSPENDED');

    const byEvent = new Map<string, typeof open>();
    for (const x of open) byEvent.set(x.eventId, [...(byEvent.get(x.eventId) ?? []), x]);
    const pair = [...byEvent.values()].find((ms) => ms.length >= 2);
    if (!pair?.[0] || !pair[1]) throw new Error('fixture');
    const acca = PlaceBetResponse.parse(
      (await service.place({ ...single(leg(pair[0])), betType: 'acca', legs: [leg(pair[0]), leg(pair[1])] })).body,
    );
    expect(acca.status === 'rejected' && acca.reason).toBe('INVALID_COMBINATION');
  });

  it('prices an accumulator as the product of leg prices', async () => {
    const { service, open } = setup();
    const byEvent = new Map<string, (typeof open)[number]>();
    for (const m of open) if (!byEvent.has(m.eventId)) byEvent.set(m.eventId, m);
    const legs = [...byEvent.values()].slice(0, 3).map((m) => leg(m));
    const first = legs[0];
    if (!first || legs.length < 2) throw new Error('fixture');
    const r = PlaceBetResponse.parse((await service.place({ ...single(first), betType: 'acca', legs, stake: 5 })).body);
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') {
      const product = legs.reduce((a, l) => a * l.price, 1);
      expect(r.combinedPrice).toBeCloseTo(product, 2);
    }
  });

  it('returns 400 on malformed input', async () => {
    const { service } = setup();
    expect((await service.place({ nope: true })).status).toBe(400);
  });
});
