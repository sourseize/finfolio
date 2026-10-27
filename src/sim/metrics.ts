import type { Goal } from '../db/database.js';
import type { SimulationInput, SimulationResult } from './types.js';
import { simulate } from './engine.js';
import { addMonths, futureValue, growthFactor, monthsBetween, round2 } from './math.js';

// ── Opportunity cost ────────────────────────────────────────────────────────

export interface OpportunityCostInput {
  /** One-off spend today (positive number). */
  oneOff?: number;
  /** Recurring monthly spend (positive number). */
  monthly?: number;
  /** Years the money would otherwise have compounded. */
  years: number;
  annualReturn: number;
  inflation: number;
}

export interface OpportunityCostResult {
  years: number;
  totalSpent: number;
  /** What the same money would be worth if invested instead (nominal). */
  futureValue: number;
  /** Future value in today's purchasing power. */
  realFutureValue: number;
  /** futureValue − totalSpent. */
  growth: number;
  /** Multiple of the original spend. */
  multiple: number;
  /** Year-by-year value of the forgone investment (for charting). */
  series: { year: number; value: number; spent: number }[];
}

/**
 * "What does this spending decision really cost?" — the future value of the
 * money if it had been invested instead. Pure compounding, no engine run.
 */
export function opportunityCost(input: OpportunityCostInput): OpportunityCostResult {
  const oneOff = Math.max(0, input.oneOff ?? 0);
  const monthly = Math.max(0, input.monthly ?? 0);
  const years = Math.max(0, input.years);
  const months = Math.round(years * 12);
  const fv = futureValue(oneOff, monthly, input.annualReturn, months);
  const totalSpent = oneOff + monthly * months;
  const series: OpportunityCostResult['series'] = [];
  for (let y = 0; y <= years; y++) {
    const m = y * 12;
    series.push({ year: y, value: round2(futureValue(oneOff, monthly, input.annualReturn, m)), spent: round2(oneOff + monthly * m) });
  }
  return {
    years,
    totalSpent: round2(totalSpent),
    futureValue: round2(fv),
    realFutureValue: round2(fv / growthFactor(input.inflation, months)),
    growth: round2(fv - totalSpent),
    multiple: totalSpent > 0 ? round2(fv / totalSpent) : 0,
    series,
  };
}

// ── Scenario comparison ─────────────────────────────────────────────────────

export interface ScenarioDelta {
  base: string;
  alt: string;
  endNetWorth: number;
  endRealNetWorth: number;
  minNetWorth: number;
  /** Positive = alt reaches FI later (months). null when either never reaches it. */
  fiMonthDelta: number | null;
  netWorthAtRetirement: number | null;
  /** Aligned yearly net-worth difference (alt − base). */
  yearly: { year: number; t: number; base: number; alt: number; delta: number }[];
}

export function compareResults(base: SimulationResult, alt: SimulationResult): ScenarioDelta {
  const baseByT = new Map(base.yearly.map(y => [y.t, y]));
  const yearly = alt.yearly
    .filter(y => baseByT.has(y.t))
    .map(y => {
      const b = baseByT.get(y.t)!;
      return { year: y.year, t: y.t, base: b.netWorth, alt: y.netWorth, delta: round2(y.netWorth - b.netWorth) };
    });
  const bFi = base.summary.fire.fiMonth;
  const aFi = alt.summary.fire.fiMonth;
  const bRet = base.summary.netWorthAtRetirement;
  const aRet = alt.summary.netWorthAtRetirement;
  return {
    base: base.scenarioName,
    alt: alt.scenarioName,
    endNetWorth: round2(alt.summary.endNetWorth - base.summary.endNetWorth),
    endRealNetWorth: round2(alt.summary.endRealNetWorth - base.summary.endRealNetWorth),
    minNetWorth: round2(alt.summary.minNetWorth - base.summary.minNetWorth),
    fiMonthDelta: bFi === null || aFi === null ? null : aFi - bFi,
    netWorthAtRetirement: bRet === null || aRet === null ? null : round2(aRet - bRet),
    yearly,
  };
}

/** Convenience: run both and diff. */
export function compareScenarios(base: SimulationInput, alt: SimulationInput): { base: SimulationResult; alt: SimulationResult; delta: ScenarioDelta } {
  const b = simulate(base);
  const a = simulate(alt);
  return { base: b, alt: a, delta: compareResults(b, a) };
}

// ── Goal feasibility ────────────────────────────────────────────────────────

export interface GoalFeasibility {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  remaining: number;
  deadline: string | null;
  monthsToDeadline: number | null;
  /** Monthly saving needed to hit the target by the deadline (0 when already funded). */
  requiredMonthly: number | null;
  /** Monthly surplus this goal gets after higher-priority goals took theirs. */
  allocatedMonthly: number;
  /** Month offset when the goal would be funded at the allocated rate (null = never). */
  fundedInMonths: number | null;
  fundedBy: string | null;
  status: 'funded' | 'on_track' | 'at_risk' | 'unreachable';
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Check each goal against the projected monthly surplus of a simulation.
 *
 * Surplus = average (income − expenses) over the first year of the run, minus
 * `reservedMonthly` (the deliberate investment contribution, which is not
 * available for goals; automatic surplus sweeps are). Goals claim it in
 * priority order (then nearest deadline) — a simple waterfall that makes the
 * trade-off between goals visible.
 */
export function goalFeasibility(goals: Goal[], result: SimulationResult, reservedMonthly = 0): GoalFeasibility[] {
  const firstYear = result.months.slice(0, 12);
  const surplus = firstYear.length
    ? Math.max(0, firstYear.reduce((s, m) => s + (m.income - m.expenses), 0) / firstYear.length - Math.max(0, reservedMonthly))
    : 0;

  const ordered = [...goals].sort((a, b) => {
    const p = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    if (p !== 0) return p;
    return (a.deadline || '9999').localeCompare(b.deadline || '9999');
  });

  let remainingSurplus = surplus;
  return ordered.map(g => {
    const remaining = Math.max(0, g.targetAmount - g.currentAmount);
    const monthsToDeadline = g.deadline ? Math.max(0, monthsBetween(result.asOf, g.deadline)) : null;
    const requiredMonthly =
      remaining === 0 ? 0 : monthsToDeadline === null ? null : monthsToDeadline === 0 ? Infinity : remaining / monthsToDeadline;

    let allocated = 0;
    if (remaining > 0 && remainingSurplus > 0) {
      allocated = requiredMonthly !== null && Number.isFinite(requiredMonthly) ? Math.min(requiredMonthly, remainingSurplus) : remainingSurplus;
      remainingSurplus -= allocated;
    }
    const fundedInMonths = remaining === 0 ? 0 : allocated > 0 ? Math.ceil(remaining / allocated) : null;

    let status: GoalFeasibility['status'];
    if (remaining === 0) status = 'funded';
    else if (fundedInMonths === null) status = 'unreachable';
    else if (monthsToDeadline === null || fundedInMonths <= monthsToDeadline) status = 'on_track';
    else status = 'at_risk';

    return {
      id: g.id,
      name: g.name,
      targetAmount: g.targetAmount,
      currentAmount: g.currentAmount,
      remaining: round2(remaining),
      deadline: g.deadline || null,
      monthsToDeadline,
      requiredMonthly: requiredMonthly === null ? null : Number.isFinite(requiredMonthly) ? round2(requiredMonthly) : null,
      allocatedMonthly: round2(allocated),
      fundedInMonths,
      fundedBy: fundedInMonths === null ? null : addMonths(result.asOf, fundedInMonths),
      status,
    };
  });
}
