import type { MarketState } from '../store/feedReducer';

/**
 * What the user sees for a market. `repriced` is client-derived: the market
 * reopened after a suspension with different prices than before it.
 */
export type MarketView = 'open' | 'suspended' | 'repriced' | 'closed' | 'settled';

export function deriveMarketView(m: Pick<MarketState, 'status' | 'repricedAt'>, now: number, repricedBadgeMs: number): MarketView {
  if (m.status === 'open' && m.repricedAt !== null && now - m.repricedAt < repricedBadgeMs) return 'repriced';
  return m.status;
}

export const marketViewLabel: Record<MarketView, string> = {
  open: 'Открыт',
  suspended: 'Приостановлен',
  repriced: 'Переоценён',
  closed: 'Закрыт',
  settled: 'Рассчитан',
};
