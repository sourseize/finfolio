import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Database, resolveDataDir, SCHEMA_VERSION, signedBalance, isLiabilityAccount, TRANSACTION_CATEGORIES, UNCATEGORIZED_CATEGORY } from '../../src/db/database.js';
import { setClock } from '../../src/util/clock.js';

describe('Database', () => {
  let dir: string;
  let db: Database;

  before(async () => {
    setClock('2026-10-25T12:00:00Z');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finfolio-db-'));
  });
  after(async () => {
    setClock(null);
    await fs.rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    db = new Database();
    await db.init(dir);
    await db.reset();
  });

  test('resolveDataDir precedence: arg > env > ./data', () => {
    const saved = process.env.FINFOLIO_DATA_DIR;
    process.env.FINFOLIO_DATA_DIR = '/tmp/from-env';
    assert.equal(resolveDataDir('/tmp/explicit'), path.resolve('/tmp/explicit'));
    assert.equal(resolveDataDir(), path.resolve('/tmp/from-env'));
    delete process.env.FINFOLIO_DATA_DIR;
    assert.equal(resolveDataDir(), path.resolve(process.cwd(), 'data'));
    if (saved !== undefined) process.env.FINFOLIO_DATA_DIR = saved;
  });

  test('init creates the file in the requested directory', async () => {
    assert.equal(db.filePath, path.join(dir, 'database.json'));
    const raw = JSON.parse(await fs.readFile(db.filePath, 'utf-8'));
    assert.deepEqual(Object.keys(raw).sort(), ['accounts', 'budgets', 'goals', 'importBatches', 'importProfiles', 'investmentTransactions', 'investments', 'profiles', 'scenarios', 'schemaVersion', 'transactions', 'users']);
  });

  test('persists and reloads data', async () => {
    const user = db.createUser('alice', 'pw')!;
    db.createAccount({ userId: user.id, name: 'Main', type: 'checking', balance: 100, currency: 'USD' });
    await db.persist();

    const db2 = new Database();
    await db2.init(dir);
    assert.equal(db2.getAccounts(user.id).length, 1);
    assert.equal(db2.authenticateUser('alice', 'pw')?.id, user.id);
    assert.equal(db2.authenticateUser('alice', 'wrong'), null);
  });

  test('tolerates a database file missing newer collections', async () => {
    await fs.writeFile(db.filePath, JSON.stringify({ users: [] }));
    const db2 = new Database();
    await db2.init(dir);
    assert.deepEqual(db2.getAccounts('x'), []);
    assert.deepEqual(db2.getGoals('x'), []);
    assert.equal(db2.schemaVersion, SCHEMA_VERSION);
  });

  test('migrates v1 data: negative credit balances become positive amounts owed', async () => {
    await fs.writeFile(db.filePath, JSON.stringify({
      users: [],
      accounts: [
        { id: 'cc', userId: 'u', name: 'Card', type: 'credit', balance: -750, currency: 'USD', createdAt: '' },
        { id: 'cc2', userId: 'u', name: 'Card 2', type: 'credit', balance: 300, currency: 'USD', createdAt: '' },
        { id: 'chk', userId: 'u', name: 'Chk', type: 'checking', balance: -20, currency: 'USD', createdAt: '' },
      ],
    }));
    const db2 = new Database();
    await db2.init(dir);
    assert.deepEqual(db2.getAccounts('u').map(a => a.balance), [750, 300, -20], 'only credit accounts are flipped');
    assert.equal(db2.schemaVersion, SCHEMA_VERSION);
    const onDisk = JSON.parse(await fs.readFile(db2.filePath, 'utf-8'));
    assert.equal(onDisk.schemaVersion, SCHEMA_VERSION, 'migration persisted');
    assert.equal(onDisk.accounts[0].balance, 750);
  });

  test('migrates v2 data: import collections appear, everything else untouched', async () => {
    await fs.writeFile(db.filePath, JSON.stringify({
      schemaVersion: 2,
      users: [],
      accounts: [{ id: 'cc', userId: 'u', name: 'Card', type: 'credit', balance: -750, currency: 'USD', createdAt: '' }],
      transactions: [{ id: 't', accountId: 'cc', userId: 'u', type: 'expense', category: 'Other', amount: 5, description: '', date: '2026-10-01', tags: [] }],
    }));
    const db2 = new Database();
    await db2.init(dir);
    assert.equal(db2.schemaVersion, 3);
    assert.equal(db2.getAccounts('u')[0].balance, -750, 'v1 fix-up is not re-applied to v2 data');
    assert.deepEqual(db2.getImportBatches('u'), []);
    assert.deepEqual(db2.getImportProfiles('u'), []);
    assert.equal(db2.getTransaction('t')!.import, undefined);
    const onDisk = JSON.parse(await fs.readFile(db2.filePath, 'utf-8'));
    assert.equal(onDisk.schemaVersion, 3);
    assert.deepEqual(onDisk.importBatches, []);
  });

  test('category list includes Uncategorized and the semantic categories', () => {
    assert.ok(TRANSACTION_CATEGORIES.includes(UNCATEGORIZED_CATEGORY));
    assert.ok(TRANSACTION_CATEGORIES.includes('Transfer'));
    assert.ok(TRANSACTION_CATEGORIES.includes('Investment'));
    assert.equal(new Set(TRANSACTION_CATEGORIES).size, TRANSACTION_CATEGORIES.length, 'no duplicates');
  });

  test('updateTransaction keeps balances consistent across amount, type and account changes', () => {
    const user = db.createUser('upd', 'pw')!;
    const chk = db.createAccount({ userId: user.id, name: 'Chk', type: 'checking', balance: 1000, currency: 'USD' });
    const card = db.createAccount({ userId: user.id, name: 'Card', type: 'credit', balance: 100, currency: 'USD' });
    const t = db.createTransaction({ userId: user.id, accountId: chk.id, type: 'expense', category: 'Other', amount: 50, description: 'x', date: '2026-10-01', tags: [] });
    assert.equal(db.getAccount(chk.id)!.balance, 950);

    // amount only
    db.updateTransaction(t.id, { amount: 80 });
    assert.equal(db.getAccount(chk.id)!.balance, 920);

    // flip to income
    db.updateTransaction(t.id, { type: 'income' });
    assert.equal(db.getAccount(chk.id)!.balance, 1080);

    // move to the credit card: income on a liability reduces the amount owed
    const moved = db.updateTransaction(t.id, { accountId: card.id })!;
    assert.equal(db.getAccount(chk.id)!.balance, 1000, 'old account restored');
    assert.equal(db.getAccount(card.id)!.balance, 20, 'card owes 100 - 80');
    assert.equal(moved.accountId, card.id);
    assert.equal(moved.userId, user.id);

    // category / description / date do not touch balances
    db.updateTransaction(t.id, { category: 'Gift', description: 'y', date: '2026-10-02' });
    assert.equal(db.getAccount(card.id)!.balance, 20);
    assert.equal(db.getTransaction(t.id)!.category, 'Gift');

    assert.equal(db.updateTransaction('missing', { amount: 1 }), null);
  });

  test('import bookkeeping: batches by hash, profiles by header signature, batchId filter', async () => {
    const user = db.createUser('imp', 'pw')!;
    const acc = db.createAccount({ userId: user.id, name: 'Chk', type: 'checking', balance: 0, currency: 'USD' });
    const batch = db.createImportBatch({ userId: user.id, accountId: acc.id, format: 'csv', filename: 'sep.csv', fileHash: 'abc', dateFrom: '2026-09-01', dateTo: '2026-09-30', counts: { imported: 1, recorded: 0, skipped: 0, excluded: 0 } });
    assert.equal(batch.importedAt, '2026-10-25T12:00:00.000Z');
    assert.equal(db.findImportBatchByHash(user.id, 'abc')!.id, batch.id);
    assert.equal(db.findImportBatchByHash('someone-else', 'abc'), undefined);

    db.createTransaction({ userId: user.id, accountId: acc.id, type: 'expense', category: 'Other', amount: 1, description: '', date: '2026-09-02', tags: [], import: { batchId: batch.id, source: 'csv', fingerprint: 'f1', rawDescription: 'RAW' } });
    db.createTransaction({ userId: user.id, accountId: acc.id, type: 'expense', category: 'Other', amount: 2, description: '', date: '2026-09-03', tags: [] });
    assert.deepEqual(db.getTransactions(user.id, { batchId: batch.id }).map(t => t.amount), [1]);

    const p = db.upsertImportProfile({ userId: user.id, headerSignature: 'sig', delimiter: ',', dateOrder: 'MDY', numberFormat: 'point', columns: { date: 0, description: 1, amount: 2 } });
    const p2 = db.upsertImportProfile({ userId: user.id, headerSignature: 'sig', delimiter: ',', dateOrder: 'DMY', numberFormat: 'point', columns: { date: 0, description: 1, amount: 2 } });
    assert.equal(p2.id, p.id, 'same signature replaces');
    assert.equal(db.findImportProfile(user.id, 'sig')!.dateOrder, 'DMY');
    assert.equal(db.getImportProfiles(user.id).length, 1);

    await db.persist();
    const db2 = new Database();
    await db2.init(dir);
    assert.equal(db2.getImportBatches(user.id).length, 1);
    assert.equal(db2.getTransactions(user.id, { batchId: batch.id })[0].import!.rawDescription, 'RAW');
    assert.equal(db2.deleteImportProfile(p.id), true);
    assert.equal(db2.deleteImportProfile(p.id), false);

    // deleting the account drops its batches
    db.deleteAccount(acc.id);
    assert.equal(db.getImportBatches(user.id).length, 0);
  });

  test('liability helpers', () => {
    assert.equal(isLiabilityAccount({ type: 'credit' }), true);
    assert.equal(isLiabilityAccount({ type: 'savings' }), false);
    assert.equal(signedBalance({ type: 'credit', balance: 500 }), -500);
    assert.equal(signedBalance({ type: 'checking', balance: 500 }), 500);
  });

  test('credit account: expenses increase the amount owed, payments reduce it, deletes reverse', () => {
    const user = db.createUser('cc-user', 'pw')!;
    const card = db.createAccount({ userId: user.id, name: 'Card', type: 'credit', balance: 200, currency: 'USD' });
    const purchase = db.createTransaction({ userId: user.id, accountId: card.id, type: 'expense', category: 'Shopping', amount: 150, description: '', date: '2026-10-03', tags: [] });
    assert.equal(db.getAccount(card.id)!.balance, 350);
    const payment = db.createTransaction({ userId: user.id, accountId: card.id, type: 'income', category: 'Other', amount: 300, description: 'payment', date: '2026-10-04', tags: [] });
    assert.equal(db.getAccount(card.id)!.balance, 50);
    db.deleteTransaction(payment.id);
    assert.equal(db.getAccount(card.id)!.balance, 350);
    db.deleteTransaction(purchase.id);
    assert.equal(db.getAccount(card.id)!.balance, 200);
  });

  test('createdAt uses the frozen clock', () => {
    const user = db.createUser('bob', 'pw')!;
    assert.equal(user.createdAt, '2026-10-25T12:00:00.000Z');
  });

  test('duplicate usernames are rejected', () => {
    assert.ok(db.createUser('carol', 'pw'));
    assert.equal(db.createUser('carol', 'other'), null);
  });

  test('transactions adjust and restore account balances', () => {
    const user = db.createUser('dave', 'pw')!;
    const acc = db.createAccount({ userId: user.id, name: 'Main', type: 'checking', balance: 1000, currency: 'USD' });
    const income = db.createTransaction({ userId: user.id, accountId: acc.id, type: 'income', category: 'Salary', amount: 500, description: '', date: '2026-10-01', tags: [] });
    const expense = db.createTransaction({ userId: user.id, accountId: acc.id, type: 'expense', category: 'Food & Dining', amount: 120, description: '', date: '2026-10-02', tags: [] });
    assert.equal(db.getAccount(acc.id)!.balance, 1380);
    db.deleteTransaction(expense.id);
    assert.equal(db.getAccount(acc.id)!.balance, 1500);
    db.deleteTransaction(income.id);
    assert.equal(db.getAccount(acc.id)!.balance, 1000);
  });

  test('deleting an account removes its transactions', () => {
    const user = db.createUser('erin', 'pw')!;
    const acc = db.createAccount({ userId: user.id, name: 'Main', type: 'checking', balance: 0, currency: 'USD' });
    db.createTransaction({ userId: user.id, accountId: acc.id, type: 'expense', category: 'Other', amount: 1, description: '', date: '2026-10-02', tags: [] });
    assert.equal(db.deleteAccount(acc.id), true);
    assert.equal(db.getTransactions(user.id).length, 0);
    assert.equal(db.deleteAccount(acc.id), false);
  });

  test('transaction filters and ordering', () => {
    const user = db.createUser('frank', 'pw')!;
    const a = db.createAccount({ userId: user.id, name: 'A', type: 'checking', balance: 0, currency: 'USD' });
    const b = db.createAccount({ userId: user.id, name: 'B', type: 'savings', balance: 0, currency: 'USD' });
    db.createTransaction({ userId: user.id, accountId: a.id, type: 'expense', category: 'Housing', amount: 10, description: '', date: '2026-09-01', tags: [] });
    db.createTransaction({ userId: user.id, accountId: b.id, type: 'expense', category: 'Housing', amount: 20, description: '', date: '2026-10-01', tags: [] });
    db.createTransaction({ userId: user.id, accountId: a.id, type: 'income', category: 'Salary', amount: 30, description: '', date: '2026-10-15', tags: [] });

    const all = db.getTransactions(user.id);
    assert.deepEqual(all.map(t => t.amount), [30, 20, 10], 'newest first');
    assert.deepEqual(db.getTransactions(user.id, { accountId: a.id }).map(t => t.amount), [30, 10]);
    assert.deepEqual(db.getTransactions(user.id, { category: 'Housing' }).map(t => t.amount), [20, 10]);
    assert.deepEqual(db.getTransactions(user.id, { from: '2026-10-01', to: '2026-10-10' }).map(t => t.amount), [20]);
    assert.deepEqual(db.getTransactions(user.id, { limit: 1 }).map(t => t.amount), [30]);
  });

  test('recalculateBudgetSpent sums expenses for the budget month', () => {
    const user = db.createUser('gina', 'pw')!;
    const acc = db.createAccount({ userId: user.id, name: 'A', type: 'checking', balance: 0, currency: 'USD' });
    const budget = db.createBudget({ userId: user.id, category: 'Food & Dining', amount: 400, spent: 0, period: 'monthly', month: 9, year: 2026 });
    db.createTransaction({ userId: user.id, accountId: acc.id, type: 'expense', category: 'Food & Dining', amount: 50, description: '', date: '2026-10-03', tags: [] });
    db.createTransaction({ userId: user.id, accountId: acc.id, type: 'expense', category: 'Food & Dining', amount: 25, description: '', date: '2026-10-20', tags: [] });
    db.createTransaction({ userId: user.id, accountId: acc.id, type: 'expense', category: 'Food & Dining', amount: 999, description: '', date: '2026-09-20', tags: [] });
    db.recalculateBudgetSpent(user.id, 'Food & Dining', 9, 2026);
    assert.equal(db.getBudgets(user.id).find(b => b.id === budget.id)!.spent, 75);
  });

  test('investment buys update average cost; sells reduce shares and floor at zero', () => {
    const user = db.createUser('hank', 'pw')!;
    const inv = db.createInvestment({ userId: user.id, symbol: 'VTI', name: 'Vanguard Total', type: 'etf', shares: 10, avgCost: 100, currentPrice: 120, currency: 'USD', notes: '' });
    db.createInvestmentTransaction({ userId: user.id, investmentId: inv.id, type: 'buy', shares: 10, pricePerShare: 200, totalAmount: 2000, date: '2026-10-01', notes: '' });
    let cur = db.getInvestments(user.id)[0];
    assert.equal(cur.shares, 20);
    assert.equal(cur.avgCost, 150);
    db.createInvestmentTransaction({ userId: user.id, investmentId: inv.id, type: 'sell', shares: 25, pricePerShare: 210, totalAmount: 5250, date: '2026-10-02', notes: '' });
    cur = db.getInvestments(user.id)[0];
    assert.equal(cur.shares, 0);
    assert.equal(db.getInvestmentTransactions(inv.id).length, 2);
    assert.equal(db.deleteInvestment(inv.id), true);
    assert.equal(db.getInvestmentTransactions(inv.id).length, 0);
  });

  test('profiles upsert per user and scenarios round-trip through disk', async () => {
    const user = db.createUser('sim-user', 'pw')!;
    assert.equal(db.getProfile(user.id), undefined);
    const p1 = db.upsertProfile(user.id, { birthDate: '1986-07-10', retirementAge: 65, safeWithdrawalRate: 0.04, planToAge: 90 });
    assert.equal(p1.updatedAt, '2026-10-25T12:00:00.000Z');
    db.upsertProfile(user.id, { ...p1, retirementAge: 60 });
    assert.equal(db.getProfile(user.id)!.retirementAge, 60);
    assert.equal(db.getProfile('nobody'), undefined);

    const scenario = { name: 'S', economy: { expectedReturn: 0.05, volatility: 0.1, inflation: 0.02, wageGrowth: 0.02, cashYield: 0.01, debtRate: 0.2, propertyAppreciation: 0.03, shocks: [] }, events: [], policy: { emergencyFundMonths: 3, investSurplus: true, contributionFollowsWages: true } };
    const s = db.createScenario(user.id, scenario);
    assert.ok(s.id);
    assert.equal(s.userId, user.id);
    assert.equal(db.updateScenario(s.id, { ...scenario, name: 'S2' })!.name, 'S2');
    assert.equal(db.updateScenario(s.id, { ...scenario, name: 'S2' })!.createdAt, s.createdAt);
    assert.equal(db.updateScenario('nope', scenario), null);
    await db.persist();

    const db2 = new Database();
    await db2.init(dir);
    assert.equal(db2.getScenarios(user.id).length, 1);
    assert.equal(db2.getScenario(s.id)!.name, 'S2');
    assert.equal(db2.getProfile(user.id)!.retirementAge, 60);
    assert.equal(db2.deleteScenario(s.id), true);
    assert.equal(db2.deleteScenario(s.id), false);
  });

  test('getSimulationSource scopes everything to the user', () => {
    const a = db.createUser('src-a', 'pw')!;
    const b = db.createUser('src-b', 'pw')!;
    const accA = db.createAccount({ userId: a.id, name: 'A', type: 'checking', balance: 1, currency: 'USD' });
    db.createAccount({ userId: b.id, name: 'B', type: 'checking', balance: 1, currency: 'USD' });
    db.createTransaction({ userId: a.id, accountId: accA.id, type: 'income', category: 'Salary', amount: 1, description: '', date: '2026-10-01', tags: [] });
    const invA = db.createInvestment({ userId: a.id, symbol: 'A', name: 'A', type: 'stock', shares: 1, avgCost: 1, currentPrice: 1, currency: 'USD', notes: '' });
    const invB = db.createInvestment({ userId: b.id, symbol: 'B', name: 'B', type: 'stock', shares: 1, avgCost: 1, currentPrice: 1, currency: 'USD', notes: '' });
    db.createInvestmentTransaction({ userId: a.id, investmentId: invA.id, type: 'buy', shares: 1, pricePerShare: 1, totalAmount: 1, date: '2026-10-01', notes: '' });
    db.createInvestmentTransaction({ userId: b.id, investmentId: invB.id, type: 'buy', shares: 1, pricePerShare: 1, totalAmount: 1, date: '2026-10-01', notes: '' });
    db.createGoal({ userId: b.id, name: 'G', targetAmount: 1, currentAmount: 0, deadline: '', category: 'Other', priority: 'low', notes: '' });
    const src = db.getSimulationSource(a.id);
    assert.equal(src.accounts.length, 1);
    assert.equal(src.transactions.length, 1);
    assert.equal(src.investments.length, 1);
    assert.equal(src.investmentTransactions.length, 1);
    assert.equal(src.goals.length, 0);
  });

  test('dashboard aggregates for the frozen month', () => {
    const user = db.createUser('ivy', 'pw')!;
    const chk = db.createAccount({ userId: user.id, name: 'Chk', type: 'checking', balance: 1000, currency: 'USD' });
    db.createAccount({ userId: user.id, name: 'CC', type: 'credit', balance: 200, currency: 'USD' });
    db.createInvestment({ userId: user.id, symbol: 'X', name: 'X', type: 'stock', shares: 2, avgCost: 10, currentPrice: 50, currency: 'USD', notes: '' });
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'income', category: 'Salary', amount: 3000, description: '', date: '2026-10-01', tags: [] });
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'expense', category: 'Housing', amount: 1200, description: '', date: '2026-10-02', tags: [] });
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'expense', category: 'Food & Dining', amount: 300, description: '', date: '2026-10-03', tags: [] });
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'expense', category: 'Housing', amount: 5000, description: 'last month', date: '2026-09-02', tags: [] });
    db.createGoal({ userId: user.id, name: 'EF', targetAmount: 1000, currentAmount: 250, deadline: '', category: 'Emergency', priority: 'high', notes: '' });
    // Transfers and investing are not spending; investment income is income.
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'expense', category: 'Transfer', amount: 700, description: 'to savings', date: '2026-10-05', tags: [] });
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'expense', category: 'Investment', amount: 400, description: 'to brokerage', date: '2026-10-05', tags: [] });
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'income', category: 'Transfer', amount: 50, description: 'refund between accounts', date: '2026-10-06', tags: [] });
    db.createTransaction({ userId: user.id, accountId: chk.id, type: 'income', category: 'Investment', amount: 20, description: 'interest', date: '2026-10-06', tags: [] });

    const d = db.getDashboard(user.id);
    // checking after txns: 1000 + 3000 - 1200 - 300 - 5000 - 700 - 400 + 50 + 20 = -3530 ; credit card (200 owed) is a liability
    assert.equal(d.totalBalance, -3530);
    assert.equal(d.totalLiabilities, 200);
    assert.equal(d.monthlyIncome, 3020);
    assert.equal(d.monthlyExpenses, 1500);
    assert.equal(d.monthlyInvested, 400);
    assert.equal(d.investmentValue, 100);
    assert.equal(d.netWorth, -3530 + 100 - 200);
    assert.equal(d.savingsRate, 50);
    assert.deepEqual(d.topExpenseCategories.map(c => [c.category, c.amount, c.percentage]), [['Housing', 1200, 80], ['Food & Dining', 300, 20]]);
    assert.deepEqual(d.goalProgress, [{ name: 'EF', current: 250, target: 1000, percentage: 25 }]);
  });
});
