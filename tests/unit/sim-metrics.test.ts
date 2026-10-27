import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { opportunityCost, compareResults, compareScenarios, goalFeasibility } from '../../src/sim/metrics.js';
import { simulate } from '../../src/sim/engine.js';
import { createEvent } from '../../src/sim/events.js';
import type { Goal } from '../../src/db/database.js';
import { mkInput, flatEconomy, approx } from '../helpers/sim.js';

describe('sim/metrics: opportunity cost', () => {
  test('zero return → future value equals what was spent', () => {
    const r = opportunityCost({ monthly: 100, years: 10, annualReturn: 0, inflation: 0 });
    assert.equal(r.totalSpent, 12000);
    assert.equal(r.futureValue, 12000);
    assert.equal(r.growth, 0);
    assert.equal(r.multiple, 1);
    assert.equal(r.series.length, 11);
    assert.deepEqual(r.series[10], { year: 10, value: 12000, spent: 12000 });
  });

  test('lump sum compounds and is deflated for the real value', () => {
    const r = opportunityCost({ oneOff: 1000, years: 10, annualReturn: 0.07, inflation: 0.03 });
    approx(r.futureValue, 1000 * Math.pow(1.07, 10), 0.01);
    approx(r.realFutureValue, 1000 * Math.pow(1.07, 10) / Math.pow(1.03, 10), 0.01);
    approx(r.multiple, 1.97, 0.01);
    assert.equal(r.series[0].value, 1000);
  });

  test('negative or missing inputs are treated as zero', () => {
    const r = opportunityCost({ oneOff: -5, monthly: -5, years: -1, annualReturn: 0.05, inflation: 0.02 });
    assert.equal(r.totalSpent, 0);
    assert.equal(r.futureValue, 0);
    assert.equal(r.multiple, 0);
    assert.equal(r.years, 0);
  });
});

describe('sim/metrics: scenario comparison', () => {
  test('delta reflects an extra recurring expense', () => {
    const base = mkInput({ scenario: { horizonYears: 3 } });
    const alt = mkInput({ scenario: { horizonYears: 3, events: [createEvent('lifestyle', { startMonth: 0, amount: 100 })] } });
    const { delta } = compareScenarios(base, alt);
    assert.equal(delta.base, 'Test');
    assert.equal(delta.endNetWorth, -3600);
    assert.equal(delta.endRealNetWorth, -3600);
    assert.equal(delta.yearly.length, 3);
    assert.deepEqual(delta.yearly.map(y => y.delta), [-1200, -2400, -3600]);
    assert.equal(delta.yearly[0].year, 2027);
    assert.equal(delta.fiMonthDelta, null, 'FI not reached in either');
  });

  test('FI delay is measured in months', () => {
    const mk = (extraExpense: number) => mkInput({
      baseline: { liquid: 0, invested: 300000, monthlyIncome: 10000, monthlyExpenses: 4000, monthlyContribution: 0 },
      scenario: {
        horizonYears: 20,
        policy: { emergencyFundMonths: 0, investSurplus: true, contributionFollowsWages: true },
        events: extraExpense ? [createEvent('lifestyle', { startMonth: 0, amount: extraExpense })] : [],
      },
    });
    const base = simulate(mk(0));
    const alt = simulate(mk(1000)); // surplus 6000 → 5000, FI target 1.2M → 1.5M
    const d = compareResults(base, alt);
    assert.equal(base.summary.fire.fiMonth, 149);
    assert.equal(alt.summary.fire.fiMonth, 239); // 300000 + 5000·240 = 1.5M
    assert.equal(d.fiMonthDelta, 90);
    assert.equal(d.netWorthAtRetirement, null, 'retirement beyond horizon');
  });
});

describe('sim/metrics: goal feasibility', () => {
  const goal = (over: Partial<Goal>): Goal => ({
    id: 'g', userId: 'u', name: 'Goal', targetAmount: 1000, currentAmount: 0, deadline: '', category: 'Savings', priority: 'medium', notes: '', createdAt: '', ...over,
  });

  test('waterfall allocation by priority then deadline', () => {
    // surplus = 5000 − 3000 − 1000 reserved contribution = 1000 / month
    const result = simulate(mkInput({ scenario: { horizonYears: 2 } }));
    const goals = [
      goal({ id: 'low', name: 'Holiday', priority: 'low', targetAmount: 2400, deadline: '2027-10-25' }),
      goal({ id: 'high', name: 'Emergency', priority: 'high', targetAmount: 6000, currentAmount: 0, deadline: '2027-10-25' }),
      goal({ id: 'done', name: 'Done', priority: 'high', targetAmount: 500, currentAmount: 500 }),
      goal({ id: 'med', name: 'Laptop', priority: 'medium', targetAmount: 3000, deadline: '2027-04-25' }),
    ];
    const out = goalFeasibility(goals, result, 1000);
    assert.deepEqual(out.map(g => g.id), ['high', 'done', 'med', 'low'], 'priority, then nearest deadline, undated last');

    const [high, done, med, low] = out;
    assert.equal(done.status, 'funded');
    assert.equal(done.requiredMonthly, 0);
    assert.equal(done.fundedInMonths, 0);

    assert.equal(high.monthsToDeadline, 12);
    assert.equal(high.requiredMonthly, 500);
    assert.equal(high.allocatedMonthly, 500);
    assert.equal(high.fundedInMonths, 12);
    assert.equal(high.fundedBy, '2027-10');
    assert.equal(high.status, 'on_track');

    assert.equal(med.requiredMonthly, 500);
    assert.equal(med.allocatedMonthly, 500);
    assert.equal(med.status, 'on_track');

    assert.equal(low.allocatedMonthly, 0, 'surplus exhausted');
    assert.equal(low.fundedInMonths, null);
    assert.equal(low.status, 'unreachable');
  });

  test('at risk when the deadline is too close, open-ended goals take the remaining surplus', () => {
    const result = simulate(mkInput({ scenario: { horizonYears: 2 } }));
    const out = goalFeasibility([
      goal({ id: 'rush', priority: 'high', targetAmount: 20000, deadline: '2027-02-25' }), // 4 months → needs 5000/mo
      goal({ id: 'open', priority: 'low', targetAmount: 3000 }),
    ], result, 1000);
    const [rush, open] = out;
    assert.equal(rush.requiredMonthly, 5000);
    assert.equal(rush.allocatedMonthly, 1000);
    assert.equal(rush.fundedInMonths, 20);
    assert.equal(rush.status, 'at_risk');
    assert.equal(open.allocatedMonthly, 0);
    assert.equal(open.status, 'unreachable');
  });

  test('automatic sweeps do not reduce the surplus available to goals', () => {
    const result = simulate(mkInput({ scenario: { horizonYears: 1, policy: { emergencyFundMonths: 0, investSurplus: true, contributionFollowsWages: true } } }));
    assert.equal(result.months[0].contribution, 2000 + 10000, 'everything swept');
    const out = goalFeasibility([goal({ id: 'g', targetAmount: 12000 })], result, 1000);
    assert.equal(out[0].allocatedMonthly, 1000);
    assert.equal(out[0].fundedInMonths, 12);
  });

  test('no surplus → nothing allocated; deadline already passed → unreachable unless funded', () => {
    const result = simulate(mkInput({ baseline: { monthlyIncome: 3000, monthlyExpenses: 3000, monthlyContribution: 0 }, scenario: { horizonYears: 1 } }));
    const out = goalFeasibility([goal({ id: 'past', targetAmount: 100, deadline: '2020-01-01' })], result);
    assert.equal(out[0].monthsToDeadline, 0);
    assert.equal(out[0].requiredMonthly, null);
    assert.equal(out[0].status, 'unreachable');
  });
});
