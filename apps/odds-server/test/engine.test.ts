import { describe, expect, it } from 'vitest';
import { DeltaMsg, Market, SportEvent } from '@live-betslip/protocol';
import { makeEngine } from './helpers';

function liveEventWithOpenMarkets(engine: ReturnType<typeof makeEngine>['engine']) {
  const snap = engine.snapshot();
  for (const ev of snap.events) {
    const markets = snap.markets.filter((m) => m.eventId === ev.id);
    if (ev.status === 'live' && markets.every((m) => m.status === 'open')) return { ev, markets };
  }
  throw new Error('no fully open live event in fixture');
}

describe('OddsEngine', () => {
  it('builds a schema-valid snapshot with three markets per event', () => {
    const { engine } = makeEngine();
    const snap = engine.snapshot();
    expect(snap.events).toHaveLength(4);
    expect(snap.markets).toHaveLength(12);
    for (const e of snap.events) expect(SportEvent.safeParse(e).success).toBe(true);
    for (const m of snap.markets) expect(Market.safeParse(m).success).toBe(true);
  });

  it('emits only contract-valid deltas over many ticks, with monotonic price versions', () => {
    const { engine, clock, deltas } = makeEngine({ eventCount: 6 });
    for (let i = 0; i < 600; i++) {
      clock.t += 500;
      engine.tick();
    }
    expect(deltas.length).toBeGreaterThan(100);
    const lastVersion = new Map<string, number>();
    let seq = 0;
    for (const d of deltas) {
      seq += 1;
      const parsed = DeltaMsg.safeParse({ ...d, seq, ts: clock.t });
      expect(parsed.success, JSON.stringify(d)).toBe(true);
      if (d.type === 'price') {
        const prev = lastVersion.get(d.selectionId) ?? -1;
        expect(d.priceVersion).toBeGreaterThan(prev);
        lastVersion.set(d.selectionId, d.priceVersion);
      }
    }
    // 600 ticks * 20s = 200 sim minutes: every initial event must have finished and been replaced.
    expect(deltas.some((d) => d.type === 'event_removed')).toBe(true);
    expect(deltas.some((d) => d.type === 'event_added')).toBe(true);
  });

  it('a goal suspends every market of the event, then reprices before reopening', () => {
    const { engine, clock, deltas, audits } = makeEngine({ goalSuspendMs: 3000, marketUpdateMeanMs: 1e9 });
    const { ev, markets } = liveEventWithOpenMarkets(engine);
    engine.forceGoal(ev.id, 'home');
    const snap = engine.snapshot();
    for (const m of snap.markets.filter((x) => x.eventId === ev.id)) {
      expect(['suspended', 'settled']).toContain(m.status);
      if (m.status === 'suspended') expect(m.suspendReason).toMatch(/^goal/);
      expect(m.cashOutAvailable).toBe(false);
    }
    expect(audits.some((a) => a.action === 'auto_suspend')).toBe(true);

    deltas.length = 0;
    clock.t += 3500;
    engine.tick();
    const oneXTwo = markets.find((m) => m.kind === 'match_result');
    expect(oneXTwo).toBeDefined();
    const reopenIdx = deltas.findIndex((d) => d.type === 'market_status' && d.marketId === oneXTwo?.id && d.status === 'open');
    const priceIdx = deltas.findIndex((d) => d.type === 'price' && d.marketId === oneXTwo?.id);
    expect(reopenIdx).toBeGreaterThanOrEqual(0);
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(priceIdx).toBeLessThan(reopenIdx);
  });

  it('an ops hold survives the automatic goal resume', () => {
    const { engine, clock } = makeEngine({ goalSuspendMs: 1000 });
    const { ev, markets } = liveEventWithOpenMarkets(engine);
    const target = markets.find((m) => m.kind === 'match_result');
    if (!target) throw new Error('fixture');
    const r = engine.opsSuspend([target.id, 'nope'], 'integrity alert', 'trader');
    expect(r.affected).toEqual([target.id]);
    expect(r.skipped).toEqual([{ marketId: 'nope', reason: 'not_found' }]);
    engine.forceGoal(ev.id, 'away');
    clock.t += 2000;
    engine.tick();
    const m = engine.getMarket(target.id);
    expect(m?.status).toBe('suspended');
    expect(m?.suspendReason).toBe('integrity alert');
    const resumed = engine.opsResume([target.id], 'checked', 'trader');
    expect(resumed.affected).toEqual([target.id]);
    expect(engine.getMarket(target.id)?.status).toBe('open');
  });

  it('closes at full time and settles every market with exactly one winner', () => {
    const { engine, clock, deltas } = makeEngine({ settleDelayMs: 1000 });
    const { ev } = liveEventWithOpenMarkets(engine);
    engine.forceFullTime(ev.id);
    for (const m of engine.snapshot().markets.filter((x) => x.eventId === ev.id)) {
      expect(['closed', 'settled']).toContain(m.status);
    }
    clock.t += 1500;
    engine.tick();
    const settled = engine.snapshot().markets.filter((x) => x.eventId === ev.id);
    for (const m of settled) {
      expect(m.status).toBe('settled');
      expect(m.selections.filter((s) => s.result === 'win')).toHaveLength(1);
    }
    const score = engine.snapshot().events.find((e) => e.id === ev.id)?.score;
    const oneXTwo = settled.find((m) => m.kind === 'match_result');
    const winner = oneXTwo?.selections.find((s) => s.result === 'win')?.id;
    expect(score).toBeDefined();
    if (score) {
      const expected = score.home > score.away ? 'home' : score.home === score.away ? 'draw' : 'away';
      expect(winner).toBe(`${oneXTwo?.id}:${expected}`);
    }
    expect(deltas.some((d) => d.type === 'settle')).toBe(true);
  });

  it('settles Over 2.5 early once the third goal goes in', () => {
    const { engine } = makeEngine();
    const { ev, markets } = liveEventWithOpenMarkets(engine);
    const total = markets.find((m) => m.kind === 'total_goals');
    const need = 3 - (ev.score.home + ev.score.away);
    for (let i = 0; i < need; i++) engine.forceGoal(ev.id, 'home');
    const m = engine.getMarket(total?.id ?? '');
    expect(m?.status).toBe('settled');
    expect(m?.selections.find((s) => s.result === 'win')?.id).toBe(`${total?.id}:over`);
  });
});
