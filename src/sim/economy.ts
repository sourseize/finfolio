import type { EconomyAssumptions, MarketShock } from './types.js';
import { annualToMonthly } from './math.js';

export interface EconomyPreset {
  id: string;
  label: string;
  description: string;
  assumptions: Omit<EconomyAssumptions, 'preset'>;
}

const base = {
  cashYield: 0.02,
  debtRate: 0.18,
  propertyAppreciation: 0.03,
  shocks: [] as MarketShock[],
};

/**
 * Named economic conditions. Numbers are deliberately conventional
 * (long-run equity returns, CPI targets) rather than forecasts.
 */
export const ECONOMY_PRESETS: EconomyPreset[] = [
  {
    id: 'moderate',
    label: 'Moderate growth',
    description: 'Long-run averages: 7 % returns, 2.5 % inflation, 3 % wage growth.',
    assumptions: { ...base, expectedReturn: 0.07, volatility: 0.15, inflation: 0.025, wageGrowth: 0.03 },
  },
  {
    id: 'optimistic',
    label: 'Bull market',
    description: 'Strong growth: 10 % returns, 2 % inflation, 4 % wage growth.',
    assumptions: { ...base, expectedReturn: 0.10, volatility: 0.14, inflation: 0.02, wageGrowth: 0.04 },
  },
  {
    id: 'pessimistic',
    label: 'Bear market',
    description: 'Weak growth: 4 % returns, 3.5 % inflation, 2 % wage growth, higher volatility.',
    assumptions: { ...base, expectedReturn: 0.04, volatility: 0.18, inflation: 0.035, wageGrowth: 0.02 },
  },
  {
    id: 'stagflation',
    label: 'Stagflation',
    description: 'High inflation with flat markets: 3 % returns, 6 % inflation, wages lag at 3 %.',
    assumptions: { ...base, expectedReturn: 0.03, volatility: 0.20, inflation: 0.06, wageGrowth: 0.03, cashYield: 0.04, debtRate: 0.22 },
  },
  {
    id: 'lost-decade',
    label: 'Lost decade',
    description: 'Markets go nowhere: 1 % returns, 2 % inflation, 2 % wage growth.',
    assumptions: { ...base, expectedReturn: 0.01, volatility: 0.17, inflation: 0.02, wageGrowth: 0.02 },
  },
  {
    id: 'crash-recovery',
    label: 'Crash then recovery',
    description: 'Moderate growth with a −35 % crash in year 2 that takes three years to recover.',
    assumptions: {
      ...base,
      expectedReturn: 0.07,
      volatility: 0.15,
      inflation: 0.025,
      wageGrowth: 0.03,
      shocks: [{ id: 'crash-y2', label: 'Market crash', startMonth: 12, drop: -0.35, recoveryMonths: 36 }],
    },
  },
  {
    id: 'deflation',
    label: 'Deflation',
    description: 'Falling prices and near-zero rates: 2 % returns, −1 % inflation, frozen wages.',
    assumptions: { ...base, expectedReturn: 0.02, volatility: 0.12, inflation: -0.01, wageGrowth: 0, cashYield: 0.005, debtRate: 0.15 },
  },
];

export function getEconomyPreset(id: string): EconomyAssumptions {
  const preset = ECONOMY_PRESETS.find(p => p.id === id);
  if (!preset) throw new Error(`Unknown economy preset: ${id}`);
  return { preset: preset.id, ...structuredClone(preset.assumptions) };
}

export const DEFAULT_ECONOMY: EconomyAssumptions = getEconomyPreset('moderate');

/**
 * Build an `EconomyAssumptions` from a partial object, filling gaps from a preset
 * (default "moderate"). Used when parsing API payloads.
 */
export function normalizeEconomy(input: Partial<EconomyAssumptions> | undefined): EconomyAssumptions {
  const presetId = input?.preset && ECONOMY_PRESETS.some(p => p.id === input.preset) ? input.preset : 'moderate';
  const fromPreset = getEconomyPreset(presetId);
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    preset: input?.preset,
    expectedReturn: num(input?.expectedReturn, fromPreset.expectedReturn),
    volatility: Math.max(0, num(input?.volatility, fromPreset.volatility)),
    inflation: num(input?.inflation, fromPreset.inflation),
    wageGrowth: num(input?.wageGrowth, fromPreset.wageGrowth),
    cashYield: num(input?.cashYield, fromPreset.cashYield),
    debtRate: num(input?.debtRate, fromPreset.debtRate),
    propertyAppreciation: num(input?.propertyAppreciation, fromPreset.propertyAppreciation),
    shocks: Array.isArray(input?.shocks)
      ? input!.shocks
          .filter(s => s && typeof s === 'object')
          .map((s, i) => ({
            id: String(s.id ?? `shock-${i + 1}`),
            label: String(s.label ?? 'Market shock'),
            startMonth: Math.max(0, Math.round(num(s.startMonth, 0))),
            drop: Math.max(-0.99, Math.min(0, num(s.drop, -0.2))),
            recoveryMonths: Math.max(0, Math.round(num(s.recoveryMonths, 0))),
          }))
      : fromPreset.shocks,
  };
}

/**
 * Apply scheduled shocks to a month's gross return factor.
 *
 * - At `startMonth` the trend return is replaced by the drop (1 + drop).
 * - During the next `recoveryMonths` the market climbs back to its **pre-crash
 *   level**: the trend return is replaced by a constant monthly factor whose
 *   product over the recovery equals 1 / (1 + drop). (Random noise in a Monte
 *   Carlo path is preserved; only the drift is replaced.) The crash therefore
 *   costs the growth that would have happened during the recovery.
 * - With `recoveryMonths = 0` the loss is permanent.
 *
 * @param baseFactor gross monthly factor before shocks (1 + r)
 * @param trendFactor the deterministic expected monthly factor (1 + r̄), used to strip drift
 */
export function applyShocks(shocks: MarketShock[], t: number, baseFactor: number, trendFactor: number): number {
  let f = baseFactor;
  for (const s of shocks) {
    if (t === s.startMonth) {
      f = (f / trendFactor) * (1 + s.drop);
    } else if (s.recoveryMonths > 0 && t > s.startMonth && t <= s.startMonth + s.recoveryMonths) {
      const recovery = Math.pow(1 / (1 + s.drop), 1 / s.recoveryMonths);
      f = (f / trendFactor) * recovery;
    }
  }
  return f;
}

/** Deterministic monthly return at `t`: expected return compounded monthly, adjusted for shocks. */
export function deterministicReturn(economy: EconomyAssumptions, t: number): number {
  const trend = 1 + annualToMonthly(economy.expectedReturn);
  return applyShocks(economy.shocks, t, trend, trend) - 1;
}
