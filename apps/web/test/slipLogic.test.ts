import { describe, expect, it } from 'vitest';
import { combinedPrice, parseStake, potentialReturn } from '../src/domain/odds';
import { acceptCurrentPrices, evaluateSlip, type SlipInput, type SlipLeg } from '../src/domain/slipLogic';
import { applyDeltas, applySnapshot, emptyFeed } from '../src/store/feedReducer';
import { snapshot } from './fixtures';

const feed0 = applySnapshot(emptyFeed, snapshot(), 1);

function leg(selectionId: string, marketId: string, eventId: string, price: number, priceVersion = 1): SlipLeg {
  return { selectionId, marketId, eventId, eventName: 'A — B', marketName: 'm', selectionName: selectionId, price, priceVersion, stake: '10' };
}

const L1 = leg('ev-1:1x2:home', 'ev-1:1x2', 'ev-1', 2.1);
const L2 = leg('ev-2:1x2:home', 'ev-2:1x2', 'ev-2', 1.5);
const L1b = leg('ev-1:ou25:over', 'ev-1:ou25', 'ev-1', 1.9);

const base: SlipInput = { legs: [L1], mode: 'single', accaStake: '10', acceptHigherOdds: false, feedHealthy: true, busy: false };

function moved(selectionId: string, marketId: string, price: number) {
  return applyDeltas(feed0, [{ type: 'price', seq: 11, ts: 1, marketId, selectionId, price, priceVersion: 2 }], 2);
}

describe('odds helpers', () => {
  it('parses stakes strictly', () => {
    expect(parseStake('10')).toEqual({ ok: true, value: 10 });
    expect(parseStake('10,5')).toEqual({ ok: true, value: 10.5 });
    expect(parseStake('1.234').ok).toBe(false);
    expect(parseStake('abc').ok).toBe(false);
    expect(parseStake('0.05').ok).toBe(false);
    expect(parseStake('20000').ok).toBe(false);
  });
  it('computes combined odds and returns', () => {
    expect(combinedPrice([2.1, 1.5])).toBe(3.15);
    expect(potentialReturn(10, 3.15)).toBe(31.5);
  });
});

describe('evaluateSlip', () => {
  it('allows placing an unchanged single', () => {
    const e = evaluateSlip(base, feed0);
    expect(e.canPlace).toBe(true);
    expect(e.potentialReturn).toBe(21);
  });

  it('requires explicit acceptance when the price drops', () => {
    const e = evaluateSlip(base, moved(L1.selectionId, L1.marketId, 1.95));
    expect(e.legs[0]?.state).toBe('price_down');
    expect(e.requoteRequired).toBe(true);
    expect(e.canPlace).toBe(false);
  });

  it('price up: requote without the preference, auto-accept with it', () => {
    const f = moved(L1.selectionId, L1.marketId, 2.3);
    expect(evaluateSlip(base, f).canPlace).toBe(false);
    const withPref = evaluateSlip({ ...base, acceptHigherOdds: true }, f);
    expect(withPref.requoteRequired).toBe(false);
    expect(withPref.canPlace).toBe(true);
    expect(withPref.legs[0]?.effectivePrice).toBe(2.3);
    expect(withPref.potentialReturn).toBe(23);
  });

  it('with the preference a price drop still needs acceptance', () => {
    const e = evaluateSlip({ ...base, acceptHigherOdds: true }, moved(L1.selectionId, L1.marketId, 2.0));
    expect(e.requoteRequired).toBe(true);
  });

  it('blocks on suspended markets and an unhealthy feed', () => {
    const suspended = applyDeltas(
      feed0,
      [{ type: 'market_status', seq: 11, ts: 1, marketId: 'ev-1:1x2', status: 'suspended', suspendReason: 'goal', cashOutAvailable: false }],
      2,
    );
    const e = evaluateSlip(base, suspended);
    expect(e.legs[0]?.state).toBe('suspended');
    expect(e.canPlace).toBe(false);
    expect(evaluateSlip({ ...base, feedHealthy: false }, feed0).canPlace).toBe(false);
  });

  it('accumulator: product of prices, rejects same-event legs and invalid stake', () => {
    const acca = evaluateSlip({ ...base, mode: 'acca', legs: [L1, L2], accaStake: '5' }, feed0);
    expect(acca.combinedPrice).toBe(3.15);
    expect(acca.potentialReturn).toBe(15.75);
    expect(acca.canPlace).toBe(true);
    const same = evaluateSlip({ ...base, mode: 'acca', legs: [L1, L1b] }, feed0);
    expect(same.canPlace).toBe(false);
    expect(same.blockingReasons.join()).toMatch(/одного события/);
    const bad = evaluateSlip({ ...base, mode: 'acca', legs: [L1, L2], accaStake: 'x' }, feed0);
    expect(bad.canPlace).toBe(false);
  });

  it('acceptCurrentPrices moves legs to the live version only for open markets', () => {
    const f = moved(L1.selectionId, L1.marketId, 1.95);
    const [next] = acceptCurrentPrices([L1], f);
    expect(next).toMatchObject({ price: 1.95, priceVersion: 2 });
    expect(evaluateSlip({ ...base, legs: [next as SlipLeg] }, f).canPlace).toBe(true);
  });

  it('a leg holding a newer server quote than the feed is not requoted again', () => {
    const ahead = { ...L1, price: 2.0, priceVersion: 5 };
    expect(evaluateSlip({ ...base, legs: [ahead] }, feed0).legs[0]?.state).toBe('ok');
  });
});
