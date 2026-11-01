import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { anonymousA, anonymousB, anonymousPersonas, anonymousSnapshot } from '../../src/seed/anonymous.js';
import { validateSnapshot } from '../../src/compare/schema.js';
import { computeMotivation } from '../../src/motivation/engine.js';
import { scanPrivacy } from '../helpers/privacy.js';

describe('seed/anonymous personas (snapshot-only people for the Compare page)', () => {
  test('both build deterministic, valid snapshots as of the seed date', () => {
    const personas = anonymousPersonas();
    assert.deepEqual(personas.map(p => p.label), ['Anonymous A', 'Anonymous B']);
    for (const p of personas) {
      const s = anonymousSnapshot(p);
      assert.equal(s.asOf, '2026-10-25');
      assert.equal(s.label, p.label);
      const v = validateSnapshot(JSON.parse(JSON.stringify(s)));
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(anonymousSnapshot(p).checksum, s.checksum, 'deterministic');
      assert.deepEqual(scanPrivacy(s.data, ['anon', 'Household checking', 'Platinum', 'Current account', 'Pension cash', '1979-05-14', '1974-09-30', 'Mortgage payment', 'Bus pass']), []);
      assert.equal(s.data.cashflow.series.length, 24);
      assert.equal(s.data.outlook.fire.fiDate, null, `${p.label}: FI is not in sight on current habits`);
    }
  });

  test('Anonymous A: high earner, high spender, streak on investing, FI rung but no FI date', () => {
    const d = anonymousSnapshot(anonymousA()).data;
    assert.equal(d.profile.age, 47);
    assert.equal(d.profile.retirementAge, 62);
    assert.ok(d.cashflow.monthlyIncome > 11000 && d.cashflow.monthlyIncome < 12500, `income ${d.cashflow.monthlyIncome}`);
    assert.ok(d.cashflow.monthlyExpenses > 8000 && d.cashflow.monthlyExpenses < 9000, `expenses ${d.cashflow.monthlyExpenses}`);
    assert.ok(d.cashflow.savingsRate > 0.25 && d.cashflow.savingsRate < 0.33, `savings rate ${d.cashflow.savingsRate}`);
    assert.equal(d.cashflow.monthlyInvested, 1500);
    assert.equal(d.position.accountsByType.credit.count, 2);
    assert.ok(d.position.debt >= 14500);
    assert.ok(d.position.netWorth > 150000);
    assert.ok(d.investments.holdings.some(h => h.type === 'crypto'));
    assert.equal(d.investments.holdings[0].symbol, 'VOO');
    assert.ok(d.budgets.items.filter(b => b.spent > b.budgeted).length >= 3, 'most budgets are over');
    assert.deepEqual(d.motivation.habits.map(h => [h.kind, h.cadence, h.streak]), [['invest', 'monthly', 12], ['swap', 'monthly', 0]]);
    assert.ok(d.motivation.habits[1].hitRate < 0.5, 'the entertainment cap is hit-and-miss');
    assert.deepEqual(d.motivation.badges.filter(b => b.unlockedOn).map(b => b.key), ['first-step', 'century', 'on-fire', 'unstoppable', 'treat', 'fi-5']);
    assert.equal(d.motivation.rewardsClaimed, 2);
    assert.ok(d.outlook.fire.progress > 0.05 && d.outlook.fire.progress < 0.1);
    assert.equal(d.outlook.fire.fiByRetirement, false);
  });

  test('Anonymous B: frugal late starter, no debt, Thousand + Unstoppable, two FI rungs', () => {
    const d = anonymousSnapshot(anonymousB()).data;
    assert.equal(d.profile.age, 52);
    assert.equal(d.profile.retirementAge, 67);
    assert.ok(d.cashflow.monthlyIncome > 3900 && d.cashflow.monthlyIncome < 4200, `income ${d.cashflow.monthlyIncome}`);
    assert.ok(d.cashflow.savingsRate > 0.38 && d.cashflow.savingsRate < 0.45, `savings rate ${d.cashflow.savingsRate}`);
    assert.equal(d.position.debt, 0);
    assert.equal(d.position.accountsByType.credit, undefined);
    assert.ok(!d.investments.holdings.some(h => h.type === 'crypto' || h.type === 'stock'));
    assert.equal(d.motivation.habits[0].cadence, 'weekly');
    assert.ok(d.motivation.habits[0].streak > 52, 'more than a year of weekly saving');
    assert.ok(d.motivation.pointsEarned > 1000);
    assert.equal(d.motivation.rewardsClaimed, 5);
    const badges = d.motivation.badges.filter(b => b.unlockedOn).map(b => b.key);
    for (const k of ['thousand', 'unstoppable', 'fi-5', 'fi-10']) assert.ok(badges.includes(k), k);
    assert.ok(!badges.includes('closer'));
    assert.ok(d.outlook.fire.progress > 0.1);
    assert.ok(d.outlook.runway.cashMonths! > 8);
  });

  test('every reward claim was affordable on its date and no nudge is pending', () => {
    for (const p of anonymousPersonas()) {
      const s = anonymousSnapshot(p).data;
      const m = computeMotivation({ ...p.source, today: '2026-10-25', fi: { progress: s.outlook.fire.progress, fiDate: s.outlook.fire.fiDate, fiNumber: s.outlook.fire.fiNumber } });
      assert.ok(m.ledger.every(l => l.balance >= 0), `${p.label}: running balance never negative`);
      assert.equal(m.nudge, null, `${p.label}: no nudge`);
      assert.equal(m.points.balance, s.motivation.balance);
    }
  });
});
