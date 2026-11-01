/**
 * The comparison engine: two snapshots in, one side-by-side report out.
 *
 * Pure and symmetric — `compare(a, b)` is the mirror image of `compare(b, a)`
 * (sides swapped, deltas negated, leaders flipped). "Mine" is always the
 * snapshot built live for the signed-in user, "theirs" the imported file; the
 * engine does not care which is which.
 *
 * Tone: the report exists to motivate. Income and spending levels are shown
 * but never "won" (they are circumstances); habits, rates, buffers, streaks
 * and progress are (they are choices).
 */
import { monthsBetween, round2, round4 } from '../sim/math.js';
import { periodLabel } from '../motivation/periods.js';
import type { Snapshot, SnapshotGoal, SnapshotHabit, SnapshotMonth } from './types.js';

export type Side = 'mine' | 'theirs';
export type MetricGroup = 'position' | 'cashflow' | 'investments' | 'goals' | 'motivation' | 'outlook';
export type MetricUnit = 'money' | 'percent' | 'months' | 'count' | 'points' | 'age' | 'month' | 'years' | 'bool';
export type BetterIs = 'higher' | 'lower' | 'neutral';

export interface MetricRow {
  key: string;
  group: MetricGroup;
  label: string;
  unit: MetricUnit;
  /** Numbers, a YYYY-MM for `month`, or null when a side has no value. */
  mine: number | string | null;
  theirs: number | string | null;
  /** mine − theirs (months for `month`), null when either side is missing or the values are not comparable. */
  delta: number | null;
  betterIs: BetterIs;
  /** Who is ahead; null for neutral metrics, missing values or money across currencies. */
  leader: Side | 'tie' | null;
  /** Short explanation shown under the row when the comparison is limited. */
  note?: string;
}

export interface CategoryRow {
  category: string;
  mine: { monthly: number; share: number } | null;
  theirs: { monthly: number; share: number } | null;
  /** mine.share − theirs.share (0 when a side has none). */
  shareDelta: number;
}

export interface SeriesPoint {
  month: string;
  mine: SnapshotMonth | null;
  theirs: SnapshotMonth | null;
}

export interface AgePoint {
  age: number;
  /** Projected nominal net worth at that age (null when outside a side's projection). */
  mine: number | null;
  theirs: number | null;
  /** The same in today's money. */
  mineReal: number | null;
  theirsReal: number | null;
}

export interface GoalSummary {
  count: number;
  onTrack: number;
  funded: number;
  /** Σ current ÷ Σ target, 0..1 */
  weightedProgress: number;
}

export interface BadgeRow {
  key: string;
  name: string;
  mine: string | null;
  theirs: string | null;
}

export interface Insight {
  /** Which side the sentence is good news for. */
  tone: 'lead' | 'behind' | 'neutral';
  text: string;
}

export interface ComparisonReport {
  generatedAt: string;
  labels: { mine: string; theirs: string };
  asOf: { mine: string; theirs: string; daysApart: number };
  currency: { mine: string; theirs: string; same: boolean };
  profile: { mine: Snapshot['data']['profile']; theirs: Snapshot['data']['profile'] };
  warnings: string[];
  /** How many scored metrics each side leads. */
  score: { mine: number; theirs: number; ties: number; scored: number };
  metrics: MetricRow[];
  spending: CategoryRow[];
  /** Aligned by calendar month, oldest first; the union of both series (at most 24 months). */
  series: SeriesPoint[];
  /** Projected net worth aligned by age (whole years), so a 33-year-old and a 40-year-old are compared at the same age. */
  projection: AgePoint[];
  goals: { mine: SnapshotGoal[]; theirs: SnapshotGoal[]; summary: { mine: GoalSummary; theirs: GoalSummary } };
  habits: { mine: SnapshotHabit[]; theirs: SnapshotHabit[] };
  badges: BadgeRow[];
  insights: Insight[];
}

export interface CompareOptions {
  /** ISO timestamp stamped on the report. */
  now: string;
  /** Days between the two snapshots' `asOf` beyond which the report warns. */
  staleAfterDays?: number;
}

const STALE_AFTER_DAYS = 90;
const SERIES_MAX = 24;

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

function leaderOf(mine: number | null, theirs: number | null, betterIs: BetterIs): MetricRow['leader'] {
  if (betterIs === 'neutral' || mine === null || theirs === null) return null;
  const eps = 1e-9;
  if (Math.abs(mine - theirs) <= eps) return 'tie';
  const mineAhead = betterIs === 'higher' ? mine > theirs : mine < theirs;
  return mineAhead ? 'mine' : 'theirs';
}

export function goalSummary(goals: SnapshotGoal[]): GoalSummary {
  const target = goals.reduce((s, g) => s + g.target, 0);
  const current = goals.reduce((s, g) => s + Math.min(g.current, g.target), 0);
  return {
    count: goals.length,
    onTrack: goals.filter(g => g.status === 'on_track' || g.status === 'funded').length,
    funded: goals.filter(g => g.status === 'funded').length,
    weightedProgress: target > 0 ? round4(current / target) : 0,
  };
}

/** Longest streak across habits (0 without habits). */
function bestStreak(habits: SnapshotHabit[]): number {
  return habits.reduce((m, h) => Math.max(m, h.bestStreak), 0);
}

function yearsToFi(s: Snapshot): number | null {
  const fi = s.data.outlook.fire.fiDate;
  if (!fi) return null;
  return round2(Math.max(0, monthsBetween(`${s.asOf.slice(0, 7)}-01`, `${fi}-01`)) / 12);
}

/** Projected net worth at whole ages: the yearly point whose age floors to that year. */
function netWorthByAge(s: Snapshot): Map<number, { nominal: number; real: number }> {
  const out = new Map<number, { nominal: number; real: number }>();
  for (const y of s.data.outlook.yearly) {
    const age = Math.floor(y.age + 1e-9);
    if (!out.has(age)) out.set(age, { nominal: y.netWorth, real: y.realNetWorth });
  }
  return out;
}

export function compareSnapshots(mine: Snapshot, theirs: Snapshot, opts: CompareOptions): ComparisonReport {
  const sameCurrency = mine.currency === theirs.currency;
  const warnings: string[] = [];
  const daysApart = Math.abs(daysBetween(mine.asOf, theirs.asOf));
  if (!sameCurrency) warnings.push(`${theirs.label}'s figures are in ${theirs.currency}, yours in ${mine.currency} — amounts are shown as they are (not converted); rates, shares and months still compare.`);
  if (daysApart > (opts.staleAfterDays ?? STALE_AFTER_DAYS)) warnings.push(`${theirs.label}'s snapshot is from ${theirs.asOf}, ${daysApart} days away from yours (${mine.asOf}).`);
  if (!theirs.data.cashflow.hasHistory) warnings.push(`${theirs.label} has no income or spending history yet — cash-flow and outlook comparisons are empty.`);
  if (!mine.data.cashflow.hasHistory) warnings.push('You have no income or spending history yet — add or import transactions to compare cash flow and outlook.');

  const M = mine.data;
  const T = theirs.data;
  const metrics: MetricRow[] = [];
  const moneyNote = sameCurrency ? undefined : 'different currencies — not scored';
  const row = (key: string, group: MetricGroup, label: string, unit: MetricUnit, m: number | string | null, t: number | string | null, betterIs: BetterIs, note?: string) => {
    let delta: number | null = null;
    let leader: MetricRow['leader'] = null;
    if (unit === 'month') {
      if (typeof m === 'string' && typeof t === 'string') {
        delta = monthsBetween(`${t}-01`, `${m}-01`);
        leader = leaderOf(delta, 0, betterIs);
      }
    } else if (typeof m === 'number' && typeof t === 'number') {
      delta = round4(m - t);
      leader = leaderOf(m, t, betterIs);
    }
    if (unit === 'money' && !sameCurrency) { delta = null; leader = null; note = note ?? moneyNote; }
    const r: MetricRow = { key, group, label, unit, mine: m, theirs: t, delta, betterIs, leader };
    if (note) r.note = note;
    metrics.push(r);
  };

  // ── Position ──
  row('netWorth', 'position', 'Net worth', 'money', M.position.netWorth, T.position.netWorth, 'higher');
  row('liquid', 'position', 'Cash & savings', 'money', M.position.liquid, T.position.liquid, 'higher');
  row('invested', 'position', 'Invested', 'money', M.position.invested, T.position.invested, 'higher');
  row('debt', 'position', 'Debt', 'money', M.position.debt, T.position.debt, 'lower');
  const debtRatio = (d: Snapshot['data']) => { const assets = d.position.liquid + d.position.invested; return assets > 0 ? round4(d.position.debt / assets) : (d.position.debt > 0 ? 1 : 0); };
  row('debtToAssets', 'position', 'Debt as a share of assets', 'percent', debtRatio(M), debtRatio(T), 'lower');

  // ── Cash flow ──
  row('monthlyIncome', 'cashflow', 'Monthly income', 'money', M.cashflow.monthlyIncome, T.cashflow.monthlyIncome, 'neutral', 'circumstance, not scored');
  row('monthlyExpenses', 'cashflow', 'Monthly spending', 'money', M.cashflow.monthlyExpenses, T.cashflow.monthlyExpenses, 'neutral', 'circumstance, not scored');
  row('monthlySaved', 'cashflow', 'Saved per month', 'money', M.cashflow.monthlySaved, T.cashflow.monthlySaved, 'higher');
  row('savingsRate', 'cashflow', 'Savings rate', 'percent', M.cashflow.savingsRate, T.cashflow.savingsRate, 'higher');
  row('monthlyInvested', 'cashflow', 'Invested per month', 'money', M.cashflow.monthlyInvested, T.cashflow.monthlyInvested, 'higher');
  row('investingRate', 'cashflow', 'Investing rate', 'percent', M.cashflow.investingRate, T.cashflow.investingRate, 'higher');
  row('cashMonths', 'cashflow', 'Emergency fund (months of spending in cash)', 'months', M.outlook.runway.cashMonths, T.outlook.runway.cashMonths, 'higher');

  // ── Investments ──
  row('holdingsValue', 'investments', 'Portfolio value', 'money', M.investments.value, T.investments.value, 'neutral', 'level, not scored');
  row('holdingsCount', 'investments', 'Holdings', 'count', M.investments.count, T.investments.count, 'neutral');
  row('gainPct', 'investments', 'Unrealised gain', 'percent', M.investments.gainPct, T.investments.gainPct, 'higher');
  row('topHoldingShare', 'investments', 'Largest holding (share of portfolio)', 'percent', M.investments.topHoldingShare, T.investments.topHoldingShare, 'lower');

  // ── Goals ──
  const gm = goalSummary(M.goals);
  const gt = goalSummary(T.goals);
  row('goalsCount', 'goals', 'Goals', 'count', gm.count, gt.count, 'neutral');
  row('goalsOnTrack', 'goals', 'Goals on track or funded', 'count', gm.onTrack, gt.onTrack, 'higher');
  row('goalsProgress', 'goals', 'Progress towards all goals', 'percent', gm.weightedProgress, gt.weightedProgress, 'higher');

  // ── Motivation ──
  row('habits', 'motivation', 'Habits', 'count', M.motivation.habits.length, T.motivation.habits.length, 'neutral');
  row('pointsEarned', 'motivation', 'Points earned all-time', 'points', M.motivation.pointsEarned, T.motivation.pointsEarned, 'higher');
  row('bestStreak', 'motivation', 'Best streak', 'count', bestStreak(M.motivation.habits), bestStreak(T.motivation.habits), 'higher');
  row('badgesUnlocked', 'motivation', 'Badges unlocked', 'count', M.motivation.badgesUnlocked, T.motivation.badgesUnlocked, 'higher');
  row('rewardsClaimed', 'motivation', 'Rewards enjoyed', 'count', M.motivation.rewardsClaimed, T.motivation.rewardsClaimed, 'neutral');

  // ── Outlook ──
  row('fiNumber', 'outlook', 'FI number', 'money', M.outlook.fire.fiNumber, T.outlook.fire.fiNumber, 'neutral', 'depends on spending, not scored');
  row('fiProgress', 'outlook', 'Progress to FI', 'percent', M.outlook.fire.progress, T.outlook.fire.progress, 'higher');
  row('fiDate', 'outlook', 'FI date', 'month', M.outlook.fire.fiDate, T.outlook.fire.fiDate, 'lower', (!M.outlook.fire.fiDate || !T.outlook.fire.fiDate) ? 'not in sight for at least one side' : undefined);
  row('fiAge', 'outlook', 'Age at FI', 'age', M.outlook.fire.fiAge, T.outlook.fire.fiAge, 'lower');
  row('yearsToFi', 'outlook', 'Years to FI', 'years', yearsToFi(mine), yearsToFi(theirs), 'lower');
  row('fiByRetirement', 'outlook', 'FI before planned retirement', 'bool', M.outlook.fire.fiByRetirement ? 1 : 0, T.outlook.fire.fiByRetirement ? 1 : 0, 'higher');
  row('totalRunway', 'outlook', 'Runway (months all assets would last)', 'months', M.outlook.runway.totalMonths, T.outlook.runway.totalMonths, 'higher');
  row('netWorthAtRetirement', 'outlook', 'Projected net worth at retirement', 'money', M.outlook.netWorthAtRetirement, T.outlook.netWorthAtRetirement, 'higher');
  row('successProbability', 'outlook', 'Chance of never running out (Monte Carlo)', 'percent', M.outlook.montecarlo?.successProbability ?? null, T.outlook.montecarlo?.successProbability ?? null, 'higher');

  const scored = metrics.filter(r => r.leader !== null);
  const score = {
    mine: scored.filter(r => r.leader === 'mine').length,
    theirs: scored.filter(r => r.leader === 'theirs').length,
    ties: scored.filter(r => r.leader === 'tie').length,
    scored: scored.length,
  };

  // ── Spending mix ──
  const categories = new Set([...Object.keys(M.cashflow.expenseByCategory), ...Object.keys(T.cashflow.expenseByCategory)]);
  const spending: CategoryRow[] = [...categories].map(category => {
    const m = M.cashflow.expenseByCategory[category] ?? null;
    const t = T.cashflow.expenseByCategory[category] ?? null;
    return { category, mine: m, theirs: t, shareDelta: round4((m?.share ?? 0) - (t?.share ?? 0)) };
  }).sort((a, b) => Math.max(b.mine?.share ?? 0, b.theirs?.share ?? 0) - Math.max(a.mine?.share ?? 0, a.theirs?.share ?? 0));

  // ── Cash-flow series aligned by month ──
  const months = [...new Set([...M.cashflow.series.map(p => p.month), ...T.cashflow.series.map(p => p.month)])].sort().slice(-SERIES_MAX);
  const mineByMonth = new Map(M.cashflow.series.map(p => [p.month, p]));
  const theirsByMonth = new Map(T.cashflow.series.map(p => [p.month, p]));
  const series: SeriesPoint[] = months.map(month => ({ month, mine: mineByMonth.get(month) ?? null, theirs: theirsByMonth.get(month) ?? null }));

  // ── Projection aligned by age ──
  const mineAges = netWorthByAge(mine);
  const theirsAges = netWorthByAge(theirs);
  const ages = [...new Set([...mineAges.keys(), ...theirsAges.keys()])].sort((a, b) => a - b);
  const projection: AgePoint[] = ages.map(age => ({
    age,
    mine: mineAges.get(age)?.nominal ?? null,
    theirs: theirsAges.get(age)?.nominal ?? null,
    mineReal: mineAges.get(age)?.real ?? null,
    theirsReal: theirsAges.get(age)?.real ?? null,
  }));

  // ── Badges side by side ──
  const badgeNames = new Map<string, string>();
  for (const b of [...M.motivation.badges, ...T.motivation.badges]) if (!badgeNames.has(b.key)) badgeNames.set(b.key, b.name);
  const mineBadges = new Map(M.motivation.badges.map(b => [b.key, b.unlockedOn]));
  const theirsBadges = new Map(T.motivation.badges.map(b => [b.key, b.unlockedOn]));
  const badges: BadgeRow[] = [...badgeNames.entries()].map(([key, name]) => ({ key, name, mine: mineBadges.get(key) ?? null, theirs: theirsBadges.get(key) ?? null }));

  const report: ComparisonReport = {
    generatedAt: opts.now,
    labels: { mine: mine.label, theirs: theirs.label },
    asOf: { mine: mine.asOf, theirs: theirs.asOf, daysApart },
    currency: { mine: mine.currency, theirs: theirs.currency, same: sameCurrency },
    profile: { mine: M.profile, theirs: T.profile },
    warnings,
    score,
    metrics,
    spending,
    series,
    projection,
    goals: { mine: M.goals, theirs: T.goals, summary: { mine: gm, theirs: gt } },
    habits: { mine: M.motivation.habits, theirs: T.motivation.habits },
    badges,
    insights: [],
  };
  report.insights = buildInsights(report, mine, theirs);
  return report;
}

// ── Insights ────────────────────────────────────────────────────────────────

const pct = (f: number) => `${Math.round(f * 100)}%`;
const pts = (f: number) => `${Math.round(f * 100)} percentage points`;

/**
 * A handful of plain sentences, written for the person reading ("you" vs the
 * label). Each is good news for one side or neutral; the UI colours them.
 */
export function buildInsights(r: ComparisonReport, mine: Snapshot, theirs: Snapshot): Insight[] {
  const out: Insight[] = [];
  const them = r.labels.theirs;
  const M = mine.data;
  const T = theirs.data;
  const metric = (key: string) => r.metrics.find(m => m.key === key)!;

  if (M.cashflow.hasHistory && T.cashflow.hasHistory) {
    const sr = metric('savingsRate');
    const d = (sr.mine as number) - (sr.theirs as number);
    if (Math.abs(d) >= 0.02) {
      out.push(d > 0
        ? { tone: 'lead', text: `You save ${pct(sr.mine as number)} of your income; ${them} saves ${pct(sr.theirs as number)} — you are ${pts(d)} ahead.` }
        : { tone: 'behind', text: `${them} saves ${pct(sr.theirs as number)} of income against your ${pct(sr.mine as number)} — ${pts(-d)} more. Closing that gap is the single biggest lever on your FI date.` });
    } else {
      out.push({ tone: 'neutral', text: `You and ${them} save a similar share of income (${pct(sr.mine as number)} vs ${pct(sr.theirs as number)}).` });
    }

    const ir = metric('investingRate');
    const di = (ir.mine as number) - (ir.theirs as number);
    if (Math.abs(di) >= 0.02) {
      out.push(di > 0
        ? { tone: 'lead', text: `You put ${pct(ir.mine as number)} of your income into investments every month; ${them} puts in ${pct(ir.theirs as number)}.` }
        : { tone: 'behind', text: `${them} invests ${pct(ir.theirs as number)} of income every month, you ${pct(ir.mine as number)}. Investing is what turns saving into an FI date.` });
    }

    // Biggest difference in the spending mix
    const top = [...r.spending].filter(c => c.mine && c.theirs).sort((a, b) => Math.abs(b.shareDelta) - Math.abs(a.shareDelta))[0];
    if (top && Math.abs(top.shareDelta) >= 0.05) {
      out.push(top.shareDelta > 0
        ? { tone: 'neutral', text: `${top.category} takes ${pct(top.mine!.share)} of your spending against ${pct(top.theirs!.share)} of ${them}'s — the biggest difference in how you two spend.` }
        : { tone: 'neutral', text: `${top.category} takes ${pct(top.theirs!.share)} of ${them}'s spending against ${pct(top.mine!.share)} of yours — the biggest difference in how you two spend.` });
    }

    const ef = metric('cashMonths');
    if (typeof ef.mine === 'number' && typeof ef.theirs === 'number' && Math.abs(ef.mine - ef.theirs) >= 1) {
      out.push(ef.mine > ef.theirs
        ? { tone: 'lead', text: `Your cash would cover ${ef.mine.toFixed(1)} months of spending; ${them}'s covers ${ef.theirs.toFixed(1)}.` }
        : { tone: 'behind', text: `${them} keeps ${ef.theirs.toFixed(1)} months of spending in cash; you keep ${ef.mine.toFixed(1)}. A bigger buffer is what lets a streak survive a bad month.` });
    }
  }

  const debt = metric('debtToAssets');
  if (typeof debt.mine === 'number' && typeof debt.theirs === 'number') {
    if (debt.mine === 0 && debt.theirs > 0) out.push({ tone: 'lead', text: `You carry no debt; ${them}'s debt is ${pct(debt.theirs)} of their assets.` });
    else if (debt.theirs === 0 && debt.mine > 0) out.push({ tone: 'behind', text: `${them} carries no debt; yours is ${pct(debt.mine)} of your assets.` });
    else if (Math.abs(debt.mine - debt.theirs) >= 0.05) out.push(debt.mine < debt.theirs
      ? { tone: 'lead', text: `Your debt is ${pct(debt.mine)} of your assets; ${them}'s is ${pct(debt.theirs)}.` }
      : { tone: 'behind', text: `Your debt is ${pct(debt.mine)} of your assets; ${them}'s is ${pct(debt.theirs)}.` });
  }

  // FI
  const mf = M.outlook.fire;
  const tf = T.outlook.fire;
  if (mf.fiDate && tf.fiDate) {
    const months = monthsBetween(`${tf.fiDate}-01`, `${mf.fiDate}-01`); // mine − theirs
    if (Math.abs(months) >= 6) {
      const years = (Math.abs(months) / 12).toFixed(1);
      out.push(months < 0
        ? { tone: 'lead', text: `On current habits you reach financial independence in ${periodLabel('monthly', mf.fiDate)} at ${Math.floor(mf.fiAge ?? 0)}, ${years} years before ${them} (${periodLabel('monthly', tf.fiDate)} at ${Math.floor(tf.fiAge ?? 0)}).` }
        : { tone: 'behind', text: `${them} reaches financial independence in ${periodLabel('monthly', tf.fiDate)} at ${Math.floor(tf.fiAge ?? 0)}; you in ${periodLabel('monthly', mf.fiDate)} at ${Math.floor(mf.fiAge ?? 0)} — ${years} years later.` });
    } else {
      out.push({ tone: 'neutral', text: `You and ${them} reach financial independence within months of each other (${periodLabel('monthly', mf.fiDate)} vs ${periodLabel('monthly', tf.fiDate)}).` });
    }
  } else if (mf.fiDate && !tf.fiDate) {
    out.push({ tone: 'lead', text: `Your FI date is in sight (${periodLabel('monthly', mf.fiDate)}); on current habits ${them}'s is not.` });
  } else if (!mf.fiDate && tf.fiDate) {
    out.push({ tone: 'behind', text: `${them}'s FI date is in sight (${periodLabel('monthly', tf.fiDate)}); on current habits yours is not yet. You are ${pct(mf.progress)} of the way to your FI number.` });
  } else if (M.cashflow.hasHistory && T.cashflow.hasHistory) {
    out.push({ tone: 'neutral', text: `Neither of you reaches the FI number on current habits; you are ${pct(mf.progress)} of the way, ${them} ${pct(tf.progress)}.` });
  }

  // Age-aligned projection: where each of you is projected to be at the other's age
  const olderIsMine = M.profile.age > T.profile.age;
  if (M.profile.age !== T.profile.age && r.currency.same) {
    const younger = olderIsMine ? theirs : mine;
    const olderAge = Math.max(M.profile.age, T.profile.age);
    const at = r.projection.find(p => p.age === olderAge);
    const youngerProjected = at ? (olderIsMine ? at.theirsReal : at.mineReal) : null;
    const olderNow = olderIsMine ? M.position.netWorth : T.position.netWorth;
    if (youngerProjected !== null) {
      const youngerIsMe = younger === mine;
      out.push({ tone: 'neutral', text: `At ${olderAge}, ${olderIsMine ? 'your' : `${them}'s`} net worth is ${fmtMoney(olderNow, r.currency.mine)}; on current habits ${youngerIsMe ? 'yours' : `${them}'s`} is projected to be ${fmtMoney(youngerProjected, r.currency.mine)} at that age, in today's money.` });
    }
  }

  // Streaks and badges
  const ms = metric('bestStreak');
  if (typeof ms.mine === 'number' && typeof ms.theirs === 'number' && ms.mine !== ms.theirs && Math.max(ms.mine, ms.theirs) >= 4) {
    const best = (habits: SnapshotHabit[]) => habits.slice().sort((a, b) => b.bestStreak - a.bestStreak)[0];
    out.push(ms.mine > ms.theirs
      ? { tone: 'lead', text: `Your longest streak is ${ms.mine} in a row (${best(M.motivation.habits).name}); ${them}'s is ${ms.theirs}.` }
      : { tone: 'behind', text: `${them}'s longest streak is ${ms.theirs} in a row (${best(T.motivation.habits).name}); yours is ${ms.mine}. Four in a row doubles the points.` });
  }
  const onlyTheirs = r.badges.filter(b => b.theirs && !b.mine).map(b => b.name);
  const onlyMine = r.badges.filter(b => b.mine && !b.theirs).map(b => b.name);
  if (onlyMine.length) out.push({ tone: 'lead', text: `Badges only you have: ${onlyMine.join(', ')}.` });
  if (onlyTheirs.length) out.push({ tone: 'behind', text: `Badges ${them} has that you do not yet: ${onlyTheirs.join(', ')}.` });

  return out;
}

function fmtMoney(n: number, currency: string): string {
  const abs = Math.abs(n);
  const compact = abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(2)}M` : abs >= 1_000 ? `${Math.round(abs / 1_000)}k` : abs.toFixed(0);
  return `${n < 0 ? '−' : ''}${compact} ${currency}`;
}
