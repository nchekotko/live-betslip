import { memo, useCallback } from 'react';
import { formatPrice } from '../domain/odds';
import type { MarketView } from '../domain/marketView';
import { useFeedStore } from '../store/feedStore';
import { slipActions, useSlipStore } from '../store/slipStore';

interface Props {
  selectionId: string;
  view: MarketView;
  navRow?: number;
  navCol?: number;
}

/**
 * One price. Subscribes to exactly one selection, so a tick elsewhere does not
 * re-render it. The flash animation restarts by re-keying the inner span on
 * every priceVersion (pure CSS, no timers per button).
 */
export const PriceButton = memo(function PriceButton({ selectionId, view, navRow, navCol }: Props) {
  const sel = useFeedStore((s) => s.selections[selectionId]);
  const inSlip = useSlipStore((s) => s.legs.some((l) => l.selectionId === selectionId));

  const onClick = useCallback(() => {
    const st = useFeedStore.getState();
    const s = st.selections[selectionId];
    if (!s) return;
    const m = st.markets[s.marketId];
    const e = st.events[s.eventId];
    if (!m || m.status !== 'open') return;
    slipActions.toggle({
      selectionId: s.id,
      marketId: m.id,
      eventId: s.eventId,
      eventName: e ? `${e.home} — ${e.away}` : s.eventId,
      marketName: m.name,
      selectionName: s.name,
      price: s.price,
      priceVersion: s.priceVersion,
    });
  }, [selectionId]);

  if (!sel) return null;

  const tradable = view === 'open' || view === 'repriced';
  const settledClass = sel.result === 'win' ? ' price--win' : sel.result === 'lose' ? ' price--lose' : '';
  const dirLabel = sel.direction === 'up' ? ', вырос' : sel.direction === 'down' ? ', снизился' : '';
  const stateLabel = tradable ? '' : view === 'suspended' ? ', приостановлен' : view === 'settled' ? (sel.result === 'win' ? ', выиграл' : ', проиграл') : ', закрыт';

  return (
    <button
      type="button"
      className={`price${inSlip ? ' price--selected' : ''}${tradable ? '' : ' price--locked'}${settledClass}`}
      onClick={onClick}
      disabled={!tradable}
      aria-pressed={inSlip}
      aria-label={`${sel.name}: ${formatPrice(sel.price)}${dirLabel}${stateLabel}`}
      data-nav-row={navRow}
      data-nav-col={navCol}
      data-testid={`price-${selectionId}`}
    >
      <span className="price__name">{sel.name}</span>
      <span
        key={sel.priceVersion}
        className={`price__value${sel.direction && sel.changedAt > 0 ? ` flash-${sel.direction}` : ''}`}
      >
        {tradable || sel.result === null ? formatPrice(sel.price) : sel.result === 'win' ? '✓' : '✗'}
        {sel.direction && sel.changedAt > 0 && tradable ? (
          <span className={`price__arrow price__arrow--${sel.direction}`} aria-hidden="true">
            {sel.direction === 'up' ? '▲' : '▼'}
          </span>
        ) : null}
      </span>
    </button>
  );
});
