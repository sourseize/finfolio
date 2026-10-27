import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, makeNormal, runMonteCarlo } from '../../src/sim/montecarlo.js';
import { simulate } from '../../src/sim/engine.js';
import { normalizeEconomy } from '../../src/sim/economy.js';
import { mkInput, flatEconomy, approx } from '../helpers/sim.js';

describe('sim/montecarlo: random numbers', () => {
  test('mulberry32 is deterministic and uniform on [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, Array.from({ length: 5 }, mulberry32(124)));
    const r = mulberry32(1);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = r();
      assert.ok(v >= 0 && v < 1);
      sum += v;
    }
    approx(sum / 20000, 0.5, 0.01);
  });

  test('Box–Muller normal has mean ≈ 0 and sd ≈ 1', () => {
    const n = makeNormal(mulberry32(99));
    const N = 40000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const z = n();
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / N;
    const sd = Math.sqrt(sumSq / N - mean * mean);
    approx(mean, 0, 0.02);
    approx(sd, 1, 0.02);
  });
});

describe('sim/montecarlo: simulation', () => {
  const healthy = () => mkInput({
    baseline: { liquid: 20000, invested: 150000, monthlyIncome: 6000, monthlyExpenses: 3500, monthlyContribution: 1000 },
    scenario: { horizonYears: 15, economy: normalizeEconomy({ preset: 'moderate' }) },
  });

  test('same seed → identical result; different seed → different result', () => {
    const a = runMonteCarlo(healthy(), { trials: 100, seed: 7 });
    const b = runMonteCarlo(healthy(), { trials: 100, seed: 7 });
    const c = runMonteCarlo(healthy(), { trials: 100, seed: 8 });
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.endNetWorth, c.endNetWorth);
    assert.equal(a.seed, 7);
    assert.equal(a.trials, 100);
  });

  test('zero volatility collapses the bands onto the deterministic path', () => {
    const input = mkInput({
      baseline: { liquid: 20000, invested: 150000, monthlyIncome: 6000, monthlyExpenses: 3500, monthlyContribution: 1000 },
      scenario: { horizonYears: 5, economy: flatEconomy({ expectedReturn: 0.07, inflation: 0.02 }) },
    });
    const det = simulate(input);
    const mc = runMonteCarlo(input, { trials: 20, seed: 1 });
    assert.equal(mc.netWorthBands.length, 5);
    mc.netWorthBands.forEach(b => {
      const expected = det.months[b.t].netWorth;
      approx(b.p10, expected, 0.02);
      approx(b.p90, expected, 0.02);
      assert.equal(b.period, det.months[b.t].period);
    });
    approx(mc.endNetWorth.p50, det.summary.endNetWorth, 0.02);
    approx(mc.endNetWorth.mean, det.summary.endNetWorth, 0.02);
    assert.equal(mc.successProbability, 1);
  });

  test('bands are ordered and sampled yearly plus the final month', () => {
    const input = healthy();
    input.scenario.horizonYears = 2.5;
    const mc = runMonteCarlo(input, { trials: 50, seed: 3 });
    assert.deepEqual(mc.netWorthBands.map(b => b.t), [11, 23, 29]);
    for (const b of [...mc.netWorthBands, ...mc.investedBands]) {
      assert.ok(b.p10 <= b.p25 && b.p25 <= b.p50 && b.p50 <= b.p75 && b.p75 <= b.p90, JSON.stringify(b));
    }
    assert.ok(mc.endNetWorth.p10 <= mc.endNetWorth.p90);
  });

  test('probabilities are fractions and a healthy plan mostly succeeds', () => {
    const mc = runMonteCarlo(healthy(), { trials: 200, seed: 11 });
    for (const p of [mc.successProbability, mc.fiByRetirementProbability, mc.fiWithinHorizonProbability, mc.negativeNetWorthProbability]) {
      assert.ok(p >= 0 && p <= 1);
    }
    assert.ok(mc.successProbability > 0.95);
    assert.equal(mc.negativeNetWorthProbability, 0);
  });

  test('a doomed plan fails with certainty', () => {
    const mc = runMonteCarlo(mkInput({
      baseline: { liquid: 1000, invested: 1000, monthlyIncome: 0, monthlyExpenses: 2000, monthlyContribution: 0 },
      scenario: { horizonYears: 2, economy: normalizeEconomy({ preset: 'moderate' }) },
    }), { trials: 30, seed: 5 });
    assert.equal(mc.successProbability, 0);
    assert.equal(mc.negativeNetWorthProbability, 1);
    assert.equal(mc.fiMonth, null);
    assert.equal(mc.fiWithinHorizonProbability, 0);
  });

  test('FI month percentiles reported when reached', () => {
    const mc = runMonteCarlo(mkInput({
      baseline: { liquid: 0, invested: 900000, monthlyIncome: 8000, monthlyExpenses: 3000, monthlyContribution: 2000 },
      scenario: { horizonYears: 10, economy: normalizeEconomy({ preset: 'moderate' }) },
    }), { trials: 100, seed: 2 });
    assert.ok(mc.fiMonth);
    assert.ok(mc.fiMonth!.p10 <= mc.fiMonth!.p50 && mc.fiMonth!.p50 <= mc.fiMonth!.p90);
    assert.equal(mc.fiByRetirementProbability, mc.fiWithinHorizonProbability, 'horizon ends before retirement');
  });

  test('trial count is clamped', () => {
    assert.equal(runMonteCarlo(healthy(), { trials: 0 }).trials, 1);
    assert.equal(runMonteCarlo(healthy(), { trials: 0.4 }).trials, 1);
  });
});
