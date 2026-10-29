import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Account, Transaction } from '../../src/db/database.js';
import {
  computeMotivation, evaluateHabit, scoreHabit, suggest,
  weekStart, periodKey, periodRange, nextPeriodKey, listPeriods, periodLabel,
  HABIT_POINTS, STREAK_BONUS_AT, REWARD_STEP, NUDGE_AFTER_DAYS, type Habit, type Reward, type RewardClaim,
} from '../../src/motivation/index.js';

/**
 * Hand-checkable scenarios for the points engine. Every number below can be
 * verified with the two-minute rule set in src/motivation/types.ts.
 */

const TODAY = '2026-10-25'; // a Sunday; the week runs Mon 19 Oct – Sun 25 Oct

const accounts: Account[] = [
  { id: 'chk', userId: 'u', name: 'Checking', type: 'checking', balance: 0, currency: 'USD', createdAt: '' },
  { id: 'sav', userId: 'u', name: 'Savings', type: 'savings', balance: 0, currency: 'USD', createdAt: '' },
  { id: 'sav2', userId: 'u', name: 'Holiday pot', type: 'savings', balance: 0, currency: 'USD', createdAt: '' },
  { id: 'card', userId: 'u', name: 'Card', type: 'credit', balance: 0, currency: 'USD', createdAt: '' },
];
const byId = new Map(accounts.map(a => [a.id, a]));

let seq = 0;
function txn(accountId: string, date: string, type: Transaction['type'], category: string, amount: number): Transaction {
  return { id: `t${++seq}`, userId: 'u', accountId, date, type, category, amount, description: '', tags: [] };
}
const saved = (date: string, amount: number, acc = 'sav') => txn(acc, date, 'income', 'Transfer', amount);
const invested = (date: string, amount: number) => txn('chk', date, 'expense', 'Investment', amount);
const spent = (date: string, amount: number, category = 'Food & Dining') => txn('card', date, 'expense', category, amount);

function habit(over: Partial<Habit>): Habit {
  return { id: 'h', userId: 'u', kind: 'save', name: 'Weekly saving', cadence: 'weekly', amount: 100, startDate: '2026-09-28', createdAt: '2026-09-28T00:00:00Z', ...over };
}

describe('periods', () => {
  test('ISO weeks start on Monday', () => {
    assert.equal(weekStart('2026-10-25'), '2026-10-19', 'Sunday belongs to the week of Monday 19th');
    assert.equal(weekStart('2026-10-19'), '2026-10-19');
    assert.equal(weekStart('2026-10-20'), '2026-10-19');
    assert.equal(weekStart('2026-10-26'), '2026-10-26', 'next Monday starts a new week');
    assert.deepEqual(periodRange('weekly', '2026-10-19'), { start: '2026-10-19', end: '2026-10-25' });
  });

  test('months, keys and successors', () => {
    assert.equal(periodKey('monthly', '2026-02-14'), '2026-02');
    assert.deepEqual(periodRange('monthly', '2026-02'), { start: '2026-02-01', end: '2026-02-28' });
    assert.deepEqual(periodRange('monthly', '2028-02'), { start: '2028-02-01', end: '2028-02-29' }, 'leap year');
    assert.equal(nextPeriodKey('monthly', '2026-12'), '2027-01');
    assert.equal(nextPeriodKey('weekly', '2026-12-28'), '2027-01-04');
    assert.deepEqual(listPeriods('weekly', '2026-10-01', '2026-10-25'), ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
    assert.deepEqual(listPeriods('monthly', '2026-08-15', '2026-10-25'), ['2026-08', '2026-09', '2026-10']);
    assert.deepEqual(listPeriods('monthly', '2026-11-01', '2026-10-25'), [], 'start after end → nothing');
    assert.equal(periodLabel('weekly', '2026-10-19'), 'Week of 19 Oct 2026');
    assert.equal(periodLabel('monthly', '2026-10'), 'October 2026');
  });
});

describe('scoring one habit', () => {
  test('weekly saving: met weeks score 10, a completed miss scores 0, the open week is neither', () => {
    const h = habit({});
    const r = scoreHabit(h, [saved('2026-09-30', 100), saved('2026-10-07', 60), saved('2026-10-09', 40), saved('2026-10-20', 99)], byId, TODAY);
    assert.deepEqual(r.map(p => p.key), ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
    assert.deepEqual(r.map(p => [p.met, p.completed, p.points]), [[true, true, 10], [true, true, 10], [false, true, 0], [false, false, 0]]);
    assert.equal(r[1].scoredOn, '2026-10-09', 'scored on the day the total reached the target');
    assert.equal(r[3].progress, 99, 'one dollar short is not met');
    const s = evaluateHabit(h, [], byId, TODAY);
    assert.equal(s.current.key, '2026-10-19');
    assert.equal(s.periodsScored, 3, 'three completed weeks; the open one is not scored yet');
  });

  test('the open week scores as soon as the target is hit', () => {
    const s = evaluateHabit(habit({}), [saved('2026-10-25', 100)], byId, TODAY);
    assert.equal(s.current.met, true);
    assert.equal(s.current.points, 10);
    assert.equal(s.periodsScored, 4);
    assert.equal(s.pointsEarned, 10);
  });

  test('exactly on target counts; floating-point sums do not lose it', () => {
    const s = evaluateHabit(habit({ amount: 0.3 }), [saved('2026-10-20', 0.1), saved('2026-10-21', 0.2)], byId, TODAY);
    assert.equal(s.current.met, true);
  });

  test('streak: the fourth consecutive week doubles the points and the bonus persists', () => {
    const h = habit({ startDate: '2026-08-03' });
    const weeks = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'];
    const r = scoreHabit(h, weeks.map(d => saved(d, 100)), byId, TODAY);
    assert.deepEqual(r.map(p => p.points), [10, 10, 10, 20, 20, 20, 20, 20, 20, 20, 20, 20]);
    assert.deepEqual(r.map(p => p.streak), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const s = evaluateHabit(h, weeks.map(d => saved(d, 100)), byId, TODAY);
    assert.equal(s.streak, 12);
    assert.equal(s.bestStreak, 12);
    assert.equal(s.pointsEarned, 3 * 10 + 9 * 20);
    assert.equal(s.recent.length, 8, 'dots strip shows the last eight periods');
  });

  test('a miss resets the streak; the open week keeps it alive until it ends', () => {
    const h = habit({ startDate: '2026-08-31' });
    const met = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', /* miss 28 Sep */ '2026-10-05', '2026-10-12'];
    const s = evaluateHabit(h, met.map(d => saved(d, 100)), byId, TODAY);
    const pts = s.recent.map(p => p.points);
    assert.deepEqual(pts, [10, 10, 10, 20, 0, 10, 10, 0]);
    assert.equal(s.streak, 2, 'two met weeks since the miss; the open week has not broken it');
    assert.equal(s.bestStreak, 4);
    assert.equal(s.bonusNext, false);
    const s2 = evaluateHabit(h, [...met, '2026-10-19'].map(d => saved(d, 100)), byId, TODAY);
    assert.equal(s2.streak, 3);
    assert.equal(s2.bonusNext, true, 'one more for the bonus');
  });

  test('monthly investing: 25 points, doubled from the fourth month', () => {
    const h = habit({ kind: 'invest', name: 'Monthly investing', cadence: 'monthly', amount: 500, startDate: '2026-05-01' });
    const r = scoreHabit(h, ['2026-05-05', '2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map(d => invested(d, 500)), byId, TODAY);
    assert.deepEqual(r.map(p => p.points), [25, 25, 25, 50, 50, 50]);
    assert.equal(HABIT_POINTS.monthly.invest, 25);
  });

  test('spending swap: scores only when the week is over and spending stayed under the cap', () => {
    const h = habit({ kind: 'swap', name: 'Coffee swap', category: 'Food & Dining', amount: 50, startDate: '2026-10-05' });
    const t = [spent('2026-10-06', 20), spent('2026-10-08', 30), /* week 12 Oct */ spent('2026-10-13', 50.01), /* open week */ spent('2026-10-20', 10)];
    const r = scoreHabit(h, t, byId, TODAY);
    assert.deepEqual(r.map(p => [p.key, p.met, p.completed, p.points]), [['2026-10-05', true, true, 5], ['2026-10-12', false, true, 0], ['2026-10-19', false, false, 0]]);
    assert.equal(r[0].scoredOn, '2026-10-11', 'a cap scores on the last day of the period');
    assert.equal(r[0].progress, 50, 'exactly on the cap is fine');
    assert.equal(r[2].progress, 10, 'the open week shows what has been spent so far');
    // other categories and transfers are ignored
    const r2 = scoreHabit(h, [spent('2026-10-06', 999, 'Shopping'), txn('card', '2026-10-07', 'income', 'Transfer', 500)], byId, TODAY);
    assert.equal(r2[0].met, true);
    assert.equal(r2[0].progress, 0);
  });

  test('saving: only Transfer income into savings accounts counts (or the chosen account)', () => {
    const anySavings = habit({ startDate: '2026-10-19' });
    const t = [
      saved('2026-10-19', 60, 'sav'),
      saved('2026-10-20', 40, 'sav2'),
      txn('chk', '2026-10-20', 'income', 'Transfer', 500),     // checking is not savings
      txn('chk', '2026-10-21', 'expense', 'Transfer', 100),    // the outgoing leg never counts
      txn('sav', '2026-10-22', 'income', 'Investment', 70),    // interest is income, not saving
      txn('card', '2026-10-23', 'income', 'Transfer', 300),    // card pay-off
    ];
    assert.equal(evaluateHabit(anySavings, t, byId, TODAY).current.progress, 100);
    assert.equal(evaluateHabit(habit({ startDate: '2026-10-19', accountId: 'sav2' }), t, byId, TODAY).current.progress, 40);
  });

  test('start date: periods before it are ignored; a future start scores nothing', () => {
    const t = [saved('2026-09-30', 100), saved('2026-10-07', 100)];
    assert.equal(evaluateHabit(habit({ startDate: '2026-10-07' }), t, byId, TODAY).pointsEarned, 10, 'the period containing the start date counts whole');
    const future = evaluateHabit(habit({ startDate: '2026-11-01' }), t, byId, TODAY);
    assert.equal(future.pointsEarned, 0);
    assert.equal(future.current.key, '2026-10-19', 'a current period is still reported for display');
    assert.equal(future.periodsScored, 0);
  });

  test('a back-dated transaction changes history (points are recomputed, never stored)', () => {
    const h = habit({ startDate: '2026-10-05' });
    const before = evaluateHabit(h, [saved('2026-10-06', 100)], byId, TODAY);
    assert.deepEqual(before.recent.map(p => p.points), [10, 0, 0]);
    const after = evaluateHabit(h, [saved('2026-10-06', 100), saved('2026-10-14', 100)], byId, TODAY);
    assert.deepEqual(after.recent.map(p => p.points), [10, 10, 0]);
    assert.equal(after.streak, 2);
  });
});

describe('computeMotivation', () => {
  const habits: Habit[] = [
    habit({ id: 'save', startDate: '2026-10-05', createdAt: '2026-10-05T00:00:00Z' }),
    habit({ id: 'inv', kind: 'invest', name: 'Monthly investing', cadence: 'monthly', amount: 500, startDate: '2026-09-01', createdAt: '2026-09-01T00:00:00Z' }),
    habit({ id: 'swap', kind: 'swap', name: 'Coffee swap', category: 'Food & Dining', amount: 50, startDate: '2026-10-05', createdAt: '2026-10-06T00:00:00Z' }),
  ];
  const transactions = [
    saved('2026-10-06', 100), saved('2026-10-14', 100), saved('2026-10-21', 100),
    invested('2026-09-10', 500), invested('2026-10-10', 300),
    spent('2026-10-07', 20), spent('2026-10-13', 80),
  ];

  test('points, balance and the bar towards the next 100-step when there is no reward list', () => {
    const m = computeMotivation({ habits, transactions, accounts, today: TODAY });
    assert.equal(m.enabled, true);
    // save: 3 weeks met (10+10+10); invest: Sep met (25), Oct 300/500 open; swap: week 5 Oct met (5), week 12 Oct miss, week 19 open
    assert.equal(m.points.earned, 30 + 25 + 5);
    assert.equal(m.points.spent, 0);
    assert.equal(m.points.balance, 60);
    assert.equal(m.points.rewardStep, REWARD_STEP);
    assert.equal(m.points.toNextReward, 40);
    assert.deepEqual(m.points.nextReward, { id: null, name: 'Next reward', cost: 100 });
    assert.equal(m.points.progress, 0.6);
    assert.equal(m.points.rewardsAvailable, 0);
    assert.deepEqual(m.rewards, []);
    assert.deepEqual(m.claims, []);
    assert.equal(m.nudge, null);
    assert.equal(m.rules.streakBonusAt, STREAK_BONUS_AT);
    assert.deepEqual(m.habits.map(h => h.id), ['inv', 'save', 'swap'], 'habits ordered by creation');
  });

  test('the trail lists every scored period newest first with a running balance', () => {
    const m = computeMotivation({ habits, transactions, accounts, today: TODAY });
    const lines = m.ledger.filter(e => e.kind !== 'milestone').map(e => `${e.date} ${e.kind} ${e.title} ${e.points} → ${e.balance}`);
    assert.deepEqual(m.ledger.filter(e => e.kind === 'milestone').map(e => `${e.date} ${e.title}`), ['2026-09-10 Badge: First step'], 'badges ride along as 0-point lines');
    assert.deepEqual(lines, [
      '2026-10-21 habit Weekly saving 10 → 60',
      '2026-10-18 miss Coffee swap — missed 0 → 50',
      '2026-10-14 habit Weekly saving 10 → 50',
      '2026-10-11 habit Coffee swap 5 → 40',
      '2026-10-06 habit Weekly saving 10 → 35',
      '2026-09-10 habit Monthly investing 25 → 25',
    ]);
    assert.match(m.ledger[0].detail, /Week of 19 Oct 2026 · Saved \$100 of \$100 · 3 in a row/);
    assert.match(m.ledger[1].detail, /Food & Dining: \$80 — over the \$50 cap/);
    assert.equal(m.ledger[m.ledger.length - 1].balance, 25, 'oldest entry starts the running total');
  });

  test('same-day entries are ordered deterministically: misses, then hits in habit order', () => {
    // Both monthly habits score on the 5th; the swap's week ends the same day.
    const hs: Habit[] = [
      habit({ id: 'b', kind: 'invest', name: 'B invest', cadence: 'monthly', amount: 100, startDate: '2026-10-01', createdAt: '2026-10-01T00:00:01Z' }),
      habit({ id: 'a', name: 'A save', cadence: 'monthly', amount: 100, startDate: '2026-10-01', createdAt: '2026-10-01T00:00:00Z' }),
      habit({ id: 'c', kind: 'swap', name: 'C swap', category: 'Shopping', amount: 10, startDate: '2026-09-28', createdAt: '2026-10-01T00:00:02Z' }),
    ];
    const t = [saved('2026-10-04', 100), invested('2026-10-04', 100), spent('2026-09-29', 50, 'Shopping')];
    const m = computeMotivation({ habits: hs, transactions: t, accounts, today: TODAY });
    const sameDay = m.ledger.filter(e => e.date === '2026-10-04' && e.kind !== 'milestone').map(e => e.title);
    // Oldest → newest the order is miss, A, B; the ledger is newest-first, so it reads back reversed.
    assert.deepEqual(sameDay, ['B invest', 'A save', 'C swap — missed'], 'creation order regardless of id; ids "a" < "b" would have given the other order');
  });

  const reward = (id: string, name: string, cost: number, createdAt = '2026-09-01T00:00:00Z'): Reward => ({ id, userId: 'u', name, cost, note: '', createdAt });
  const claim = (rewardId: string, cost: number, date: string, name = 'Treat'): RewardClaim => ({ id: `c-${date}`, userId: 'u', rewardId, name, cost, note: '~$20', date, createdAt: `${date}T10:00:00Z` });
  const tiers = [reward('big', 'Family dinner', 500), reward('small', 'Brunch', 50), reward('mid', 'Dinner for two', 100)];

  test('rewards: sorted by cost, ready/shortBy, and the bar fills towards the next unaffordable one', () => {
    const m = computeMotivation({ habits, transactions, accounts, today: TODAY, rewards: tiers });
    assert.deepEqual(m.rewards.map(r => [r.name, r.ready, r.shortBy]), [['Brunch', true, 0], ['Dinner for two', false, 40], ['Family dinner', false, 440]]);
    assert.equal(m.points.rewardsAvailable, 1);
    assert.deepEqual(m.points.nextReward, { id: 'mid', name: 'Dinner for two', cost: 100 });
    assert.equal(m.points.toNextReward, 40);
    assert.equal(m.points.progress, 0.6, 'balance ÷ next reward cost');
    // Exactly affordable everything → bar full, nothing next
    const rich = computeMotivation({ habits, transactions, accounts, today: TODAY, rewards: [reward('s', 'Snack', 60)] });
    assert.equal(rich.points.nextReward, null);
    assert.equal(rich.points.progress, 1);
    assert.equal(rich.points.toNextReward, 0);
  });

  test('the bar never shows empty when rewards are banked (the 1,000-points case)', () => {
    // A balance that is an exact multiple of 100 used to render 0/100 while ten rewards were banked.
    const many: Habit[] = [habit({ id: 'inv', kind: 'invest', name: 'Monthly investing', cadence: 'monthly', amount: 1, startDate: '2024-01-01' })];
    const t = Array.from({ length: 34 }, (_, i) => invested(`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-05`, 1));
    const m = computeMotivation({ habits: many, transactions: t, accounts, today: TODAY, rewards: [reward('s', 'Brunch', 100), reward('m', 'Dinner', 250), reward('l', 'Weekend', 1000)] });
    assert.equal(m.points.balance, 3 * 25 + 31 * 50, 'sanity: 1,625');
    assert.equal(m.points.progress, 1);
    assert.equal(m.points.rewardsAvailable, 3);
    const noList = computeMotivation({ habits: many, transactions: t.slice(0, 23), accounts, today: TODAY });
    assert.equal(noList.points.balance, 3 * 25 + 20 * 50, 'sanity: 1,075 → bar towards 1,100');
    assert.equal(noList.points.toNextReward, 25);
  });

  test('claims: −cost lines in the trail, spent reduces the balance, history survives list edits', () => {
    const claims = [claim('small', 50, '2026-10-15', 'Brunch'), claim('gone', 10, '2026-10-22', 'Old treat')];
    const m = computeMotivation({ habits, transactions, accounts, today: TODAY, rewards: tiers, claims });
    assert.equal(m.points.spent, 60);
    assert.equal(m.points.balance, 0);
    assert.deepEqual(m.points.rewardsAvailable, 0);
    assert.equal(m.rewards.find(r => r.id === 'small')!.timesClaimed, 1);
    const lines = m.ledger.filter(e => e.kind === 'reward').map(e => `${e.date} ${e.title} ${e.points} → ${e.balance}`);
    assert.deepEqual(lines, ['2026-10-22 Reward: Old treat -10 → 0', '2026-10-15 Reward: Brunch -50 → 0']);
    assert.match(m.ledger.find(e => e.kind === 'reward')!.detail, /~\$20 · 10 points used/);
    assert.deepEqual(m.claims.map(c => c.date), ['2026-10-22', '2026-10-15'], 'newest first');
    // Same day as a habit line: the claim comes after the hit
    const sameDay = computeMotivation({ habits, transactions, accounts, today: TODAY, rewards: tiers, claims: [claim('small', 50, '2026-10-21')] });
    assert.deepEqual(sameDay.ledger.filter(e => e.kind !== 'milestone').slice(0, 2).map(e => e.kind), ['reward', 'habit']);
  });

  test('nudge: the cheapest reward affordable for 30 days without a claim; a claim restarts the clock', () => {
    const h: Habit[] = [habit({ id: 'inv', kind: 'invest', name: 'Monthly investing', cadence: 'monthly', amount: 1, startDate: '2026-01-01' })];
    const t = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map(mm => invested(`2026-${mm}-05`, 1));
    const list = [reward('s', 'Brunch', 100)];
    // 25,50,75,125 (Apr 5, doubled) → affordable since 2026-04-05 → 203 days by 25 Oct
    const m = computeMotivation({ habits: h, transactions: t, accounts, today: TODAY, rewards: list });
    assert.ok(m.nudge);
    assert.equal(m.nudge!.since, '2026-04-05');
    assert.equal(m.nudge!.days, 203);
    assert.ok(NUDGE_AFTER_DAYS <= 203);
    // A claim on 1 Oct restarts the clock even though the balance stays above 100
    const claimed = computeMotivation({ habits: h, transactions: t, accounts, today: TODAY, rewards: list, claims: [claim('s', 100, '2026-10-01', 'Brunch')] });
    assert.equal(claimed.nudge, null, '24 days since the claim');
    const later = computeMotivation({ habits: h, transactions: t, accounts, today: '2026-10-31', rewards: list, claims: [claim('s', 100, '2026-10-01', 'Brunch')] });
    assert.equal(later.nudge!.since, '2026-10-01');
    assert.equal(later.nudge!.days, 30);
    assert.equal(NUDGE_AFTER_DAYS, 30);
    // Dropping below the cost resets it
    const poor = computeMotivation({ habits: h, transactions: t.slice(0, 4), accounts, today: TODAY, rewards: list, claims: [claim('s', 100, '2026-04-10', 'Brunch')] });
    assert.equal(poor.points.balance, 25);
    assert.equal(poor.nudge, null);
  });

  test('claims dated after today do not exist yet (clock frozen on an earlier day)', () => {
    const future = [claim('small', 50, '2026-11-05', 'Brunch')];
    const m = computeMotivation({ habits, transactions, accounts, today: TODAY, rewards: tiers, claims: future });
    assert.equal(m.points.spent, 0);
    assert.equal(m.points.balance, 60);
    assert.deepEqual(m.claims, []);
    assert.equal(m.ledger.filter(e => e.kind === 'reward').length, 0);
    assert.equal(m.rewards[0].readySince, '2026-10-14', 'brunch (50) affordable since the balance reached 50 (25 + 10 + 5 + 10)');
  });

  test('readySince per reward: each clock starts when that reward became affordable; any claim restarts all of them', () => {
    const h: Habit[] = [habit({ id: 'inv', kind: 'invest', name: 'Monthly investing', cadence: 'monthly', amount: 1, startDate: '2026-01-01' })];
    const t = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map(mm => invested(`2026-${mm}-05`, 1));
    // balances after the 5th: 25, 50, 75, 125, 175, 225, 275, 325, 375, 425
    const list = [reward('s', 'Brunch', 100), reward('m', 'Dinner', 250), reward('l', 'Weekend', 400)];
    const m = computeMotivation({ habits: h, transactions: t, accounts, today: TODAY, rewards: list });
    assert.deepEqual(m.rewards.map(r => [r.name, r.readySince, r.readyDays]), [['Brunch', '2026-04-05', 203], ['Dinner', '2026-07-05', 112], ['Weekend', '2026-10-05', 20]]);
    const claimed = computeMotivation({ habits: h, transactions: t, accounts, today: TODAY, rewards: list, claims: [claim('s', 100, '2026-08-10', 'Brunch')] });
    assert.deepEqual(claimed.rewards.map(r => [r.name, r.ready, r.readySince]), [['Brunch', true, '2026-08-10'], ['Dinner', true, '2026-09-05'], ['Weekend', false, null]], '225 after the claim: brunch restarts on the claim day, dinner only when the balance passes 250 again');
    assert.equal(claimed.nudge!.days, 76);
  });

  test('extra entries (milestones) are merged into the trail without changing the balance', () => {
    const m = computeMotivation({
      habits, transactions, accounts, today: TODAY,
      extraEntries: [{ date: '2026-10-15', kind: 'milestone', title: '25 % of the way to FI', detail: '', points: 0 }],
    });
    assert.equal(m.points.balance, 60);
    const ms = m.ledger.find(e => e.kind === 'milestone')!;
    assert.equal(ms.balance, 50, '25 + 10 + 5 + 10 up to 15 Oct');
  });

  test('no habits → disabled, empty trail, suggestions still computed', () => {
    const m = computeMotivation({ habits: [], transactions, accounts, today: TODAY });
    assert.equal(m.enabled, false);
    assert.deepEqual(m.ledger, []);
    assert.equal(m.points.balance, 0);
    assert.equal(m.suggestions.monthlyInvesting, Math.round(500 / 3), 'September only falls in the last three complete months');
  });

  test('suggestions: averages over the last three complete months, discretionary categories first', () => {
    const s = suggest([
      saved('2026-07-01', 300), saved('2026-08-01', 300), saved('2026-09-01', 300), saved('2026-10-01', 900), // October is not complete
      spent('2026-09-03', 300, 'Housing'), spent('2026-09-04', 90, 'Food & Dining'), spent('2026-09-05', 30, 'Entertainment'),
    ], accounts, TODAY);
    assert.equal(s.monthlySaving, 300);
    assert.equal(s.spendingByCategory.Housing, 100);
    assert.deepEqual(s.swapCandidates, ['Food & Dining', 'Entertainment', 'Housing']);
  });
});
