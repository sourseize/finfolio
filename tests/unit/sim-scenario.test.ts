import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario, normalizeProfile, normalizePolicy, baselineScenario, DEFAULT_PROFILE } from '../../src/sim/scenario.js';

describe('sim/scenario normalisation', () => {
  test('profile fills defaults and clamps', () => {
    assert.deepEqual(normalizeProfile(undefined), DEFAULT_PROFILE);
    const p = normalizeProfile({ birthDate: '1986-07-10', retirementAge: 65, safeWithdrawalRate: 0.035, planToAge: 50 });
    assert.equal(p.birthDate, '1986-07-10');
    assert.equal(p.planToAge, 65, 'plan-to age cannot precede retirement');
    assert.equal(normalizeProfile({ birthDate: 'yesterday' }).birthDate, DEFAULT_PROFILE.birthDate);
    assert.equal(normalizeProfile({ birthDate: '2020-13-45' }).birthDate, DEFAULT_PROFILE.birthDate);
    assert.equal(normalizeProfile({ retirementAge: 5 }).retirementAge, 18);
    assert.equal(normalizeProfile({ safeWithdrawalRate: 5 }).safeWithdrawalRate, 0.2);
  });

  test('policy fills defaults', () => {
    assert.deepEqual(normalizePolicy(undefined), { emergencyFundMonths: 6, investSurplus: true, contributionFollowsWages: true });
    assert.deepEqual(normalizePolicy({ emergencyFundMonths: -2, investSurplus: false }), { emergencyFundMonths: 0, investSurplus: false, contributionFollowsWages: true });
  });

  test('scenario validation and coercion', () => {
    assert.throws(() => normalizeScenario(null), /must be an object/);
    assert.throws(() => normalizeScenario({ events: 'x' }), /must be an array/);
    const s = normalizeScenario({
      name: '  Buy a flat  ',
      horizonYears: 300,
      economy: { preset: 'pessimistic' },
      events: [{ kind: 'one_off', amount: -1000, startMonth: 2 }],
      overrides: { monthlyExpenses: 4000, liquid: 'lots', bogus: 1 },
      policy: { investSurplus: false },
    });
    assert.equal(s.name, 'Buy a flat');
    assert.equal(s.horizonYears, 80);
    assert.equal(s.economy.expectedReturn, 0.04);
    assert.equal(s.events.length, 1);
    assert.deepEqual(s.overrides, { monthlyExpenses: 4000 });
    assert.equal(s.policy.investSurplus, false);
    assert.equal(s.id, undefined);

    const blank = normalizeScenario({});
    assert.equal(blank.name, 'Untitled scenario');
    assert.equal(blank.horizonYears, undefined);
    assert.equal(blank.overrides, undefined);
  });

  test('baselineScenario is the moderate economy with no events', () => {
    const b = baselineScenario();
    assert.equal(b.name, 'Baseline');
    assert.equal(b.economy.preset, 'moderate');
    assert.deepEqual(b.events, []);
  });
});
