import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp, TEST_TODAY } from '../helpers/server.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD, FIN_FOOD_CAP } from '../../src/seed/fin.js';

/**
 * Habits CRUD + the computed motivation picture over HTTP. The clock is frozen
 * on 2026-10-25 (a Sunday): the current week is Mon 19 – Sun 25 Oct.
 */
describe('Motivation API', () => {
  let app: TestApp;

  before(async () => { app = await launch(); });
  after(async () => { await app.close(); });

  describe('a fresh user builds the loop from scratch', () => {
    let token: string;
    let checking: string;
    let savings: string;

    before(async () => {
      token = (await app.register('alice', 'pw')).token;
      checking = (await app.post('/api/accounts', { name: 'Checking', type: 'checking', balance: 5000 }, token)).body.id;
      savings = (await app.post('/api/accounts', { name: 'Savings', type: 'savings', balance: 1000 }, token)).body.id;
    });

    test('no habits → disabled, zero points, suggestions present', async () => {
      const res = await app.get('/api/motivation', token);
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, false);
      assert.equal(res.body.today, TEST_TODAY);
      assert.deepEqual(res.body.habits, []);
      assert.deepEqual(res.body.ledger, []);
      assert.equal(res.body.points.balance, 0);
      assert.equal(res.body.points.rewardStep, 100);
      assert.equal(res.body.rules.streakBonusAt, 4);
      assert.ok(res.body.suggestions);
    });

    test('validation: kind, cadence, amount, category, account, date', async () => {
      const bad = async (body: unknown, re: RegExp) => {
        const res = await app.post('/api/habits', body, token);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.error, re);
      };
      await bad({ kind: 'nap', amount: 10 }, /kind/);
      await bad({ kind: 'save', cadence: 'daily', amount: 10 }, /cadence/);
      await bad({ kind: 'save', amount: 0 }, /amount/);
      await bad({ kind: 'save', amount: -5 }, /amount/);
      await bad({ kind: 'swap', amount: 50 }, /category/);
      await bad({ kind: 'swap', amount: 50, category: 'Transfer' }, /category/);
      await bad({ kind: 'swap', amount: 50, category: 'Salary' }, /category/);
      await bad({ kind: 'save', amount: 50, accountId: 'nope' }, /account/i);
      await bad({ kind: 'save', amount: 50, startDate: '25/10/2026' }, /startDate/);
      assert.equal((await app.get('/api/habits')).status, 401, 'auth required');
    });

    test('create with defaults: name derived, start today, weekly; the first habit seeds the reward list', async () => {
      assert.deepEqual((await app.get('/api/rewards', token)).body, []);
      const res = await app.post('/api/habits', { kind: 'save', amount: 100 }, token);
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'Weekly saving');
      assert.equal(res.body.cadence, 'weekly');
      assert.equal(res.body.startDate, TEST_TODAY);
      assert.equal(res.body.accountId, undefined);
      const list = (await app.get('/api/habits', token)).body;
      assert.equal(list.length, 1);
      const rewards = (await app.get('/api/rewards', token)).body;
      assert.deepEqual(rewards.map((r: any) => [r.name, r.cost]), [['Brunch at the coffee shop', 100], ['Dinner for two', 250], ['Family dinner out', 500], ['Weekend away', 1000]]);
      const m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.points.nextReward.name, 'Brunch at the coffee shop');
      assert.equal(m.points.toNextReward, 100);
      assert.equal(m.points.progress, 0);
    });

    test('points follow the transactions: hit the target → +10, edit it away → gone, back-date → history rewritten', async () => {
      const habit = (await app.get('/api/habits', token)).body[0];
      // Outgoing leg on checking never counts; the incoming leg on savings does.
      await app.post('/api/transactions', { accountId: checking, type: 'expense', amount: 100, category: 'Transfer', date: '2026-10-24', description: 'To savings' }, token);
      let m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.points.balance, 0, 'the outgoing leg is not saving');
      const leg = (await app.post('/api/transactions', { accountId: savings, type: 'income', amount: 100, category: 'Transfer', date: '2026-10-24', description: 'From checking' }, token)).body;
      m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.enabled, true);
      assert.equal(m.points.balance, 10);
      assert.equal(m.points.progress, 0.1, 'bar fills towards the 100-point brunch');
      assert.equal(m.habits[0].current.met, true);
      assert.equal(m.habits[0].current.scoredOn, '2026-10-24');
      const lines = (x: any) => x.ledger.filter((e: any) => e.kind !== 'milestone');
      assert.equal(lines(m).length, 1);
      assert.equal(lines(m)[0].title, 'Weekly saving');
      assert.equal(lines(m)[0].points, 10);
      assert.equal(lines(m)[0].habitId, habit.id);
      assert.deepEqual(m.ledger.map((e: any) => e.kind), ['milestone', 'habit'], 'the first points also unlock the First step badge');
      assert.equal(m.badges.find((b: any) => b.id === 'first-step').unlockedOn, '2026-10-24');

      // Reduce the amount → target no longer reached
      await app.put(`/api/transactions/${leg.id}`, { amount: 99 }, token);
      m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.points.balance, 0);
      assert.equal(m.habits[0].current.progress, 99);
      assert.equal(m.ledger.length, 0, 'the open week is not a miss yet (and no badge without points)');

      // Restore and move the habit's start date back → earlier weeks are scored (as misses)
      await app.put(`/api/transactions/${leg.id}`, { amount: 100 }, token);
      const upd = await app.put(`/api/habits/${habit.id}`, { startDate: '2026-10-05' }, token);
      assert.equal(upd.status, 200);
      m = (await app.get('/api/motivation', token)).body;
      assert.deepEqual(lines(m).map((e: any) => [e.date, e.kind, e.points]), [['2026-10-24', 'habit', 10], ['2026-10-18', 'miss', 0], ['2026-10-11', 'miss', 0]]);
      assert.equal(m.habits[0].streak, 1);
      assert.equal(m.habits[0].periodsScored, 3);
      // Back-dated saving for the week of 12 Oct turns the miss into a hit
      await app.post('/api/transactions', { accountId: savings, type: 'income', amount: 120, category: 'Transfer', date: '2026-10-13' }, token);
      m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.points.balance, 20);
      assert.equal(m.habits[0].streak, 2);
      assert.deepEqual(lines(m).map((e: any) => e.kind), ['habit', 'habit', 'miss']);
    });

    test('update: changing kind drops fields that no longer apply; account pinning works', async () => {
      const habit = (await app.get('/api/habits', token)).body[0];
      const pinned = await app.put(`/api/habits/${habit.id}`, { accountId: savings, name: 'Rainy day' }, token);
      assert.equal(pinned.body.accountId, savings);
      assert.equal(pinned.body.name, 'Rainy day');
      const unpinned = await app.put(`/api/habits/${habit.id}`, { accountId: null }, token);
      assert.equal(unpinned.body.accountId, undefined, 'null clears the pin');
      const asSwap = await app.put(`/api/habits/${habit.id}`, { kind: 'swap', category: 'Food & Dining', amount: 60, accountId: savings }, token);
      assert.equal(asSwap.status, 200);
      assert.equal(asSwap.body.category, 'Food & Dining');
      assert.equal(asSwap.body.accountId, undefined, 'accounts are a save-only field');
      const back = await app.put(`/api/habits/${habit.id}`, { kind: 'save', amount: 100 }, token);
      assert.equal(back.body.category, undefined);
      assert.equal((await app.put('/api/habits/missing', { amount: 1 }, token)).status, 404);
      assert.equal((await app.put(`/api/habits/${habit.id}`, { amount: 'lots' }, token)).status, 400);
    });

    test('swap habit scores completed weeks under the cap; Uncategorized spending is not the category', async () => {
      const res = await app.post('/api/habits', { kind: 'swap', category: 'Food & Dining', cadence: 'weekly', amount: 50, startDate: '2026-10-12' }, token);
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'Food & Dining swap');
      await app.post('/api/transactions', { accountId: checking, type: 'expense', amount: 30, category: 'Food & Dining', date: '2026-10-14' }, token);
      await app.post('/api/transactions', { accountId: checking, type: 'expense', amount: 30, category: 'Uncategorized', date: '2026-10-15' }, token);
      const m = (await app.get('/api/motivation', token)).body;
      const swap = m.habits.find((h: any) => h.kind === 'swap');
      assert.equal(swap.recent.length, 2);
      assert.deepEqual(swap.recent.map((p: any) => [p.met, p.points]), [[true, 5], [false, 0]], 'week of 12 Oct met; the open week cannot score yet');
      assert.equal(m.points.balance, 25);
    });

    test('delete removes the habit and its points from the trail; a cap on the number of habits', async () => {
      const habits = (await app.get('/api/habits', token)).body;
      const swap = habits.find((h: any) => h.kind === 'swap');
      assert.equal((await app.del(`/api/habits/${swap.id}`, token)).status, 200);
      const m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.points.balance, 20);
      assert.equal((await app.del(`/api/habits/${swap.id}`, token)).status, 404);
      for (let i = 0; i < 7; i++) assert.equal((await app.post('/api/habits', { kind: 'invest', amount: 10 }, token)).status, 201);
      const full = await app.post('/api/habits', { kind: 'invest', amount: 10 }, token);
      assert.equal(full.status, 400);
      assert.match(full.body.error, /At most 8/);
    });

    test('rewards: validation, edit, delete, cap of 8, defaults only add what is missing', async () => {
      const bad = async (body: unknown, re: RegExp) => {
        const res = await app.post('/api/rewards', body, token);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.error, re);
      };
      await bad({ cost: 100 }, /name/);
      await bad({ name: 'x', cost: 0 }, /cost/);
      await bad({ name: 'x', cost: 12.5 }, /whole number/);
      const created = await app.post('/api/rewards', { name: '  Massage ', cost: 300, note: '~$70' }, token);
      assert.equal(created.status, 201);
      assert.equal(created.body.name, 'Massage');
      const edited = await app.put(`/api/rewards/${created.body.id}`, { cost: 200 }, token);
      assert.equal(edited.body.cost, 200);
      assert.equal(edited.body.note, '~$70', 'untouched fields stay');
      assert.equal((await app.put('/api/rewards/nope', { cost: 1 }, token)).status, 404);
      const again = await app.post('/api/rewards/defaults', undefined, token);
      assert.equal(again.status, 201);
      assert.deepEqual(again.body, [], 'the four are already there');
      assert.equal((await app.get('/api/rewards', token)).body.length, 5);
      for (let i = 0; i < 3; i++) assert.equal((await app.post('/api/rewards', { name: `Extra ${i}`, cost: 50 }, token)).status, 201);
      const full = await app.post('/api/rewards', { name: 'One too many', cost: 50 }, token);
      assert.equal(full.status, 400);
      assert.match(full.body.error, /At most 8/);
      for (const r of (await app.get('/api/rewards', token)).body.filter((r: any) => /^Extra/.test(r.name))) assert.equal((await app.del(`/api/rewards/${r.id}`, token)).status, 200);
      assert.equal((await app.del(`/api/rewards/${created.body.id}`, token)).status, 200);
      assert.equal((await app.del(`/api/rewards/${created.body.id}`, token)).status, 404);
      assert.equal((await app.get('/api/rewards', token)).body.length, 4);
    });

    test('claiming: refused when short, then a −cost line in the trail, undo only today', async () => {
      const m0 = (await app.get('/api/motivation', token)).body;
      assert.equal(m0.points.balance, 20);
      const brunch = m0.rewards.find((r: any) => r.name === 'Brunch at the coffee shop');
      assert.equal(brunch.ready, false);
      assert.equal(brunch.shortBy, 80);
      const refused = await app.post(`/api/rewards/${brunch.id}/claim`, undefined, token);
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /80 more/);
      assert.equal(refused.body.balance, 20);

      // A cheap reward the balance covers
      const snack = (await app.post('/api/rewards', { name: 'Fancy pastry', cost: 15, note: '~$5' }, token)).body;
      const m1 = (await app.get('/api/motivation', token)).body;
      assert.equal(m1.rewards[0].name, 'Fancy pastry', 'list sorted by cost');
      assert.equal(m1.rewards[0].ready, true);
      assert.equal(m1.points.rewardsAvailable, 1);
      assert.equal(m1.points.nextReward.name, 'Brunch at the coffee shop');
      assert.equal(m1.points.progress, 0.2);

      const claimed = await app.post(`/api/rewards/${snack.id}/claim`, undefined, token);
      assert.equal(claimed.status, 201);
      assert.equal(claimed.body.claim.date, TEST_TODAY);
      assert.equal(claimed.body.claim.name, 'Fancy pastry');
      assert.equal(claimed.body.balance, 5);
      const m2 = (await app.get('/api/motivation', token)).body;
      assert.equal(m2.points.spent, 15);
      assert.equal(m2.points.balance, 5);
      assert.equal(m2.claims.length, 1);
      assert.equal(m2.ledger[0].kind, 'reward');
      assert.equal(m2.ledger[0].points, -15);
      assert.equal(m2.ledger[0].balance, 5);
      assert.match(m2.ledger[0].title, /Fancy pastry/);
      assert.equal(m2.badges.find((b: any) => b.id === 'treat').unlockedOn, TEST_TODAY, 'first claim unlocks Treat yourself');
      assert.match(m2.ledger[1].title, /Badge: Treat yourself/);
      assert.equal(m2.fi, null, 'a few days of data is not enough history to judge FI progress');
      assert.ok(m2.badges.every((b: any) => !b.id.startsWith('fi-') || b.unlockedOn === null), 'no FI badges on thin data');
      assert.equal(m2.rewards[0].timesClaimed, 1);
      assert.equal(m2.rewards[0].ready, false, 'cannot afford it twice');

      // Deleting the reward keeps the claim in the trail
      await app.del(`/api/rewards/${snack.id}`, token);
      const m3 = (await app.get('/api/motivation', token)).body;
      assert.equal(m3.points.spent, 15);
      assert.equal(m3.ledger[0].kind, 'reward');
      assert.equal(m3.ledger[1].kind, 'milestone');

      // Undo: only today's claims, only the owner's
      const other = (await app.register('carol', 'pw')).token;
      assert.equal((await app.del(`/api/rewards/claims/${claimed.body.claim.id}`, other)).status, 404);
      assert.equal((await app.del(`/api/rewards/claims/${claimed.body.claim.id}`, token)).status, 200);
      assert.equal((await app.get('/api/motivation', token)).body.points.balance, 20);
      db.createRewardClaim({ userId: (await app.get('/api/habits', token)).body[0].userId, rewardId: 'x', name: 'Yesterday', cost: 5, note: '', date: '2026-10-24' });
      const old = (await app.get('/api/motivation', token)).body.claims[0];
      const undo = await app.del(`/api/rewards/claims/${old.id}`, token);
      assert.equal(undo.status, 400);
      assert.match(undo.body.error, /today/);
      db.deleteRewardClaim(old.id);
    });

    test('habits are private to their owner', async () => {
      const other = (await app.register('bob', 'pw')).token;
      const mine = (await app.get('/api/habits', token)).body[0];
      assert.equal((await app.get('/api/habits', other)).body.length, 0);
      assert.equal((await app.put(`/api/habits/${mine.id}`, { amount: 1 }, other)).status, 404);
      assert.equal((await app.del(`/api/habits/${mine.id}`, other)).status, 404);
      assert.equal((await app.post('/api/habits', { kind: 'save', amount: 1, accountId: savings }, other)).status, 400, 'cannot pin someone else\'s account');
    });

    test('deleting a pinned account unpins the habit instead of breaking it', async () => {
      const mine = (await app.get('/api/habits', token)).body[0];
      await app.put(`/api/habits/${mine.id}`, { accountId: savings }, token);
      await app.del(`/api/accounts/${savings}`, token);
      const after = (await app.get('/api/habits', token)).body.find((h: any) => h.id === mine.id);
      assert.equal(after.accountId, undefined);
      assert.equal((await app.get('/api/motivation', token)).status, 200);
    });
  });

  describe('FI milestones are observed live from the simulator', () => {
    test('a user with a year of history crosses rungs as their FI progress changes', async () => {
      const token = (await app.register('dave', 'pw')).token;
      const chk = (await app.post('/api/accounts', { name: 'Chk', type: 'checking', balance: 0 }, token)).body.id;
      // The 12 complete months before October 2026 at 4,000 income / 2,000 spending → FI number = 24,000 / 0.04 = 600,000;
      // the balance ends at 26,000 → 4.3%
      for (const ym of ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
        await app.post('/api/transactions', { accountId: chk, type: 'income', amount: 4000, category: 'Salary', date: `${ym}-01` }, token);
        await app.post('/api/transactions', { accountId: chk, type: 'expense', amount: 2000, category: 'Housing', date: `${ym}-02` }, token);
      }
      await app.post('/api/transactions', { accountId: chk, type: 'income', amount: 4000, category: 'Salary', date: '2026-10-01' }, token);
      await app.post('/api/transactions', { accountId: chk, type: 'expense', amount: 2000, category: 'Housing', date: '2026-10-02' }, token);
      let m = (await app.get('/api/motivation', token)).body;
      assert.ok(m.fi, 'enough history now');
      assert.ok(m.fi.progress > 0.04 && m.fi.progress < 0.05, `progress ${m.fi.progress}`);
      assert.equal(m.badges.find((b: any) => b.id === 'fi-5').unlockedOn, null);
      const stored = db.getMilestones((await app.get('/api/habits', token)).body.userId ?? db.getUserByUsername('dave')!.id);
      assert.deepEqual(stored.map(x => x.kind), ['fi-date'], 'the first sighting of an FI date is recorded as a baseline (no badge)');
      assert.equal(m.badges.find((b: any) => b.id === 'closer').unlockedOn, null);

      // A windfall lifts investable assets above 5% and 10% of the FI number
      await app.put(`/api/accounts/${chk}`, { balance: 80000 }, token);
      m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.badges.find((b: any) => b.id === 'fi-5').unlockedOn, TEST_TODAY);
      assert.equal(m.badges.find((b: any) => b.id === 'fi-10').unlockedOn, TEST_TODAY);
      assert.equal(m.badges.find((b: any) => b.id === 'fi-25').unlockedOn, null);
      assert.equal(m.ledger.filter((e: any) => e.kind === 'milestone').length, 2);
      // Recorded once: a second call adds nothing, and going back down does not take the badge away
      await app.put(`/api/accounts/${chk}`, { balance: 20000 }, token);
      m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.badges.find((b: any) => b.id === 'fi-10').unlockedOn, TEST_TODAY, 'badges are kept');
      assert.equal(db.getMilestones(db.getUserByUsername('dave')!.id).length, 3);
    });
  });

  describe('fin (seeded)', () => {
    let token: string;
    before(async () => {
      await seedFin(db);
      token = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
    });

    test('three habits with a trail back to January 2026', async () => {
      const habits = (await app.get('/api/habits', token)).body;
      assert.equal(habits.length, 3);
      const m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.enabled, true);
      assert.deepEqual(m.habits.map((h: any) => h.name), ['Monthly saving', 'Monthly investing', 'Eating-out swap']);
      const [save, invest, swap] = m.habits;
      assert.equal(save.periodsMet, 10, 'Jan–Oct, saved on the 5th every month');
      assert.equal(save.streak, 10);
      assert.equal(save.pointsEarned, 3 * 25 + 7 * 50, 'bonus from the fourth month');
      assert.equal(save.current.scoredOn, '2026-10-05');
      assert.equal(invest.pointsEarned, 425);
      assert.equal(swap.amount, FIN_FOOD_CAP);
      assert.ok(swap.periodsMet > 15 && swap.periodsMet < swap.periodsScored, `eating-out cap is hit-and-miss (${swap.periodsMet}/${swap.periodsScored})`);
      assert.equal(swap.current.completed, false);
      assert.equal(m.points.earned, 850 + swap.pointsEarned);
      // Four reward tiers, four claims (700 points enjoyed) → 295 left: brunch and dinner are ready, the bar fills towards the family dinner
      assert.deepEqual(m.rewards.map((r: any) => [r.name, r.cost, r.ready, r.timesClaimed]), [
        ['Brunch at the coffee shop', 100, true, 2], ['Dinner for two', 250, true, 2], ['Family dinner out', 500, false, 0], ['Weekend away', 1000, false, 0],
      ]);
      assert.equal(m.points.spent, 700);
      assert.equal(m.points.balance, 295);
      assert.equal(m.points.nextReward.name, 'Family dinner out');
      assert.equal(m.points.toNextReward, 205);
      assert.equal(m.points.progress, 0.59);
      assert.equal(m.points.rewardsAvailable, 2);
      assert.equal(m.claims.length, 4);
      assert.equal(m.claims[0].date, '2026-09-05');
      assert.deepEqual(m.nudge && [m.nudge.name, m.nudge.since, m.nudge.days], ['Brunch at the coffee shop', '2026-09-05', 50], 'affordable for 50 days without a claim → nudge');
      const lisbonDinner = m.ledger.find((e: any) => e.kind === 'reward' && e.date === '2026-07-10');
      assert.ok(lisbonDinner, 'dinner for two claimed in Lisbon');
      assert.ok([...m.ledger].reverse().every((e: any) => e.balance >= 0), 'the running balance never goes negative');
      // Badges: derived ones from the trail, FI ones from the seeded milestones
      const unlocked = Object.fromEntries(m.badges.filter((b: any) => b.unlockedOn).map((b: any) => [b.id, b.unlockedOn]));
      assert.deepEqual(unlocked, {
        'first-step': '2026-01-05', century: '2026-02-05',
        'on-fire': '2026-03-15', treat: '2026-03-07',
        'fi-5': '2025-11-20', closer: '2026-07-25',
      }, 'Thousand (995 earned) and Unstoppable (best streak 10) are still locked — something to aim for');
      assert.match(m.badges.find((b: any) => b.id === 'on-fire').detail, /4 in a row · Eating-out swap/);
      assert.match(m.badges.find((b: any) => b.id === 'closer').detail, /moved 4 months earlier/);
      assert.equal(m.badges.find((b: any) => b.id === 'fi-10').unlockedOn, null);
      assert.equal(m.fi.fiDate, '2043-05');
      assert.ok(m.fi.progress > 0.08 && m.fi.progress < 0.1);
      // The Lisbon holiday week (12 Jul) is a miss in the trail
      const lisbon = m.ledger.find((e: any) => e.kind === 'miss' && e.periodKey === '2026-07-06');
      assert.ok(lisbon, 'holiday dining breaks the streak');
      assert.match(lisbon.detail, /over the \$175 cap/);
      assert.equal(m.ledger.filter((e: any) => e.kind !== 'milestone').pop().date >= '2026-01-05', true, 'nothing before the start');
      assert.equal(m.ledger[0].balance, m.points.balance, 'newest entry carries the running total');
      assert.equal(m.suggestions.monthlySaving, 900);
      assert.equal(m.suggestions.monthlyInvesting, 1200);
    });
  });
});
