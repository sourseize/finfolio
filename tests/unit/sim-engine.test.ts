import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, resolveHorizonMonths, resolveRetirementMonth, effectiveBaseline, MAX_HORIZON_MONTHS, MIN_HORIZON_MONTHS } from '../../src/sim/engine.js';
import { createEvent } from '../../src/sim/events.js';
import { normalizeEconomy } from '../../src/sim/economy.js';
import { mkInput, mkScenario, flatEconomy, approx } from '../helpers/sim.js';

describe('sim/engine: horizon & retirement', () => {
  test('horizon from scenario years, else plan-to age, clamped', () => {
    assert.equal(resolveHorizonMonths(mkInput({ scenario: { horizonYears: 2 } })), 24);
    assert.equal(resolveHorizonMonths(mkInput({ scenario: { horizonYears: undefined } })), 597, 'until age 90');
    assert.equal(resolveHorizonMonths(mkInput({ scenario: { horizonYears: undefined }, profile: { planToAge: 30 } })), MIN_HORIZON_MONTHS);
    assert.equal(resolveHorizonMonths(mkInput({ scenario: { horizonYears: 500 } })), MAX_HORIZON_MONTHS);
  });

  test('retirement month from profile, overridden by the earliest retirement event', () => {
    assert.equal(resolveRetirementMonth(mkInput()), 297);
    const ev = mkInput({ scenario: { events: [createEvent('retire', { startMonth: 120 }), createEvent('retire', { startMonth: 60 })] } });
    assert.equal(resolveRetirementMonth(ev), 60);
  });

  test('scenario overrides replace baseline figures', () => {
    const b = effectiveBaseline(mkInput().baseline, mkScenario({ overrides: { monthlyExpenses: 4321, liquid: NaN as any } }));
    assert.equal(b.monthlyExpenses, 4321);
    assert.equal(b.liquid, 10000);
  });
});

describe('sim/engine: cash-flow mechanics (flat economy)', () => {
  test('surplus accumulates: contribution to invested, rest stays liquid', () => {
    const r = simulate(mkInput());
    // income 5000 − expenses 3000 = 2000; contribution 1000 → liquid +1000, invested +1000 each month
    assert.equal(r.months.length, 24);
    r.months.forEach((m, i) => {
      assert.equal(m.income, 5000);
      assert.equal(m.expenses, 3000);
      assert.equal(m.contribution, 1000);
      assert.equal(m.liquid, 10000 + 1000 * (i + 1));
      assert.equal(m.invested, 1000 * (i + 1));
      assert.equal(m.netWorth, 10000 + 2000 * (i + 1));
      assert.equal(m.realNetWorth, m.netWorth, 'no inflation → real = nominal');
      assert.equal(m.retired, false);
    });
    assert.equal(r.months[0].period, '2026-10');
    assert.equal(r.months[23].period, '2028-09');
    assert.equal(r.months[0].age, 40.25);
    assert.equal(r.summary.startNetWorth, 10000);
    assert.equal(r.summary.endNetWorth, 58000);
    assert.equal(r.summary.totalIncome, 120000);
    assert.equal(r.summary.totalExpenses, 72000);
    assert.equal(r.summary.totalContributions, 24000);
    assert.equal(r.summary.depletedMonth, null);
  });

  test('investSurplus sweeps cash above the emergency buffer', () => {
    const r = simulate(mkInput({ scenario: { policy: { emergencyFundMonths: 2, investSurplus: true, contributionFollowsWages: true } } }));
    // buffer = 2 × 3000 = 6000. Month 0: liquid 10000 + 2000 − 1000 contribution = 11000 → sweep 5000
    assert.equal(r.months[0].liquid, 6000);
    assert.equal(r.months[0].invested, 6000);
    assert.equal(r.months[0].contribution, 6000);
    assert.equal(r.months[1].liquid, 6000);
    assert.equal(r.months[1].invested, 8000);
    assert.equal(r.months[1].contribution, 2000);
  });

  test('market growth compounds on invested assets', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 0, invested: 1000, monthlyIncome: 0, monthlyExpenses: 0, monthlyContribution: 0 },
      scenario: { economy: flatEconomy({ expectedReturn: 0.12 }), horizonYears: 1 },
    }));
    approx(r.months[11].invested, 1120, 0.01);
    approx(r.months[0].marketReturn, Math.pow(1.12, 1 / 12) - 1, 1e-4);
  });

  test('cash yield applies to positive liquid only', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 1200, invested: 0, monthlyIncome: 0, monthlyExpenses: 0, monthlyContribution: 0 },
      scenario: { economy: flatEconomy({ cashYield: 0.12 }), horizonYears: 1 },
    }));
    approx(r.months[11].liquid, 1344, 0.01);
  });

  test('inflation raises expenses, wage growth raises income, real net worth deflates', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 0, invested: 0, monthlyIncome: 1000, monthlyExpenses: 1000, monthlyContribution: 0 },
      scenario: { economy: flatEconomy({ inflation: 0.12, wageGrowth: 0.24 }), horizonYears: 2 },
    }));
    assert.equal(r.months[0].income, 1000);
    assert.equal(r.months[0].expenses, 1000);
    approx(r.months[12].expenses, 1120, 0.01);
    approx(r.months[12].income, 1240, 0.01);
    approx(r.months[23].realNetWorth, r.months[23].netWorth / Math.pow(1.12, 23 / 12), 0.01);
  });

  test('retirement stops earned income at the profile age', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 100000, monthlyIncome: 5000, monthlyExpenses: 1000, monthlyContribution: 0 },
      profile: { retirementAge: 41 }, // 9 months away
      scenario: { horizonYears: 1 },
    }));
    assert.equal(r.months[8].income, 5000);
    assert.equal(r.months[8].retired, false);
    assert.equal(r.months[9].income, 0);
    assert.equal(r.months[9].retired, true);
    assert.equal(r.summary.fire.retirementMonth, 9);
    assert.equal(r.summary.fire.retirementAge, 41);
    assert.equal(r.summary.netWorthAtRetirement, r.months[9].netWorth);
  });

  test('retirement stops contributions and surplus sweeps', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 50000, invested: 0, monthlyIncome: 5000, monthlyExpenses: 1000, monthlyContribution: 1000 },
      profile: { retirementAge: 41 },
      scenario: { horizonYears: 1, policy: { emergencyFundMonths: 0, investSurplus: true, contributionFollowsWages: true } },
    }));
    assert.equal(r.months[8].contribution, 4000);
    assert.equal(r.months[9].contribution, -1000, 'drawdown: deficit covered by selling invested');
    assert.equal(r.months[9].liquid, 0); // cash was swept to 0 before retirement
    assert.equal(r.months[9].invested, r.months[8].invested - 1000);
  });
});

describe('sim/engine: life events (flat economy)', () => {
  test('job loss zeroes income for its duration', () => {
    const r = simulate(mkInput({ scenario: { events: [createEvent('job_loss', { startMonth: 2, durationMonths: 3 })] } }));
    assert.deepEqual(r.months.slice(0, 6).map(m => m.income), [5000, 5000, 0, 0, 0, 5000]);
  });

  test('percentage and absolute income events stack', () => {
    const r = simulate(mkInput({
      scenario: {
        events: [
          createEvent('raise', { startMonth: 1, percent: 0.1 }),
          createEvent('pay_cut', { startMonth: 2, percent: -0.5, durationMonths: 1 }),
          createEvent('second_income', { startMonth: 3, amount: 700 }),
        ],
      },
    }));
    assert.equal(r.months[0].income, 5000);
    assert.equal(r.months[1].income, 5500);
    assert.equal(r.months[2].income, 2750);
    assert.equal(r.months[3].income, 6200);
  });

  test('absolute income survives retirement (pension) and is inflated', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 100000, monthlyIncome: 5000, monthlyExpenses: 1000, monthlyContribution: 0 },
      profile: { retirementAge: 41 },
      scenario: { horizonYears: 2, economy: flatEconomy({ inflation: 0.12 }), events: [createEvent('second_income', { label: 'Pension', startMonth: 12, amount: 1000 })] },
    }));
    assert.equal(r.months[11].income, 0);
    approx(r.months[12].income, 1120, 0.01);
  });

  test('expense events add for their duration; negative amounts reduce spending', () => {
    const r = simulate(mkInput({
      scenario: { events: [createEvent('child', { startMonth: 1, amount: 900, durationMonths: 2 }), createEvent('relocation', { startMonth: 2, amount: -500 })] },
    }));
    assert.deepEqual(r.months.slice(0, 5).map(m => m.expenses), [3000, 3900, 3400, 2500, 2500]);
  });

  test('windfall and big purchase move cash once', () => {
    const r = simulate(mkInput({
      scenario: { events: [createEvent('windfall', { startMonth: 1, amount: 20000 }), createEvent('big_purchase', { startMonth: 2, amount: -5000 })] },
    }));
    assert.equal(r.months[0].liquid, 11000);
    assert.equal(r.months[1].liquid, 32000);
    assert.equal(r.months[2].liquid, 28000);
    assert.equal(r.months[3].liquid, 29000);
  });

  test('one-off amounts are stated in today\'s money and inflated', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 0, monthlyIncome: 0, monthlyExpenses: 0, monthlyContribution: 0 },
      scenario: { economy: flatEconomy({ inflation: 0.12 }), events: [createEvent('windfall', { startMonth: 12, amount: 1000 })] },
    }));
    approx(r.months[12].liquid, 1120, 0.01);
  });

  test('existing revolving debt is repaid first and accrues interest while outstanding', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 0, invested: 0, debt: 1200, monthlyIncome: 1000, monthlyExpenses: 500, monthlyContribution: 300 },
      scenario: { economy: flatEconomy({ debtRate: 0.12 }), horizonYears: 1 },
    }));
    const m0 = r.months[0];
    const rate = Math.pow(1.12, 1 / 12) - 1;
    approx(m0.debt, 1200 * (1 + rate) - 500, 0.01);
    assert.equal(m0.invested, 0, 'no contribution while paying debt');
    assert.equal(m0.liquid, 0);
    const m2 = r.months[2];
    assert.equal(m2.debt, 0);
    assert.ok(m2.invested > 0);
  });

  test('debt payoff event uses available cash', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 3000, debt: 10000, monthlyIncome: 0, monthlyExpenses: 0, monthlyContribution: 0 },
      scenario: { events: [createEvent('pay_off_debt', { startMonth: 1, amount: 5000 })] },
    }));
    // month 0: 3000 cash pays 3000 of debt automatically → debt 7000, liquid 0. Event at month 1 has no cash to use.
    assert.equal(r.months[0].debt, 7000);
    assert.equal(r.months[1].debt, 7000);
  });

  test('property purchase: down payment, mortgage amortisation, rent replaced', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 50000, invested: 0, monthlyIncome: 5000, monthlyExpenses: 3000, monthlyContribution: 0 },
      scenario: {
        horizonYears: 11,
        events: [createEvent('buy_home', { startMonth: 1, price: 100000, downPayment: 20000, mortgageRate: 0, mortgageYears: 10, rentReplaced: 1000, ownershipCosts: 200 })],
      },
    }));
    const m1 = r.months[1];
    assert.equal(m1.property, 100000);
    assert.equal(m1.mortgage, 80000);
    assert.equal(m1.expenses, 3000 - 1000 + 200, 'first payment starts the month after purchase');
    assert.equal(m1.liquid, 52000 - 20000 + (5000 - 2200));
    assert.equal(m1.netWorth, m1.liquid + 100000 - 80000);
    const m2 = r.months[2];
    approx(m2.expenses, 2200 + 666.67, 0.01);
    approx(m2.mortgage, 80000 - 666.67, 0.01);
    // 120 payments from month 2 → last payment in month 121
    assert.ok(r.months[120].mortgage > 0);
    assert.equal(r.months[121].mortgage, 0);
    approx(r.months[121].expenses, 2200 + 666.67, 0.01);
    assert.equal(r.months[122].expenses, 2200, 'payment disappears once amortised');
  });

  test('property appreciates', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 100000, monthlyIncome: 0, monthlyExpenses: 0, monthlyContribution: 0 },
      scenario: { economy: flatEconomy({ propertyAppreciation: 0.12 }), events: [createEvent('buy_home', { startMonth: 0, price: 100000, downPayment: 100000, rentReplaced: 0, ownershipCosts: 0 })] },
    }));
    approx(r.months[11].property, 112000, 0.01);
  });

  test('contribution events change the investing rate', () => {
    const r = simulate(mkInput({
      scenario: { events: [createEvent('contribution', { startMonth: 1, amount: 500 }), createEvent('contribution', { startMonth: 2, percent: -1, amount: undefined, durationMonths: 1 })] },
    }));
    assert.deepEqual(r.months.slice(0, 4).map(m => m.contribution), [1000, 1500, 500, 1500], "percent scales the base; absolute add-ons persist");
  });

  test('contribution is capped by available cash', () => {
    const r = simulate(mkInput({ baseline: { liquid: 0, monthlyIncome: 3500, monthlyExpenses: 3000, monthlyContribution: 1000 } }));
    assert.equal(r.months[0].contribution, 500);
    assert.equal(r.months[0].liquid, 0);
  });
});

describe('sim/engine: deficits, depletion and runway', () => {
  const input = () => mkInput({
    baseline: { liquid: 2500, invested: 1000, monthlyIncome: 0, monthlyExpenses: 1000, monthlyContribution: 0 },
    scenario: { horizonYears: 1 },
  });

  test('deficits drain cash, then investments, then become shortfall', () => {
    const r = simulate(input());
    assert.deepEqual(r.months.slice(0, 6).map(m => [m.liquid, m.invested, m.shortfall, m.contribution]), [
      [1500, 1000, 0, 0],
      [500, 1000, 0, 0],
      [0, 500, 0, -500],
      [0, 0, 500, -500],
      [0, 0, 1500, 0],
      [0, 0, 2500, 0],
    ]);
    assert.equal(r.summary.depletedMonth, 3);
    assert.equal(r.summary.endShortfall, 8500);
    assert.equal(r.summary.minNetWorth, -8500);
    assert.equal(r.months[11].netWorth, -8500);
  });

  test('runway metrics', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 10000, invested: 5000, debt: 0, monthlyIncome: 5000, monthlyExpenses: 1000, monthlyContribution: 500 },
      scenario: { horizonYears: 3 },
    }));
    assert.equal(r.summary.runway.cashMonths, 10);
    assert.equal(r.summary.runway.totalMonths, 15);
    assert.equal(r.summary.runway.simulatedMonths, 15, 'income stops today → assets last 15 months');
    assert.equal(r.summary.depletedMonth, null, 'main run is healthy');
  });

  test('runway with zero expenses is null / never', () => {
    const r = simulate(mkInput({ baseline: { monthlyExpenses: 0, monthlyIncome: 0, monthlyContribution: 0 } }));
    assert.equal(r.summary.runway.cashMonths, null);
    assert.equal(r.summary.runway.totalMonths, null);
    assert.equal(r.summary.runway.simulatedMonths, null);
  });
});

describe('sim/engine: FIRE metrics', () => {
  test('FI numbers and progress from the baseline', () => {
    const r = simulate(mkInput({ baseline: { liquid: 100000, invested: 250000, debt: 50000, monthlyExpenses: 4000 } }));
    const f = r.summary.fire;
    assert.equal(f.annualExpensesToday, 48000);
    assert.equal(f.fiNumber, 1200000);
    assert.equal(f.leanFiNumber, 840000);
    assert.equal(f.investableToday, 300000);
    assert.equal(f.progress, 0.25);
    assert.equal(f.safeWithdrawalRate, 0.04);
  });

  test('FI / lean / coast months in a zero-growth world', () => {
    // Everything surplus is invested: investable_t = 300000 + 6000·(t+1)
    const r = simulate(mkInput({
      baseline: { liquid: 0, invested: 300000, monthlyIncome: 10000, monthlyExpenses: 4000, monthlyContribution: 0 },
      scenario: { horizonYears: 20, policy: { emergencyFundMonths: 0, investSurplus: true, contributionFollowsWages: true } },
    }));
    const f = r.summary.fire;
    assert.equal(f.fiMonth, 149);       // 300000 + 6000·150 = 1 200 000
    assert.equal(f.leanFiMonth, 89);    // 840 000
    assert.equal(f.coastFiMonth, 149, 'with 0 % growth coast FI equals FI');
    assert.equal(f.coastFiNumber, 1200000);
    assert.equal(f.fiDate, '2039-03');
    assert.equal(f.fiAge, 52.67);
    assert.equal(f.fiByRetirement, true);
  });

  test('coast FI is reached earlier when growth does the work', () => {
    const r = simulate(mkInput({
      baseline: { liquid: 0, invested: 300000, monthlyIncome: 10000, monthlyExpenses: 4000, monthlyContribution: 0 },
      scenario: { horizonYears: 25, economy: flatEconomy({ expectedReturn: 0.07 }), policy: { emergencyFundMonths: 0, investSurplus: true, contributionFollowsWages: true } },
    }));
    const f = r.summary.fire;
    assert.ok(f.coastFiMonth !== null && f.fiMonth !== null && f.coastFiMonth < f.fiMonth);
    approx(f.coastFiNumber, 1200000 / Math.pow(1.07, 297 / 12), 1);
  });

  test('FI not reached within horizon → nulls', () => {
    const r = simulate(mkInput({ baseline: { liquid: 0, invested: 0, monthlyIncome: 3000, monthlyExpenses: 2900, monthlyContribution: 0 }, scenario: { horizonYears: 1 } }));
    assert.equal(r.summary.fire.fiMonth, null);
    assert.equal(r.summary.fire.fiDate, null);
    assert.equal(r.summary.fire.fiAge, null);
    assert.equal(r.summary.fire.fiByRetirement, false);
  });
});

describe('sim/engine: output shape & determinism', () => {
  test('yearly snapshots aggregate twelve months and include a trailing partial year', () => {
    const r = simulate(mkInput({ scenario: { horizonYears: 2.5 } }));
    assert.equal(r.months.length, 30);
    assert.equal(r.yearly.length, 3);
    assert.deepEqual(r.yearly.map(y => y.t), [11, 23, 29]);
    assert.deepEqual(r.yearly.map(y => y.year), [2027, 2028, 2029]);
    assert.equal(r.yearly[0].income, 60000);
    assert.equal(r.yearly[0].expenses, 36000);
    assert.equal(r.yearly[0].contribution, 12000);
    assert.equal(r.yearly[2].income, 30000);
    assert.equal(r.yearly[1].netWorth, r.months[23].netWorth);
  });

  test('same input produces identical output', () => {
    const a = simulate(mkInput({ scenario: { economy: normalizeEconomy({ preset: 'crash-recovery' }), horizonYears: 10, events: [createEvent('buy_home', { startMonth: 6 })] } }));
    const b = simulate(mkInput({ scenario: { economy: normalizeEconomy({ preset: 'crash-recovery' }), horizonYears: 10, events: [createEvent('buy_home', { startMonth: 6, id: a.months.length.toString() })] } }));
    assert.deepEqual(a.months, b.months);
    assert.deepEqual(a.summary, b.summary);
  });

  test('input objects are not mutated', () => {
    const input = mkInput({ scenario: { events: [createEvent('windfall', { startMonth: 0 })] } });
    const snapshot = JSON.stringify(input);
    simulate(input);
    assert.equal(JSON.stringify(input), snapshot);
  });
});
