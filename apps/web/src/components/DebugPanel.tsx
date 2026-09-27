import { useEffect, useState } from 'react';
import type { ChaosState } from '@live-betslip/protocol';
import { getChaos, setChaos } from '../api/http';
import { getFeedClient } from '../feed/connection';
import { useFeedStore } from '../store/feedStore';
import { metrics, type MetricsSnapshot } from '../telemetry/metrics';

function fmt(v: number | null, suffix = ''): string {
  return v === null ? '—' : `${v}${suffix}`;
}

export function DebugPanel({ onClose }: { onClose: () => void }) {
  const [snap, setSnap] = useState<MetricsSnapshot>(() => metrics.snapshot());
  const [buffered, setBuffered] = useState(0);
  const [chaos, setChaosState] = useState<ChaosState | null>(null);
  const [chaosError, setChaosError] = useState<string | null>(null);
  const connection = useFeedStore((s) => s.connection);
  const lastSeq = useFeedStore((s) => s.lastSeq);

  useEffect(() => {
    const id = setInterval(() => {
      setSnap(metrics.snapshot());
      setBuffered(getFeedClient()?.sequencer.buffered ?? 0);
    }, 500);
    getChaos().then(setChaosState, (e: Error) => setChaosError(e.message));
    return () => clearInterval(id);
  }, []);

  const update = (patch: Parameters<typeof setChaos>[0]) => {
    setChaos(patch).then(
      (s) => {
        setChaosState(s);
        setChaosError(null);
      },
      (e: Error) => setChaosError(e.message),
    );
  };

  const rows: [string, string][] = [
    ['Соединение', connection],
    ['lastSeq', fmt(lastSeq)],
    ['Буфер переупорядочивания', String(buffered)],
    ['WS lag (последний)', fmt(snap.lagLastMs, ' мс')],
    ['WS lag p50 / p95', `${fmt(snap.lagP50Ms)} / ${fmt(snap.lagP95Ms, ' мс')}`],
    ['Сообщений/с', String(snap.messagesPerSec)],
    ['Кадров (rAF) / средний батч', `${snap.frames} / ${fmt(snap.avgBatchSize)}`],
    ['Переподключений', String(snap.reconnects)],
    ['Resync / snapshots', `${snap.resyncs} / ${snap.snapshots}`],
    ['Отброшено дублей/поздних', String(snap.droppedDeltas)],
    ['Восстановлено перестановок', String(snap.reorderedWindows)],
    ['Невалидных сообщений', String(snap.invalidMessages)],
    ['Попыток ставок', String(snap.placementAttempts)],
    ['Requote rate (PRICE_CHANGED)', snap.requoteRate === null ? '—' : `${(snap.requoteRate * 100).toFixed(1)}%`],
    ['Показов requote в купоне', String(snap.requotePrompts)],
  ];

  return (
    <aside className="debug" aria-label="Debug-панель">
      <div className="debug__head">
        <h2 className="subsection-title">Телеметрия</h2>
        <button type="button" className="icon-btn" aria-label="Закрыть debug-панель" onClick={onClose}>
          ×
        </button>
      </div>
      <dl className="debug__grid">
        {rows.map(([k, v]) => (
          <div key={k} className="debug__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="debug__actions">
        <button type="button" className="btn" onClick={() => getFeedClient()?.simulateDrop()}>
          Оборвать WS
        </button>
        <button type="button" className="btn" onClick={() => update({ freezeForMs: 6000 })}>
          Заморозить фид 6 с
        </button>
        <button type="button" className="btn" onClick={() => metrics.reset()}>
          Сбросить метрики
        </button>
      </div>
      <h3 className="subsection-title">Chaos (mock-сервер)</h3>
      {chaosError ? <p className="error">{chaosError}</p> : null}
      {chaos ? (
        <div className="debug__chaos">
          {(
            [
              ['duplicateRate', 'Дубли'],
              ['reorderRate', 'Перестановки'],
              ['gapRate', 'Потери (gap)'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="field field--inline">
              <span>{label}</span>
              <input
                type="range"
                min={0}
                max={0.3}
                step={0.01}
                value={chaos[key]}
                onChange={(e) => update({ [key]: Number(e.target.value) })}
              />
              <output>{(chaos[key] * 100).toFixed(0)}%</output>
            </label>
          ))}
          <label className="field field--inline">
            <span>Разрывы, в среднем раз в</span>
            <select value={chaos.disconnectMeanMs} onChange={(e) => update({ disconnectMeanMs: Number(e.target.value) })}>
              <option value={0}>выкл</option>
              <option value={10000}>10 с</option>
              <option value={30000}>30 с</option>
              <option value={60000}>60 с</option>
            </select>
          </label>
        </div>
      ) : null}
    </aside>
  );
}
