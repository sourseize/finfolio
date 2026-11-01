/**
 * Demo user "penny" — the second persona, built to be *compared* with "fin".
 *
 *   username: penny    password: wise
 *   born 1993-03-22 (33 on the seed date), retires at 60, seed date 2026-10-25
 *
 * Penny is at an earlier stage than fin and her strengths are different, so a
 * side-by-side report has something to say in both directions:
 *
 *   • 18 months of history (fin has 24) — the comparison must align unequal windows
 *   • lower income (4 650 → 4 900 after a July 2026 rise), flat-share rent, no car
 *   • debt: a credit card she only partly pays off and a student loan (both
 *     liabilities), repaid 260 a month
 *   • a modest portfolio: two index ETFs and a bond fund, monthly purchases, no crypto
 *   • a *weekly* saving habit with a long streak (On fire → Unstoppable) and a
 *     weekly Shopping swap that is hit-and-miss; no investing habit
 *   • the suggested reward list, three claims so far, no nudge pending
 *   • FI progress under 5 % — the FI rungs stay locked, streak badges do not
 *
 * Like fin, everything comes from a fixed PRNG seed and is re-runnable; the
 * golden tests take a snapshot of it. `fin.ts` is untouched by design — its
 * PRNG sequence, and therefore its golden snapshot, must not move.
 */
import { Database, type Account, type InvestmentTransaction, type Transaction } from '../db/database.js';
import { getClockOverride, setClock, today } from '../util/clock.js';
import { mulberry32 } from '../sim/montecarlo.js';
import { normalizeScenario } from '../sim/scenario.js';
import { createEvent } from '../sim/events.js';
import { addMonths, round2 } from '../sim/math.js';
import { DEFAULT_REWARDS } from '../motivation/types.js';
import { addDays, weekStart } from '../motivation/periods.js';
import { wipeUser, type SeedSummary } from './fin.js';

export const PENNY_USERNAME = 'penny';
export const PENNY_PASSWORD = 'wise';
export const PENNY_SEED_DATE = '2026-10-25';
export const PENNY_BIRTH_DATE = '1993-03-22';
export const PENNY_HISTORY_MONTHS = 18;
/** Weekly amount moved to savings (the saving habit's target). */
export const PENNY_WEEKLY_SAVING = 150;
/** Weekly Shopping cap for penny's spending-swap habit. */
export const PENNY_SHOPPING_CAP = 60;
/** Monday of the first week the habits count. */
export const PENNY_HABIT_START = '2026-03-02';
/** Weeks (Monday keys) with no transfer to savings — a camping trip; they break the first streak. */
export const PENNY_SKIPPED_WEEKS = ['2026-04-13', '2026-04-20'];

type PendingTxn = Omit<Transaction, 'id' | 'userId' | 'accountId'> & { account: string };
type PendingTrade = Omit<InvestmentTransaction, 'id' | 'userId' | 'investmentId'> & { symbol: string };

/**
 * Create (or re-create) penny and all her data. The clock is frozen at the seed
 * date while generating so `createdAt` stamps are deterministic; it is restored afterwards.
 */
export async function seedPenny(db: Database, opts: { asOf?: string; persist?: boolean } = {}): Promise<SeedSummary> {
  const asOf = opts.asOf ?? PENNY_SEED_DATE;
  const previousClock = getClockOverride();
  setClock(`${asOf}T09:00:00.000Z`);
  try {
    let user = db.authenticateUser(PENNY_USERNAME, PENNY_PASSWORD) ?? db.getUserByUsername(PENNY_USERNAME);
    if (user) wipeUser(db, user.id);
    else user = db.createUser(PENNY_USERNAME, PENNY_PASSWORD)!;
    const userId = user.id;

    const rand = mulberry32(19930322);
    const between = (lo: number, hi: number) => round2(lo + rand() * (hi - lo));
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
    const day = (ym: string, d: number) => `${ym}-${String(Math.min(28, Math.max(1, d))).padStart(2, '0')}`;

    const currentYm = asOf.slice(0, 7);
    const months: string[] = [];
    for (let i = PENNY_HISTORY_MONTHS; i >= 0; i--) months.push(addMonths(currentYm, -i));
    const asOfDay = Number(asOf.slice(8, 10));
    const historyStart = `${months[0]}-01`;

    const txns: PendingTxn[] = [];
    const add = (account: string, type: Transaction['type'], category: string, amount: number, date: string, description: string, tags: string[] = []) => {
      if (date > asOf || date < historyStart) return;
      txns.push({ account, type, category, amount: round2(amount), date, description, tags });
    };

    // ── One-offs ──
    add('checking', 'expense', 'Transportation', 780, '2025-05-17', 'New bike — commuter', ['big-ticket']);
    add('card', 'expense', 'Shopping', 240, '2025-08-09', 'Laptop repair');
    add('checking', 'expense', 'Gift', 220, '2025-12-13', 'Christmas gifts');
    add('checking', 'expense', 'Education', 129, '2026-01-18', 'Online course — UX writing');
    add('checking', 'expense', 'Healthcare', 190, '2026-02-10', 'Dentist');
    add('checking', 'income', 'Gift', 150, '2026-03-22', 'Birthday money');
    add('card', 'expense', 'Entertainment', 600, '2026-06-20', 'Norway cycling trip — deposit', ['holiday', 'big-ticket']);
    add('card', 'expense', 'Shopping', 185, '2026-04-11', 'Camping gear', ['holiday']);
    add('checking', 'expense', 'Housing', 150, '2025-11-03', 'Flat-share deposit top-up');

    // ── Recurring cash flows ──
    for (const ym of months) {
      const isCurrent = ym === currentYm;
      const lim = isCurrent ? asOfDay : 28;
      const salary = ym >= '2026-07' ? 4900 : 4650; // pay rise in July 2026
      add('checking', 'income', 'Salary', salary, day(ym, 1), 'Monthly salary — Brightline Studio', ['payroll']);
      add('checking', 'expense', 'Housing', 1350, day(ym, 2), 'Rent — flat share', ['fixed']);
      add('checking', 'expense', 'Housing', 120, day(ym, 4), 'Service charge share', ['fixed']);
      add('checking', 'expense', 'Gift', 150, day(ym, 3), 'Money to mum');
      add('checking', 'expense', 'Utilities', between(95, 145), day(ym, 8), 'Bills share — energy & water');
      add('checking', 'expense', 'Utilities', 30, day(ym, 9), 'Mobile plan', ['fixed']);
      add('checking', 'expense', 'Utilities', 20, day(ym, 10), 'Broadband share', ['fixed']);
      add('checking', 'expense', 'Other', 18, day(ym, 12), 'Contents insurance', ['fixed']);
      add('card', 'expense', 'Entertainment', 11.99, day(ym, 14), 'Streaming subscription');
      add('card', 'expense', 'Healthcare', 45, day(ym, 16), 'Climbing gym pass');
      if (19 <= lim) add('checking', 'expense', 'Healthcare', 85, day(ym, 19), 'Therapy session');
      add('card', 'expense', 'Education', 12.99, day(ym, 13), 'Language app');
      // Groceries: weekly, cooks at home, plus a meal-kit box
      for (const d of [3, 10, 17, 24]) if (d <= lim) add('card', 'expense', 'Food & Dining', between(65, 115), day(ym, d), pick(['Supermarket', 'Market stall', 'Grocery run']));
      if (9 <= lim) add('card', 'expense', 'Food & Dining', 89, day(ym, 9), 'Meal-kit box');
      // Eating out: three times a month
      for (let k = 0; k < 3; k++) { const d = 5 + k * 8 + Math.floor(rand() * 5); if (d <= lim) add('card', 'expense', 'Food & Dining', between(22, 70), day(ym, d), pick(['Lunch with colleagues', 'Pizza night', 'Coffee & cake', 'Ramen', 'Brunch'])); }
      // Transport: no car — a transit pass, the odd train ticket or ride-hail, and bike parts
      add('checking', 'expense', 'Transportation', 95, day(ym, 6), 'Transit pass', ['fixed']);
      if (13 <= lim) add('card', 'expense', 'Transportation', between(25, 75), day(ym, 13), pick(['Train tickets', 'Ride-hail', 'Weekend train']));
      if (rand() < 0.3 && 20 <= lim) add('card', 'expense', 'Transportation', between(12, 48), day(ym, 20), pick(['Bike tube & tyre', 'Bike service', 'Rain jacket repair']));
      // Entertainment
      if (11 <= lim) add('card', 'expense', 'Entertainment', between(12, 50), day(ym, 11), pick(['Cinema', 'Gig tickets', 'Board-game café', 'Books']));
      if (25 <= lim) add('card', 'expense', 'Entertainment', between(30, 90), day(ym, 25), pick(['Concert', 'Climbing competition entry', 'Festival day ticket', 'Theatre']));
      // Shopping: a small one early in the month, a bigger one on the 21st (the swap habit's hit-and-miss)
      if (7 <= lim) add('card', 'expense', 'Shopping', between(10, 40), day(ym, 7), pick(['Stationery', 'Pharmacy bits', 'Phone case', 'Socks']));
      if (21 <= lim) add('card', 'expense', 'Shopping', between(25, 140), day(ym, 21), pick(['Clothing', 'Household bits', 'Headphones', 'Running shoes']));
      if (rand() < 0.35 && 23 <= lim) add('checking', 'expense', 'Healthcare', between(20, 90), day(ym, 23), pick(['Pharmacy', 'GP visit', 'Physio']));
      // Card: interest on the carried balance, then a partial pay-off on the 27th
      if (27 <= lim) {
        add('card', 'expense', 'Other', 28, day(ym, 26), 'Card interest');
        const cardSpend = txns.filter(t => t.account === 'card' && t.type === 'expense' && t.date.startsWith(ym)).reduce((s, t) => s + t.amount, 0);
        const payment = round2(cardSpend * 0.85);
        add('checking', 'expense', 'Transfer', payment, day(ym, 27), 'Credit card payment', ['transfer']);
        add('card', 'income', 'Transfer', payment, day(ym, 27), 'Payment received — thank you', ['transfer']);
      }
      // Student loan: interest, then the monthly repayment on the 15th
      add('loan', 'expense', 'Other', 35, day(ym, 14), 'Loan interest');
      if (15 <= lim) {
        add('checking', 'expense', 'Transfer', 260, day(ym, 15), 'Student loan repayment', ['transfer']);
        add('loan', 'income', 'Transfer', 260, day(ym, 15), 'Repayment received', ['transfer']);
      }
      // Investing: 350 to the fund platform on the 5th
      add('checking', 'expense', 'Investment', 350, day(ym, 5), 'Transfer to fund platform', ['transfer']);
      // Tutoring every other month
      if (months.indexOf(ym) % 2 === 1 && 18 <= lim) add('checking', 'income', 'Freelance', between(180, 420), day(ym, 18), 'Tutoring — maths', ['side-income']);
      // Savings interest
      if (28 <= lim) add('savings', 'income', 'Investment', between(15, 30), day(ym, 28), 'Interest — rainy-day savings');
    }

    // ── Weekly saving: 150 every Monday (skipping the camping weeks) ──
    // Before the habit existed the transfers were already a routine; the habit only starts scoring on PENNY_HABIT_START.
    for (let monday = weekStart(historyStart); monday <= asOf; monday = addDays(monday, 7)) {
      if (PENNY_SKIPPED_WEEKS.includes(monday)) continue;
      add('checking', 'expense', 'Transfer', PENNY_WEEKLY_SAVING, monday, 'Weekly transfer to savings', ['transfer']);
      add('savings', 'income', 'Transfer', PENNY_WEEKLY_SAVING, monday, 'Weekly transfer from current', ['transfer']);
    }

    // ── Accounts: opening balances chosen so that today's balances are the targets ──
    const targets: Record<string, { name: string; type: Account['type']; target: number; currency: string }> = {
      checking: { name: 'Everyday Current', type: 'checking', target: 2610.75, currency: 'USD' },
      savings: { name: 'Rainy-Day Savings', type: 'savings', target: 8200, currency: 'USD' },
      card: { name: 'Cashback Card', type: 'credit', target: 2380.6, currency: 'USD' },
      loan: { name: 'Student Loan', type: 'credit', target: 9780, currency: 'USD' },
      platform: { name: 'Fund Platform Cash', type: 'investment', target: 310, currency: 'USD' },
      wallet: { name: 'Wallet', type: 'cash', target: 45, currency: 'USD' },
    };

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
    for (const [key, spec] of Object.entries(targets)) {
      const acc = db.getAccount(accountIds[key])!;
      acc.balance = round2(acc.balance);
      if (Math.abs(acc.balance - spec.target) > 0.02) throw new Error(`seed(penny): ${key} balance ${acc.balance} ≠ ${spec.target}`);
    }

    // ── Investments: holdings as of 18 months ago, then monthly purchases funded by the 350 transfer ──
    const holdings = [
      { symbol: 'VT', name: 'Vanguard Total World Stock ETF', type: 'etf' as const, shares: 90, avgCost: 98, price0: 105, priceNow: 128, monthlyBuy: 2 },
      { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', type: 'etf' as const, shares: 80, avgCost: 71, price0: 74, priceNow: 84, monthlyBuy: 1 },
      { symbol: 'BND', name: 'Vanguard Total Bond Market ETF', type: 'bond' as const, shares: 40, avgCost: 72.8, price0: 71, priceNow: 73.5, monthlyBuy: 0 },
    ];
    const trades: PendingTrade[] = [];
    const invIds: Record<string, string> = {};
    for (const h of holdings) {
      const inv = db.createInvestment({ userId, symbol: h.symbol, name: h.name, type: h.type, shares: h.shares, avgCost: h.avgCost, currentPrice: h.priceNow, currency: 'USD', notes: '' });
      invIds[h.symbol] = inv.id;
      const steps = PENNY_HISTORY_MONTHS;
      months.forEach((ym, i) => {
        const f = i / steps;
        const trend = h.price0 * Math.pow(h.priceNow / h.price0, f);
        const price = round2(trend * (1 + (rand() - 0.5) * 0.05));
        const date = day(ym, 6);
        if (h.monthlyBuy > 0 && date <= asOf) trades.push({ symbol: h.symbol, type: 'buy', shares: h.monthlyBuy, pricePerShare: price, totalAmount: round2(h.monthlyBuy * price), date, notes: 'Monthly purchase' });
        if (i % 3 === 1 && day(ym, 25) <= asOf) {
          const perShare = h.symbol === 'BND' ? 0.19 : h.symbol === 'SCHD' ? 0.74 : 0.48;
          const sharesNow = h.shares + h.monthlyBuy * (i + 1);
          trades.push({ symbol: h.symbol, type: 'dividend', shares: sharesNow, pricePerShare: perShare, totalAmount: round2(sharesNow * perShare), date: day(ym, 25), notes: 'Quarterly distribution' });
        }
      });
    }
    trades.sort((a, b) => a.date.localeCompare(b.date));
    for (const t of trades) {
      const { symbol, ...rest } = t;
      db.createInvestmentTransaction({ ...rest, userId, investmentId: invIds[symbol] });
    }
    for (const inv of db.getInvestments(userId)) db.updateInvestment(inv.id, { shares: round2(inv.shares * 10000) / 10000, avgCost: round2(inv.avgCost) });

    // ── Budgets for the current month (Shopping is the one that tends to go over) ──
    const current = new Date(`${asOf}T00:00:00Z`);
    const month = current.getUTCMonth();
    const year = current.getUTCFullYear();
    const budgets: [string, number][] = [['Food & Dining', 520], ['Transportation', 160], ['Entertainment', 140], ['Shopping', 120], ['Utilities', 180], ['Housing', 1470]];
    for (const [category, amount] of budgets) {
      db.createBudget({ userId, category, amount, spent: 0, period: 'monthly', month, year });
      db.recalculateBudgetSpent(userId, category, month, year);
    }

    // ── Goals ──
    db.createGoal({ userId, name: 'Student loan gone', targetAmount: 12000, currentAmount: 2220, deadline: '2029-12-31', category: 'Debt', priority: 'high', notes: 'Overpay when tutoring money comes in.' });
    db.createGoal({ userId, name: 'Emergency fund (3 months)', targetAmount: 8500, currentAmount: 8200, deadline: '2026-12-31', category: 'Emergency', priority: 'high', notes: 'Rainy-day savings.' });
    db.createGoal({ userId, name: 'Deposit for my own place', targetAmount: 30000, currentAmount: 4000, deadline: '2030-06-30', category: 'House', priority: 'medium', notes: 'After the loan is gone.' });
    db.createGoal({ userId, name: 'Cycling trip — Norway', targetAmount: 1800, currentAmount: 600, deadline: '2027-07-01', category: 'Travel', priority: 'low', notes: 'Deposit paid in June.' });

    // ── Profile ──
    db.upsertProfile(userId, { birthDate: PENNY_BIRTH_DATE, retirementAge: 60, safeWithdrawalRate: 0.035, planToAge: 90 });

    // ── Habits: a weekly saving target and a weekly Shopping cap, both from the first Monday of March 2026 ──
    db.createHabit({ userId, kind: 'save', name: 'Weekly saving', cadence: 'weekly', amount: PENNY_WEEKLY_SAVING, accountId: accountIds.savings, startDate: PENNY_HABIT_START });
    db.createHabit({ userId, kind: 'swap', name: 'Shopping swap', cadence: 'weekly', amount: PENNY_SHOPPING_CAP, category: 'Shopping', startDate: PENNY_HABIT_START });

    // ── Rewards: the suggested list and the three treats enjoyed so far ──
    const rewardIds: Record<string, string> = {};
    for (const r of DEFAULT_REWARDS) rewardIds[r.name] = db.createReward({ userId, ...r }).id;
    // Claims are dated when the running balance covered them (the API enforces this; the seed mirrors it).
    // The last claim is recent, so the 30-day nudge does not fire on the seed date.
    const claim = (name: string, date: string) => {
      const r = DEFAULT_REWARDS.find(d => d.name === name)!;
      if (date <= asOf) db.createRewardClaim({ userId, rewardId: rewardIds[name], name: r.name, cost: r.cost, note: r.note, date });
    };
    claim('Brunch at the coffee shop', '2026-06-13');
    claim('Dinner for two', '2026-08-15');
    claim('Brunch at the coffee shop', '2026-10-10');

    // ── FI milestones: progress is under 5 %, so only the FI date has been sighted (value set from the simulator) ──
    db.createMilestone({ userId, kind: 'fi-date', value: '2050-04', date: '2026-05-25', detail: 'FI date first in sight: April 2050' });

    // ── Scenarios ──
    const scenarios = [
      normalizeScenario({ name: 'Keep going', description: 'No changes — current habits, moderate economy.', economy: { preset: 'moderate' }, events: [] }),
      normalizeScenario({
        name: 'Loan gone by 2027',
        description: 'Clear the student loan with savings next spring, then redirect the repayment into investing.',
        economy: { preset: 'moderate' },
        events: [
          createEvent('pay_off_debt', { id: 'loan-payoff', label: 'Pay off the student loan', startMonth: 6, amount: 9000 }),
          createEvent('contribution', { id: 'redirect', label: 'Invest the old repayment', startMonth: 7, amount: 260 }),
        ],
      }),
      normalizeScenario({
        name: 'Move out in 2028',
        description: 'A place of my own: rent roughly doubles from early 2028 — in a pessimistic economy retiring at 60 stops adding up.',
        economy: { preset: 'pessimistic' },
        events: [createEvent('lifestyle', { id: 'own-place', label: 'Renting alone', startMonth: 15, amount: 1050 })],
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
      habits: db.getHabits(userId).length,
      rewards: db.getRewards(userId).length,
      claims: db.getRewardClaims(userId).length,
      asOf: today(),
    };
  } finally {
    setClock(previousClock);
  }
}
