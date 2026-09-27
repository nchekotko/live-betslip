import { describe, expect, it } from 'vitest';
import { Metrics, percentile } from '../src/telemetry/metrics';

describe('Metrics', () => {
  it('computes lag percentiles, rates and the requote rate', () => {
    const clock = { t: 1000 };
    const m = new Metrics(100, () => clock.t);
    for (let i = 1; i <= 10; i++) m.recordMessage(clock.t - i * 10);
    m.inc('placementAttempts', 4);
    m.inc('priceChangedRejections');
    m.recordFrame(6);
    m.recordFrame(2);
    const s = m.snapshot();
    expect(s.lagLastMs).toBe(100);
    expect(s.lagP50Ms).toBe(50);
    expect(s.lagP95Ms).toBe(100);
    expect(s.requoteRate).toBe(0.25);
    expect(s.avgBatchSize).toBe(4);
    clock.t += 1000;
    for (let i = 0; i < 20; i++) m.recordMessage();
    expect(m.snapshot().messagesPerSec).toBe(20);
  });

  it('percentile handles empty input', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
  });
});
