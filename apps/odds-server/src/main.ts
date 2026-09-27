import { createOddsServer, defaultServerConfig } from './app';
import { defaultEngineConfig } from './engine';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${raw}"`);
  return n;
}

const port = num('PORT', 8787);
const host = process.env.HOST ?? '127.0.0.1';

const app = createOddsServer({
  seed: num('SEED', defaultServerConfig.seed),
  tickMs: num('TICK_MS', defaultServerConfig.tickMs),
  heartbeatMs: num('HEARTBEAT_MS', defaultServerConfig.heartbeatMs),
  betDelayMs: num('BET_DELAY_MS', defaultServerConfig.betDelayMs),
  engine: {
    ...defaultEngineConfig,
    eventCount: num('EVENTS', defaultEngineConfig.eventCount),
    goalSuspendMs: num('GOAL_SUSPEND_MS', defaultEngineConfig.goalSuspendMs),
    stuckProbability: num('STUCK_PROBABILITY', defaultEngineConfig.stuckProbability),
  },
  chaos: {
    duplicateRate: num('CHAOS_DUPLICATE', defaultServerConfig.chaos.duplicateRate),
    reorderRate: num('CHAOS_REORDER', defaultServerConfig.chaos.reorderRate),
    gapRate: num('CHAOS_GAP', defaultServerConfig.chaos.gapRate),
    disconnectMeanMs: num('CHAOS_DISCONNECT_MEAN_MS', defaultServerConfig.chaos.disconnectMeanMs),
  },
});

const bound = await app.listen(port, host);
console.info(`odds-server listening on http://${host}:${bound} (ws: /ws)`);

const shutdown = () => {
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
