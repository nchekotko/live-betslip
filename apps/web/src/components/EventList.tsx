import { memo, useCallback, type KeyboardEvent } from 'react';
import { config } from '../config';
import { deriveMarketView, marketViewLabel } from '../domain/marketView';
import { useRerenderAt } from '../hooks/useNow';
import { useFeedStore } from '../store/feedStore';
import { PriceButton } from './PriceButton';
import { VirtualList } from './VirtualList';

export const EVENT_ROW_HEIGHT = 124;

const MarketGroup = memo(function MarketGroup({ marketId, navRow, navColStart }: { marketId: string; navRow: number; navColStart: number }) {
  const m = useFeedStore((s) => s.markets[marketId]);
  const repricedUntil = m?.repricedAt != null ? m.repricedAt + config.repricedBadgeMs : null;
  useRerenderAt(repricedUntil);
  if (!m) return null;
  const view = deriveMarketView(m, Date.now(), config.repricedBadgeMs);
  return (
    <div className={`market market--${view}`} role="group" aria-label={`${m.name}: ${marketViewLabel[view]}`}>
      <div className="market__head">
        <span className="market__name">{m.name}</span>
        {view !== 'open' ? (
          <span className={`badge badge--${view}`} title={m.suspendReason ?? undefined}>
            {marketViewLabel[view]}
            {view === 'suspended' && m.suspendReason ? `: ${m.suspendReason}` : ''}
          </span>
        ) : null}
        {!m.cashOutAvailable && (view === 'open' || view === 'repriced') ? (
          <span className="badge badge--cashout" title="Cash-out недоступен">Cash-out недоступен</span>
        ) : null}
      </div>
      <div className="market__prices">
        {m.selectionIds.map((id, i) => (
          <PriceButton key={id} selectionId={id} view={view} navRow={navRow} navCol={navColStart + i} />
        ))}
      </div>
    </div>
  );
});

export const EventRow = memo(function EventRow({ eventId, index }: { eventId: string; index: number }) {
  const ev = useFeedStore((s) => s.events[eventId]);
  const marketIds = useFeedStore((s) => s.marketsByEvent[eventId]);
  if (!ev) return null;
  let col = 0;
  return (
    <article className={`event${ev.status === 'ended' ? ' event--ended' : ''}`} aria-label={`${ev.home} — ${ev.away}`}>
      <header className="event__head">
        <span className="event__comp">{ev.competition}</span>
        <span className="event__teams">
          {ev.home} <strong className="event__score">{ev.score.home}:{ev.score.away}</strong> {ev.away}
        </span>
        <span className={`event__minute${ev.status === 'ended' ? ' event__minute--ended' : ''}`}>
          {ev.status === 'ended' ? 'Завершён' : `${ev.minute}'`}
        </span>
      </header>
      <div className="event__markets">
        {(marketIds ?? []).map((id) => {
          const start = col;
          col += 3;
          return <MarketGroup key={id} marketId={id} navRow={index} navColStart={start} />;
        })}
      </div>
    </article>
  );
});

/**
 * Arrow-key navigation across the price grid. Buttons carry data-nav-row /
 * data-nav-col; disabled buttons are skipped.
 */
export function handleGridKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const target = e.target as HTMLElement;
  const row = Number(target.dataset.navRow);
  const col = Number(target.dataset.navCol);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return;
  const root = e.currentTarget;
  const enabled = (r: number) =>
    [...root.querySelectorAll<HTMLButtonElement>(`button[data-nav-row="${r}"]:not(:disabled)`)].sort(
      (a, b) => Number(a.dataset.navCol) - Number(b.dataset.navCol),
    );
  let next: HTMLButtonElement | undefined;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const inRow = enabled(row);
    const idx = inRow.findIndex((b) => b === target);
    next = inRow[e.key === 'ArrowRight' ? idx + 1 : idx - 1];
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    for (let r = row + dir, guard = 0; guard < 50; r += dir, guard++) {
      const candidates = enabled(r);
      if (candidates.length === 0) {
        if (!root.querySelector(`[data-nav-row="${r}"]`)) break;
        continue;
      }
      next = candidates.reduce((best, b) =>
        Math.abs(Number(b.dataset.navCol) - col) < Math.abs(Number(best.dataset.navCol) - col) ? b : best,
      );
      break;
    }
  } else {
    return;
  }
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

export function EventList() {
  const eventOrder = useFeedStore((s) => s.eventOrder);
  const hydrated = useFeedStore((s) => s.hydrated);
  const getKey = useCallback((i: number) => eventOrder[i] ?? `row-${i}`, [eventOrder]);
  const renderRow = useCallback(
    (i: number) => {
      const id = eventOrder[i];
      return id ? <EventRow eventId={id} index={i} /> : null;
    },
    [eventOrder],
  );

  if (!hydrated) return <p className="muted" role="status">Загрузка линии…</p>;
  if (eventOrder.length === 0) return <p className="muted">Нет событий в лайве</p>;

  return (
    <section className="events" aria-labelledby="events-title" onKeyDown={handleGridKeyDown}>
      <h2 id="events-title" className="section-title">
        Лайв <span className="muted">· {eventOrder.length} событий · стрелки ←↑→↓ для навигации</span>
      </h2>
      <VirtualList
        className="events__list"
        count={eventOrder.length}
        rowHeight={EVENT_ROW_HEIGHT}
        height="calc(100dvh - 190px)"
        threshold={30}
        getKey={getKey}
        renderRow={renderRow}
        role="list"
        ariaLabel="Список событий"
      />
    </section>
  );
}
