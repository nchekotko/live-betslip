/**
 * In-play football pricing model.
 *
 * Remaining goals for each side are independent Poisson variables with
 * intensity lambda * remainingMinutes / 90. Fair probabilities for all three
 * markets are computed from the joint distribution of final scores, then a
 * bookmaker margin is applied and prices are floored to a tick ladder.
 */

export interface ModelInput {
  /** Expected goals per 90 minutes for the home side. */
  lambdaHome: number;
  lambdaAway: number;
  minute: number;
  score: { home: number; away: number };
}

export interface FairProbabilities {
  home: number;
  draw: number;
  away: number;
  over25: number;
  under25: number;
  bttsYes: number;
  bttsNo: number;
}

const MAX_GOALS = 12;
export const MIN_PRICE = 1.01;
export const MAX_PRICE = 101;

export function poissonPmf(lambda: number, kMax = MAX_GOALS): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= kMax; k++) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  return out;
}

export function fairProbabilities(input: ModelInput): FairProbabilities {
  const remaining = Math.max(0, 90 - input.minute) / 90;
  const ph = poissonPmf(input.lambdaHome * remaining);
  const pa = poissonPmf(input.lambdaAway * remaining);
  const { home: sh, away: sa } = input.score;

  let home = 0;
  let draw = 0;
  let away = 0;
  let over = 0;
  for (let i = 0; i < ph.length; i++) {
    for (let j = 0; j < pa.length; j++) {
      const p = (ph[i] ?? 0) * (pa[j] ?? 0);
      const fh = sh + i;
      const fa = sa + j;
      if (fh > fa) home += p;
      else if (fh === fa) draw += p;
      else away += p;
      if (fh + fa > 2.5) over += p;
    }
  }
  // Renormalise to absorb the truncated Poisson tail.
  const total = home + draw + away;
  home /= total;
  draw /= total;
  away /= total;
  over /= total;

  const homeScores = sh > 0 ? 1 : 1 - (ph[0] ?? 0);
  const awayScores = sa > 0 ? 1 : 1 - (pa[0] ?? 0);
  const bttsYes = homeScores * awayScores;

  return {
    home,
    draw,
    away,
    over25: over,
    under25: 1 - over,
    bttsYes,
    bttsNo: 1 - bttsYes,
  };
}

/** Tick ladder: finer steps at short prices, coarser at long prices. */
export function ladderStep(price: number): number {
  if (price < 2) return 0.01;
  if (price < 3) return 0.02;
  if (price < 4) return 0.05;
  if (price < 6) return 0.1;
  if (price < 10) return 0.2;
  if (price < 20) return 0.5;
  if (price < 50) return 1;
  return 2;
}

/** Floors a raw price to the ladder (rounding in the book's favour). */
export function toLadder(raw: number): number {
  const clamped = Math.min(MAX_PRICE, Math.max(MIN_PRICE, raw));
  const step = ladderStep(clamped);
  const floored = Math.floor(clamped / step + 1e-9) * step;
  return Math.max(MIN_PRICE, Number(floored.toFixed(2)));
}

/** Fair probability -> offered decimal price with a proportional margin. */
export function priceFromProbability(p: number, margin: number): number {
  if (p <= 0) return MAX_PRICE;
  return toLadder(1 / (p * (1 + margin)));
}
