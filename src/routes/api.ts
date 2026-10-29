import { router } from '../server/router.js';
import { db, TRANSACTION_CATEGORIES, type Transaction } from '../db/database.js';
import { now, nowIso, today, isClockFrozen } from '../util/clock.js';
import type { ServerResponse, IncomingMessage } from 'node:http';

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Refresh the budget total for the month a transaction falls in. */
function recalcBudgetFor(userId: string, txn: Pick<Transaction, 'category' | 'date'>) {
  const d = new Date(txn.date);
  db.recalculateBudgetSpent(userId, txn.category, d.getMonth(), d.getFullYear());
}

// ── Meta ──
router.get('/api/meta', async (_req, res) => {
  json(res, { name: 'finfolio', now: nowIso(), today: today(), clockFrozen: isClockFrozen() });
}, false);

// ── Auth ──
router.post('/api/auth/register', async (req, res, _match, body) => {
  if (!body?.username || !body?.password) {
    return json(res, { error: 'Username and password required' }, 400);
  }
  const user = db.createUser(body.username, body.password);
  if (!user) return json(res, { error: 'Username already exists' }, 409);
  const token = router.createSessionToken(user.id);
  json(res, { token, user: { id: user.id, username: user.username } });
}, false);

router.post('/api/auth/login', async (req, res, _match, body) => {
  if (!body?.username || !body?.password) {
    return json(res, { error: 'Username and password required' }, 400);
  }
  const user = db.authenticateUser(body.username, body.password);
  if (!user) return json(res, { error: 'Invalid credentials' }, 401);
  const token = router.createSessionToken(user.id);
  json(res, { token, user: { id: user.id, username: user.username } });
}, false);

// ── Dashboard ──
router.get('/api/dashboard', async (req, res) => {
  const userId = (req as any).userId;
  const data = db.getDashboard(userId);
  json(res, data);
});

// ── Accounts ──
router.get('/api/accounts', async (req, res) => {
  const userId = (req as any).userId;
  json(res, db.getAccounts(userId));
});

router.get('/api/accounts/:id', async (req, res, match) => {
  const account = db.getAccount(match[1]);
  if (!account) return json(res, { error: 'Not found' }, 404);
  json(res, account);
});

router.post('/api/accounts', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  if (!body?.name || !body?.type) return json(res, { error: 'Name and type required' }, 400);
  const account = db.createAccount({
    userId,
    name: body.name,
    type: body.type,
    balance: body.balance || 0,
    currency: body.currency || 'USD',
  });
  await db.persist();
  json(res, account, 201);
});

router.put('/api/accounts/:id', async (req, res, match, body) => {
  const account = db.updateAccount(match[1], body);
  if (!account) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, account);
});

router.delete('/api/accounts/:id', async (req, res, match) => {
  const ok = db.deleteAccount(match[1]);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, { success: true });
});

// ── Transactions ──
router.get('/api/transactions', async (req, res) => {
  const userId = (req as any).userId;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const filters: any = {};
  if (url.searchParams.has('accountId')) filters.accountId = url.searchParams.get('accountId')!;
  if (url.searchParams.has('category')) filters.category = url.searchParams.get('category')!;
  if (url.searchParams.has('from')) filters.from = url.searchParams.get('from')!;
  if (url.searchParams.has('to')) filters.to = url.searchParams.get('to')!;
  if (url.searchParams.has('limit')) filters.limit = parseInt(url.searchParams.get('limit')!);
  if (url.searchParams.has('batchId')) filters.batchId = url.searchParams.get('batchId')!;
  json(res, db.getTransactions(userId, filters));
});

router.post('/api/transactions', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  if (!body?.accountId || !body?.type || !body?.amount || !body?.category) {
    return json(res, { error: 'accountId, type, amount, category required' }, 400);
  }
  const txn = db.createTransaction({
    userId,
    accountId: body.accountId,
    type: body.type,
    category: body.category,
    amount: body.amount,
    description: body.description || '',
    date: body.date || today(),
    tags: body.tags || [],
  });
  recalcBudgetFor(userId, txn);
  await db.persist();
  json(res, txn, 201);
});

/**
 * Edit a transaction (account, type, amount, category, date, description, tags).
 * Balances of the old and new account and the budgets of the old and new
 * category/month are kept in sync. Import bookkeeping (`import`) is read-only here.
 */
router.put('/api/transactions/:id', async (req, res, match, body) => {
  const userId = (req as any).userId;
  const existing = db.getTransaction(match[1]);
  if (!existing || existing.userId !== userId) return json(res, { error: 'Not found' }, 404);
  if (!body || typeof body !== 'object') return json(res, { error: 'Body required' }, 400);

  const updates: Partial<Transaction> = {};
  if (body.accountId !== undefined) {
    const account = db.getAccount(body.accountId);
    if (!account || account.userId !== userId) return json(res, { error: 'Unknown account' }, 400);
    updates.accountId = body.accountId;
  }
  if (body.type !== undefined) {
    if (body.type !== 'income' && body.type !== 'expense') return json(res, { error: 'type must be income or expense' }, 400);
    updates.type = body.type;
  }
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json(res, { error: 'amount must be a positive number' }, 400);
    updates.amount = amount;
  }
  if (body.category !== undefined) {
    if (typeof body.category !== 'string' || !TRANSACTION_CATEGORIES.includes(body.category)) return json(res, { error: 'Unknown category' }, 400);
    updates.category = body.category;
  }
  if (body.date !== undefined) {
    if (typeof body.date !== 'string' || !ISO_DATE.test(body.date) || Number.isNaN(new Date(body.date).getTime())) return json(res, { error: 'date must be YYYY-MM-DD' }, 400);
    updates.date = body.date;
  }
  if (body.description !== undefined) updates.description = String(body.description);
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return json(res, { error: 'tags must be an array' }, 400);
    updates.tags = body.tags.map(String);
  }

  const before = { category: existing.category, date: existing.date };
  const txn = db.updateTransaction(existing.id, updates)!;
  recalcBudgetFor(userId, before);
  recalcBudgetFor(userId, txn);
  await db.persist();
  json(res, txn);
});

router.delete('/api/transactions/:id', async (req, res, match) => {
  const ok = db.deleteTransaction(match[1]);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, { success: true });
});

// ── Budgets ──
router.get('/api/budgets', async (req, res) => {
  const userId = (req as any).userId;
  json(res, db.getBudgets(userId));
});

router.post('/api/budgets', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  if (!body?.category || !body?.amount) return json(res, { error: 'category and amount required' }, 400);
  const current = now();
  const budget = db.createBudget({
    userId,
    category: body.category,
    amount: body.amount,
    spent: 0,
    period: body.period || 'monthly',
    month: body.month ?? current.getMonth(),
    year: body.year ?? current.getFullYear(),
  });
  await db.persist();
  json(res, budget, 201);
});

router.put('/api/budgets/:id', async (req, res, match, body) => {
  const budget = db.updateBudget(match[1], body);
  if (!budget) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, budget);
});

router.delete('/api/budgets/:id', async (req, res, match) => {
  const ok = db.deleteBudget(match[1]);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, { success: true });
});

// ── Investments ──
router.get('/api/investments', async (req, res) => {
  const userId = (req as any).userId;
  json(res, db.getInvestments(userId));
});

router.post('/api/investments', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  if (!body?.symbol || !body?.name) return json(res, { error: 'symbol and name required' }, 400);
  const inv = db.createInvestment({
    userId,
    symbol: body.symbol.toUpperCase(),
    name: body.name,
    type: body.type || 'stock',
    shares: body.shares || 0,
    avgCost: body.avgCost || 0,
    currentPrice: body.currentPrice || 0,
    currency: body.currency || 'USD',
    notes: body.notes || '',
  });
  await db.persist();
  json(res, inv, 201);
});

router.put('/api/investments/:id', async (req, res, match, body) => {
  const inv = db.updateInvestment(match[1], body);
  if (!inv) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, inv);
});

router.delete('/api/investments/:id', async (req, res, match) => {
  const ok = db.deleteInvestment(match[1]);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, { success: true });
});

// ── Investment Transactions ──
router.get('/api/investments/:id/transactions', async (req, res, match) => {
  json(res, db.getInvestmentTransactions(match[1]));
});

router.post('/api/investments/:id/transactions', async (req, res, match, body) => {
  const userId = (req as any).userId;
  if (!body?.type || !body?.shares || !body?.pricePerShare) {
    return json(res, { error: 'type, shares, pricePerShare required' }, 400);
  }
  const txn = db.createInvestmentTransaction({
    investmentId: match[1],
    userId,
    type: body.type,
    shares: body.shares,
    pricePerShare: body.pricePerShare,
    totalAmount: body.shares * body.pricePerShare,
    date: body.date || today(),
    notes: body.notes || '',
  });
  await db.persist();
  json(res, txn, 201);
});

// ── Goals ──
router.get('/api/goals', async (req, res) => {
  const userId = (req as any).userId;
  json(res, db.getGoals(userId));
});

router.post('/api/goals', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  if (!body?.name || !body?.targetAmount) return json(res, { error: 'name and targetAmount required' }, 400);
  const goal = db.createGoal({
    userId,
    name: body.name,
    targetAmount: body.targetAmount,
    currentAmount: body.currentAmount || 0,
    deadline: body.deadline || '',
    category: body.category || 'general',
    priority: body.priority || 'medium',
    notes: body.notes || '',
  });
  await db.persist();
  json(res, goal, 201);
});

router.put('/api/goals/:id', async (req, res, match, body) => {
  const goal = db.updateGoal(match[1], body);
  if (!goal) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, goal);
});

router.delete('/api/goals/:id', async (req, res, match) => {
  const ok = db.deleteGoal(match[1]);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  await db.persist();
  json(res, { success: true });
});
