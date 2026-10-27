import type { Profile, Scenario, SavingsPolicy } from './types.js';
import { normalizeEconomy } from './economy.js';
import { normalizeEvents } from './events.js';
import { DEFAULT_POLICY } from './engine.js';

export const DEFAULT_PROFILE: Profile = {
  birthDate: '1991-01-01',
  retirementAge: 65,
  safeWithdrawalRate: 0.04,
  planToAge: 90,
};

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Coerce an untrusted object into a Profile, filling gaps from defaults. */
export function normalizeProfile(raw: any, base: Profile = DEFAULT_PROFILE): Profile {
  const birth = typeof raw?.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.birthDate) && !Number.isNaN(Date.parse(raw.birthDate))
    ? raw.birthDate
    : base.birthDate;
  const retirementAge = Math.min(100, Math.max(18, num(raw?.retirementAge, base.retirementAge)));
  return {
    birthDate: birth,
    retirementAge,
    safeWithdrawalRate: Math.min(0.2, Math.max(0.005, num(raw?.safeWithdrawalRate, base.safeWithdrawalRate))),
    planToAge: Math.min(110, Math.max(retirementAge, num(raw?.planToAge, base.planToAge))),
  };
}

export function normalizePolicy(raw: any): SavingsPolicy {
  return {
    emergencyFundMonths: Math.max(0, num(raw?.emergencyFundMonths, DEFAULT_POLICY.emergencyFundMonths)),
    investSurplus: typeof raw?.investSurplus === 'boolean' ? raw.investSurplus : DEFAULT_POLICY.investSurplus,
    contributionFollowsWages: typeof raw?.contributionFollowsWages === 'boolean' ? raw.contributionFollowsWages : DEFAULT_POLICY.contributionFollowsWages,
  };
}

const OVERRIDE_KEYS = ['liquid', 'invested', 'debt', 'monthlyIncome', 'monthlyExpenses', 'monthlyContribution'] as const;

/**
 * Validate and coerce an untrusted scenario payload (API body or stored JSON).
 * Throws on structural errors; numeric fields are clamped to sane ranges.
 */
export function normalizeScenario(raw: any): Scenario {
  if (!raw || typeof raw !== 'object') throw new Error('scenario must be an object');
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : 'Untitled scenario';
  const horizonRaw = num(raw.horizonYears, 0);
  const overrides: NonNullable<Scenario['overrides']> = {};
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const k of OVERRIDE_KEYS) {
      const v = raw.overrides[k];
      if (typeof v === 'number' && Number.isFinite(v)) overrides[k] = v;
    }
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 1000) : undefined,
    horizonYears: horizonRaw > 0 ? Math.min(80, Math.max(1, horizonRaw)) : undefined,
    economy: normalizeEconomy(raw.economy),
    events: normalizeEvents(raw.events),
    policy: normalizePolicy(raw.policy),
    overrides: Object.keys(overrides).length ? overrides : undefined,
  };
}

/** A scenario with no events on the default economy: the "keep doing what you're doing" path. */
export function baselineScenario(name = 'Baseline'): Scenario {
  return normalizeScenario({ name, economy: { preset: 'moderate' }, events: [] });
}
