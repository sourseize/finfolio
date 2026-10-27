/** Builders for simulation inputs with "boring" defaults so tests can hand-calculate results. */
import type { Baseline, EconomyAssumptions, Profile, Scenario, SimulationInput } from '../../src/sim/types.js';
import { DEFAULT_POLICY } from '../../src/sim/engine.js';

export const AS_OF = '2026-10-25';

/** Fin's profile: born 1986-07-10 (age 40 on the as-of date), retire at 65. */
export function mkProfile(over: Partial<Profile> = {}): Profile {
  return { birthDate: '1986-07-10', retirementAge: 65, safeWithdrawalRate: 0.04, planToAge: 90, ...over };
}

/** All rates zero: money neither grows nor inflates, so arithmetic is exact. */
export function flatEconomy(over: Partial<EconomyAssumptions> = {}): EconomyAssumptions {
  return {
    expectedReturn: 0, volatility: 0, inflation: 0, wageGrowth: 0, cashYield: 0, debtRate: 0, propertyAppreciation: 0, shocks: [],
    ...over,
  };
}

export function mkBaseline(over: Partial<Baseline> = {}): Baseline {
  return {
    asOf: AS_OF,
    liquid: 10000,
    invested: 0,
    debt: 0,
    monthlyIncome: 5000,
    monthlyExpenses: 3000,
    monthlyContribution: 1000,
    lookbackMonths: 12,
    detail: { accounts: [], holdingsValue: 0, incomeMonths: 12, windowStart: '2025-10', windowEnd: '2026-09', expenseByCategory: {} },
    ...over,
  };
}

export function mkScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    name: 'Test',
    horizonYears: 2,
    economy: flatEconomy(),
    events: [],
    policy: { ...DEFAULT_POLICY, investSurplus: false },
    ...over,
  };
}

export function mkInput(over: { baseline?: Partial<Baseline>; profile?: Partial<Profile>; scenario?: Partial<Scenario> } = {}): SimulationInput {
  return { baseline: mkBaseline(over.baseline), profile: mkProfile(over.profile), scenario: mkScenario(over.scenario) };
}

export function approx(actual: number, expected: number, tolerance = 0.01): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Expected ${actual} ≈ ${expected} (±${tolerance})`);
  }
}
