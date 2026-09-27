import type { FeedHealth } from '../hooks/useFeedHealth';

/**
 * Degraded-mode banner. Rendered whenever prices on screen may not be
 * current; bet placement is disabled in exactly the same conditions.
 */
export function ConnectionBanner({ health }: { health: FeedHealth }) {
  const { connection, stale, staleForMs, nextRetryAt, reconnectAttempt, now } = health;
  if (connection === 'live' && !stale) return null;

  let text: string;
  let kind: 'error' | 'warn' | 'info' = 'warn';
  if (connection === 'reconnecting') {
    const secs = nextRetryAt !== null ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0;
    text = `Нет соединения с фидом. Повторное подключение через ${secs} с (попытка ${reconnectAttempt}). Приём ставок приостановлен.`;
    kind = 'error';
  } else if (connection === 'connecting' || connection === 'idle') {
    text = 'Подключение к фиду…';
    kind = 'info';
  } else if (connection === 'syncing') {
    text = 'Синхронизация состояния (snapshot/replay)… Приём ставок временно приостановлен.';
    kind = 'info';
  } else if (connection === 'stopped') {
    text = 'Фид остановлен.';
    kind = 'error';
  } else {
    text = `Фид не обновлялся ${Math.round(staleForMs / 1000)} с: коэффициенты могут быть неактуальны (degraded mode). Приём ставок приостановлен.`;
  }
  return (
    <div className={`banner banner--${kind}`} role={kind === 'error' ? 'alert' : 'status'} data-testid="connection-banner">
      {text}
    </div>
  );
}
