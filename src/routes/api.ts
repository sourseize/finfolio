import { router } from '../server/router.js';
import { db } from '../db/database.js';
import type { ServerResponse, IncomingMessage } from 'node:http';

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

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
    date: body.date || new Date().toISOString().slice(0, 10),
    tags: body.tags || [],
  });
  // Recalculate budgets
  const d = new Date(txn.date);
  db.recalculateBudgetSpent(userId, txn.category, d.getMonth(), d.getFullYear());
  await db.persist();
  json(res, txn, 201);
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
  const now = new Date();
  const budget = db.createBudget({
    userId,
    category: body.category,
    amount: body.amount,
    spent: 0,
    period: body.period || 'monthly',
    month: body.month ?? now.getMonth(),
    year: body.year ?? now.getFullYear(),
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
    date: body.date || new Date().toISOString().slice(0, 10),
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
