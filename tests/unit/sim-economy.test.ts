import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY_PRESETS, getEconomyPreset, normalizeEconomy, applyShocks, deterministicReturn } from '../../src/sim/economy.js';
import { annualToMonthly } from '../../src/sim/math.js';
import { approx } from '../helpers/sim.js';

describe('sim/economy', () => {
  test('presets are unique and complete', () => {
    const ids = ECONOMY_PRESETS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of ECONOMY_PRESETS) {
      for (const k of ['expectedReturn', 'volatility', 'inflation', 'wageGrowth', 'cashYield', 'debtRate', 'propertyAppreciation'] as const) {
        assert.equal(typeof p.assumptions[k], 'number', `${p.id}.${k}`);
      }
      assert.ok(Array.isArray(p.assumptions.shocks));
    }
    assert.throws(() => getEconomyPreset('nope'), /Unknown economy preset/);
    const a = getEconomyPreset('moderate');
    a.shocks.push({ id: 'x', label: 'x', startMonth: 0, drop: -0.1, recoveryMonths: 0 });
    assert.equal(getEconomyPreset('moderate').shocks.length, 0, 'presets are cloned');
  });

  test('normalizeEconomy fills gaps from the preset and sanitises shocks', () => {
    const e = normalizeEconomy({ preset: 'stagflation', expectedReturn: 0.05 });
    assert.equal(e.expectedReturn, 0.05);
    assert.equal(e.inflation, 0.06);
    const d = normalizeEconomy(undefined);
    assert.equal(d.expectedReturn, 0.07);
    const bad = normalizeEconomy({ preset: 'unknown', volatility: -1, shocks: [{ drop: 0.5, startMonth: -3, recoveryMonths: -1 }, null as any] });
    assert.equal(bad.expectedReturn, 0.07, 'unknown preset falls back to moderate');
    assert.equal(bad.volatility, 0);
    assert.deepEqual(bad.shocks, [{ id: 'shock-1', label: 'Market shock', startMonth: 0, drop: 0, recoveryMonths: 0 }]);
    const fromPreset = normalizeEconomy({ preset: 'crash-recovery' });
    assert.equal(fromPreset.shocks.length, 1);
  });

  test('deterministic return without shocks equals the monthly rate', () => {
    const e = normalizeEconomy({ expectedReturn: 0.07 });
    approx(deterministicReturn(e, 0), annualToMonthly(0.07), 1e-12);
    approx(deterministicReturn(e, 500), annualToMonthly(0.07), 1e-12);
  });

  test('a shock with recovery returns exactly to the pre-crash level', () => {
    const trend = 1 + annualToMonthly(0.07);
    const shocks = [{ id: 's', label: 's', startMonth: 12, drop: -0.35, recoveryMonths: 36 }];
    let cumulative = 1;
    for (let t = 12; t <= 48; t++) cumulative *= applyShocks(shocks, t, trend, trend);
    approx(cumulative, 1, 1e-9);
    approx(applyShocks(shocks, 12, trend, trend), 0.65, 1e-12);
    approx(applyShocks(shocks, 11, trend, trend), trend, 1e-12);
    approx(applyShocks(shocks, 49, trend, trend), trend, 1e-12);
  });

  test('a permanent shock only applies the drop', () => {
    const trend = 1 + annualToMonthly(0.07);
    const shocks = [{ id: 's', label: 's', startMonth: 5, drop: -0.2, recoveryMonths: 0 }];
    approx(applyShocks(shocks, 5, trend, trend), 0.8, 1e-12);
    approx(applyShocks(shocks, 6, trend, trend), trend, 1e-12);
  });

  test('recovery strips drift but keeps Monte Carlo noise', () => {
    const trend = 1 + annualToMonthly(0.07);
    const shocks = [{ id: 's', label: 's', startMonth: 0, drop: -0.5, recoveryMonths: 10 }];
    const noisy = trend * 1.03; // a lucky month
    const recovery = Math.pow(2, 1 / 10);
    approx(applyShocks(shocks, 3, noisy, trend), 1.03 * recovery, 1e-12);
  });
});
