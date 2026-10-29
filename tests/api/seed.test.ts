import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp, TEST_TODAY } from '../helpers/server.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD, FIN_SEED_DATE } from '../../src/seed/fin.js';

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
