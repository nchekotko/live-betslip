import { useEffect, useState } from 'react';
import { ConnectionBanner } from './components/ConnectionBanner';
import { DebugPanel } from './components/DebugPanel';
import { EventList } from './components/EventList';
import { OpsConsole } from './components/ops/OpsConsole';
import { BetSlip } from './components/slip/BetSlip';
import { startFeed } from './feed/connection';
import { useFeedHealth } from './hooks/useFeedHealth';
import { useHashRoute } from './hooks/useHashRoute';

export function App({ autoConnect = true }: { autoConnect?: boolean }) {
  const route = useHashRoute();
  const health = useFeedHealth();
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    if (!autoConnect) return;
    return startFeed();
  }, [autoConnect]);

  return (
    <div className="app">
      <a className="skip-link" href="#slip-title">
        К купону
      </a>
      <header className="topbar">
        <h1 className="brand">Live Betslip</h1>
        <nav aria-label="Разделы">
          <a href="#/" aria-current={route === 'slip' ? 'page' : undefined}>
            Лайв и купон
          </a>
          <a href="#/ops" aria-current={route === 'ops' ? 'page' : undefined}>
            Операции
          </a>
        </nav>
        <span
          className={`dot dot--${health.healthy ? 'ok' : health.connection === 'live' ? 'warn' : 'bad'}`}
          title={health.healthy ? 'Фид в порядке' : 'Фид недоступен или устарел'}
          aria-hidden="true"
        />
        <button type="button" className="btn btn--ghost" aria-pressed={debug} onClick={() => setDebug((d) => !d)}>
          Debug
        </button>
      </header>
      <ConnectionBanner health={health} />
      <main className={`layout layout--${route}`}>
        {route === 'ops' ? (
          <OpsConsole />
        ) : (
          <>
            <EventList />
            <BetSlip />
          </>
        )}
      </main>
      {debug ? <DebugPanel onClose={() => setDebug(false)} /> : null}
    </div>
  );
}
