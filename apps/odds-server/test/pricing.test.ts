import { describe, expect, it } from 'vitest';
import { fairProbabilities, poissonPmf, priceFromProbability, toLadder } from '../src/pricing';

describe('pricing model', () => {
  it('poisson pmf sums to ~1', () => {
    const sum = poissonPmf(1.7).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('1X2 probabilities form a distribution and favour the stronger side', () => {
    const p = fairProbabilities({ lambdaHome: 2.2, lambdaAway: 0.8, minute: 0, score: { home: 0, away: 0 } });
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
    expect(p.home).toBeGreaterThan(p.away);
    expect(p.over25 + p.under25).toBeCloseTo(1, 9);
  });

  it('at full time outcomes are deterministic', () => {
    const p = fairProbabilities({ lambdaHome: 1.5, lambdaAway: 1.5, minute: 90, score: { home: 2, away: 1 } });
    expect(p.home).toBeCloseTo(1, 9);
    expect(p.over25).toBeCloseTo(1, 9);
    expect(p.bttsYes).toBeCloseTo(1, 9);
  });

  it('a late lead shortens the leader price', () => {
    const early = fairProbabilities({ lambdaHome: 1.4, lambdaAway: 1.4, minute: 10, score: { home: 1, away: 0 } });
    const late = fairProbabilities({ lambdaHome: 1.4, lambdaAway: 1.4, minute: 80, score: { home: 1, away: 0 } });
    expect(late.home).toBeGreaterThan(early.home);
  });

  it('ladder floors to the tick size and clamps', () => {
    expect(toLadder(1.005)).toBe(1.01);
    expect(toLadder(2.037)).toBe(2.02);
    expect(toLadder(3.33)).toBe(3.3);
    expect(toLadder(7.77)).toBe(7.6);
    expect(toLadder(5000)).toBe(100);
  });

  it('margin makes the book overround > 1', () => {
    const p = fairProbabilities({ lambdaHome: 1.3, lambdaAway: 1.1, minute: 30, score: { home: 0, away: 0 } });
    const book = [p.home, p.draw, p.away].reduce((acc, x) => acc + 1 / priceFromProbability(x, 0.06), 0);
    expect(book).toBeGreaterThan(1.05);
    expect(book).toBeLessThan(1.12);
  });
});
