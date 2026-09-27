import { STAKE_MAX, STAKE_MIN } from '@live-betslip/protocol';

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function formatPrice(p: number): string {
  return p.toFixed(2);
}

export function formatMoney(x: number): string {
  return x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Accumulator price = product of leg prices, rounded to 2 decimals (same as the server). */
export function combinedPrice(prices: readonly number[]): number {
  return round2(prices.reduce((acc, p) => acc * p, 1));
}

export function potentialReturn(stake: number, price: number): number {
  return round2(stake * price);
}

export type StakeParse = { ok: true; value: number } | { ok: false; error: string };

/** Parses user input: "10", "10.5", "10,50". Max two decimals, bounded. */
export function parseStake(input: string): StakeParse {
  const s = input.trim().replace(',', '.');
  if (s === '') return { ok: false, error: 'Введите сумму' };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Сумма: число, не более 2 знаков после запятой' };
  const value = Number(s);
  if (value < STAKE_MIN) return { ok: false, error: `Минимальная ставка ${STAKE_MIN}` };
  if (value > STAKE_MAX) return { ok: false, error: `Максимальная ставка ${STAKE_MAX}` };
  return { ok: true, value };
}
