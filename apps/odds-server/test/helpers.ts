import type { AuditAction } from '@live-betslip/protocol';
import { defaultEngineConfig, OddsEngine, type DeltaPayload, type EngineConfig } from '../src/engine';
import { mulberry32 } from '../src/rng';

export function makeEngine(overrides: Partial<EngineConfig> = {}, seed = 7) {
  const clock = { t: 1_000_000 };
  const deltas: DeltaPayload[] = [];
  const audits: { actor: string; action: AuditAction; marketIds: string[]; reason: string }[] = [];
  const engine = new OddsEngine(
    { ...defaultEngineConfig, eventCount: 4, stuckProbability: 0, ...overrides },
    {
      rng: mulberry32(seed),
      now: () => clock.t,
      emit: (d) => deltas.push(d),
      audit: (e) => audits.push(e),
    },
  );
  engine.init();
  return { engine, clock, deltas, audits };
}
