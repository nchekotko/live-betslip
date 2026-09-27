import type { MarketState } from '../store/feedReducer';

/**
 * Ages are computed from the server timestamp of the last market change, so a
 * snapshot resync does not hide a stale market. Assumes client and server
 * clocks are roughly in sync (true for the local demo; see README).
 */
export interface AnomalyThresholds {
  /** Highlight if the last price update moved any selection by more than this (percent). */
  jumpPct: number;
  /** Highlight an open market that has not updated for this many seconds. */
  staleSec: number;
}

export const defaultThresholds: AnomalyThresholds = { jumpPct: 15, staleSec: 10 };

/** Jumps older than this are no longer highlighted. */
export const JUMP_MEMORY_MS = 30_000;

export interface Anomaly {
  priceJump: boolean;
  stale: boolean;
  movePct: number;
  ageSec: number;
}

export function detectAnomaly(
  m: Pick<MarketState, 'status' | 'lastMovePct' | 'updatedAt'>,
  now: number,
  t: AnomalyThresholds,
): Anomaly {
  const ageMs = Math.max(0, now - m.updatedAt);
  const movePct = Math.round(m.lastMovePct * 1000) / 10;
  return {
    priceJump: movePct > t.jumpPct && ageMs < JUMP_MEMORY_MS,
    stale: m.status === 'open' && ageMs >= t.staleSec * 1000,
    movePct,
    ageSec: Math.floor(ageMs / 1000),
  };
}

export function isAnomalous(a: Anomaly): boolean {
  return a.priceJump || a.stale;
}
