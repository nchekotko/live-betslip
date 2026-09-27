/**
 * Pure bet-slip evaluation: given what the user confirmed (legs with price +
 * priceVersion) and the live feed, decide per leg what the user must see and
 * whether a bet may be sent.
 *
 * Invariant: a bet is only ever sent at a price the user has explicitly seen
 * and accepted. The one exception is an upward move with the user's explicit
 * "accept higher odds" preference on — strictly better terms for the player.
 */
import { MAX_ACCA_LEGS, MAX_POTENTIAL_RETURN } from '@live-betslip/protocol';
import type { MarketState, SelectionState } from '../store/feedReducer';
import { combinedPrice, parseStake, potentialReturn, round2 } from './odds';

export interface SlipLeg {
  selectionId: string;
  marketId: string;
  eventId: string;
  eventName: string;
  marketName: string;
  selectionName: string;
  /** Price the user has seen and accepted. */
  price: number;
  priceVersion: number;
  /** Stake input for singles (raw string, validated on evaluation). */
  stake: string;
}

export type BetMode = 'single' | 'acca';

export type LegState = 'ok' | 'price_up' | 'price_down' | 'suspended' | 'closed' | 'settled' | 'unavailable';

export interface LegEval {
  leg: SlipLeg;
  state: LegState;
  currentPrice: number | null;
  currentVersion: number | null;
  /** Price the bet will be sent/accepted at if placed now. */
  effectivePrice: number;
  /** The user must accept a new price for this leg before placing. */
  needsAcceptance: boolean;
  stakeError: string | null;
  stakeValue: number | null;
}

export interface SlipEval {
  legs: LegEval[];
  mode: BetMode;
  requoteRequired: boolean;
  blockingReasons: string[];
  combinedPrice: number | null;
  totalStake: number;
  potentialReturn: number | null;
  accaStakeError: string | null;
  canPlace: boolean;
}

export interface FeedView {
  markets: Record<string, MarketState>;
  selections: Record<string, SelectionState>;
}

export interface SlipInput {
  legs: readonly SlipLeg[];
  mode: BetMode;
  accaStake: string;
  acceptHigherOdds: boolean;
  /** Feed connected, in sync and not stale. */
  feedHealthy: boolean;
  /** A placement is in flight. */
  busy: boolean;
}

export function evaluateLeg(leg: SlipLeg, feed: FeedView, acceptHigherOdds: boolean): Omit<LegEval, 'stakeError' | 'stakeValue'> {
  const m = feed.markets[leg.marketId];
  const s = feed.selections[leg.selectionId];
  const base = { leg, currentPrice: s?.price ?? null, currentVersion: s?.priceVersion ?? null, effectivePrice: leg.price };
  if (!m || !s) return { ...base, state: 'unavailable', needsAcceptance: false };
  if (m.status === 'settled') return { ...base, state: 'settled', needsAcceptance: false };
  if (m.status === 'closed') return { ...base, state: 'closed', needsAcceptance: false };
  if (m.status === 'suspended') return { ...base, state: 'suspended', needsAcceptance: false };
  // leg.priceVersion > feed version: the user accepted a server quote the feed has not delivered yet.
  if (s.priceVersion <= leg.priceVersion || s.price === leg.price) {
    return { ...base, state: 'ok', needsAcceptance: false };
  }
  if (s.price > leg.price) {
    return acceptHigherOdds
      ? { ...base, state: 'price_up', needsAcceptance: false, effectivePrice: s.price }
      : { ...base, state: 'price_up', needsAcceptance: true };
  }
  return { ...base, state: 'price_down', needsAcceptance: true };
}

export function evaluateSlip(input: SlipInput, feed: FeedView): SlipEval {
  const reasons: string[] = [];
  const legs: LegEval[] = input.legs.map((leg) => {
    const ev = evaluateLeg(leg, feed, input.acceptHigherOdds);
    if (input.mode === 'single') {
      const st = parseStake(leg.stake);
      return { ...ev, stakeError: st.ok ? null : st.error, stakeValue: st.ok ? st.value : null };
    }
    return { ...ev, stakeError: null, stakeValue: null };
  });

  if (legs.length === 0) reasons.push('Купон пуст');
  if (!input.feedHealthy) reasons.push('Нет актуальных данных фида — приём ставок приостановлен');
  if (input.busy) reasons.push('Ставка обрабатывается');

  const unavailable = legs.filter((l) => l.state === 'suspended' || l.state === 'closed' || l.state === 'settled' || l.state === 'unavailable');
  if (unavailable.length > 0) reasons.push(`Недоступно исходов: ${unavailable.length}`);

  const requoteRequired = legs.some((l) => l.needsAcceptance);

  let combined: number | null = null;
  let totalStake = 0;
  let ret: number | null = null;
  let accaStakeError: string | null = null;

  if (input.mode === 'acca') {
    if (legs.length === 1) reasons.push('Для экспресса нужно минимум 2 исхода');
    if (legs.length > MAX_ACCA_LEGS) reasons.push(`Не более ${MAX_ACCA_LEGS} исходов в экспрессе`);
    const events = new Set(legs.map((l) => l.leg.eventId));
    if (events.size !== legs.length) reasons.push('Экспресс: исходы одного события нельзя комбинировать');
    const st = parseStake(input.accaStake);
    accaStakeError = legs.length > 0 && !st.ok ? st.error : null;
    if (legs.length > 0) combined = combinedPrice(legs.map((l) => l.effectivePrice));
    if (st.ok) {
      totalStake = st.value;
      if (combined !== null) ret = potentialReturn(st.value, combined);
    }
  } else {
    let sum = 0;
    let allValid = legs.length > 0;
    for (const l of legs) {
      if (l.stakeValue === null) allValid = false;
      else {
        totalStake += l.stakeValue;
        sum += potentialReturn(l.stakeValue, l.effectivePrice);
      }
    }
    totalStake = round2(totalStake);
    ret = allValid ? round2(sum) : null;
    if (legs.some((l) => l.stakeError !== null)) reasons.push('Проверьте суммы ставок');
  }
  if (accaStakeError) reasons.push(accaStakeError);
  if (ret !== null && ret > MAX_POTENTIAL_RETURN) reasons.push(`Максимальный выигрыш ${MAX_POTENTIAL_RETURN}`);

  return {
    legs,
    mode: input.mode,
    requoteRequired,
    blockingReasons: reasons,
    combinedPrice: combined,
    totalStake,
    potentialReturn: ret,
    accaStakeError,
    canPlace: reasons.length === 0 && !requoteRequired,
  };
}

/** User accepted the current prices: move every open leg to the live price/version. */
export function acceptCurrentPrices(legs: readonly SlipLeg[], feed: FeedView): SlipLeg[] {
  return legs.map((leg) => {
    const s = feed.selections[leg.selectionId];
    const m = feed.markets[leg.marketId];
    if (!s || !m || m.status !== 'open') return leg;
    if (s.priceVersion === leg.priceVersion) return leg;
    return { ...leg, price: s.price, priceVersion: s.priceVersion };
  });
}
