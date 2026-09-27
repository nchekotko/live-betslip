/**
 * Pure, normalised feed state + reducers. No React, no zustand: unit-testable.
 *
 * Updates are immutable at entity granularity: a price tick replaces exactly
 * one selection object (and nothing else), so memoised rows subscribed to
 * other entities do not re-render.
 */
import type { DeltaMsg, Market, MarketKind, MarketStatus, SnapshotMsg, SportEvent } from '@live-betslip/protocol';

export interface SelectionState {
  id: string;
  marketId: string;
  eventId: string;
  name: string;
  price: number;
  priceVersion: number;
  prevPrice: number | null;
  direction: 'up' | 'down' | null;
  /** Client receive time of the last price change. */
  changedAt: number;
  result: 'win' | 'lose' | null;
}

export interface MarketState {
  id: string;
  eventId: string;
  name: string;
  kind: MarketKind;
  status: MarketStatus;
  suspendReason: string | null;
  cashOutAvailable: boolean;
  selectionIds: string[];
  /** Server timestamp of the last change. */
  updatedAt: number;
  /** Client receive time of the last change of any kind (for stale detection). */
  receivedAt: number;
  /** Set when a market reopens with prices that differ from before the suspension. */
  repricedAt: number | null;
  /** Prices captured at suspension, to detect a reprice on reopen. */
  pricesAtSuspend: Record<string, number> | null;
  /** Largest absolute relative move of the last price update (e.g. 0.18 = 18%). */
  lastMovePct: number;
}

export interface FeedData {
  events: Record<string, SportEvent>;
  eventOrder: string[];
  markets: Record<string, MarketState>;
  marketOrder: string[];
  marketsByEvent: Record<string, string[]>;
  selections: Record<string, SelectionState>;
  lastSeq: number | null;
  lastMessageAt: number | null;
  lastServerTs: number | null;
}

export const emptyFeed: FeedData = {
  events: {},
  eventOrder: [],
  markets: {},
  marketOrder: [],
  marketsByEvent: {},
  selections: {},
  lastSeq: null,
  lastMessageAt: null,
  lastServerTs: null,
};

function marketFromWire(m: Market, now: number, prev?: MarketState): MarketState {
  return {
    id: m.id,
    eventId: m.eventId,
    name: m.name,
    kind: m.kind,
    status: m.status,
    suspendReason: m.suspendReason,
    cashOutAvailable: m.cashOutAvailable,
    selectionIds: m.selections.map((s) => s.id),
    updatedAt: m.updatedAt,
    receivedAt: now,
    repricedAt: prev?.repricedAt ?? null,
    pricesAtSuspend: prev?.pricesAtSuspend ?? null,
    lastMovePct: prev?.lastMovePct ?? 0,
  };
}

function selectionsFromWire(m: Market, now: number, prev: Record<string, SelectionState>): SelectionState[] {
  return m.selections.map((s) => {
    const old = prev[s.id];
    const moved = old !== undefined && old.price !== s.price;
    return {
      id: s.id,
      marketId: m.id,
      eventId: m.eventId,
      name: s.name,
      price: s.price,
      priceVersion: s.priceVersion,
      prevPrice: moved ? old.price : (old?.prevPrice ?? null),
      direction: moved ? (s.price > old.price ? 'up' : 'down') : (old?.direction ?? null),
      changedAt: moved ? now : (old?.changedAt ?? 0),
      result: s.result,
    };
  });
}

/**
 * Replace everything with the snapshot, but keep per-selection history
 * (previous price, direction) so a resync does not erase flash/requote info.
 */
export function applySnapshot(prev: FeedData, snap: SnapshotMsg, now: number): FeedData {
  const events: Record<string, SportEvent> = {};
  const eventOrder: string[] = [];
  for (const e of snap.events) {
    events[e.id] = e;
    eventOrder.push(e.id);
  }
  const markets: Record<string, MarketState> = {};
  const marketOrder: string[] = [];
  const marketsByEvent: Record<string, string[]> = {};
  const selections: Record<string, SelectionState> = {};
  for (const m of snap.markets) {
    const old = prev.markets[m.id];
    markets[m.id] = marketFromWire(m, now, old);
    marketOrder.push(m.id);
    (marketsByEvent[m.eventId] ??= []).push(m.id);
    for (const s of selectionsFromWire(m, now, prev.selections)) {
      const oldSel = prev.selections[s.id];
      // Keep object identity when nothing changed: avoids re-rendering every row on resync.
      selections[s.id] = oldSel && sameSelection(oldSel, s) ? oldSel : s;
    }
    if (old && sameMarket(old, markets[m.id] as MarketState)) markets[m.id] = old;
  }
  return {
    events,
    eventOrder,
    markets,
    marketOrder,
    marketsByEvent,
    selections,
    lastSeq: snap.seq,
    lastMessageAt: now,
    lastServerTs: snap.ts,
  };
}

function sameSelection(a: SelectionState, b: SelectionState): boolean {
  return a.price === b.price && a.priceVersion === b.priceVersion && a.result === b.result && a.name === b.name;
}

function sameMarket(a: MarketState, b: MarketState): boolean {
  return (
    a.status === b.status &&
    a.suspendReason === b.suspendReason &&
    a.cashOutAvailable === b.cashOutAvailable &&
    a.updatedAt === b.updatedAt &&
    a.selectionIds.length === b.selectionIds.length
  );
}

/** Applies an ordered batch of deltas. Copies each top-level map at most once. */
export function applyDeltas(prev: FeedData, deltas: readonly DeltaMsg[], now: number): FeedData {
  if (deltas.length === 0) return prev;
  let events = prev.events;
  let eventOrder = prev.eventOrder;
  let markets = prev.markets;
  let marketOrder = prev.marketOrder;
  let marketsByEvent = prev.marketsByEvent;
  let selections = prev.selections;
  let copiedE = false;
  let copiedM = false;
  let copiedS = false;
  let copiedMBE = false;
  const mutE = () => {
    if (!copiedE) {
      events = { ...events };
      copiedE = true;
    }
    return events;
  };
  const mutM = () => {
    if (!copiedM) {
      markets = { ...markets };
      copiedM = true;
    }
    return markets;
  };
  const mutS = () => {
    if (!copiedS) {
      selections = { ...selections };
      copiedS = true;
    }
    return selections;
  };
  const mutMBE = () => {
    if (!copiedMBE) {
      marketsByEvent = { ...marketsByEvent };
      copiedMBE = true;
    }
    return marketsByEvent;
  };
  let lastSeq = prev.lastSeq;
  let lastServerTs = prev.lastServerTs;

  for (const d of deltas) {
    lastSeq = d.seq;
    lastServerTs = d.ts;
    switch (d.type) {
      case 'price': {
        const sel = selections[d.selectionId];
        // Idempotency guard on top of the sequencer: never go back in price version.
        if (!sel || d.priceVersion <= sel.priceVersion) break;
        const moved = d.price !== sel.price;
        mutS()[sel.id] = {
          ...sel,
          price: d.price,
          priceVersion: d.priceVersion,
          prevPrice: moved ? sel.price : sel.prevPrice,
          direction: moved ? (d.price > sel.price ? 'up' : 'down') : sel.direction,
          changedAt: moved ? now : sel.changedAt,
        };
        const m = markets[d.marketId];
        if (m) {
          const move = moved ? Math.abs(d.price / sel.price - 1) : 0;
          mutM()[m.id] = {
            ...m,
            updatedAt: d.ts,
            receivedAt: now,
            lastMovePct: m.updatedAt === d.ts ? Math.max(m.lastMovePct, move) : move,
          };
        }
        break;
      }
      case 'market_status': {
        const m = markets[d.marketId];
        if (!m) break;
        let pricesAtSuspend = m.pricesAtSuspend;
        let repricedAt = m.repricedAt;
        if (d.status === 'suspended' && m.status === 'open') {
          pricesAtSuspend = Object.fromEntries(m.selectionIds.map((id) => [id, selections[id]?.price ?? 0]));
        }
        if (d.status === 'open' && m.status === 'suspended') {
          const before = pricesAtSuspend;
          const changed = before !== null && m.selectionIds.some((id) => before[id] !== selections[id]?.price);
          repricedAt = changed ? now : repricedAt;
          pricesAtSuspend = null;
        }
        mutM()[m.id] = {
          ...m,
          status: d.status,
          suspendReason: d.suspendReason,
          cashOutAvailable: d.cashOutAvailable,
          updatedAt: d.ts,
          receivedAt: now,
          pricesAtSuspend,
          repricedAt,
        };
        break;
      }
      case 'settle': {
        const m = markets[d.marketId];
        if (!m) break;
        for (const id of m.selectionIds) {
          const s = selections[id];
          if (!s) continue;
          const result = id === d.winningSelectionId ? 'win' : 'lose';
          if (s.result !== result) mutS()[id] = { ...s, result };
        }
        if (m.status !== 'settled') {
          mutM()[m.id] = { ...m, status: 'settled', cashOutAvailable: false, suspendReason: null, updatedAt: d.ts, receivedAt: now };
        }
        break;
      }
      case 'event_update': {
        const e = events[d.eventId];
        if (!e) break;
        mutE()[e.id] = { ...e, score: d.score, minute: d.minute, status: d.status };
        break;
      }
      case 'event_added': {
        if (events[d.event.id]) break;
        mutE()[d.event.id] = d.event;
        eventOrder = [...eventOrder, d.event.id];
        const ids: string[] = [];
        for (const m of d.markets) {
          mutM()[m.id] = marketFromWire(m, now);
          ids.push(m.id);
          for (const s of selectionsFromWire(m, now, selections)) mutS()[s.id] = s;
        }
        marketOrder = [...marketOrder, ...ids];
        mutMBE()[d.event.id] = ids;
        break;
      }
      case 'event_removed': {
        if (!events[d.eventId]) break;
        const ids = marketsByEvent[d.eventId] ?? [];
        const e = mutE();
        delete e[d.eventId];
        eventOrder = eventOrder.filter((id) => id !== d.eventId);
        const drop = new Set(ids);
        marketOrder = marketOrder.filter((id) => !drop.has(id));
        const mm = mutM();
        const ss = mutS();
        for (const id of ids) {
          for (const sid of mm[id]?.selectionIds ?? []) delete ss[sid];
          delete mm[id];
        }
        delete mutMBE()[d.eventId];
        break;
      }
    }
  }

  return {
    events,
    eventOrder,
    markets,
    marketOrder,
    marketsByEvent,
    selections,
    lastSeq,
    lastMessageAt: now,
    lastServerTs,
  };
}
