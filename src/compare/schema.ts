/**
 * Validation of an imported snapshot. The file is untrusted input: every
 * field is type-checked, numbers must be finite, arrays are capped, strings are
 * trimmed and capped, and the checksum must match. The result is a *new*
 * object containing only known fields, so nothing unexpected travels further.
 */
import { checksumOf } from './snapshot.js';
import {
  SNAPSHOT_FORMAT, SNAPSHOT_LIMITS, SNAPSHOT_VERSION,
  type Snapshot, type SnapshotData, type SnapshotGoal, type SnapshotHabit, type SnapshotHolding, type SnapshotMonth,
} from './types.js';

export type Validation = { ok: true; snapshot: Snapshot; warnings: string[] } | { ok: false; errors: string[] };

class Invalid extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const GOAL_STATUS = new Set(['funded', 'on_track', 'at_risk', 'unreachable']);

function fail(path: string, what: string): never {
  throw new Invalid(`${path}: ${what}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected an object');
  return v as Record<string, unknown>;
}

function num(v: unknown, path: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a finite number');
  if (opts.min !== undefined && v < opts.min) fail(path, `must be ≥ ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) fail(path, `must be ≤ ${opts.max}`);
  return v;
}

function numOrNull(v: unknown, path: string): number | null {
  return v === null ? null : num(v, path);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected true or false');
  return v;
}

function str(v: unknown, path: string, max: number = SNAPSHOT_LIMITS.string): string {
  if (typeof v !== 'string') fail(path, 'expected text');
  // Strip control characters; keep the rest (names may hold any script).
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function strOrNull(v: unknown, path: string, max?: number): string | null {
  return v === null ? null : str(v, path, max);
}

function date(v: unknown, path: string): string {
  const s = str(v, path, 10);
  if (!ISO_DATE.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) fail(path, 'expected YYYY-MM-DD');
  return s;
}

function month(v: unknown, path: string): string {
  const s = str(v, path, 7);
  if (!ISO_MONTH.test(s)) fail(path, 'expected YYYY-MM');
  return s;
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected a list');
  if (v.length > max) fail(path, `at most ${max} entries`);
  return v;
}

function record<T>(v: unknown, path: string, max: number, each: (value: unknown, p: string) => T): Record<string, T> {
  const o = obj(v, path);
  const keys = Object.keys(o);
  if (keys.length > max) fail(path, `at most ${max} entries`);
  const out: Record<string, T> = {};
  for (const k of keys) out[str(k, `${path} key`)] = each(o[k], `${path}.${k}`);
  return out;
}

function validateData(raw: unknown): SnapshotData {
  const d = obj(raw, 'data');

  const p = obj(d.profile, 'data.profile');
  const profile = {
    age: num(p.age, 'data.profile.age', { min: 0, max: 130 }),
    retirementAge: num(p.retirementAge, 'data.profile.retirementAge', { min: 0, max: 130 }),
    safeWithdrawalRate: num(p.safeWithdrawalRate, 'data.profile.safeWithdrawalRate', { min: 0, max: 1 }),
    planToAge: num(p.planToAge, 'data.profile.planToAge', { min: 0, max: 130 }),
  };

  const pos = obj(d.position, 'data.position');
  const position = {
    netWorth: num(pos.netWorth, 'data.position.netWorth'),
    liquid: num(pos.liquid, 'data.position.liquid'),
    invested: num(pos.invested, 'data.position.invested'),
    debt: num(pos.debt, 'data.position.debt'),
    holdingsValue: num(pos.holdingsValue, 'data.position.holdingsValue'),
    accountsByType: record(pos.accountsByType, 'data.position.accountsByType', SNAPSHOT_LIMITS.accountTypes, (v, path) => {
      const o = obj(v, path);
      return { count: num(o.count, `${path}.count`, { min: 0 }), balance: num(o.balance, `${path}.balance`) };
    }),
  };

  const c = obj(d.cashflow, 'data.cashflow');
  const cashflow = {
    lookbackMonths: num(c.lookbackMonths, 'data.cashflow.lookbackMonths', { min: 0, max: 1200 }),
    hasHistory: bool(c.hasHistory, 'data.cashflow.hasHistory'),
    historyMonths: num(c.historyMonths, 'data.cashflow.historyMonths', { min: 0, max: 1200 }),
    windowStart: month(c.windowStart, 'data.cashflow.windowStart'),
    windowEnd: month(c.windowEnd, 'data.cashflow.windowEnd'),
    monthlyIncome: num(c.monthlyIncome, 'data.cashflow.monthlyIncome'),
    monthlyExpenses: num(c.monthlyExpenses, 'data.cashflow.monthlyExpenses'),
    monthlySaved: num(c.monthlySaved, 'data.cashflow.monthlySaved'),
    monthlyInvested: num(c.monthlyInvested, 'data.cashflow.monthlyInvested'),
    savingsRate: num(c.savingsRate, 'data.cashflow.savingsRate'),
    investingRate: num(c.investingRate, 'data.cashflow.investingRate'),
    expenseByCategory: record(c.expenseByCategory, 'data.cashflow.expenseByCategory', SNAPSHOT_LIMITS.categories, (v, path) => {
      const o = obj(v, path);
      return { monthly: num(o.monthly, `${path}.monthly`), share: num(o.share, `${path}.share`) };
    }),
    series: arr(c.series, 'data.cashflow.series', SNAPSHOT_LIMITS.series).map((v, i): SnapshotMonth => {
      const path = `data.cashflow.series[${i}]`;
      const o = obj(v, path);
      return {
        month: month(o.month, `${path}.month`),
        income: num(o.income, `${path}.income`),
        spending: num(o.spending, `${path}.spending`),
        invested: num(o.invested, `${path}.invested`),
        saved: num(o.saved, `${path}.saved`),
        net: num(o.net, `${path}.net`),
      };
    }),
  };
  for (let i = 1; i < cashflow.series.length; i++) {
    if (cashflow.series[i].month <= cashflow.series[i - 1].month) fail('data.cashflow.series', 'months must be ascending and unique');
  }

  const b = obj(d.budgets, 'data.budgets');
  const budgets = {
    month: month(b.month, 'data.budgets.month'),
    items: arr(b.items, 'data.budgets.items', SNAPSHOT_LIMITS.budgets).map((v, i) => {
      const path = `data.budgets.items[${i}]`;
      const o = obj(v, path);
      return { category: str(o.category, `${path}.category`), budgeted: num(o.budgeted, `${path}.budgeted`), spent: num(o.spent, `${path}.spent`) };
    }),
  };

  const inv = obj(d.investments, 'data.investments');
  const investments = {
    count: num(inv.count, 'data.investments.count', { min: 0 }),
    value: num(inv.value, 'data.investments.value'),
    cost: num(inv.cost, 'data.investments.cost'),
    gainPct: num(inv.gainPct, 'data.investments.gainPct'),
    byType: record(inv.byType, 'data.investments.byType', SNAPSHOT_LIMITS.categories, (v, path) => num(v, path)),
    topHoldingShare: num(inv.topHoldingShare, 'data.investments.topHoldingShare'),
    holdings: arr(inv.holdings, 'data.investments.holdings', SNAPSHOT_LIMITS.holdings).map((v, i): SnapshotHolding => {
      const path = `data.investments.holdings[${i}]`;
      const o = obj(v, path);
      return {
        symbol: str(o.symbol, `${path}.symbol`, 20),
        type: str(o.type, `${path}.type`, 20),
        value: num(o.value, `${path}.value`),
        cost: num(o.cost, `${path}.cost`),
        weight: num(o.weight, `${path}.weight`),
      };
    }),
  };

  const goals = arr(d.goals, 'data.goals', SNAPSHOT_LIMITS.goals).map((v, i): SnapshotGoal => {
    const path = `data.goals[${i}]`;
    const o = obj(v, path);
    const status = str(o.status, `${path}.status`, 20);
    if (!GOAL_STATUS.has(status)) fail(`${path}.status`, 'unknown status');
    return {
      name: str(o.name, `${path}.name`),
      category: str(o.category, `${path}.category`, 30),
      priority: str(o.priority, `${path}.priority`, 10),
      target: num(o.target, `${path}.target`),
      current: num(o.current, `${path}.current`),
      deadline: o.deadline === null || o.deadline === undefined ? null : date(o.deadline, `${path}.deadline`),
      progress: num(o.progress, `${path}.progress`),
      status: status as SnapshotGoal['status'],
      fundedBy: o.fundedBy === null || o.fundedBy === undefined ? null : month(o.fundedBy, `${path}.fundedBy`),
    };
  });

  const mo = obj(d.motivation, 'data.motivation');
  const motivation = {
    enabled: bool(mo.enabled, 'data.motivation.enabled'),
    pointsEarned: num(mo.pointsEarned, 'data.motivation.pointsEarned', { min: 0 }),
    pointsSpent: num(mo.pointsSpent, 'data.motivation.pointsSpent', { min: 0 }),
    balance: num(mo.balance, 'data.motivation.balance'),
    rewardsClaimed: num(mo.rewardsClaimed, 'data.motivation.rewardsClaimed', { min: 0 }),
    habits: arr(mo.habits, 'data.motivation.habits', SNAPSHOT_LIMITS.habits).map((v, i): SnapshotHabit => {
      const path = `data.motivation.habits[${i}]`;
      const o = obj(v, path);
      const h: SnapshotHabit = {
        kind: str(o.kind, `${path}.kind`, 10),
        name: str(o.name, `${path}.name`),
        cadence: str(o.cadence, `${path}.cadence`, 10),
        amount: num(o.amount, `${path}.amount`),
        streak: num(o.streak, `${path}.streak`, { min: 0 }),
        bestStreak: num(o.bestStreak, `${path}.bestStreak`, { min: 0 }),
        periodsMet: num(o.periodsMet, `${path}.periodsMet`, { min: 0 }),
        periodsScored: num(o.periodsScored, `${path}.periodsScored`, { min: 0 }),
        hitRate: num(o.hitRate, `${path}.hitRate`),
        pointsEarned: num(o.pointsEarned, `${path}.pointsEarned`, { min: 0 }),
      };
      if (o.category !== undefined) h.category = str(o.category, `${path}.category`, 30);
      return h;
    }),
    badges: arr(mo.badges, 'data.motivation.badges', SNAPSHOT_LIMITS.badges).map((v, i) => {
      const path = `data.motivation.badges[${i}]`;
      const o = obj(v, path);
      return { key: str(o.key, `${path}.key`, 20), name: str(o.name, `${path}.name`, 40), unlockedOn: o.unlockedOn === null ? null : date(o.unlockedOn, `${path}.unlockedOn`) };
    }),
    badgesUnlocked: num(mo.badgesUnlocked, 'data.motivation.badgesUnlocked', { min: 0 }),
  };

  const ou = obj(d.outlook, 'data.outlook');
  const fire = obj(ou.fire, 'data.outlook.fire');
  const runway = obj(ou.runway, 'data.outlook.runway');
  const mc = ou.montecarlo === null || ou.montecarlo === undefined ? null : obj(ou.montecarlo, 'data.outlook.montecarlo');
  const mcEnd = mc ? obj(mc.endNetWorth, 'data.outlook.montecarlo.endNetWorth') : null;
  const outlook = {
    hasHistory: bool(ou.hasHistory, 'data.outlook.hasHistory'),
    fire: {
      fiNumber: num(fire.fiNumber, 'data.outlook.fire.fiNumber'),
      progress: num(fire.progress, 'data.outlook.fire.progress'),
      fiDate: fire.fiDate === null ? null : month(fire.fiDate, 'data.outlook.fire.fiDate'),
      fiAge: numOrNull(fire.fiAge, 'data.outlook.fire.fiAge'),
      coastFiMonth: numOrNull(fire.coastFiMonth, 'data.outlook.fire.coastFiMonth'),
      fiByRetirement: bool(fire.fiByRetirement, 'data.outlook.fire.fiByRetirement'),
      retirementAge: num(fire.retirementAge, 'data.outlook.fire.retirementAge'),
    },
    runway: {
      cashMonths: numOrNull(runway.cashMonths, 'data.outlook.runway.cashMonths'),
      totalMonths: numOrNull(runway.totalMonths, 'data.outlook.runway.totalMonths'),
      simulatedMonths: numOrNull(runway.simulatedMonths, 'data.outlook.runway.simulatedMonths'),
    },
    netWorthAtRetirement: numOrNull(ou.netWorthAtRetirement, 'data.outlook.netWorthAtRetirement'),
    endNetWorth: num(ou.endNetWorth, 'data.outlook.endNetWorth'),
    endRealNetWorth: num(ou.endRealNetWorth, 'data.outlook.endRealNetWorth'),
    yearly: arr(ou.yearly, 'data.outlook.yearly', SNAPSHOT_LIMITS.yearly).map((v, i) => {
      const path = `data.outlook.yearly[${i}]`;
      const o = obj(v, path);
      return { year: num(o.year, `${path}.year`), age: num(o.age, `${path}.age`), netWorth: num(o.netWorth, `${path}.netWorth`), realNetWorth: num(o.realNetWorth, `${path}.realNetWorth`) };
    }),
    montecarlo: mc && mcEnd ? {
      trials: num(mc.trials, 'data.outlook.montecarlo.trials', { min: 1 }),
      seed: num(mc.seed, 'data.outlook.montecarlo.seed'),
      successProbability: num(mc.successProbability, 'data.outlook.montecarlo.successProbability', { min: 0, max: 1 }),
      fiByRetirementProbability: num(mc.fiByRetirementProbability, 'data.outlook.montecarlo.fiByRetirementProbability', { min: 0, max: 1 }),
      endNetWorth: { p10: num(mcEnd.p10, 'data.outlook.montecarlo.endNetWorth.p10'), p50: num(mcEnd.p50, 'data.outlook.montecarlo.endNetWorth.p50'), p90: num(mcEnd.p90, 'data.outlook.montecarlo.endNetWorth.p90') },
    } : null,
  };

  return { profile, position, cashflow, budgets, investments, goals, motivation, outlook };
}

/**
 * Validate a parsed JSON value as a snapshot. Errors are phrased for the
 * person importing the file ("data.goals[3].target: expected a finite number").
 */
export function validateSnapshot(raw: unknown): Validation {
  try {
    const s = obj(raw, 'file');
    if (s.format !== SNAPSHOT_FORMAT) throw new Invalid('This is not a FinFolio comparison snapshot (unexpected format)');
    if (typeof s.version !== 'number') throw new Invalid('This is not a FinFolio comparison snapshot (no version)');
    if (s.version > SNAPSHOT_VERSION) throw new Invalid(`This snapshot was made by a newer FinFolio (format ${s.version}); this one reads up to ${SNAPSHOT_VERSION}`);
    if (s.version < 1) throw new Invalid('Unsupported snapshot version');
    const exportedAt = str(s.exportedAt, 'exportedAt', 30);
    if (Number.isNaN(new Date(exportedAt).getTime())) fail('exportedAt', 'expected an ISO timestamp');
    const asOf = date(s.asOf, 'asOf');
    const label = str(s.label, 'label', SNAPSHOT_LIMITS.label);
    const currency = str(s.currency, 'currency', 10);
    const app = obj(s.app, 'app');
    const checksum = str(s.checksum, 'checksum', 80);
    const data = validateData(s.data);
    const warnings: string[] = [];
    // The checksum covers the file's `data` as written (canonical key order), so a file whose
    // numbers were edited after export does not verify.
    if (checksum !== checksumOf(s.data as SnapshotData)) throw new Invalid('The file\'s checksum does not match its contents — it was edited or damaged after export');
    return {
      ok: true,
      warnings,
      snapshot: {
        format: SNAPSHOT_FORMAT,
        version: SNAPSHOT_VERSION,
        exportedAt,
        asOf,
        label: label || 'A friend',
        currency: currency || 'USD',
        app: { name: str(app.name, 'app.name', 30), version: str(app.version, 'app.version', 30) },
        checksum,
        data,
      },
    };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, errors: [err.message] };
    throw err;
  }
}
