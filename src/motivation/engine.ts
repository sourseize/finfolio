/**
 * The points engine. Pure and deterministic: given the user's habits,
 * transactions and accounts plus "today", it produces the whole motivation
 * picture — per-habit status, streaks, the ledger (trail) and the balance.
 *
 * Nothing here is persisted; the API recomputes on every call, which is cheap
 * (a few hundred periods at most) and means the trail can never drift from
 * the transactions it is derived from.
 */
import type { Account, Transaction } from '../db/database.js';
import { INVESTMENT_CATEGORY, TRANSFER_CATEGORY, isSpendingTxn } from '../db/database.js';
import { daysBetween, listPeriods, monthKey, periodKey, periodLabel, periodRange } from './periods.js';
import {
  HABIT_POINTS, MAX_HABITS, MAX_REWARDS, NUDGE_AFTER_DAYS, REWARD_STEP, STREAK_BONUS_AT, STREAK_MULTIPLIER,
  type Habit, type HabitStatus, type LedgerEntry, type Milestone, type MotivationSummary, type PeriodResult, type Reward, type RewardClaim, type RewardStatus,
} from './types.js';
import { deriveBadges } from './badges.js';
import { isFiDateImprovement, type FiSnapshot } from './milestones.js';

export interface MotivationInput {
  habits: Habit[];
  transactions: Transaction[];
  accounts: Account[];
  /** YYYY-MM-DD */
  today: string;
  /** The user's reward list (default: none). */
  rewards?: Reward[];
  /** Rewards cashed in so far; each one is a −cost line in the trail. */
  claims?: RewardClaim[];
  /** Observed FI milestones (see milestones.ts). */
  milestones?: Milestone[];
  /** Today's FI snapshot, echoed back for the UI. */
  fi?: FiSnapshot | null;
  /** Extra ledger lines merged into the trail (tests / future use). */
  extraEntries?: Omit<LedgerEntry, 'balance'>[];
}

const EPSILON = 0.005;
const RECENT_PERIODS = 8;

/** Does this transaction count towards the habit? */
export function matchesHabit(habit: Habit, t: Transaction, accountsById: Map<string, Account>): boolean {
  switch (habit.kind) {
    case 'save': {
      if (t.type !== 'income' || t.category !== TRANSFER_CATEGORY) return false;
      if (habit.accountId) return t.accountId === habit.accountId;
      return accountsById.get(t.accountId)?.type === 'savings';
    }
    case 'invest':
      return t.type === 'expense' && t.category === INVESTMENT_CATEGORY;
    case 'swap':
      return isSpendingTxn(t) && t.category === habit.category;
  }
}

export function pointsFor(habit: Pick<Habit, 'kind' | 'cadence'>): number {
  return HABIT_POINTS[habit.cadence][habit.kind];
}

/**
 * Score every period of a habit from its start date to today, oldest first.
 *
 *  - save / invest: met the moment the period's total reaches the target
 *    (so the current period can already score).
 *  - swap: met only once the period is over and spending stayed under the cap.
 *  - a miss is only recorded for completed periods.
 *  - streak: consecutive met periods; from the 4th on, points double.
 */
export function scoreHabit(habit: Habit, transactions: Transaction[], accountsById: Map<string, Account>, today: string): PeriodResult[] {
  if (habit.startDate > today) return [];
  const base = pointsFor(habit);
  const byPeriod = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (!matchesHabit(habit, t, accountsById)) continue;
    const k = periodKey(habit.cadence, t.date);
    if (!byPeriod.has(k)) byPeriod.set(k, []);
    byPeriod.get(k)!.push(t);
  }
  for (const list of byPeriod.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const results: PeriodResult[] = [];
  let streak = 0;
  for (const key of listPeriods(habit.cadence, habit.startDate, today)) {
    const { start, end } = periodRange(habit.cadence, key);
    const completed = end < today;
    const txns = byPeriod.get(key) ?? [];
    let progress = 0;
    let scoredOn: string | null = null;
    let met = false;
    if (habit.kind === 'swap') {
      progress = txns.reduce((s, t) => s + Math.abs(t.amount), 0);
      met = completed && progress <= habit.amount + EPSILON;
      if (met) scoredOn = end;
    } else {
      for (const t of txns) {
        progress += Math.abs(t.amount);
        if (!scoredOn && progress + EPSILON >= habit.amount) scoredOn = t.date;
      }
      met = scoredOn !== null;
    }
    let points = 0;
    if (met) {
      streak += 1;
      points = base * (streak >= STREAK_BONUS_AT ? STREAK_MULTIPLIER : 1);
    } else if (completed) {
      streak = 0;
    }
    results.push({
      key, start, end,
      progress: Math.round(progress * 100) / 100,
      target: habit.amount,
      met, completed, points,
      streak: met ? streak : 0,
      scoredOn,
    });
  }
  return results;
}

function emptyPeriod(habit: Habit, today: string): PeriodResult {
  const key = periodKey(habit.cadence, today);
  const { start, end } = periodRange(habit.cadence, key);
  return { key, start, end, progress: 0, target: habit.amount, met: false, completed: false, points: 0, streak: 0, scoredOn: null };
}

/** Per-habit status for the UI, derived from `scoreHabit`. */
export function evaluateHabit(habit: Habit, transactions: Transaction[], accountsById: Map<string, Account>, today: string): HabitStatus {
  const results = scoreHabit(habit, transactions, accountsById, today);
  let streak = 0;
  let best = 0;
  let met = 0;
  let scored = 0;
  let earned = 0;
  for (const p of results) {
    if (p.met) { streak = p.streak; met += 1; scored += 1; earned += p.points; }
    else if (p.completed) { streak = 0; scored += 1; }
    best = Math.max(best, streak);
  }
  return {
    id: habit.id,
    kind: habit.kind,
    name: habit.name,
    cadence: habit.cadence,
    amount: habit.amount,
    category: habit.category,
    accountId: habit.accountId,
    startDate: habit.startDate,
    pointsPerPeriod: pointsFor(habit),
    current: results[results.length - 1] ?? emptyPeriod(habit, today),
    streak,
    bestStreak: best,
    periodsMet: met,
    periodsScored: scored,
    pointsEarned: earned,
    recent: results.slice(-RECENT_PERIODS),
    bonusNext: streak === STREAK_BONUS_AT - 1,
  };
}

function money(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/** Human line for a period result, e.g. "Saved $900 of $900 · 5-month streak, points doubled". */
export function describePeriod(habit: Pick<Habit, 'kind' | 'cadence' | 'category'>, p: PeriodResult): string {
  const unit = habit.cadence === 'weekly' ? 'week' : 'month';
  const streakNote = !p.met ? '' : p.streak >= STREAK_BONUS_AT ? ` · ${p.streak}-${unit} streak, points doubled` : p.streak > 1 ? ` · ${p.streak} in a row` : '';
  if (habit.kind === 'swap') {
    return p.met
      ? `${habit.category}: $${money(p.progress)} of a $${money(p.target)} cap${streakNote}`
      : `${habit.category}: $${money(p.progress)} — over the $${money(p.target)} cap`;
  }
  const verb = habit.kind === 'save' ? 'Saved' : 'Invested';
  return `${verb} $${money(p.progress)} of $${money(p.target)}${streakNote}`;
}

/** Averages of the last `n` complete months — starting values for the habit form. */
export function suggest(transactions: Transaction[], accounts: Account[], today: string, n = 3): MotivationSummary['suggestions'] {
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const months: string[] = [];
  let [y, m] = monthKey(today).split('-').map(Number);
  for (let i = 0; i < n; i++) {
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const inWindow = transactions.filter(t => months.includes(monthKey(t.date)));
  const avg = (sum: number) => Math.round(sum / n);
  const saving = inWindow.filter(t => t.type === 'income' && t.category === TRANSFER_CATEGORY && accountsById.get(t.accountId)?.type === 'savings').reduce((s, t) => s + Math.abs(t.amount), 0);
  const investing = inWindow.filter(t => t.type === 'expense' && t.category === INVESTMENT_CATEGORY).reduce((s, t) => s + Math.abs(t.amount), 0);
  const byCat: Record<string, number> = {};
  for (const t of inWindow.filter(isSpendingTxn)) byCat[t.category] = (byCat[t.category] || 0) + Math.abs(t.amount);
  const spendingByCategory: Record<string, number> = {};
  for (const [c, v] of Object.entries(byCat)) spendingByCategory[c] = avg(v);
  const discretionary = ['Food & Dining', 'Entertainment', 'Shopping', 'Transportation'];
  const swapCandidates = Object.entries(spendingByCategory)
    .sort(([a, va], [b, vb]) => (Number(discretionary.includes(b)) - Number(discretionary.includes(a))) || vb - va)
    .map(([c]) => c)
    .slice(0, 4);
  return { monthlySaving: avg(saving), monthlyInvesting: avg(investing), spendingByCategory, swapCandidates };
}

/** The complete motivation picture for one user. */
export function computeMotivation(input: MotivationInput): MotivationSummary {
  const { today } = input;
  const accountsById = new Map(input.accounts.map(a => [a.id, a]));
  // Creation order; Array.prototype.sort is stable, so equal timestamps keep insertion order.
  const habits = [...input.habits]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, MAX_HABITS);

  const statuses: HabitStatus[] = [];
  const entries: Omit<LedgerEntry, 'balance'>[] = [];
  const periods = new Map<string, PeriodResult[]>();
  for (const habit of habits) {
    statuses.push(evaluateHabit(habit, input.transactions, accountsById, today));
    const scored = scoreHabit(habit, input.transactions, accountsById, today);
    periods.set(habit.id, scored);
    for (const p of scored) {
      if (p.met) {
        entries.push({ date: p.scoredOn!, kind: 'habit', habitId: habit.id, habitKind: habit.kind, title: habit.name, detail: `${periodLabel(habit.cadence, p.key)} · ${describePeriod(habit, p)}`, points: p.points, periodKey: p.key });
      } else if (p.completed) {
        entries.push({ date: p.end, kind: 'miss', habitId: habit.id, habitKind: habit.kind, title: `${habit.name} — missed`, detail: `${periodLabel(habit.cadence, p.key)} · ${describePeriod(habit, p)}`, points: 0, periodKey: p.key });
      }
    }
  }
  // Claims and milestones dated after today do not exist yet (the clock can be frozen on an earlier day).
  const claims = (input.claims ?? []).filter(c => c.date <= today).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  for (const c of claims) {
    entries.push({ date: c.date, kind: 'reward', title: `Reward: ${c.name}`, detail: `${c.note ? `${c.note} · ` : ''}${c.cost} points used — enjoy it, you earned it`, points: -c.cost });
  }
  const milestones = (input.milestones ?? []).filter(m => m.date <= today);
  const badges = deriveBadges({ habits, periods, claims, milestones });
  for (const b of badges) {
    if (b.unlockedOn) entries.push({ date: b.unlockedOn, kind: 'milestone', title: `Badge: ${b.name}`, detail: b.detail, points: 0 });
  }
  // Every further FI-date improvement is worth a line too (the Closer badge only marks the first).
  const closer = badges.find(b => b.id === 'closer');
  for (const m of milestones) {
    if (isFiDateImprovement(m) && !(closer?.unlockedOn === m.date && closer.detail === m.detail)) {
      entries.push({ date: m.date, kind: 'milestone', title: 'FI date moved earlier', detail: m.detail, points: 0 });
    }
  }
  for (const e of input.extraEntries ?? []) entries.push(e);

  // Same-day entries: misses first, then hits in habit (creation) order, then milestones and claims — deterministic.
  const order: Record<string, number> = { miss: 0, habit: 1, milestone: 2, reward: 3 };
  const position = new Map(habits.map((h, i) => [h.id, i]));
  const pos = (e: { habitId?: string }) => (e.habitId ? position.get(e.habitId) ?? 0 : 0);
  entries.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || pos(a) - pos(b));

  // Running balance, and — per reward — since when it has been continuously affordable.
  // Any claim restarts every clock: treating yourself is the point, whichever reward it was.
  const rewardList = [...(input.rewards ?? [])].sort((a, b) => a.cost - b.cost || a.createdAt.localeCompare(b.createdAt)).slice(0, MAX_REWARDS);
  const since = new Map<string, string | null>(rewardList.map(r => [r.id, null]));
  let running = 0;
  const ledger: LedgerEntry[] = entries.map(e => {
    running += e.points;
    for (const r of rewardList) {
      if (running < r.cost) since.set(r.id, null);
      else if (since.get(r.id) === null || e.kind === 'reward') since.set(r.id, e.date);
    }
    return { ...e, balance: running };
  }).reverse();

  const earned = statuses.reduce((s, h) => s + h.pointsEarned, 0);
  const spent = claims.reduce((s, c) => s + c.cost, 0);
  const balance = earned - spent;

  const timesClaimed = new Map<string, number>();
  for (const c of claims) timesClaimed.set(c.rewardId, (timesClaimed.get(c.rewardId) ?? 0) + 1);
  const rewards: RewardStatus[] = rewardList.map(r => {
    const readySince = balance >= r.cost ? since.get(r.id) ?? null : null;
    return { ...r, ready: balance >= r.cost, shortBy: Math.max(0, r.cost - balance), timesClaimed: timesClaimed.get(r.id) ?? 0, readySince, readyDays: readySince ? daysBetween(readySince, today) : 0 };
  });
  const next = rewards.find(r => !r.ready) ?? null;
  const stepTarget = REWARD_STEP * (Math.floor(Math.max(0, balance) / REWARD_STEP) + 1);
  const nextReward = next ? { id: next.id, name: next.name, cost: next.cost }
    : rewards.length === 0 ? { id: null, name: 'Next reward', cost: stepTarget }
    : null;
  const toNextReward = nextReward ? Math.max(0, nextReward.cost - balance) : 0;
  const progress = nextReward ? Math.min(1, Math.max(0, balance) / nextReward.cost) : 1;

  const cheapest = rewards[0];
  const nudge = cheapest && cheapest.readySince && cheapest.readyDays >= NUDGE_AFTER_DAYS
    ? { rewardId: cheapest.id, name: cheapest.name, cost: cheapest.cost, since: cheapest.readySince, days: cheapest.readyDays }
    : null;

  return {
    today,
    enabled: habits.length > 0,
    points: {
      earned,
      spent,
      balance,
      rewardStep: REWARD_STEP,
      toNextReward,
      nextReward,
      progress,
      rewardsAvailable: rewards.filter(r => r.ready).length,
    },
    habits: statuses,
    rewards,
    claims: [...claims].reverse(),
    nudge,
    badges,
    fi: input.fi ?? null,
    ledger,
    rules: { points: HABIT_POINTS, streakBonusAt: STREAK_BONUS_AT, streakMultiplier: STREAK_MULTIPLIER, rewardStep: REWARD_STEP },
    suggestions: suggest(input.transactions, input.accounts, today),
  };
}
