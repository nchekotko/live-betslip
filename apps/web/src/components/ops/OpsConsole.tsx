import { memo, useCallback, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { detectAnomaly, isAnomalous, type AnomalyThresholds } from '../../domain/anomalies';
import { formatPrice } from '../../domain/odds';
import { marketViewLabel } from '../../domain/marketView';
import { useNow } from '../../hooks/useNow';
import { useFeedStore } from '../../store/feedStore';
import type { FeedData } from '../../store/feedReducer';
import { opsActions, useOpsStore, validateOpsRequest, type StatusFilter } from '../../store/opsStore';
import { VirtualList } from '../VirtualList';
import { AuditTrail } from './AuditTrail';

export const OPS_ROW_HEIGHT = 44;

export interface OpsFilter {
  text: string;
  status: StatusFilter;
  onlyAnomalies: boolean;
  thresholds: AnomalyThresholds;
}

/** Pure filter used by the table (and tests). */
export function filterMarkets(feed: Pick<FeedData, 'marketOrder' | 'markets' | 'events'>, f: OpsFilter, now: number): string[] {
  const q = f.text.trim().toLowerCase();
  return feed.marketOrder.filter((id) => {
    const m = feed.markets[id];
    if (!m) return false;
    if (f.status !== 'all' && m.status !== f.status) return false;
    if (q) {
      const e = feed.events[m.eventId];
      const hay = `${e?.home ?? ''} ${e?.away ?? ''} ${e?.competition ?? ''} ${m.name} ${m.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.onlyAnomalies && !isAnomalous(detectAnomaly(m, now, f.thresholds))) return false;
    return true;
  });
}

const OpsRow = memo(function OpsRow({ marketId, now, thresholds }: { marketId: string; now: number; thresholds: AnomalyThresholds }) {
  const m = useFeedStore((s) => s.markets[marketId]);
  const ev = useFeedStore((s) => (m ? s.events[m.eventId] : undefined));
  // Shallow-compared list of this market's selections: re-render only when one of them changes.
  const sels = useFeedStore(useShallow((s) => (m ? m.selectionIds.map((id) => s.selections[id]) : [])));
  const selected = useOpsStore((s) => s.selected[marketId] === true);
  if (!m) return null;
  const a = detectAnomaly(m, now, thresholds);
  const prices = sels
    .map((s) => (s ? `${s.name} ${formatPrice(s.price)}` : ''))
    .join(' · ');
  return (
    <div
      role="row"
      className={`ops-row${selected ? ' ops-row--selected' : ''}${a.priceJump ? ' ops-row--jump' : ''}${a.stale ? ' ops-row--stale' : ''}`}
      aria-selected={selected}
      data-testid={`ops-row-${marketId}`}
    >
      <div role="cell" className="ops-cell ops-cell--check">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => opsActions.toggleSelected(marketId)}
          aria-label={`Выбрать ${ev ? `${ev.home} — ${ev.away}` : m.eventId}, ${m.name}`}
        />
      </div>
      <div role="cell" className="ops-cell ops-cell--event">
        {ev ? `${ev.home} — ${ev.away}` : m.eventId}
        <span className="muted"> {ev ? `${ev.score.home}:${ev.score.away} ${ev.minute}'` : ''}</span>
      </div>
      <div role="cell" className="ops-cell">{m.name}</div>
      <div role="cell" className="ops-cell">
        <span className={`badge badge--${m.status}`} title={m.suspendReason ?? undefined}>
          {marketViewLabel[m.status]}
        </span>
        {m.suspendReason ? <span className="muted ops-reason"> {m.suspendReason}</span> : null}
      </div>
      <div role="cell" className="ops-cell ops-cell--prices">{prices}</div>
      <div role="cell" className={`ops-cell ops-cell--num${a.priceJump ? ' warn' : ''}`}>{a.movePct > 0 ? `${a.movePct}%` : '—'}</div>
      <div role="cell" className={`ops-cell ops-cell--num${a.stale ? ' warn' : ''}`}>{a.ageSec}s</div>
      <div role="cell" className="ops-cell">{m.cashOutAvailable ? 'да' : 'нет'}</div>
      <div role="cell" className="ops-cell">
        {a.priceJump ? <span className="badge badge--jump">скачок</span> : null}
        {a.stale ? <span className="badge badge--stale">нет обновлений</span> : null}
      </div>
    </div>
  );
});

export function OpsConsole() {
  const now = useNow(1000);
  const marketOrder = useFeedStore((s) => s.marketOrder);
  const markets = useFeedStore((s) => s.markets);
  const events = useFeedStore((s) => s.events);
  const text = useOpsStore((s) => s.text);
  const status = useOpsStore((s) => s.status);
  const onlyAnomalies = useOpsStore((s) => s.onlyAnomalies);
  const thresholds = useOpsStore((s) => s.thresholds);
  const selected = useOpsStore((s) => s.selected);
  const reason = useOpsStore((s) => s.reason);
  const actor = useOpsStore((s) => s.actor);
  const pending = useOpsStore((s) => s.pending);
  const lastResult = useOpsStore((s) => s.lastResult);
  const error = useOpsStore((s) => s.error);

  useEffect(() => {
    void opsActions.loadAudit();
    const id = setInterval(() => void opsActions.loadAudit(), 5000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(
    () => filterMarkets({ marketOrder, markets, events }, { text, status, onlyAnomalies, thresholds }, now),
    [marketOrder, markets, events, text, status, onlyAnomalies, thresholds, now],
  );
  const anomalyCount = useMemo(
    () => marketOrder.filter((id) => {
      const m = markets[id];
      return m ? isAnomalous(detectAnomaly(m, now, thresholds)) : false;
    }).length,
    [marketOrder, markets, now, thresholds],
  );

  const selectedIds = Object.keys(selected);
  const allFilteredSelected = filtered.length > 0 && filtered.every((id) => selected[id]);
  const validation = validateOpsRequest(selectedIds, reason, actor);

  const getKey = useCallback((i: number) => filtered[i] ?? `r${i}`, [filtered]);
  const renderRow = useCallback(
    (i: number) => {
      const id = filtered[i];
      return id ? <OpsRow marketId={id} now={now} thresholds={thresholds} /> : null;
    },
    [filtered, now, thresholds],
  );

  return (
    <section className="ops" aria-labelledby="ops-title">
      <h2 id="ops-title" className="section-title">
        Операции с рынками <span className="muted">· {marketOrder.length} рынков · аномалий: {anomalyCount}</span>
      </h2>

      <div className="ops-toolbar" role="search">
        <label className="field">
          <span>Поиск</span>
          <input value={text} onChange={(e) => opsActions.setText(e.target.value)} placeholder="команда, турнир, рынок" />
        </label>
        <label className="field">
          <span>Статус</span>
          <select value={status} onChange={(e) => opsActions.setStatus(e.target.value as StatusFilter)}>
            <option value="all">все</option>
            <option value="open">открыт</option>
            <option value="suspended">приостановлен</option>
            <option value="closed">закрыт</option>
            <option value="settled">рассчитан</option>
          </select>
        </label>
        <label className="field field--narrow">
          <span>Скачок, %</span>
          <input
            type="number"
            min={1}
            max={500}
            value={thresholds.jumpPct}
            onChange={(e) => opsActions.setThresholds({ jumpPct: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
        <label className="field field--narrow">
          <span>Нет обновлений, с</span>
          <input
            type="number"
            min={1}
            max={600}
            value={thresholds.staleSec}
            onChange={(e) => opsActions.setThresholds({ staleSec: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={onlyAnomalies} onChange={(e) => opsActions.setOnlyAnomalies(e.target.checked)} />
          <span>Только аномалии</span>
        </label>
      </div>

      <form
        className="ops-bulk"
        aria-label="Массовые действия"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <span>
          Выбрано: <strong data-testid="selected-count">{selectedIds.length}</strong>
        </span>
        <label className="field field--grow">
          <span>Причина (обязательно)</span>
          <input
            value={reason}
            onChange={(e) => opsActions.setReason(e.target.value)}
            placeholder="например: integrity alert, проверка трейдером"
            aria-required="true"
            aria-invalid={reason.length > 0 && reason.trim().length < 5}
          />
        </label>
        <label className="field field--narrow">
          <span>Оператор</span>
          <input value={actor} onChange={(e) => opsActions.setActor(e.target.value)} />
        </label>
        <button type="button" className="btn btn--warn" disabled={validation !== null || pending !== null} onClick={() => void opsActions.submit('suspend')}>
          {pending === 'suspend' ? 'Приостановка…' : 'Приостановить'}
        </button>
        <button type="button" className="btn" disabled={validation !== null || pending !== null} onClick={() => void opsActions.submit('resume')}>
          {pending === 'resume' ? 'Возобновление…' : 'Возобновить'}
        </button>
        {selectedIds.length > 0 ? (
          <button type="button" className="link" onClick={() => opsActions.clearSelection()}>
            Снять выделение
          </button>
        ) : null}
        <div className="ops-bulk__status" role="status" aria-live="polite">
          {validation && selectedIds.length > 0 ? <span className="muted">{validation}</span> : null}
          {error ? <span className="error">{error}</span> : null}
          {lastResult ? (
            <span>
              {lastResult.action === 'suspend' ? 'Приостановлено' : 'Возобновлено'}: {lastResult.affected.length}
              {lastResult.skipped.length > 0 ? `, пропущено: ${lastResult.skipped.length} (${[...new Set(lastResult.skipped.map((s) => s.reason))].join(', ')})` : ''}
              {' · '}статус в таблице обновится по фиду
            </span>
          ) : null}
        </div>
      </form>

      <div className="ops-table" role="table" aria-label="Рынки" aria-rowcount={filtered.length + 1}>
        <div role="row" className="ops-row ops-row--head">
          <div role="columnheader" className="ops-cell ops-cell--check">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={(e) => opsActions.setSelectedMany(filtered, e.target.checked)}
              aria-label="Выбрать все отфильтрованные"
            />
          </div>
          <div role="columnheader" className="ops-cell ops-cell--event">Событие</div>
          <div role="columnheader" className="ops-cell">Рынок</div>
          <div role="columnheader" className="ops-cell">Статус</div>
          <div role="columnheader" className="ops-cell ops-cell--prices">Цены</div>
          <div role="columnheader" className="ops-cell ops-cell--num">Δ посл.</div>
          <div role="columnheader" className="ops-cell ops-cell--num">Возраст</div>
          <div role="columnheader" className="ops-cell">Cash-out</div>
          <div role="columnheader" className="ops-cell">Аномалии</div>
        </div>
        <VirtualList
          className="ops-table__body"
          count={filtered.length}
          rowHeight={OPS_ROW_HEIGHT}
          height={420}
          threshold={40}
          getKey={getKey}
          renderRow={renderRow}
          role="rowgroup"
        />
      </div>

      <AuditTrail />
    </section>
  );
}
