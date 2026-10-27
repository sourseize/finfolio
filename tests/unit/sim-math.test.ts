import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, ageAt, amortizedPayment, annualToMonthly, futureValue, growthFactor, monthsBetween, monthsUntilAge, percentile, round2, round4,
} from '../../src/sim/math.js';
import { approx } from '../helpers/sim.js';

describe('sim/math', () => {
  test('annualToMonthly compounds back to the annual rate', () => {
    approx(Math.pow(1 + annualToMonthly(0.07), 12), 1.07, 1e-12);
    assert.equal(annualToMonthly(0), 0);
    approx(growthFactor(0.07, 24), 1.07 * 1.07, 1e-12);
  });

  test('amortizedPayment matches the standard mortgage formula', () => {
    approx(amortizedPayment(100000, 0.06, 30), 599.55, 0.01);
    approx(amortizedPayment(80000, 0, 10), 666.67, 0.01);
    assert.equal(amortizedPayment(0, 0.05, 30), 0);
  });

  test('futureValue of lump sum and level contributions', () => {
    approx(futureValue(1000, 0, 0.07, 12), 1070, 1e-9);
    assert.equal(futureValue(0, 100, 0, 12), 1200);
    const r = Math.pow(1.12, 1 / 12) - 1;
    approx(futureValue(0, 100, 0.12, 12), 100 * ((Math.pow(1 + r, 12) - 1) / r), 1e-9); // ≈ 1264.65
  });

  test('calendar helpers', () => {
    assert.equal(addMonths('2026-10-25', 0), '2026-10');
    assert.equal(addMonths('2026-10-25', 3), '2027-01');
    assert.equal(addMonths('2026-10', -1), '2026-09');
    assert.equal(addMonths('2026-10-25', 14), '2027-12');
    assert.equal(addMonths('2026-10-25', -10), '2025-12');
    assert.equal(monthsBetween('2026-10-25', '2027-12-31'), 14);
    assert.equal(monthsBetween('2026-10-25', '2026-10-01'), 0);
    assert.equal(monthsBetween('2026-10-25', '2026-08-01'), -2);
  });

  test('age arithmetic for fin (born 1986-07-10)', () => {
    assert.equal(ageAt('1986-07-10', '2026-10-25'), 40.25);
    assert.equal(ageAt('1986-07-10', '2026-07-10'), 40);
    approx(ageAt('1986-07-10', '2026-07-09'), 39 + 11 / 12, 1e-12);
    assert.equal(monthsUntilAge('1986-07-10', '2026-10-25', 65), 297); // July 2051
    assert.equal(monthsUntilAge('1986-07-10', '2026-10-25', 40), 0);   // already 40
    assert.equal(monthsUntilAge('1986-07-10', '2026-10-25', 41), 9);   // July 2027
    assert.equal(monthsUntilAge('1986-07-10', '2026-10-25', 90), 597);
  });

  test('percentile interpolates', () => {
    assert.equal(percentile([5, 1, 3], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentile([1, 2, 3, 4], 0), 1);
    assert.equal(percentile([1, 2, 3, 4], 1), 4);
    assert.ok(Number.isNaN(percentile([], 0.5)));
  });

  test('rounding helpers', () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(-1.005), -1);
    assert.equal(round4(0.17410899999999999), 0.1741);
  });
});
