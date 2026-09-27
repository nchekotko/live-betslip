/**
 * Bet slip state + placement flow.
 *
 * Placement state machine (per request):
 *   pending ──accepted──▶ accepted   (legs leave the slip, receipt shown)
 *           ──rejected──▶ rejected   (PRICE_CHANGED -> requote; others -> message)
 *           ──network/5xx──▶ error   (retry re-sends the *same* idempotency key)
 *
 * Nothing about a bet is optimistic: "accepted" is shown only after the server
 * says so. Slip edits (add/remove/stake/preferences) are local and immediate.
 */
import { create } from 'zustand';
import type { PlaceBetRequest, PlaceBetResponse, Quote } from '@live-betslip/protocol';
import { ApiRequestError, newIdempotencyKey, placeBet as defaultPlaceBet } from '../api/http';
import { acceptCurrentPrices, type BetMode, type FeedView, type SlipEval, type SlipLeg } from '../domain/slipLogic';
import { metrics } from '../telemetry/metrics';

export type PlacementStatus = 'pending' | 'accepted' | 'rejected' | 'error';

export interface Placement {
  key: string;
  request: PlaceBetRequest;
  legs: SlipLeg[];
  status: PlacementStatus;
  response: PlaceBetResponse | null;
  error: string | null;
  retryable: boolean;
  createdAt: number;
}

export interface SlipStore {
  legs: SlipLeg[];
  mode: BetMode;
  accaStake: string;
  acceptHigherOdds: boolean;
  sheetOpen: boolean;
  placements: Placement[];
  /** Quotes returned by a PRICE_CHANGED rejection, keyed by selection. */
  serverQuotes: Record<string, Quote>;
  /** Text for the aria-live region. */
  announcement: string;
}

const PREF_KEY = 'live-betslip:acceptHigherOdds';

function loadPref(): boolean {
  try {
    return globalThis.localStorage?.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function savePref(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(PREF_KEY, v ? '1' : '0');
  } catch {
    // storage may be unavailable (private mode): the preference is per-session then.
  }
}

export const initialSlip = (): SlipStore => ({
  legs: [],
  mode: 'single',
  accaStake: '10',
  acceptHigherOdds: loadPref(),
  sheetOpen: false,
  placements: [],
  serverQuotes: {},
  announcement: '',
});

export const useSlipStore = create<SlipStore>()(() => initialSlip());

const set = useSlipStore.setState;
const get = useSlipStore.getState;

let placeBetImpl: (req: PlaceBetRequest) => Promise<PlaceBetResponse> = (req) => defaultPlaceBet(req);

/** Test seam. */
export function setPlaceBetImpl(fn: (req: PlaceBetRequest) => Promise<PlaceBetResponse>): void {
  placeBetImpl = fn;
}

function patchPlacement(key: string, patch: Partial<Placement>): void {
  set((s) => ({ placements: s.placements.map((p) => (p.key === key ? { ...p, ...patch } : p)) }));
}

async function send(key: string): Promise<void> {
  const p = get().placements.find((x) => x.key === key);
  if (!p) return;
  metrics.inc('placementAttempts');
  patchPlacement(key, { status: 'pending', error: null });
  try {
    const res = await placeBetImpl(p.request);
    if (res.status === 'accepted') {
      const placed = new Set(p.legs.map((l) => l.selectionId));
      set((s) => ({
        legs: s.legs.filter((l) => !placed.has(l.selectionId)),
        announcement: `Ставка принята: коэффициент ${res.combinedPrice.toFixed(2)}, возможный выигрыш ${res.potentialReturn.toFixed(2)}`,
      }));
      patchPlacement(key, { status: 'accepted', response: res });
    } else {
      if (res.reason === 'PRICE_CHANGED') {
        metrics.inc('priceChangedRejections');
        const quotes: Record<string, Quote> = {};
        for (const q of res.quotes) quotes[q.selectionId] = q;
        set((s) => ({ serverQuotes: { ...s.serverQuotes, ...quotes } }));
      }
      set({ announcement: `Ставка отклонена: ${rejectText(res.reason)}` });
      patchPlacement(key, { status: 'rejected', response: res });
    }
  } catch (err) {
    const e = err instanceof ApiRequestError ? err : new ApiRequestError(String(err), null, true);
    set({ announcement: `Ошибка отправки ставки: ${e.message}` });
    patchPlacement(key, { status: 'error', error: e.message, retryable: e.retryable });
  }
}

export function rejectText(reason: string): string {
  switch (reason) {
    case 'PRICE_CHANGED':
      return 'коэффициент изменился, подтвердите новую цену';
    case 'MARKET_SUSPENDED':
      return 'рынок приостановлен';
    case 'MARKET_CLOSED':
      return 'рынок закрыт';
    case 'SELECTION_NOT_FOUND':
      return 'исход недоступен';
    case 'INVALID_COMBINATION':
      return 'недопустимая комбинация';
    case 'LIMIT_EXCEEDED':
      return 'превышен лимит';
    default:
      return reason;
  }
}

export const slipActions = {
  toggle(leg: Omit<SlipLeg, 'stake'>) {
    const s = get();
    if (s.legs.some((l) => l.selectionId === leg.selectionId)) {
      set({ legs: s.legs.filter((l) => l.selectionId !== leg.selectionId), announcement: `${leg.selectionName} удалён из купона` });
      return;
    }
    // One selection per market: picking another outcome replaces the previous one.
    const legs = s.legs.filter((l) => l.marketId !== leg.marketId);
    set({
      legs: [...legs, { ...leg, stake: '10' }],
      announcement: `${leg.selectionName} добавлен в купон, коэффициент ${leg.price.toFixed(2)}`,
    });
  },
  remove(selectionId: string) {
    set((s) => ({ legs: s.legs.filter((l) => l.selectionId !== selectionId) }));
  },
  clear() {
    set({ legs: [], serverQuotes: {} });
  },
  removeUnavailable(feed: FeedView) {
    set((s) => ({
      legs: s.legs.filter((l) => {
        const m = feed.markets[l.marketId];
        return m !== undefined && feed.selections[l.selectionId] !== undefined && m.status !== 'closed' && m.status !== 'settled';
      }),
    }));
  },
  setStake(selectionId: string, stake: string) {
    set((s) => ({ legs: s.legs.map((l) => (l.selectionId === selectionId ? { ...l, stake } : l)) }));
  },
  setAccaStake(accaStake: string) {
    set({ accaStake });
  },
  setMode(mode: BetMode) {
    set({ mode });
  },
  setAcceptHigherOdds(v: boolean) {
    savePref(v);
    set({ acceptHigherOdds: v });
  },
  setSheetOpen(sheetOpen: boolean) {
    set({ sheetOpen });
  },
  announce(announcement: string) {
    set({ announcement });
  },

  /** Explicit requote acceptance: the user saw the new prices and agreed. */
  acceptPrices(feed: FeedView) {
    const { legs, serverQuotes } = get();
    // Feed may lag behind the server quote after a rejection: take whichever is newer.
    const merged: FeedView = { markets: feed.markets, selections: { ...feed.selections } };
    for (const q of Object.values(serverQuotes)) {
      const cur = merged.selections[q.selectionId];
      if (cur && q.price !== null && q.priceVersion !== null && q.priceVersion > cur.priceVersion) {
        merged.selections[q.selectionId] = { ...cur, price: q.price, priceVersion: q.priceVersion };
      }
    }
    const next = acceptCurrentPrices(legs, merged);
    set({ legs: next, serverQuotes: {}, announcement: 'Новые коэффициенты приняты' });
  },

  /**
   * With "accept higher odds" on, silently move legs to a *better* live price.
   * Never moves a leg to a worse price.
   */
  followHigherOdds(feed: FeedView): void {
    const { legs, acceptHigherOdds } = get();
    if (!acceptHigherOdds) return;
    let changed = false;
    const next = legs.map((l) => {
      const s = feed.selections[l.selectionId];
      const m = feed.markets[l.marketId];
      if (s && m?.status === 'open' && s.price > l.price && s.priceVersion > l.priceVersion) {
        changed = true;
        return { ...l, price: s.price, priceVersion: s.priceVersion };
      }
      return l;
    });
    if (changed) set({ legs: next });
  },

  /** Builds requests from the evaluated slip and sends them. Returns the idempotency keys. */
  async place(evaluation: SlipEval): Promise<string[]> {
    if (!evaluation.canPlace) return [];
    const { acceptHigherOdds } = get();
    const legs = evaluation.legs.map((e) => e.leg);
    const now = Date.now();
    const toLeg = (l: SlipLeg) => ({ marketId: l.marketId, selectionId: l.selectionId, price: l.price, priceVersion: l.priceVersion });
    const created: Placement[] = [];
    if (evaluation.mode === 'acca') {
      const stake = evaluation.totalStake;
      created.push(makePlacement({ betType: 'acca', stake, legs: legs.map(toLeg), acceptHigherOdds }, legs, now));
    } else {
      for (const ev of evaluation.legs) {
        if (ev.stakeValue === null) continue;
        created.push(makePlacement({ betType: 'single', stake: ev.stakeValue, legs: [toLeg(ev.leg)], acceptHigherOdds }, [ev.leg], now));
      }
    }
    set((s) => ({ placements: [...created, ...s.placements].slice(0, 30), serverQuotes: {} }));
    await Promise.all(created.map((p) => send(p.key)));
    return created.map((p) => p.key);
  },

  /** Retries a failed request with the *same* idempotency key: safe against double placement. */
  async retry(key: string): Promise<void> {
    const p = get().placements.find((x) => x.key === key);
    if (!p || p.status !== 'error') return;
    await send(key);
  },

  dismissPlacement(key: string) {
    set((s) => ({ placements: s.placements.filter((p) => p.key !== key) }));
  },
};

function makePlacement(body: Omit<PlaceBetRequest, 'idempotencyKey'>, legs: SlipLeg[], now: number): Placement {
  const key = newIdempotencyKey();
  return {
    key,
    request: { ...body, idempotencyKey: key },
    legs,
    status: 'pending',
    response: null,
    error: null,
    retryable: false,
    createdAt: now,
  };
}
