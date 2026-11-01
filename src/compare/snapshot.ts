/**
 * Build a comparison snapshot from a user's data.
 *
 * Pure: the input is plain data, the engines it calls (baseline, simulator,
 * Monte Carlo, goal feasibility, points engine, badges) are pure, and nothing
 * is written anywhere — not even the FI milestones `/api/motivation` would
 * record. The route layer assembles the input from the database.
 */
import crypto from 'node:crypto';
import {
  isIncomeTxn, isSpendingTxn, isLiabilityAccount, INVESTMENT_CATEGORY, TRANSFER_CATEGORY,
  type Account, type Budget, type Goal, type Investment, type InvestmentTransaction, type Transaction,
} from '../db/database.js';
import {
  DEFAULT_PROFILE, addMonths, ageAt, baselineScenario, deriveBaseline, effectiveBaseline, goalFeasibility, round2, round4,
  runMonteCarlo, simulate, type Profile, type SimulationInput,
} from '../sim/index.js';
import { computeMotivation } from '../motivation/engine.js';
import type { Habit, Milestone, Reward, RewardClaim } from '../motivation/types.js';
import type { FiSnapshot } from '../motivation/milestones.js';
import { FI_MIN_HISTORY_MONTHS } from '../routes/simulate.js';
import {
  DEFAULT_LABEL, SERIES_MONTHS, SNAPSHOT_FORMAT, SNAPSHOT_LIMITS, SNAPSHOT_MONTECARLO, SNAPSHOT_VERSION,
  type Snapshot, type SnapshotData, type SnapshotGoal, type SnapshotHolding, type SnapshotMonth,
} from './types.js';

export interface SnapshotSource {
  accounts: Account[];
  transactions: Transaction[];
  investments: Investment[];
  investmentTransactions: InvestmentTransaction[];
  goals: Goal[];
  budgets: Budget[];
  /** Stored planning profile, or undefined for the defaults. */
  profile?: Profile;
  habits: Habit[];
  rewards: Reward[];
  claims: RewardClaim[];
  milestones: Milestone[];
}

export interface SnapshotOptions {
  /** YYYY-MM-DD — the exporter's "today". */
  today: string;
  /** ISO timestamp stamped as `exportedAt`. */
  now: string;
  label?: string;
  appVersion?: string;
}

/** Trim and cap the label; empty → the default. */
export function normalizeLabel(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return s ? s.slice(0, SNAPSHOT_LIMITS.label) : DEFAULT_LABEL;
}

/** JSON with object keys sorted recursively, so the checksum does not depend on property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function checksumOf(data: SnapshotData): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(data)).digest('hex')}`;
}

/** The currency most accounts use (USD when there are none). */
function dominantCurrency(accounts: Account[]): string {
  const counts = new Map<string, number>();
  for (const a of accounts) counts.set(a.currency || 'USD', (counts.get(a.currency || 'USD') || 0) + 1);
  let best = 'USD';
  let n = -1;
  for (const [c, k] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) if (k > n) { best = c; n = k; }
  return best;
}

function ratio(num: number, den: number): number {
  return den > 0 ? round4(num / den) : 0;
}

export function buildSnapshotData(src: SnapshotSource, today: string): SnapshotData {
  const profile: Profile = src.profile ? { ...src.profile } : { ...DEFAULT_PROFILE };
  const baseline = deriveBaseline(src, { asOf: today });
  const scenario = baselineScenario();
  const input: SimulationInput = { baseline, profile, scenario };
  const result = simulate(input);
  const montecarlo = runMonteCarlo(input, { ...SNAPSHOT_MONTECARLO });
  const feasibility = goalFeasibility(src.goals, result, effectiveBaseline(baseline, scenario).monthlyContribution);
  const hasHistory = baseline.monthlyIncome > 0 || baseline.monthlyExpenses > 0;

  // ── Position ──
  const accountsByType: Record<string, { count: number; balance: number }> = {};
  for (const a of src.accounts) {
    const slot = accountsByType[a.type] ?? (accountsByType[a.type] = { count: 0, balance: 0 });
    slot.count += 1;
    slot.balance = round2(slot.balance + a.balance);
  }
  const position = {
    netWorth: round2(baseline.liquid + baseline.invested - baseline.debt),
    liquid: baseline.liquid,
    invested: baseline.invested,
    debt: baseline.debt,
    holdingsValue: baseline.detail.holdingsValue,
    accountsByType,
  };

  // ── Cash flow ──
  const asOfMonth = today.slice(0, 7);
  const { windowStart, windowEnd } = baseline.detail;
  const inWindow = (t: Transaction) => t.date.slice(0, 7) >= windowStart && t.date.slice(0, 7) <= windowEnd;
  const savingsIds = new Set(src.accounts.filter(a => a.type === 'savings').map(a => a.id));
  const isInvesting = (t: Transaction) => t.type === 'expense' && t.category === INVESTMENT_CATEGORY;
  const isSavingIn = (t: Transaction) => t.type === 'income' && t.category === TRANSFER_CATEGORY && savingsIds.has(t.accountId);
  const investedInWindow = src.transactions.filter(t => inWindow(t) && isInvesting(t)).reduce((s, t) => s + Math.abs(t.amount), 0);
  const monthlyInvested = round2(investedInWindow / Math.max(1, baseline.lookbackMonths));
  const monthlySaved = round2(baseline.monthlyIncome - baseline.monthlyExpenses);
  const totalByCategory = Object.values(baseline.detail.expenseByCategory).reduce((s, v) => s + v, 0);
  const expenseByCategory: Record<string, { monthly: number; share: number }> = {};
  for (const [cat, monthly] of Object.entries(baseline.detail.expenseByCategory).sort(([, a], [, b]) => b - a).slice(0, SNAPSHOT_LIMITS.categories)) {
    expenseByCategory[cat] = { monthly, share: ratio(monthly, totalByCategory) };
  }

  const activeMonths = new Set(src.transactions.map(t => t.date.slice(0, 7)));
  const lastComplete = addMonths(asOfMonth, -1);
  const firstActive = [...activeMonths].sort()[0];
  const series: SnapshotMonth[] = [];
  if (firstActive && firstActive <= lastComplete) {
    const earliest = addMonths(asOfMonth, -SERIES_MONTHS);
    const byMonth = new Map<string, SnapshotMonth>();
    for (let m = firstActive > earliest ? firstActive : earliest; m <= lastComplete; m = addMonths(m, 1)) {
      byMonth.set(m, { month: m, income: 0, spending: 0, invested: 0, saved: 0, net: 0 });
    }
    for (const t of src.transactions) {
      const p = byMonth.get(t.date.slice(0, 7));
      if (!p) continue;
      const amount = Math.abs(t.amount);
      if (isIncomeTxn(t)) p.income += amount;
      else if (isSpendingTxn(t)) p.spending += amount;
      if (isInvesting(t)) p.invested += amount;
      if (isSavingIn(t)) p.saved += amount;
    }
    for (const p of byMonth.values()) {
      p.income = round2(p.income); p.spending = round2(p.spending); p.invested = round2(p.invested); p.saved = round2(p.saved);
      p.net = round2(p.income - p.spending);
      series.push(p);
    }
  }

  const cashflow = {
    lookbackMonths: baseline.lookbackMonths,
    hasHistory,
    historyMonths: activeMonths.size,
    windowStart,
    windowEnd,
    monthlyIncome: baseline.monthlyIncome,
    monthlyExpenses: baseline.monthlyExpenses,
    monthlySaved,
    monthlyInvested,
    savingsRate: ratio(monthlySaved, baseline.monthlyIncome),
    investingRate: ratio(monthlyInvested, baseline.monthlyIncome),
    expenseByCategory,
    series,
  };

  // ── Budgets (this month) ──
  const d = new Date(`${today}T00:00:00Z`);
  const budgets = {
    month: asOfMonth,
    items: src.budgets
      .filter(b => b.month === d.getUTCMonth() && b.year === d.getUTCFullYear())
      .slice(0, SNAPSHOT_LIMITS.budgets)
      .map(b => ({ category: b.category, budgeted: round2(b.amount), spent: round2(b.spent) })),
  };

  // ── Investments ──
  const holdingsRaw = src.investments.map(i => ({ symbol: i.symbol, type: i.type, value: i.shares * i.currentPrice, cost: i.shares * i.avgCost }));
  const value = holdingsRaw.reduce((s, h) => s + h.value, 0);
  const cost = holdingsRaw.reduce((s, h) => s + h.cost, 0);
  const holdings: SnapshotHolding[] = holdingsRaw
    .sort((a, b) => b.value - a.value)
    .slice(0, SNAPSHOT_LIMITS.holdings)
    .map(h => ({ symbol: h.symbol, type: h.type, value: round2(h.value), cost: round2(h.cost), weight: ratio(h.value, value) }));
  const byType: Record<string, number> = {};
  for (const h of holdingsRaw) byType[h.type] = (byType[h.type] || 0) + h.value;
  for (const k of Object.keys(byType)) byType[k] = ratio(byType[k], value);
  const investments = {
    count: src.investments.length,
    value: round2(value),
    cost: round2(cost),
    gainPct: cost > 0 ? round4((value - cost) / cost) : 0,
    byType,
    topHoldingShare: holdings.length ? holdings[0].weight : 0,
    holdings,
  };

  // ── Goals ──
  const feasibilityById = new Map(feasibility.map(f => [f.id, f]));
  const goals: SnapshotGoal[] = src.goals.slice(0, SNAPSHOT_LIMITS.goals).map(g => {
    const f = feasibilityById.get(g.id);
    return {
      name: g.name,
      category: g.category,
      priority: g.priority,
      target: round2(g.targetAmount),
      current: round2(g.currentAmount),
      deadline: g.deadline || null,
      progress: ratio(g.currentAmount, g.targetAmount),
      status: f?.status ?? 'unreachable',
      fundedBy: f?.fundedBy ?? null,
    };
  });

  // ── Motivation (pure: no milestone is recorded here) ──
  const fi: FiSnapshot | null =
    baseline.monthlyIncome > 0 && baseline.monthlyExpenses > 0 && baseline.detail.incomeMonths >= FI_MIN_HISTORY_MONTHS
      ? { progress: result.summary.fire.progress, fiDate: result.summary.fire.fiDate, fiNumber: result.summary.fire.fiNumber }
      : null;
  const m = computeMotivation({ habits: src.habits, transactions: src.transactions, accounts: src.accounts, rewards: src.rewards, claims: src.claims, milestones: src.milestones, today, fi });
  const motivation = {
    enabled: m.enabled,
    pointsEarned: m.points.earned,
    pointsSpent: m.points.spent,
    balance: m.points.balance,
    rewardsClaimed: m.claims.length,
    habits: m.habits.slice(0, SNAPSHOT_LIMITS.habits).map(h => ({
      kind: h.kind,
      name: h.name,
      cadence: h.cadence,
      amount: h.amount,
      ...(h.category ? { category: h.category } : {}),
      streak: h.streak,
      bestStreak: h.bestStreak,
      periodsMet: h.periodsMet,
      periodsScored: h.periodsScored,
      hitRate: ratio(h.periodsMet, h.periodsScored),
      pointsEarned: h.pointsEarned,
    })),
    badges: m.badges.map(b => ({ key: b.id, name: b.name, unlockedOn: b.unlockedOn })),
    badgesUnlocked: m.badges.filter(b => b.unlockedOn).length,
  };

  // ── Outlook ──
  const { fire, runway } = result.summary;
  const outlook = {
    hasHistory,
    fire: {
      fiNumber: fire.fiNumber,
      progress: fire.progress,
      fiDate: fire.fiDate,
      fiAge: fire.fiAge,
      coastFiMonth: fire.coastFiMonth,
      fiByRetirement: fire.fiByRetirement,
      retirementAge: fire.retirementAge,
    },
    runway: { cashMonths: runway.cashMonths, totalMonths: runway.totalMonths, simulatedMonths: runway.simulatedMonths },
    netWorthAtRetirement: result.summary.netWorthAtRetirement,
    endNetWorth: result.summary.endNetWorth,
    endRealNetWorth: result.summary.endRealNetWorth,
    yearly: result.yearly.slice(0, SNAPSHOT_LIMITS.yearly).map(y => ({ year: y.year, age: y.age, netWorth: y.netWorth, realNetWorth: y.realNetWorth })),
    montecarlo: {
      trials: montecarlo.trials,
      seed: montecarlo.seed,
      successProbability: montecarlo.successProbability,
      fiByRetirementProbability: montecarlo.fiByRetirementProbability,
      endNetWorth: { p10: montecarlo.endNetWorth.p10, p50: montecarlo.endNetWorth.p50, p90: montecarlo.endNetWorth.p90 },
    },
  };

  return {
    profile: {
      age: Math.floor(ageAt(profile.birthDate, today)),
      retirementAge: profile.retirementAge,
      safeWithdrawalRate: profile.safeWithdrawalRate,
      planToAge: profile.planToAge,
    },
    position,
    cashflow,
    budgets,
    investments,
    goals,
    motivation,
    outlook,
  };
}

/** The whole file: envelope + data + checksum. */
export function buildSnapshot(src: SnapshotSource, opts: SnapshotOptions): Snapshot {
  const data = buildSnapshotData(src, opts.today);
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: opts.now,
    asOf: opts.today,
    label: normalizeLabel(opts.label),
    currency: dominantCurrency(src.accounts),
    app: { name: 'finfolio', version: opts.appVersion ?? '0.0.0' },
    checksum: checksumOf(data),
    data,
  };
}

/** Safe file name for a snapshot: `penny.finfolio-compare.json`. */
export function snapshotFileName(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'snapshot';
  return `${base}.finfolio-compare.json`;
}
