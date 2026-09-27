import { useEffect, useId, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { formatMoney, formatPrice } from '../../domain/odds';
import { evaluateSlip, type FeedView, type LegEval } from '../../domain/slipLogic';
import { useFeedHealth } from '../../hooks/useFeedHealth';
import { useFeedStore } from '../../store/feedStore';
import type { MarketState, SelectionState } from '../../store/feedReducer';
import { rejectText, slipActions, useSlipStore, type Placement } from '../../store/slipStore';
import { metrics } from '../../telemetry/metrics';

const legStateLabel: Record<LegEval['state'], string> = {
  ok: '',
  price_up: 'Коэффициент вырос',
  price_down: 'Коэффициент снизился',
  suspended: 'Рынок приостановлен',
  closed: 'Рынок закрыт',
  settled: 'Рынок рассчитан',
  unavailable: 'Исход недоступен',
};

/** Subscribes only to the markets/selections referenced by the slip. */
function useSlipFeedView(): FeedView {
  const legs = useSlipStore((s) => s.legs);
  const sels = useFeedStore(useShallow((s) => legs.map((l) => s.selections[l.selectionId])));
  const mkts = useFeedStore(useShallow((s) => legs.map((l) => s.markets[l.marketId])));
  return useMemo(() => {
    const selections: Record<string, SelectionState> = {};
    const markets: Record<string, MarketState> = {};
    for (const s of sels) if (s) selections[s.id] = s;
    for (const m of mkts) if (m) markets[m.id] = m;
    return { selections, markets };
  }, [sels, mkts]);
}

export function BetSlip() {
  const legs = useSlipStore((s) => s.legs);
  const mode = useSlipStore((s) => s.mode);
  const accaStake = useSlipStore((s) => s.accaStake);
  const acceptHigherOdds = useSlipStore((s) => s.acceptHigherOdds);
  const placements = useSlipStore((s) => s.placements);
  const serverQuotes = useSlipStore((s) => s.serverQuotes);
  const announcement = useSlipStore((s) => s.announcement);
  const sheetOpen = useSlipStore((s) => s.sheetOpen);
  const feed = useSlipFeedView();
  const health = useFeedHealth();
  const busy = placements.some((p) => p.status === 'pending');
  const reasonsId = useId();

  const evaluation = useMemo(
    () => evaluateSlip({ legs, mode, accaStake, acceptHigherOdds, feedHealthy: health.healthy, busy }, feed),
    [legs, mode, accaStake, acceptHigherOdds, health.healthy, busy, feed],
  );

  const serverRequote = legs.some((l) => {
    const q = serverQuotes[l.selectionId];
    return q !== undefined && q.priceVersion !== null && q.priceVersion !== l.priceVersion;
  });
  const requote = evaluation.requoteRequired || serverRequote;
  const canPlace = evaluation.canPlace && !serverRequote;

  // aria-live: announce price changes of slip legs once per new version.
  const announced = useRef<Record<string, number>>({});
  useEffect(() => {
    const msgs: string[] = [];
    for (const l of evaluation.legs) {
      const v = l.currentVersion;
      if (v === null || l.currentPrice === null) continue;
      const prev = announced.current[l.leg.selectionId];
      announced.current[l.leg.selectionId] = v;
      if (prev !== undefined && prev !== v && l.currentPrice !== l.leg.price) {
        msgs.push(`${l.leg.selectionName}: коэффициент ${formatPrice(l.leg.price)} → ${formatPrice(l.currentPrice)}`);
      }
    }
    if (msgs.length > 0) slipActions.announce(msgs.join('. '));
  }, [evaluation.legs]);

  // Telemetry: count how often the user is forced into a requote.
  const wasRequote = useRef(false);
  useEffect(() => {
    if (requote && !wasRequote.current) metrics.inc('requotePrompts');
    wasRequote.current = requote;
  }, [requote]);

  const hasUnavailable = evaluation.legs.some((l) => l.state === 'closed' || l.state === 'settled' || l.state === 'unavailable');

  return (
    <aside className={`slip${sheetOpen ? ' slip--open' : ''}`} aria-labelledby="slip-title">
      {/* Outside the collapsible body so announcements work with the mobile sheet collapsed. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="slip-live">
        {announcement}
      </div>
      <button
        type="button"
        className="slip__handle"
        aria-expanded={sheetOpen}
        aria-controls="slip-body"
        onClick={() => slipActions.setSheetOpen(!sheetOpen)}
      >
        <span>Купон ({legs.length})</span>
        {evaluation.combinedPrice !== null && mode === 'acca' ? <span>× {formatPrice(evaluation.combinedPrice)}</span> : null}
        {requote ? <span className="badge badge--repriced">Требуется подтверждение</span> : null}
        <span aria-hidden="true">{sheetOpen ? '▾' : '▴'}</span>
      </button>

      <div id="slip-body" className="slip__body">
        <h2 id="slip-title" className="section-title">
          Купон
        </h2>

        <div className="segmented" role="radiogroup" aria-label="Тип ставки">
          <button type="button" role="radio" aria-checked={mode === 'single'} onClick={() => slipActions.setMode('single')}>
            Одиночные
          </button>
          <button type="button" role="radio" aria-checked={mode === 'acca'} onClick={() => slipActions.setMode('acca')}>
            Экспресс
          </button>
        </div>

        {legs.length === 0 ? (
          <p className="muted">Выберите коэффициент в линии, чтобы добавить исход.</p>
        ) : (
          <ul className="slip__legs">
            {evaluation.legs.map((l) => (
              <LegItem key={l.leg.selectionId} ev={l} mode={mode} disabled={busy} />
            ))}
          </ul>
        )}

        {hasUnavailable ? (
          <button type="button" className="link" onClick={() => slipActions.removeUnavailable(feed)}>
            Удалить недоступные исходы
          </button>
        ) : null}

        {mode === 'acca' && legs.length > 0 ? (
          <label className="field">
            <span>Сумма экспресса</span>
            <input
              inputMode="decimal"
              value={accaStake}
              onChange={(e) => slipActions.setAccaStake(e.target.value)}
              aria-invalid={evaluation.accaStakeError !== null}
              disabled={busy}
            />
          </label>
        ) : null}

        <label className="checkbox">
          <input type="checkbox" checked={acceptHigherOdds} onChange={(e) => slipActions.setAcceptHigherOdds(e.target.checked)} />
          <span>Принимать повышение коэффициентов автоматически</span>
        </label>

        {legs.length > 0 ? (
          <dl className="slip__summary">
            {mode === 'acca' ? (
              <>
                <dt>Общий коэффициент</dt>
                <dd data-testid="acca-price">{evaluation.combinedPrice !== null ? formatPrice(evaluation.combinedPrice) : '—'}</dd>
              </>
            ) : null}
            <dt>Сумма</dt>
            <dd>{formatMoney(evaluation.totalStake)}</dd>
            <dt>Возможный выигрыш</dt>
            <dd data-testid="potential-return">{evaluation.potentialReturn !== null ? formatMoney(evaluation.potentialReturn) : '—'}</dd>
          </dl>
        ) : null}

        {requote ? (
          <div className="requote" role="alert">
            <p>
              <strong>Коэффициенты изменились.</strong> Ставка не будет отправлена по новой цене без вашего подтверждения.
            </p>
            <ul>
              {evaluation.legs
                .filter((l) => l.needsAcceptance || serverQuotes[l.leg.selectionId])
                .map((l) => {
                  const q = serverQuotes[l.leg.selectionId];
                  const next = q?.price != null && (l.currentVersion === null || (q.priceVersion ?? 0) > l.currentVersion) ? q.price : l.currentPrice;
                  return (
                    <li key={l.leg.selectionId}>
                      {l.leg.selectionName}: {formatPrice(l.leg.price)} → <strong>{next !== null ? formatPrice(next) : '—'}</strong>
                    </li>
                  );
                })}
            </ul>
            <button type="button" className="btn btn--warn" onClick={() => slipActions.acceptPrices(feed)} disabled={busy}>
              Принять новые коэффициенты
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={!canPlace}
          aria-describedby={canPlace ? undefined : reasonsId}
          onClick={() => void slipActions.place(evaluation)}
        >
          {busy ? 'Отправка…' : mode === 'acca' ? 'Сделать экспресс' : `Сделать ставки (${legs.length})`}
        </button>
        {!canPlace && legs.length > 0 ? (
          <ul id={reasonsId} className="slip__reasons">
            {requote ? <li>Подтвердите изменившиеся коэффициенты</li> : null}
            {evaluation.blockingReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}

        {placements.length > 0 ? <Placements placements={placements} /> : null}
      </div>
    </aside>
  );
}

function LegItem({ ev, mode, disabled }: { ev: LegEval; mode: 'single' | 'acca'; disabled: boolean }) {
  const { leg, state } = ev;
  const changed = state === 'price_up' || state === 'price_down';
  return (
    <li className={`leg leg--${state}`} data-testid={`leg-${leg.selectionId}`}>
      <div className="leg__top">
        <span className="leg__sel">{leg.selectionName}</span>
        <span className="leg__price">
          {changed && ev.currentPrice !== null ? (
            <>
              <s aria-label={`было ${formatPrice(leg.price)}`}>{formatPrice(leg.price)}</s>{' '}
              <strong className={state === 'price_up' ? 'up' : 'down'}>{formatPrice(ev.currentPrice)}</strong>
            </>
          ) : (
            formatPrice(leg.price)
          )}
        </span>
        <button type="button" className="icon-btn" aria-label={`Удалить ${leg.selectionName}`} onClick={() => slipActions.remove(leg.selectionId)} disabled={disabled}>
          ×
        </button>
      </div>
      <div className="leg__meta muted">
        {leg.eventName} · {leg.marketName}
      </div>
      {state !== 'ok' ? <div className={`leg__state leg__state--${state}`}>{legStateLabel[state]}{state === 'price_up' && !ev.needsAcceptance ? ' — будет принят по новой цене' : ''}</div> : null}
      {mode === 'single' ? (
        <label className="field field--inline">
          <span>Сумма</span>
          <input
            inputMode="decimal"
            value={leg.stake}
            onChange={(e) => slipActions.setStake(leg.selectionId, e.target.value)}
            aria-invalid={ev.stakeError !== null}
            aria-label={`Сумма ставки на ${leg.selectionName}`}
            disabled={disabled}
          />
          {ev.stakeError ? <span className="error">{ev.stakeError}</span> : null}
        </label>
      ) : null}
    </li>
  );
}

const placementLabel: Record<Placement['status'], string> = {
  pending: 'Ожидает подтверждения',
  accepted: 'Принята',
  rejected: 'Отклонена',
  error: 'Ошибка сети',
};

function Placements({ placements }: { placements: Placement[] }) {
  return (
    <section className="placements" aria-label="История ставок">
      <h3 className="subsection-title">Ставки</h3>
      <ul>
        {placements.map((p) => (
          <li key={p.key} className={`placement placement--${p.status}`} data-testid={`placement-${p.status}`}>
            <div className="placement__row">
              <span className={`badge badge--${p.status}`}>{placementLabel[p.status]}</span>
              <span>
                {p.request.betType === 'acca' ? `Экспресс ×${p.legs.length}` : p.legs[0]?.selectionName} · {formatMoney(p.request.stake)}
              </span>
              {p.status !== 'pending' ? (
                <button type="button" className="icon-btn" aria-label="Скрыть" onClick={() => slipActions.dismissPlacement(p.key)}>
                  ×
                </button>
              ) : null}
            </div>
            {p.response?.status === 'accepted' ? (
              <div className="muted">
                Коэф. {formatPrice(p.response.combinedPrice)} · выигрыш {formatMoney(p.response.potentialReturn)} · {p.response.betId.slice(0, 12)}
              </div>
            ) : null}
            {p.response?.status === 'rejected' ? <div className="error">{rejectText(p.response.reason)}</div> : null}
            {p.status === 'error' ? (
              <div>
                <span className="error">{p.error}</span>{' '}
                {p.retryable ? (
                  <button type="button" className="link" onClick={() => void slipActions.retry(p.key)} title={`idempotency key ${p.key}`}>
                    Повторить (тот же ключ)
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
