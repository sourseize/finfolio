/**
 * Demo user "fin" — plausible, deterministic data for manual testing and the
 * regression suite.
 *
 *   username: fin      password: folio
 *   born 1986-07-10 (40 on the seed date), retires at 65, seed date 2026-10-25
 *
 * 24 months of history ending on the seed date: salary, rent, groceries,
 * utilities, card spending with monthly pay-offs, transfers to savings and a
 * brokerage with monthly ETF purchases, a few one-offs (laptop, car repair,
 * holiday, dentist), current-month budgets, goals, a profile and five saved
 * scenarios.
 *
 * Everything is generated from a fixed PRNG seed, so re-running produces the
 * same database (ids aside) — the golden regression tests rely on that.
 */
import { Database, type Account, type InvestmentTransaction, type Transaction } from '../db/database.js';
import { getClockOverride, setClock, today } from '../util/clock.js';
import { mulberry32 } from '../sim/montecarlo.js';
import { normalizeScenario } from '../sim/scenario.js';
import { createEvent } from '../sim/events.js';
import { addMonths, round2 } from '../sim/math.js';

export const FIN_USERNAME = 'fin';
export const FIN_PASSWORD = 'folio';
export const FIN_SEED_DATE = '2026-10-25';
export const FIN_BIRTH_DATE = '1986-07-10';
export const FIN_HISTORY_MONTHS = 24;

export interface SeedSummary {
  userId: string;
  accounts: number;
  transactions: number;
  investments: number;
  trades: number;
  budgets: number;
  goals: number;
  scenarios: number;
  asOf: string;
}

type PendingTxn = Omit<Transaction, 'id' | 'userId' | 'accountId'> & { account: string };
type PendingTrade = Omit<InvestmentTransaction, 'id' | 'userId' | 'investmentId'> & { symbol: string };

/** Remove every record belonging to the user (used to make the seed re-runnable). */
export function wipeUser(db: Database, userId: string): void {
  for (const a of db.getAccounts(userId)) db.deleteAccount(a.id);
  for (const t of db.getTransactions(userId)) db.deleteTransaction(t.id);
  for (const b of db.getBudgets(userId)) db.deleteBudget(b.id);
  for (const i of db.getInvestments(userId)) db.deleteInvestment(i.id);
  for (const g of db.getGoals(userId)) db.deleteGoal(g.id);
  for (const s of db.getScenarios(userId)) db.deleteScenario(s.id);
}

/**
 * Create (or re-create) the demo user and all their data.
 * The clock is frozen at the seed date while generating so `createdAt` stamps
 * are deterministic; it is restored afterwards.
 */
export async function seedFin(db: Database, opts: { asOf?: string; persist?: boolean } = {}): Promise<SeedSummary> {
  const asOf = opts.asOf ?? FIN_SEED_DATE;
  const previousClock = getClockOverride();
  setClock(`${asOf}T09:00:00.000Z`);
  try {
    let user = db.authenticateUser(FIN_USERNAME, FIN_PASSWORD) ?? db.getUserByUsername(FIN_USERNAME);
    if (user) wipeUser(db, user.id);
    else user = db.createUser(FIN_USERNAME, FIN_PASSWORD)!;
    const userId = user.id;

    const rand = mulberry32(20261025);
    const between = (lo: number, hi: number) => round2(lo + rand() * (hi - lo));
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
    const day = (ym: string, d: number) => `${ym}-${String(Math.min(28, Math.max(1, d))).padStart(2, '0')}`;

    // Month list: FIN_HISTORY_MONTHS complete months + the current partial month.
    const currentYm = asOf.slice(0, 7);
    const months: string[] = [];
    for (let i = FIN_HISTORY_MONTHS; i >= 0; i--) months.push(addMonths(currentYm, -i));
    const asOfDay = Number(asOf.slice(8, 10));

    const txns: PendingTxn[] = [];
    const add = (account: string, type: Transaction['type'], category: string, amount: number, date: string, description: string, tags: string[] = []) => {
      if (date > asOf) return; // nothing in the future
      txns.push({ account, type, category, amount: round2(amount), date, description, tags });
    };

    // ── One-offs (added first so card purchases are included in that month's pay-off) ──
    add('card', 'expense', 'Shopping', 1450, '2024-11-18', 'Laptop', ['big-ticket']);
    add('checking', 'expense', 'Gift', 420, '2024-12-15', 'Christmas gifts');
    add('checking', 'expense', 'Gift', 465, '2025-12-14', 'Christmas gifts');
    add('checking', 'income', 'Gift', 300, '2025-07-10', 'Birthday money from parents');
    add('checking', 'income', 'Gift', 300, '2026-07-10', 'Birthday money from parents');
    add('checking', 'expense', 'Transportation', 860, '2026-03-12', 'Car repair — clutch', ['big-ticket']);
    add('checking', 'expense', 'Healthcare', 420, '2025-05-20', 'Dentist — crown');
    add('card', 'expense', 'Entertainment', 2380, '2026-07-03', 'Flights + hotel — Lisbon', ['holiday', 'big-ticket']);
    add('card', 'expense', 'Food & Dining', 540, '2026-07-12', 'Holiday dining — Lisbon', ['holiday']);
    add('checking', 'expense', 'Education', 399, '2025-09-08', 'Online course — Financial modelling');
    add('checking', 'expense', 'Education', 349, '2026-09-14', 'Online course — TypeScript');
    add('checking', 'income', 'Salary', 3200, '2025-12-19', 'Annual bonus', ['payroll']);
    add('checking', 'expense', 'Transfer', 3000, '2025-12-20', 'Bonus to savings', ['transfer']);
    add('savings', 'income', 'Transfer', 3000, '2025-12-20', 'Bonus from checking', ['transfer']);
    add('checking', 'expense', 'Housing', 380, '2026-04-22', 'Apartment deposit top-up');

    // ── Recurring cash flows ──
    for (const ym of months) {
      const isCurrent = ym === currentYm;
      const lim = isCurrent ? asOfDay : 28;
      const year = Number(ym.slice(0, 4));
      const raise = year >= 2026 ? 6400 : 6100; // pay rise in January 2026
      add('checking', 'income', 'Salary', raise, day(ym, 1), 'Monthly salary — Northwind Analytics', ['payroll']);
      add('checking', 'expense', 'Housing', 1950, day(ym, 2), 'Rent — 14 Harbour St', ['fixed']);
      add('checking', 'expense', 'Utilities', between(120, 210), day(ym, 8), 'Electricity & gas');
      add('checking', 'expense', 'Utilities', 65, day(ym, 9), 'Mobile plan', ['fixed']);
      add('checking', 'expense', 'Utilities', 49.99, day(ym, 10), 'Broadband', ['fixed']);
      add('checking', 'expense', 'Other', 128, day(ym, 12), 'Health & contents insurance', ['fixed']);
      add('card', 'expense', 'Entertainment', 15.99, day(ym, 14), 'Streaming subscription');
      add('card', 'expense', 'Healthcare', 38, day(ym, 16), 'Gym membership');
      // Groceries: weekly
      for (const d of [3, 10, 17, 24]) if (d <= lim) add('card', 'expense', 'Food & Dining', between(85, 165), day(ym, d), pick(['Supermarket', 'Farmers market', 'Grocery run']));
      // Eating out
      for (let k = 0; k < 3; k++) { const d = 4 + k * 8 + Math.floor(rand() * 4); if (d <= lim) add('card', 'expense', 'Food & Dining', between(28, 95), day(ym, d), pick(['Dinner with friends', 'Lunch', 'Coffee & pastries', 'Takeaway'])); }
      // Transport
      add('checking', 'expense', 'Transportation', between(55, 120), day(ym, 6), 'Fuel');
      if (19 <= lim) add('checking', 'expense', 'Transportation', 72, day(ym, 19), 'Transit pass');
      // Entertainment / shopping
      if (11 <= lim) add('card', 'expense', 'Entertainment', between(18, 80), day(ym, 11), pick(['Cinema', 'Concert tickets', 'Board-game night', 'Books']));
      if (21 <= lim) add('card', 'expense', 'Shopping', between(40, 240), day(ym, 21), pick(['Clothing', 'Household bits', 'Electronics accessory', 'Gifts']));
      if (rand() < 0.45 && 23 <= lim) add('checking', 'expense', 'Healthcare', between(45, 180), day(ym, 23), pick(['Pharmacy', 'GP visit', 'Physio session']));
      // Card pay-off on the 27th (previous month's balance — approximate as the card's spend in this month)
      if (27 <= lim) {
        const cardSpend = txns.filter(t => t.account === 'card' && t.type === 'expense' && t.date.startsWith(ym)).reduce((s, t) => s + t.amount, 0);
        add('checking', 'expense', 'Transfer', cardSpend, day(ym, 27), 'Credit card payment', ['transfer']);
        add('card', 'income', 'Transfer', cardSpend, day(ym, 27), 'Payment received — thank you', ['transfer']);
      }
      // Savings + investing transfers on the 5th
      add('checking', 'expense', 'Transfer', 900, day(ym, 5), 'Transfer to savings', ['transfer']);
      add('savings', 'income', 'Transfer', 900, day(ym, 5), 'Transfer from checking', ['transfer']);
      add('checking', 'expense', 'Investment', 1200, day(ym, 5), 'Transfer to brokerage', ['transfer']);
      // Freelance every ~3 months
      if (months.indexOf(ym) % 3 === 1 && 15 <= lim) add('checking', 'income', 'Freelance', between(650, 1500), day(ym, 15), 'Freelance — data dashboard project', ['side-income']);
      // Savings interest
      if (28 <= lim) add('savings', 'income', 'Investment', between(60, 95), day(ym, 28), 'Interest — high-yield savings');
    }

    // ── Accounts: opening balances chosen so that today's balances are the targets ──
    const targets: Record<string, { name: string; type: Account['type']; target: number; currency: string }> = {
      checking: { name: 'Everyday Checking', type: 'checking', target: 7850.4, currency: 'USD' },
      savings: { name: 'High-Yield Savings', type: 'savings', target: 28400, currency: 'USD' },
      card: { name: 'Travel Rewards Card', type: 'credit', target: 0, currency: 'USD' }, // filled below
      brokerage: { name: 'Brokerage Cash', type: 'investment', target: 2150, currency: 'USD' },
      wallet: { name: 'Wallet', type: 'cash', target: 180, currency: 'USD' },
    };
    // Card: whatever was spent on it since the last pay-off is what is owed today.
    const lastPayoff = txns.filter(t => t.account === 'card' && t.type === 'income').map(t => t.date).sort().pop() ?? '0000';
    targets.card.target = round2(txns.filter(t => t.account === 'card' && t.type === 'expense' && t.date > lastPayoff).reduce((s, t) => s + t.amount, 0));

    const net: Record<string, number> = {};
    for (const t of txns) {
      const liability = targets[t.account].type === 'credit';
      const sign = t.type === 'income' ? (liability ? -1 : 1) : t.type === 'expense' ? (liability ? 1 : -1) : 0;
      net[t.account] = (net[t.account] || 0) + sign * t.amount;
    }
    const accountIds: Record<string, string> = {};
    for (const [key, spec] of Object.entries(targets)) {
      const opening = round2(spec.target - (net[key] || 0));
      const acc = db.createAccount({ userId, name: spec.name, type: spec.type, balance: opening, currency: spec.currency });
      accountIds[key] = acc.id;
    }
    txns.sort((a, b) => a.date.localeCompare(b.date));
    for (const t of txns) {
      const { account, ...rest } = t;
      db.createTransaction({ ...rest, userId, accountId: accountIds[account] });
    }
    // Sanity: balances now equal the targets (floating error aside)
    for (const [key, spec] of Object.entries(targets)) {
      const acc = db.getAccount(accountIds[key])!;
      acc.balance = round2(acc.balance);
      if (Math.abs(acc.balance - spec.target) > 0.02) throw new Error(`seed: ${key} balance ${acc.balance} ≠ ${spec.target}`);
    }

    // ── Investments ──
    // Holdings as of 24 months ago, then monthly ETF purchases funded by the 1 200 brokerage transfer.
    const holdings = [
      { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf' as const, shares: 48, avgCost: 190, price0: 205, priceNow: 268, monthlyBuy: 3 },
      { symbol: 'VXUS', name: 'Vanguard Total International ETF', type: 'etf' as const, shares: 60, avgCost: 52, price0: 54, priceNow: 64.2, monthlyBuy: 6 },
      { symbol: 'BND', name: 'Vanguard Total Bond Market ETF', type: 'bond' as const, shares: 80, avgCost: 72.4, price0: 71, priceNow: 73.5, monthlyBuy: 0 },
      { symbol: 'AAPL', name: 'Apple Inc.', type: 'stock' as const, shares: 15, avgCost: 158, price0: 172, priceNow: 231.4, monthlyBuy: 0 },
      { symbol: 'BTC', name: 'Bitcoin', type: 'crypto' as const, shares: 0.08, avgCost: 38500, price0: 42000, priceNow: 67500, monthlyBuy: 0 },
    ];
    const trades: PendingTrade[] = [];
    const invIds: Record<string, string> = {};
    for (const h of holdings) {
      const inv = db.createInvestment({ userId, symbol: h.symbol, name: h.name, type: h.type, shares: h.shares, avgCost: h.avgCost, currentPrice: h.priceNow, currency: 'USD', notes: '' });
      invIds[h.symbol] = inv.id;
      // price path: geometric interpolation from price0 → priceNow with small noise
      const steps = FIN_HISTORY_MONTHS;
      months.forEach((ym, i) => {
        const f = i / steps;
        const trend = h.price0 * Math.pow(h.priceNow / h.price0, f);
        const price = round2(trend * (1 + (rand() - 0.5) * 0.06));
        const date = day(ym, 6);
        if (h.monthlyBuy > 0 && date <= asOf) trades.push({ symbol: h.symbol, type: 'buy', shares: h.monthlyBuy, pricePerShare: price, totalAmount: round2(h.monthlyBuy * price), date, notes: 'Monthly purchase' });
        // Quarterly dividends for the ETFs / bond fund
        if ((h.symbol === 'VTI' || h.symbol === 'VXUS' || h.symbol === 'BND') && i % 3 === 2 && day(ym, 25) <= asOf) {
          const perShare = h.symbol === 'BND' ? 0.19 : h.symbol === 'VTI' ? 0.92 : 0.55;
          const sharesNow = h.shares + h.monthlyBuy * (i + 1);
          trades.push({ symbol: h.symbol, type: 'dividend', shares: sharesNow, pricePerShare: perShare, totalAmount: round2(sharesNow * perShare), date: day(ym, 25), notes: 'Quarterly distribution' });
        }
      });
    }
    // Extra lots
    trades.push({ symbol: 'AAPL', type: 'buy', shares: 10, pricePerShare: 189.5, totalAmount: 1895, date: '2025-04-08', notes: 'Added after pullback' });
    trades.push({ symbol: 'BTC', type: 'buy', shares: 0.04, pricePerShare: 58200, totalAmount: 2328, date: '2025-09-17', notes: 'DCA' });
    trades.push({ symbol: 'BTC', type: 'buy', shares: 0.03, pricePerShare: 61900, totalAmount: 1857, date: '2026-02-11', notes: 'DCA' });
    trades.sort((a, b) => a.date.localeCompare(b.date));
    for (const t of trades) {
      const { symbol, ...rest } = t;
      db.createInvestmentTransaction({ ...rest, userId, investmentId: invIds[symbol] });
    }
    for (const inv of db.getInvestments(userId)) db.updateInvestment(inv.id, { shares: round2(inv.shares * 10000) / 10000, avgCost: round2(inv.avgCost) });

    // ── Budgets for the current month ──
    const current = new Date(`${asOf}T00:00:00Z`);
    const month = current.getUTCMonth();
    const year = current.getUTCFullYear();
    const budgets: [string, number][] = [['Food & Dining', 750], ['Transportation', 260], ['Entertainment', 180], ['Shopping', 300], ['Utilities', 260], ['Housing', 1950], ['Healthcare', 150]];
    for (const [category, amount] of budgets) {
      db.createBudget({ userId, category, amount, spent: 0, period: 'monthly', month, year });
      db.recalculateBudgetSpent(userId, category, month, year);
    }

    // ── Goals ──
    db.createGoal({ userId, name: 'Emergency fund (6 months)', targetAmount: 25000, currentAmount: 18500, deadline: '2027-06-30', category: 'Emergency', priority: 'high', notes: 'Kept in the high-yield savings account.' });
    db.createGoal({ userId, name: 'Flat deposit', targetAmount: 84000, currentAmount: 22000, deadline: '2029-12-31', category: 'House', priority: 'medium', notes: '20% on a ~420k flat.' });
    db.createGoal({ userId, name: 'Japan trip', targetAmount: 4500, currentAmount: 900, deadline: '2027-10-01', category: 'Travel', priority: 'low', notes: 'Two weeks, spring 2028.' });
    db.createGoal({ userId, name: 'Retire at 65', targetAmount: 1500000, currentAmount: 0, deadline: '2051-07-10', category: 'Retirement', priority: 'medium', notes: 'Tracked automatically by the simulator.' });

    // ── Profile ──
    db.upsertProfile(userId, { birthDate: FIN_BIRTH_DATE, retirementAge: 65, safeWithdrawalRate: 0.04, planToAge: 90 });

    // ── Scenarios ──
    const scenarios = [
      normalizeScenario({ name: 'Keep going', description: 'No changes — current habits, moderate economy.', economy: { preset: 'moderate' }, events: [] }),
      normalizeScenario({
        name: 'Buy a flat in 2028',
        description: '20% deposit on a 420k flat in early 2028; mortgage replaces rent.',
        economy: { preset: 'moderate' },
        events: [createEvent('buy_home', { id: 'flat-2028', label: 'Buy a flat', startMonth: 15, price: 420000, downPayment: 84000, mortgageRate: 0.045, mortgageYears: 25, rentReplaced: 1950, ownershipCosts: 450 })],
      }),
      normalizeScenario({
        name: 'Sabbatical + crash',
        description: 'A year off starting next spring, right as the market drops 35%.',
        economy: { preset: 'crash-recovery' },
        events: [createEvent('sabbatical', { id: 'sabbatical-2027', label: 'Year off travelling', startMonth: 6, durationMonths: 12 })],
      }),
      normalizeScenario({
        name: 'Retire at 58',
        description: 'Stop working seven years early and live off the portfolio.',
        economy: { preset: 'moderate' },
        events: [createEvent('retire', { id: 'retire-58', label: 'Retire at 58', startMonth: 213 })],
      }),
      normalizeScenario({
        name: 'Family of four',
        description: 'First child next year, second in 2029, with a bigger home in 2030.',
        economy: { preset: 'pessimistic' },
        events: [
          createEvent('child', { id: 'child-1', label: 'First child', startMonth: 10, amount: 950 }),
          createEvent('child', { id: 'child-2', label: 'Second child', startMonth: 34, amount: 900 }),
          createEvent('lifestyle', { id: 'bigger-home', label: 'Bigger rental', startMonth: 44, amount: 700 }),
          createEvent('second_income', { id: 'partner', label: 'Partner returns to work', startMonth: 46, amount: 2800 }),
        ],
      }),
    ];
    for (const s of scenarios) db.createScenario(userId, s);

    if (opts.persist !== false) await db.persist();

    return {
      userId,
      accounts: db.getAccounts(userId).length,
      transactions: db.getTransactions(userId).length,
      investments: db.getInvestments(userId).length,
      trades: trades.length,
      budgets: db.getBudgets(userId).length,
      goals: db.getGoals(userId).length,
      scenarios: db.getScenarios(userId).length,
      asOf: today(),
    };
  } finally {
    setClock(previousClock);
  }
}
