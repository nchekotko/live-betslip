import { describe, expect, it } from 'vitest';
import { applyDeltas, applySnapshot, emptyFeed } from '../src/store/feedReducer';
import { deriveMarketView } from '../src/domain/marketView';
import { detectAnomaly } from '../src/domain/anomalies';
import { event, market, snapshot } from './fixtures';

const H = 'ev-1:1x2:home';

describe('feedReducer', () => {
  it('normalises a snapshot', () => {
    const s = applySnapshot(emptyFeed, snapshot(), 5);
    expect(s.eventOrder).toEqual(['ev-1', 'ev-2']);
    expect(s.marketsByEvent['ev-1']).toEqual(['ev-1:1x2', 'ev-1:ou25']);
    expect(s.selections[H]?.price).toBe(2.1);
    expect(s.lastSeq).toBe(10);
  });

  it('price delta updates exactly one selection object and records direction', () => {
    const s0 = applySnapshot(emptyFeed, snapshot(), 5);
    const s1 = applyDeltas(s0, [{ type: 'price', seq: 11, ts: 2000, marketId: 'ev-1:1x2', selectionId: H, price: 2.3, priceVersion: 2 }], 6);
    expect(s1.selections[H]).toMatchObject({ price: 2.3, prevPrice: 2.1, direction: 'up', changedAt: 6 });
    expect(s1.selections['ev-1:1x2:draw']).toBe(s0.selections['ev-1:1x2:draw']);
    expect(s1.markets['ev-2:1x2']).toBe(s0.markets['ev-2:1x2']);
    expect(s1.events).toBe(s0.events);
    expect(s1.markets['ev-1:1x2']?.lastMovePct).toBeCloseTo(2.3 / 2.1 - 1, 6);
  });

  it('ignores a price delta whose version is not newer (idempotent)', () => {
    const s0 = applySnapshot(emptyFeed, snapshot(), 5);
    const s1 = applyDeltas(s0, [{ type: 'price', seq: 11, ts: 2000, marketId: 'ev-1:1x2', selectionId: H, price: 1.5, priceVersion: 1 }], 6);
    expect(s1.selections[H]?.price).toBe(2.1);
  });

  it('marks a market repriced when it reopens with different prices', () => {
    const s0 = applySnapshot(emptyFeed, snapshot(), 5);
    const s1 = applyDeltas(
      s0,
      [
        { type: 'market_status', seq: 11, ts: 2000, marketId: 'ev-1:1x2', status: 'suspended', suspendReason: 'goal 1-0', cashOutAvailable: false },
        { type: 'price', seq: 12, ts: 2100, marketId: 'ev-1:1x2', selectionId: H, price: 1.6, priceVersion: 2 },
        { type: 'market_status', seq: 13, ts: 2200, marketId: 'ev-1:1x2', status: 'open', suspendReason: null, cashOutAvailable: true },
      ],
      100,
    );
    const m = s1.markets['ev-1:1x2'];
    expect(m?.status).toBe('open');
    expect(m?.repricedAt).toBe(100);
    if (!m) return;
    expect(deriveMarketView(m, 200, 5000)).toBe('repriced');
    expect(deriveMarketView(m, 6000, 5000)).toBe('open');
  });

  it('settles, adds and removes events', () => {
    const s0 = applySnapshot(emptyFeed, snapshot(), 5);
    const s1 = applyDeltas(
      s0,
      [
        { type: 'settle', seq: 11, ts: 1, marketId: 'ev-1:ou25', winningSelectionId: 'ev-1:ou25:under' },
        { type: 'event_added', seq: 12, ts: 1, event: event('ev-3'), markets: [market('ev-3', '1x2', [2, 3, 4])] },
        { type: 'event_removed', seq: 13, ts: 1, eventId: 'ev-2' },
      ],
      7,
    );
    expect(s1.markets['ev-1:ou25']?.status).toBe('settled');
    expect(s1.selections['ev-1:ou25:under']?.result).toBe('win');
    expect(s1.selections['ev-1:ou25:over']?.result).toBe('lose');
    expect(s1.eventOrder).toEqual(['ev-1', 'ev-3']);
    expect(s1.markets['ev-2:1x2']).toBeUndefined();
    expect(s1.selections['ev-2:1x2:home']).toBeUndefined();
    expect(s1.marketsByEvent['ev-3']).toEqual(['ev-3:1x2']);
    expect(s1.lastSeq).toBe(13);
  });

  it('a resync snapshot keeps unchanged entities by identity', () => {
    const s0 = applySnapshot(emptyFeed, snapshot(), 5);
    const s1 = applySnapshot(s0, snapshot(20), 9);
    expect(s1.selections[H]).toBe(s0.selections[H]);
    expect(s1.lastSeq).toBe(20);
  });
});

describe('anomaly detection', () => {
  const t = { jumpPct: 15, staleSec: 10 };
  it('flags a large recent jump and a stale open market', () => {
    expect(detectAnomaly({ status: 'open', lastMovePct: 0.2, updatedAt: 1000 }, 2000, t)).toMatchObject({ priceJump: true, stale: false, movePct: 20 });
    expect(detectAnomaly({ status: 'open', lastMovePct: 0.05, updatedAt: 1000 }, 12_000, t)).toMatchObject({ priceJump: false, stale: true, ageSec: 11 });
    // Suspended markets are expected to be quiet.
    expect(detectAnomaly({ status: 'suspended', lastMovePct: 0, updatedAt: 1000 }, 60_000, t).stale).toBe(false);
  });
});
