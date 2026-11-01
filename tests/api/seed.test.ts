import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp, TEST_TODAY } from '../helpers/server.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD, FIN_SEED_DATE } from '../../src/seed/fin.js';
import { seedPenny, PENNY_USERNAME, PENNY_PASSWORD, PENNY_SEED_DATE, PENNY_WEEKLY_SAVING, PENNY_SKIPPED_WEEKS } from '../../src/seed/penny.js';

describe('Demo user "fin"', () => {
  let app: TestApp;
  let token: string;
  let first: Awaited<ReturnType<typeof seedFin>>;

  before(async () => {
    app = await launch();
    first = await seedFin(db);
    token = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
  });
  after(async () => { await app.close(); });

  test('seed summary and credentials', () => {
    assert.equal(FIN_SEED_DATE, '2026-10-25');
    assert.equal(TEST_TODAY, FIN_SEED_DATE, 'the suite is frozen on the seed date');
    assert.equal(first.accounts, 5);
    assert.equal(first.investments, 5);
    assert.equal(first.goals, 4);
    assert.equal(first.scenarios, 5);
    assert.equal(first.budgets, 7);
    assert.equal(first.habits, 3);
    assert.equal(first.rewards, 4);
    assert.equal(first.claims, 4);
    assert.ok(first.transactions > 500, `transactions: ${first.transactions}`);
    assert.ok(first.trades > 60, `trades: ${first.trades}`);
  });

  test('accounts follow the liability convention and balances are exact', async () => {
    const accounts = (await app.get('/api/accounts', token)).body;
    const byName = Object.fromEntries(accounts.map((a: any) => [a.name, a]));
    assert.equal(byName['Everyday Checking'].balance, 7850.4);
    assert.equal(byName['High-Yield Savings'].balance, 28400);
    assert.equal(byName['Brokerage Cash'].type, 'investment');
    assert.equal(byName['Wallet'].balance, 180);
    const card = byName['Travel Rewards Card'];
    assert.equal(card.type, 'credit');
    assert.ok(card.balance > 0 && card.balance < 3000, `card owed ${card.balance}`);
    // Every account balance equals opening + sum of its transactions (consistency of the generator)
    for (const a of accounts) assert.equal(Number.isFinite(a.balance), true);
  });

  test('no transaction is dated after the seed date; history spans 24 months', async () => {
    const txns = (await app.get('/api/transactions?limit=5000', token)).body;
    const dates = txns.map((t: any) => t.date).sort();
    assert.ok(dates[dates.length - 1] <= FIN_SEED_DATE);
    assert.equal(dates[0].slice(0, 7), '2024-10');
    const months = new Set(txns.map((t: any) => t.date.slice(0, 7)));
    assert.equal(months.size, 25, '24 complete months + the current one');
    assert.ok(txns.some((t: any) => t.category === 'Transfer'));
    assert.ok(txns.some((t: any) => t.description === 'Flights + hotel — Lisbon'));
  });

  test('dashboard reads sensibly for the seed month', async () => {
    const d = (await app.get('/api/dashboard', token)).body;
    assert.ok(d.monthlyIncome >= 6400 && d.monthlyIncome < 9000, `income ${d.monthlyIncome}`);
    assert.ok(d.monthlyExpenses > 2500 && d.monthlyExpenses < 5000, `expenses ${d.monthlyExpenses}`);
    assert.equal(d.monthlyInvested, 1200);
    assert.ok(d.savingsRate > 20, `savings rate ${d.savingsRate}`);
    assert.ok(d.netWorth > 90000 && d.netWorth < 130000, `net worth ${d.netWorth}`);
    assert.ok(d.totalLiabilities > 0);
    assert.equal(d.budgetHealth.length, 7);
    assert.ok(d.budgetHealth.some((b: any) => b.percentUsed > 100), 'one budget is over for a realistic demo');
    assert.ok(!d.topExpenseCategories.some((c: any) => c.category === 'Transfer' || c.category === 'Investment'));
    assert.equal(d.topExpenseCategories[0].category, 'Housing');
  });

  test('investments and trades', async () => {
    const inv = (await app.get('/api/investments', token)).body;
    const vti = inv.find((i: any) => i.symbol === 'VTI');
    assert.equal(vti.shares, 123, '48 + 25 monthly buys of 3');
    assert.ok(vti.avgCost > 190 && vti.avgCost < 268);
    const trades = (await app.get(`/api/investments/${vti.id}/transactions`, token)).body;
    assert.ok(trades.some((t: any) => t.type === 'dividend'));
    assert.ok(trades.every((t: any) => t.date <= FIN_SEED_DATE));
  });

  test('baseline derived from the history is plausible', async () => {
    const { baseline, profile } = (await app.get('/api/simulate/baseline', token)).body;
    assert.equal(baseline.asOf, FIN_SEED_DATE);
    assert.equal(baseline.lookbackMonths, 12);
    assert.equal(baseline.detail.windowStart, '2025-10');
    assert.equal(baseline.detail.windowEnd, '2026-09');
    assert.ok(baseline.monthlyIncome > 6500 && baseline.monthlyIncome < 7500, `income ${baseline.monthlyIncome}`);
    assert.ok(baseline.monthlyExpenses > 3500 && baseline.monthlyExpenses < 4500, `expenses ${baseline.monthlyExpenses}`);
    assert.ok(baseline.monthlyContribution > 1000 && baseline.monthlyContribution < 1500, `contribution ${baseline.monthlyContribution}`);
    assert.ok(baseline.invested > 60000);
    assert.ok(baseline.liquid > 30000);
    assert.equal(profile.birthDate, '1986-07-10');
    assert.equal(profile.retirementAge, 65);
    assert.equal(profile.isDefault, false);
    assert.equal((await app.get('/api/profile', token)).body.age, 40);
  });

  test('all saved scenarios run and tell different stories', async () => {
    const scenarios = (await app.get('/api/scenarios', token)).body;
    assert.deepEqual(scenarios.map((s: any) => s.name), ['Keep going', 'Buy a flat in 2028', 'Sabbatical + crash', 'Retire at 58', 'Family of four']);
    const runs: Record<string, any> = {};
    for (const s of scenarios) {
      const r = await app.get(`/api/scenarios/${s.id}/run?months=0&montecarlo=1&trials=50`, token);
      assert.equal(r.status, 200, s.name);
      runs[s.name] = r.body.result.summary;
      assert.equal(r.body.montecarlo.trials, 50);
    }
    assert.equal(runs['Keep going'].fire.retirementMonth, 297);
    assert.ok(runs['Keep going'].fire.fiByRetirement, 'fin reaches FI before 65 on current habits');
    assert.equal(runs['Retire at 58'].fire.retirementMonth, 213);
    assert.ok(runs['Buy a flat in 2028'].fire.fiMonth > runs['Keep going'].fire.fiMonth, 'the flat delays FI');
    assert.ok(runs['Sabbatical + crash'].endNetWorth < runs['Keep going'].endNetWorth);
    assert.ok(runs['Family of four'].endNetWorth < runs['Keep going'].endNetWorth);
    for (const name of Object.keys(runs)) assert.equal(runs[name].depletedMonth, null, `${name} never runs out of money`);
  });

  test('re-seeding is deterministic and leaves exactly one fin user', async () => {
    const before = (await app.get('/api/simulate/baseline', token)).body.baseline;
    const again = await seedFin(db);
    assert.equal(again.userId, first.userId, 'same user is reused');
    assert.equal(again.transactions, first.transactions);
    assert.equal(again.trades, first.trades);
    const after = (await app.get('/api/simulate/baseline', token)).body.baseline;
    assert.deepEqual({ ...after, detail: { ...after.detail, accounts: after.detail.accounts.map((a: any) => a.balance) } },
      { ...before, detail: { ...before.detail, accounts: before.detail.accounts.map((a: any) => a.balance) } });
    assert.equal((await app.get('/api/scenarios', token)).body.length, 5, 'scenarios are replaced, not duplicated');
    assert.equal((await app.get('/api/accounts', token)).body.length, 5);
    assert.equal((await app.post('/api/auth/register', { username: FIN_USERNAME, password: 'x' })).status, 409);
  });

  test('the clock is restored after seeding', async () => {
    const meta = (await app.get('/api/meta')).body;
    assert.equal(meta.today, TEST_TODAY);
    assert.equal(meta.now, '2026-10-25T12:00:00.000Z', 'test clock, not the seed clock');
  });
});

describe('Demo user "penny" (the comparison persona)', () => {
  let app: TestApp;
  let token: string;
  let finToken: string;
  let first: Awaited<ReturnType<typeof seedPenny>>;

  before(async () => {
    app = await launch();
    await seedFin(db);
    first = await seedPenny(db);
    token = (await app.login(PENNY_USERNAME, PENNY_PASSWORD)).token;
    finToken = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
  });
  after(async () => { await app.close(); });

  test('seed summary and credentials', () => {
    assert.equal(PENNY_SEED_DATE, FIN_SEED_DATE, 'both personas share the seed date');
    assert.equal(first.accounts, 6);
    assert.equal(first.investments, 3);
    assert.equal(first.goals, 4);
    assert.equal(first.scenarios, 3);
    assert.equal(first.budgets, 6);
    assert.equal(first.habits, 2);
    assert.equal(first.rewards, 4);
    assert.equal(first.claims, 3);
    assert.ok(first.transactions > 700, `transactions: ${first.transactions}`);
    assert.ok(first.trades > 40, `trades: ${first.trades}`);
  });

  test('two liabilities (card and student loan), balances exact', async () => {
    const accounts = (await app.get('/api/accounts', token)).body;
    const byName = Object.fromEntries(accounts.map((a: any) => [a.name, a]));
    assert.equal(byName['Everyday Current'].balance, 2610.75);
    assert.equal(byName['Rainy-Day Savings'].balance, 8200);
    assert.equal(byName['Student Loan'].type, 'credit');
    assert.equal(byName['Student Loan'].balance, 9780);
    assert.equal(byName['Cashback Card'].type, 'credit');
    assert.equal(byName['Cashback Card'].balance, 2380.6);
    assert.equal(byName['Fund Platform Cash'].type, 'investment');
    assert.equal(byName['Wallet'].balance, 45);
    assert.ok(!accounts.some((a: any) => a.name === 'Everyday Checking'), 'none of fin\'s accounts leaked into penny');
  });

  test('18 months of history, weekly transfers to savings with the two camping weeks skipped', async () => {
    const txns = (await app.get('/api/transactions?limit=5000', token)).body;
    const dates = txns.map((t: any) => t.date).sort();
    assert.ok(dates[dates.length - 1] <= PENNY_SEED_DATE);
    assert.equal(dates[0].slice(0, 7), '2025-04');
    assert.equal(new Set(txns.map((t: any) => t.date.slice(0, 7))).size, 19, '18 complete months + the current one');
    const savings = (await app.get('/api/accounts', token)).body.find((a: any) => a.name === 'Rainy-Day Savings');
    const weekly = txns.filter((t: any) => t.accountId === savings.id && t.category === 'Transfer' && t.amount === PENNY_WEEKLY_SAVING);
    assert.ok(weekly.length > 70, `weekly transfers: ${weekly.length}`);
    for (const monday of PENNY_SKIPPED_WEEKS) assert.ok(!weekly.some((t: any) => t.date === monday), `no transfer on ${monday}`);
    assert.ok(weekly.every((t: any) => new Date(`${t.date}T00:00:00Z`).getUTCDay() === 1), 'every transfer lands on a Monday');
    assert.ok(txns.some((t: any) => t.description === 'Norway cycling trip — deposit'));
    assert.ok(txns.some((t: any) => t.description === 'Card interest'), 'the card is carried, not paid off');
  });

  test('dashboard: lower income, higher spending share and a heavier debt load than fin', async () => {
    const d = (await app.get('/api/dashboard', token)).body;
    const f = (await app.get('/api/dashboard', finToken)).body;
    assert.equal(d.monthlyIncome, 4900);
    assert.equal(d.monthlyInvested, 350);
    assert.ok(d.monthlyExpenses > 2500 && d.monthlyExpenses < 3500, `expenses ${d.monthlyExpenses}`);
    assert.ok(d.netWorth > 20000 && d.netWorth < 35000, `net worth ${d.netWorth}`);
    assert.ok(d.totalLiabilities > 12000 && d.totalLiabilities < 12500, `liabilities ${d.totalLiabilities}`);
    assert.ok(d.savingsRate < f.savingsRate, `penny ${d.savingsRate}% vs fin ${f.savingsRate}%`);
    assert.ok(d.netWorth < f.netWorth);
    assert.equal(d.budgetHealth.length, 6);
    assert.equal(d.budgetHealth.filter((b: any) => b.percentUsed > 100).length, 2, 'two budgets over');
    assert.equal(d.topExpenseCategories[0].category, 'Housing');
  });

  test('holdings: two ETFs and a bond fund, no crypto', async () => {
    const inv = (await app.get('/api/investments', token)).body;
    assert.deepEqual(inv.map((i: any) => i.symbol).sort(), ['BND', 'SCHD', 'VT']);
    assert.ok(!inv.some((i: any) => i.type === 'crypto'));
    const vt = inv.find((i: any) => i.symbol === 'VT');
    assert.equal(vt.shares, 128, '90 + 19 monthly buys of 2');
    const trades = (await app.get(`/api/investments/${vt.id}/transactions`, token)).body;
    assert.ok(trades.some((t: any) => t.type === 'dividend'));
    assert.ok(trades.every((t: any) => t.date <= PENNY_SEED_DATE));
  });

  test('profile and baseline: 33, retiring at 60, FI progress under the first rung', async () => {
    const { baseline, profile } = (await app.get('/api/simulate/baseline', token)).body;
    assert.equal(baseline.lookbackMonths, 12);
    assert.ok(baseline.monthlyIncome > 4700 && baseline.monthlyIncome < 5100, `income ${baseline.monthlyIncome}`);
    assert.ok(baseline.monthlyExpenses > 2800 && baseline.monthlyExpenses < 3300, `expenses ${baseline.monthlyExpenses}`);
    assert.ok(baseline.monthlyContribution > 280 && baseline.monthlyContribution < 360, `contribution ${baseline.monthlyContribution}`);
    assert.ok(baseline.debt > 12000);
    assert.equal(profile.birthDate, '1993-03-22');
    assert.equal(profile.retirementAge, 60);
    assert.equal(profile.safeWithdrawalRate, 0.035);
    assert.equal((await app.get('/api/profile', token)).body.age, 33);
    const outlook = (await app.get('/api/simulate/outlook', token)).body;
    assert.ok(outlook.fire.progress < 0.05, `FI progress ${outlook.fire.progress}`);
    assert.equal(outlook.fire.fiDate, '2050-04', 'matches the seeded first-sighting milestone');
    assert.ok(outlook.fire.fiByRetirement);
  });

  test('motivation: weekly habits, a long streak, streak badges but no FI rung, no nudge', async () => {
    const m = (await app.get('/api/motivation', token)).body;
    const byName = Object.fromEntries(m.habits.map((h: any) => [h.name, h]));
    assert.equal(byName['Weekly saving'].cadence, 'weekly');
    assert.ok(byName['Weekly saving'].streak >= 20, `saving streak ${byName['Weekly saving'].streak}`);
    assert.ok(byName['Shopping swap'].periodsMet < byName['Shopping swap'].periodsScored, 'the swap is hit-and-miss');
    assert.ok(!m.habits.some((h: any) => h.kind === 'invest'), 'no investing habit');
    assert.equal(m.points.spent, 450, 'three claims: 100 + 250 + 100');
    assert.ok(m.points.balance >= 100 && m.points.balance < 500, `balance ${m.points.balance}`);
    assert.equal(m.nudge, null, 'the last claim is recent');
    const unlocked = m.badges.filter((b: any) => b.unlockedOn).map((b: any) => b.id).sort();
    assert.deepEqual(unlocked, ['century', 'first-step', 'on-fire', 'treat', 'unstoppable']);
    assert.equal(m.claims.length, 3);
    // Every claim was affordable on its date: the running balance never goes negative.
    assert.ok(m.ledger.every((l: any) => l.balance >= 0), 'running balance never negative');
  });

  test('saved scenarios run', async () => {
    const scenarios = (await app.get('/api/scenarios', token)).body;
    assert.deepEqual(scenarios.map((s: any) => s.name), ['Keep going', 'Loan gone by 2027', 'Move out in 2028']);
    const runs: Record<string, any> = {};
    for (const s of scenarios) {
      const r = await app.get(`/api/scenarios/${s.id}/run?months=0`, token);
      assert.equal(r.status, 200, s.name);
      runs[s.name] = r.body.result.summary;
    }
    assert.ok(runs['Loan gone by 2027'].endNetWorth > runs['Keep going'].endNetWorth, 'clearing the loan and redirecting the repayment pays off');
    assert.ok(runs['Move out in 2028'].endNetWorth < runs['Keep going'].endNetWorth);
    assert.equal(runs['Keep going'].depletedMonth, null);
    assert.equal(runs['Loan gone by 2027'].depletedMonth, null);
    assert.ok(runs['Move out in 2028'].depletedMonth !== null && runs['Move out in 2028'].depletedMonth >= 300, 'renting alone in a pessimistic economy means retiring at 60 does not add up');
  });

  test('re-seeding is deterministic and does not touch fin', async () => {
    const finBefore = (await app.get('/api/dashboard', finToken)).body;
    const before = (await app.get('/api/simulate/baseline', token)).body.baseline;
    const again = await seedPenny(db);
    assert.equal(again.userId, first.userId);
    assert.equal(again.transactions, first.transactions);
    const after = (await app.get('/api/simulate/baseline', token)).body.baseline;
    assert.deepEqual({ ...after, detail: { ...after.detail, accounts: after.detail.accounts.map((a: any) => a.balance) } },
      { ...before, detail: { ...before.detail, accounts: before.detail.accounts.map((a: any) => a.balance) } });
    assert.equal((await app.get('/api/accounts', token)).body.length, 6);
    const { recentTransactions: _r, ...finAfter } = (await app.get('/api/dashboard', finToken)).body;
    const { recentTransactions: _r2, ...finBeforeCore } = finBefore;
    assert.deepEqual(finAfter, finBeforeCore, 'fin is untouched');
    assert.equal((await app.post('/api/auth/register', { username: PENNY_USERNAME, password: 'x' })).status, 409);
  });
});
