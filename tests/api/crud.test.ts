import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp, TEST_TODAY } from '../helpers/server.js';

/**
 * Regression coverage for the pre-existing CRUD surface. Each block is
 * independent (own user) so ordering inside `describe` doesn't matter.
 */
describe('API: CRUD', () => {
  let app: TestApp;
  before(async () => { app = await launch(); });
  after(async () => { await app.close(); });

  describe('accounts', () => {
    let token: string;
    before(async () => { token = (await app.register('acc-user', 'pw')).token; });

    test('create / read / update / delete', async () => {
      const missing = await app.post('/api/accounts', { name: 'NoType' }, token);
      assert.equal(missing.status, 400);

      const created = await app.post('/api/accounts', { name: 'Checking', type: 'checking', balance: 1500 }, token);
      assert.equal(created.status, 201);
      assert.equal(created.body.currency, 'USD', 'defaults currency');
      assert.equal(created.body.createdAt, '2026-10-25T12:00:00.000Z', 'createdAt from frozen clock');
      const id = created.body.id;

      const one = await app.get(`/api/accounts/${id}`, token);
      assert.equal(one.status, 200);
      assert.equal(one.body.name, 'Checking');

      const upd = await app.put(`/api/accounts/${id}`, { name: 'Main Checking', balance: 1600 }, token);
      assert.equal(upd.status, 200);
      assert.equal(upd.body.name, 'Main Checking');
      assert.equal(upd.body.balance, 1600);

      const list = await app.get('/api/accounts', token);
      assert.equal(list.body.length, 1);

      assert.equal((await app.del(`/api/accounts/${id}`, token)).status, 200);
      assert.equal((await app.del(`/api/accounts/${id}`, token)).status, 404);
      assert.equal((await app.get(`/api/accounts/${id}`, token)).status, 404);
      assert.equal((await app.put(`/api/accounts/${id}`, { name: 'x' }, token)).status, 404);
    });
  });

  describe('transactions', () => {
    let token: string;
    let accountId: string;
    before(async () => {
      token = (await app.register('txn-user', 'pw')).token;
      accountId = (await app.post('/api/accounts', { name: 'Chk', type: 'checking', balance: 1000 }, token)).body.id;
    });

    test('create adjusts balance, defaults date to frozen today, filters work, delete restores', async () => {
      assert.equal((await app.post('/api/transactions', { accountId, type: 'expense' }, token)).status, 400);

      const exp = await app.post('/api/transactions', { accountId, type: 'expense', amount: 45.5, category: 'Food & Dining', description: 'Lunch' }, token);
      assert.equal(exp.status, 201);
      assert.equal(exp.body.date, TEST_TODAY);
      assert.deepEqual(exp.body.tags, []);

      const inc = await app.post('/api/transactions', { accountId, type: 'income', amount: 2000, category: 'Salary', date: '2026-10-01' }, token);
      assert.equal(inc.status, 201);

      const acc = await app.get(`/api/accounts/${accountId}`, token);
      assert.equal(acc.body.balance, 1000 - 45.5 + 2000);

      const all = await app.get('/api/transactions', token);
      assert.equal(all.body.length, 2);
      assert.equal(all.body[0].id, exp.body.id, 'newest first');

      const byCat = await app.get('/api/transactions?category=Salary', token);
      assert.equal(byCat.body.length, 1);
      const byDate = await app.get('/api/transactions?from=2026-10-01&to=2026-10-01', token);
      assert.equal(byDate.body.length, 1);
      const limited = await app.get('/api/transactions?limit=1', token);
      assert.equal(limited.body.length, 1);
      const byAcc = await app.get(`/api/transactions?accountId=${accountId}`, token);
      assert.equal(byAcc.body.length, 2);

      assert.equal((await app.del(`/api/transactions/${exp.body.id}`, token)).status, 200);
      assert.equal((await app.del(`/api/transactions/${exp.body.id}`, token)).status, 404);
      assert.equal((await app.get(`/api/accounts/${accountId}`, token)).body.balance, 3000);
    });
  });

  describe('transaction editing (PUT)', () => {
    let token: string;
    let otherToken: string;
    let chk: string;
    let card: string;
    before(async () => {
      token = (await app.register('edit-user', 'pw')).token;
      otherToken = (await app.register('edit-other', 'pw')).token;
      chk = (await app.post('/api/accounts', { name: 'Chk', type: 'checking', balance: 1000 }, token)).body.id;
      card = (await app.post('/api/accounts', { name: 'Card', type: 'credit', balance: 100 }, token)).body.id;
    });

    test('validates input and ownership', async () => {
      const t = (await app.post('/api/transactions', { accountId: chk, type: 'expense', amount: 50, category: 'Other', date: '2026-10-01' }, token)).body;
      assert.equal((await app.put(`/api/transactions/${t.id}`, { amount: 1 }, otherToken)).status, 404, 'other users cannot see it');
      assert.equal((await app.put('/api/transactions/nope', { amount: 1 }, token)).status, 404);
      assert.equal((await app.put(`/api/transactions/${t.id}`, { amount: -3 }, token)).status, 400);
      assert.equal((await app.put(`/api/transactions/${t.id}`, { amount: 'abc' }, token)).status, 400);
      assert.equal((await app.put(`/api/transactions/${t.id}`, { type: 'transfer' }, token)).status, 400);
      assert.equal((await app.put(`/api/transactions/${t.id}`, { category: 'Not a category' }, token)).status, 400);
      assert.equal((await app.put(`/api/transactions/${t.id}`, { date: '01/10/2026' }, token)).status, 400);
      assert.equal((await app.put(`/api/transactions/${t.id}`, { date: '2026-13-45' }, token)).status, 400);
      assert.equal((await app.put(`/api/transactions/${t.id}`, { tags: 'x' }, token)).status, 400);
      const otherAcc = (await app.post('/api/accounts', { name: 'Theirs', type: 'checking' }, otherToken)).body.id;
      assert.equal((await app.put(`/api/transactions/${t.id}`, { accountId: otherAcc }, token)).status, 400, 'cannot move onto another user\'s account');
      assert.equal((await app.get(`/api/accounts/${chk}`, token)).body.balance, 950, 'nothing changed');
      await app.del(`/api/transactions/${t.id}`, token);
    });

    test('re-categorising an imported Uncategorized row and moving between accounts keeps balances and budgets right', async () => {
      await app.post('/api/budgets', { category: 'Food & Dining', amount: 300 }, token);
      await app.post('/api/budgets', { category: 'Shopping', amount: 300 }, token);
      const t = (await app.post('/api/transactions', { accountId: chk, type: 'expense', amount: 40, category: 'Uncategorized', description: 'TESCO', date: '2026-10-03' }, token)).body;
      assert.equal(t.category, 'Uncategorized');

      const r1 = await app.put(`/api/transactions/${t.id}`, { category: 'Food & Dining', description: 'Tesco groceries' }, token);
      assert.equal(r1.status, 200);
      assert.equal(r1.body.category, 'Food & Dining');
      assert.equal(r1.body.description, 'Tesco groceries');
      let budgets = (await app.get('/api/budgets', token)).body;
      assert.equal(budgets.find((b: any) => b.category === 'Food & Dining').spent, 40);

      // change category + amount + move onto the credit card in one go
      const r2 = await app.put(`/api/transactions/${t.id}`, { category: 'Shopping', amount: 60, accountId: card }, token);
      assert.equal(r2.status, 200);
      budgets = (await app.get('/api/budgets', token)).body;
      assert.equal(budgets.find((b: any) => b.category === 'Food & Dining').spent, 0, 'old budget released');
      assert.equal(budgets.find((b: any) => b.category === 'Shopping').spent, 60, 'new budget charged');
      assert.equal((await app.get(`/api/accounts/${chk}`, token)).body.balance, 1000, 'checking restored');
      assert.equal((await app.get(`/api/accounts/${card}`, token)).body.balance, 160, 'card owes 100 + 60');

      // moving the date out of the budget month releases it too
      await app.put(`/api/transactions/${t.id}`, { date: '2026-09-30' }, token);
      budgets = (await app.get('/api/budgets', token)).body;
      assert.equal(budgets.find((b: any) => b.category === 'Shopping').spent, 0);

      const list = await app.get(`/api/transactions?accountId=${card}`, token);
      assert.equal(list.body.length, 1);
      assert.equal(list.body[0].date, '2026-09-30');
      assert.equal((await app.get('/api/transactions?batchId=none', token)).body.length, 0, 'batchId filter');
    });
  });

  describe('request limits', () => {
    test('oversized JSON bodies are rejected with 413', async () => {
      const token = (await app.register('big-user', 'pw')).token;
      const res = await app.post('/api/accounts', { name: 'x'.repeat(26 * 1024 * 1024), type: 'checking' }, token);
      assert.equal(res.status, 413);
      assert.match(res.body.error, /too large/);
      // the server is still healthy afterwards
      assert.equal((await app.get('/api/accounts', token)).status, 200);
    });
  });

  describe('budgets', () => {
    let token: string;
    let accountId: string;
    before(async () => {
      token = (await app.register('bud-user', 'pw')).token;
      accountId = (await app.post('/api/accounts', { name: 'Chk', type: 'checking', balance: 0 }, token)).body.id;
    });

    test('defaults to the frozen month and tracks spend from transactions', async () => {
      assert.equal((await app.post('/api/budgets', { category: 'Food & Dining' }, token)).status, 400);

      const b = await app.post('/api/budgets', { category: 'Food & Dining', amount: 500 }, token);
      assert.equal(b.status, 201);
      assert.equal(b.body.month, 9, 'October (0-based)');
      assert.equal(b.body.year, 2026);
      assert.equal(b.body.period, 'monthly');
      assert.equal(b.body.spent, 0);

      await app.post('/api/transactions', { accountId, type: 'expense', amount: 120, category: 'Food & Dining', date: '2026-10-05' }, token);
      await app.post('/api/transactions', { accountId, type: 'expense', amount: 80, category: 'Food & Dining', date: '2026-10-09' }, token);
      await app.post('/api/transactions', { accountId, type: 'expense', amount: 999, category: 'Food & Dining', date: '2026-09-09' }, token);

      const list = await app.get('/api/budgets', token);
      assert.equal(list.body[0].spent, 200);

      const upd = await app.put(`/api/budgets/${b.body.id}`, { amount: 600 }, token);
      assert.equal(upd.body.amount, 600);

      const dash = await app.get('/api/dashboard', token);
      assert.deepEqual(dash.body.budgetHealth, [{ category: 'Food & Dining', budgeted: 600, spent: 200, remaining: 400, percentUsed: 33 }]);

      assert.equal((await app.del(`/api/budgets/${b.body.id}`, token)).status, 200);
      assert.equal((await app.del(`/api/budgets/${b.body.id}`, token)).status, 404);
    });
  });

  describe('investments', () => {
    let token: string;
    before(async () => { token = (await app.register('inv-user', 'pw')).token; });

    test('holdings and trades', async () => {
      assert.equal((await app.post('/api/investments', { symbol: 'x' }, token)).status, 400);

      const inv = await app.post('/api/investments', { symbol: 'vti', name: 'Vanguard Total Market', type: 'etf', shares: 10, avgCost: 200, currentPrice: 250 }, token);
      assert.equal(inv.status, 201);
      assert.equal(inv.body.symbol, 'VTI', 'symbol upper-cased');

      const badTrade = await app.post(`/api/investments/${inv.body.id}/transactions`, { type: 'buy' }, token);
      assert.equal(badTrade.status, 400);

      const buy = await app.post(`/api/investments/${inv.body.id}/transactions`, { type: 'buy', shares: 10, pricePerShare: 300, date: '2026-10-10' }, token);
      assert.equal(buy.status, 201);
      assert.equal(buy.body.totalAmount, 3000);

      const after = (await app.get('/api/investments', token)).body[0];
      assert.equal(after.shares, 20);
      assert.equal(after.avgCost, 250);

      const trades = await app.get(`/api/investments/${inv.body.id}/transactions`, token);
      assert.equal(trades.body.length, 1);

      const upd = await app.put(`/api/investments/${inv.body.id}`, { currentPrice: 260 }, token);
      assert.equal(upd.body.currentPrice, 260);

      const dash = await app.get('/api/dashboard', token);
      assert.equal(dash.body.investmentValue, 20 * 260);

      assert.equal((await app.del(`/api/investments/${inv.body.id}`, token)).status, 200);
      assert.equal((await app.del(`/api/investments/${inv.body.id}`, token)).status, 404);
      assert.equal((await app.get(`/api/investments/${inv.body.id}/transactions`, token)).body.length, 0);
    });
  });

  describe('goals', () => {
    let token: string;
    before(async () => { token = (await app.register('goal-user', 'pw')).token; });

    test('crud + dashboard progress', async () => {
      assert.equal((await app.post('/api/goals', { name: 'x' }, token)).status, 400);

      const g = await app.post('/api/goals', { name: 'Emergency Fund', targetAmount: 15000, currentAmount: 5000, category: 'Emergency', priority: 'high', deadline: '2027-12-31' }, token);
      assert.equal(g.status, 201);
      assert.equal(g.body.priority, 'high');

      const upd = await app.put(`/api/goals/${g.body.id}`, { currentAmount: 7500 }, token);
      assert.equal(upd.body.currentAmount, 7500);

      const dash = await app.get('/api/dashboard', token);
      assert.deepEqual(dash.body.goalProgress, [{ name: 'Emergency Fund', current: 7500, target: 15000, percentage: 50 }]);

      assert.equal((await app.get('/api/goals', token)).body.length, 1);
      assert.equal((await app.del(`/api/goals/${g.body.id}`, token)).status, 200);
      assert.equal((await app.del(`/api/goals/${g.body.id}`, token)).status, 404);
    });
  });

  describe('dashboard', () => {
    test('empty user gets zeroed dashboard', async () => {
      const { token } = await app.register('empty-user', 'pw');
      const dash = await app.get('/api/dashboard', token);
      assert.equal(dash.status, 200);
      assert.deepEqual(dash.body, {
        totalBalance: 0, totalLiabilities: 0, monthlyIncome: 0, monthlyInvested: 0, monthlyExpenses: 0, netWorth: 0, investmentValue: 0,
        budgetHealth: [], recentTransactions: [], topExpenseCategories: [], savingsRate: 0, goalProgress: [],
      });
    });

    test('net worth = asset balances + investments − credit owed', async () => {
      const { token } = await app.register('nw-user', 'pw');
      await app.post('/api/accounts', { name: 'Chk', type: 'checking', balance: 5000 }, token);
      const card = await app.post('/api/accounts', { name: 'Card', type: 'credit', balance: 1200 }, token);
      await app.post('/api/investments', { symbol: 'BND', name: 'Bond ETF', shares: 100, avgCost: 70, currentPrice: 72 }, token);
      let dash = await app.get('/api/dashboard', token);
      assert.equal(dash.body.totalBalance, 5000, 'assets only');
      assert.equal(dash.body.totalLiabilities, 1200);
      assert.equal(dash.body.investmentValue, 7200);
      assert.equal(dash.body.netWorth, 5000 + 7200 - 1200);

      // Spending on the card increases what is owed; paying it off reduces it.
      await app.post('/api/transactions', { accountId: card.body.id, type: 'expense', amount: 300, category: 'Shopping' }, token);
      assert.equal((await app.get(`/api/accounts/${card.body.id}`, token)).body.balance, 1500);
      await app.post('/api/transactions', { accountId: card.body.id, type: 'income', amount: 1500, category: 'Transfer', description: 'Pay off card' }, token);
      assert.equal((await app.get(`/api/accounts/${card.body.id}`, token)).body.balance, 0);
      dash = await app.get('/api/dashboard', token);
      assert.equal(dash.body.totalLiabilities, 0);
      assert.equal(dash.body.netWorth, 5000 + 7200);
      assert.equal(dash.body.monthlyExpenses, 300, 'card purchase is still an expense');
      assert.equal(dash.body.monthlyIncome, 0, 'a card pay-off is not income');
    });
  });
});
