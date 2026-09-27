import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  DeltaMsg,
  OpsActionRequest,
  PlaceBetRequest,
  PlaceBetResponse,
  ServerMessage,
  isDelta,
} from '../src/index';

const market = {
  id: 'm1',
  eventId: 'e1',
  name: 'Match result',
  kind: 'match_result',
  status: 'open',
  suspendReason: null,
  cashOutAvailable: true,
  selections: [
    { id: 's1', name: 'Home', price: 2.1, priceVersion: 3, result: null },
    { id: 's2', name: 'Away', price: 1.8, priceVersion: 1, result: null },
  ],
  updatedAt: 1000,
};

describe('ServerMessage', () => {
  it('accepts a valid snapshot', () => {
    const msg = {
      type: 'snapshot',
      seq: 0,
      ts: 1,
      events: [
        {
          id: 'e1',
          competition: 'Mock League',
          home: 'A',
          away: 'B',
          score: { home: 0, away: 0 },
          minute: 12,
          status: 'live',
        },
      ],
      markets: [market],
    };
    expect(ServerMessage.safeParse(msg).success).toBe(true);
  });

  it('rejects a price below 1.01 and a non-positive seq on deltas', () => {
    const bad = { type: 'price', seq: 1, ts: 1, marketId: 'm', selectionId: 's', price: 1.0, priceVersion: 1 };
    expect(ServerMessage.safeParse(bad).success).toBe(false);
    const badSeq = { ...bad, price: 1.5, seq: 0 };
    expect(DeltaMsg.safeParse(badSeq).success).toBe(false);
  });

  it('rejects unknown message types and missing fields', () => {
    expect(ServerMessage.safeParse({ type: 'bogus' }).success).toBe(false);
    expect(ServerMessage.safeParse({ type: 'market_status', seq: 2, ts: 1, marketId: 'm' }).success).toBe(false);
  });

  it('isDelta distinguishes sequenced deltas from control messages', () => {
    const hb = ServerMessage.parse({ type: 'heartbeat', seq: 10, ts: 5 });
    const settle = ServerMessage.parse({ type: 'settle', seq: 11, ts: 5, marketId: 'm', winningSelectionId: 's' });
    expect(isDelta(hb)).toBe(false);
    expect(isDelta(settle)).toBe(true);
  });
});

describe('ClientMessage', () => {
  it('parses subscribe with and without lastSeq', () => {
    expect(ClientMessage.parse({ type: 'subscribe', lastSeq: null })).toEqual({ type: 'subscribe', lastSeq: null });
    expect(ClientMessage.safeParse({ type: 'subscribe', lastSeq: 42 }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'subscribe', lastSeq: -1 }).success).toBe(false);
  });
});

describe('REST contracts', () => {
  const req = {
    idempotencyKey: 'abcdef123456',
    betType: 'single',
    stake: 10,
    legs: [{ marketId: 'm1', selectionId: 's1', price: 2.1, priceVersion: 3 }],
    acceptHigherOdds: false,
  };

  it('validates stake bounds and idempotency key', () => {
    expect(PlaceBetRequest.safeParse(req).success).toBe(true);
    expect(PlaceBetRequest.safeParse({ ...req, stake: 0 }).success).toBe(false);
    expect(PlaceBetRequest.safeParse({ ...req, stake: 1e6 }).success).toBe(false);
    expect(PlaceBetRequest.safeParse({ ...req, idempotencyKey: 'x' }).success).toBe(false);
  });

  it('discriminates accepted/rejected responses', () => {
    const rejected = PlaceBetResponse.parse({
      status: 'rejected',
      reason: 'PRICE_CHANGED',
      message: 'moved',
      quotes: [{ marketId: 'm1', selectionId: 's1', price: 2.0, priceVersion: 4, marketStatus: 'open' }],
      rejectedAt: 1,
    });
    expect(rejected.status).toBe('rejected');
  });

  it('requires a meaningful reason for ops actions', () => {
    expect(OpsActionRequest.safeParse({ marketIds: ['m1'], reason: '  ', actor: 'ops' }).success).toBe(false);
    expect(OpsActionRequest.safeParse({ marketIds: [], reason: 'integrity alert', actor: 'ops' }).success).toBe(false);
    const ok = OpsActionRequest.parse({ marketIds: ['m1'], reason: '  integrity alert ', actor: 'ops' });
    expect(ok.reason).toBe('integrity alert');
  });
});
