import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Account, Transaction } from '../../src/db/database.js';
import {
  observeFi, monthsBetween, deriveBadges, computeMotivation, scoreHabit, BADGE_CATALOG, FI_LEVELS,
  type Habit, type Milestone, type RewardClaim,
} from '../../src/motivation/index.js';

const TODAY = '2026-10-25';
const ms = (over: Partial<Milestone>): Milestone => ({ id: 'm', userId: 'u', kind: 'fi-progress', value: 0, date: '2026-01-01', detail: '', createdAt: '', ...over });

describe('observeFi — milestones recorded the day they are first seen', () => {
  test('progress rungs: every rung reached and not yet recorded, once', () => {
    const fresh = observeFi([], { progress: 0.27, fiDate: '2043-05', fiNumber: 1e6 }, TODAY);
    assert.deepEqual(fresh.filter(m => m.kind === 'fi-progress').map(m => m.level), [5, 10, 25]);
    assert.equal(fresh.find(m => m.level === 25)!.detail, '25% of your FI number');
    assert.equal(fresh.find(m => m.level === 25)!.value, 0.27);
    const again = observeFi(fresh.map((m, i) => ms({ ...m, id: String(i) })), { progress: 0.27, fiDate: '2043-05', fiNumber: 1e6 }, '2026-10-26');
    assert.deepEqual(again, [], 'nothing new the next day');
    const more = observeFi(fresh.map((m, i) => ms({ ...m, id: String(i) })), { progress: 1.02, fiDate: '2026-10', fiNumber: 1e6 }, '2030-01-01');
    assert.deepEqual(more.filter(m => m.kind === 'fi-progress').map(m => m.level), [50, 75, 100]);
    assert.equal(more.find(m => m.level === 100)!.detail, 'Financially independent on current habits');
    assert.deepEqual([...FI_LEVELS], [5, 10, 25, 50, 75, 100]);
  });

  test('exactly on a rung counts; below it does not; null snapshot records nothing', () => {
    assert.deepEqual(observeFi([], { progress: 0.05, fiDate: null, fiNumber: 1 }, TODAY).map(m => m.level), [5]);
    assert.deepEqual(observeFi([], { progress: 0.0499, fiDate: null, fiNumber: 1 }, TODAY), []);
    assert.deepEqual(observeFi([], null, TODAY), []);
  });

  test('FI date: first sighting is a baseline, an earlier date (≥ 1 month, next calendar month) is a milestone, a later one is ignored', () => {
    const first = observeFi([], { progress: 0.01, fiDate: '2043-09', fiNumber: 1 }, '2026-01-25');
    assert.deepEqual(first.filter(m => m.kind === 'fi-date').map(m => [m.value, m.detail]), [['2043-09', 'FI date first in sight: September 2043']]);
    const base = ms({ kind: 'fi-date', value: '2043-09', date: '2026-01-25' });
    assert.deepEqual(observeFi([base], { progress: 0.01, fiDate: '2043-08', fiNumber: 1 }, '2026-01-31'), [], 'same calendar month as the last record → wait');
    assert.deepEqual(observeFi([base], { progress: 0.01, fiDate: '2043-09', fiNumber: 1 }, '2026-02-10'), [], 'unchanged');
    assert.deepEqual(observeFi([base], { progress: 0.01, fiDate: '2044-01', fiNumber: 1 }, '2026-02-10'), [], 'later is not a milestone');
    const better = observeFi([base], { progress: 0.01, fiDate: '2043-05', fiNumber: 1 }, '2026-07-25');
    assert.equal(better.length, 1);
    assert.equal(better[0].detail, 'FI date moved 4 months earlier — May 2043, was September 2043');
    assert.equal(better[0].value, '2043-05');
    const one = observeFi([base], { progress: 0.01, fiDate: '2043-08', fiNumber: 1 }, '2026-07-25');
    assert.equal(one[0].detail, 'FI date moved 1 month earlier — August 2043, was September 2043');
    assert.deepEqual(observeFi([base], { progress: 0.01, fiDate: null, fiNumber: 1 }, '2026-07-25'), [], 'FI out of sight → nothing');
    assert.equal(monthsBetween('2043-05', '2043-09'), 4);
    assert.equal(monthsBetween('2043-09', '2043-05'), -4);
  });
});

describe('deriveBadges', () => {
  const accounts: Account[] = [{ id: 'chk', userId: 'u', name: 'Checking', type: 'checking', balance: 0, currency: 'USD', createdAt: '' }];
  const byId = new Map(accounts.map(a => [a.id, a]));
  let seq = 0;
  const invested = (date: string, amount = 500): Transaction => ({ id: `t${++seq}`, userId: 'u', accountId: 'chk', date, type: 'expense', category: 'Investment', amount, description: '', tags: [] });
  const habit: Habit = { id: 'h', userId: 'u', kind: 'invest', name: 'Monthly investing', cadence: 'monthly', amount: 500, startDate: '2025-01-01', createdAt: '2025-01-01T00:00:00Z' };
  const months = (n: number) => Array.from({ length: n }, (_, i) => `${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-05`);
  const periods = (t: Transaction[]) => new Map([[habit.id, scoreHabit(habit, t, byId, TODAY)]]);

  test('catalog has thirteen badges, all locked with nothing to show', () => {
    const b = deriveBadges({ habits: [], periods: new Map(), claims: [], milestones: [] });
    assert.equal(b.length, 13);
    assert.deepEqual(b.map(x => x.id), BADGE_CATALOG.map(x => x.id));
    assert.ok(b.every(x => x.unlockedOn === null && x.detail === ''));
  });

  test('first points, 100 and 1,000 earned, 4 and 12 in a row — dated on the day it happened', () => {
    // 25, 25, 25, then 50 from the 4th month: cumulative 75 → 125 (4th) … 1,025 at the 22nd month
    const t = months(22).map(d => invested(d));
    const b = Object.fromEntries(deriveBadges({ habits: [habit], periods: periods(t), claims: [], milestones: [] }).map(x => [x.id, x]));
    assert.equal(b['first-step'].unlockedOn, '2025-01-05');
    assert.equal(b['century'].unlockedOn, '2025-04-05');
    assert.equal(b['century'].detail, '125 points earned');
    assert.equal(b['on-fire'].unlockedOn, '2025-04-05');
    assert.equal(b['on-fire'].detail, '4 in a row · Monthly investing');
    assert.equal(b['unstoppable'].unlockedOn, '2025-12-05');
    assert.equal(b['thousand'].unlockedOn, '2026-10-05');
    assert.equal(b['thousand'].detail, '1,025 points earned');
    assert.equal(b['treat'].unlockedOn, null);
    // A shorter run leaves the later badges locked
    const few = Object.fromEntries(deriveBadges({ habits: [habit], periods: periods(t.slice(0, 3)), claims: [], milestones: [] }).map(x => [x.id, x]));
    assert.equal(few['first-step'].unlockedOn, '2025-01-05');
    assert.equal(few['century'].unlockedOn, null);
    assert.equal(few['on-fire'].unlockedOn, null);
  });

  test('first reward and FI milestones', () => {
    const claims: RewardClaim[] = [{ id: 'c', userId: 'u', rewardId: 'r', name: 'Brunch', cost: 100, note: '', date: '2025-06-01', createdAt: '' }];
    const milestones = [
      ms({ id: '1', kind: 'fi-progress', level: 5, date: '2025-03-01', detail: '5% of your FI number' }),
      ms({ id: '2', kind: 'fi-progress', level: 10, date: '2026-02-01', detail: '10% of your FI number' }),
      ms({ id: '3', kind: 'fi-date', value: '2043-09', date: '2026-01-25', detail: 'FI date first in sight: September 2043' }),
      ms({ id: '4', kind: 'fi-date', value: '2043-05', date: '2026-07-25', detail: 'FI date moved 4 months earlier — May 2043, was September 2043' }),
    ];
    const b = Object.fromEntries(deriveBadges({ habits: [], periods: new Map(), claims, milestones }).map(x => [x.id, x]));
    assert.equal(b['treat'].unlockedOn, '2025-06-01');
    assert.equal(b['treat'].detail, 'Brunch');
    assert.equal(b['fi-5'].unlockedOn, '2025-03-01');
    assert.equal(b['fi-10'].unlockedOn, '2026-02-01');
    assert.equal(b['fi-25'].unlockedOn, null);
    assert.equal(b['closer'].unlockedOn, '2026-07-25', 'the baseline sighting is not a badge; the improvement is');
    assert.match(b['closer'].detail, /moved 4 months earlier/);
  });

  test('unlocked badges become 0-point milestone lines in the trail, in date order', () => {
    const t = months(5).map(d => invested(d));
    const m = computeMotivation({ habits: [habit], transactions: t, accounts, today: TODAY, milestones: [ms({ kind: 'fi-progress', level: 5, date: '2025-02-14', detail: '5% of your FI number' })] });
    const lines = m.ledger.filter(e => e.kind === 'milestone').reverse().map(e => `${e.date} ${e.title} (${e.points})`);
    assert.deepEqual(lines, [
      '2025-01-05 Badge: First step (0)',
      '2025-02-14 Badge: First brick (0)',
      '2025-04-05 Badge: Century (0)',
      '2025-04-05 Badge: On fire (0)',
    ]);
    assert.equal(m.points.balance, 75 + 50 + 50, 'badges do not change the points');
    assert.equal(m.badges.filter(b => b.unlockedOn).length, 4);
  });

  test('a second FI-date improvement gets its own trail line; the Closer badge keeps its first date', () => {
    const milestones = [
      ms({ id: '1', kind: 'fi-date', value: '2043-09', date: '2026-01-25', detail: 'FI date first in sight: September 2043' }),
      ms({ id: '2', kind: 'fi-date', value: '2043-05', date: '2026-07-25', detail: 'FI date moved 4 months earlier — May 2043, was September 2043' }),
      ms({ id: '3', kind: 'fi-date', value: '2042-02', date: '2026-10-25', detail: 'FI date moved 15 months earlier — February 2042, was May 2043' }),
    ];
    const m = computeMotivation({ habits: [], transactions: [], accounts, today: TODAY, milestones });
    assert.deepEqual(m.ledger.map(e => `${e.date} ${e.title}`), ['2026-10-25 FI date moved earlier', '2026-07-25 Badge: Closer']);
    assert.equal(m.badges.find(b => b.id === 'closer')!.unlockedOn, '2026-07-25');
  });
});
