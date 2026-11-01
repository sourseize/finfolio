/**
 * Two anonymous personas that exist only as comparison snapshots — no user,
 * no password, nothing in the database. `npm run seed` writes them next to
 * fin's and penny's files so either demo user has three people to compare with.
 *
 *   Anonymous A — mid-forties, high earner and high spender: ~11 900 income,
 *                 ~8 500 spending (savings rate ≈ 29 %), a car loan and a card
 *                 paid in full, a growth-heavy portfolio, a monthly investing
 *                 habit on a streak and an entertainment cap that is more
 *                 often missed than met. Net worth ~175k, yet FI is never reached before 92 on
 *                 current habits — the report's "no FI date" path.
 *   Anonymous B — early fifties, frugal late starter: ~4 050 income, ~2 400
 *                 spending (savings rate ≈ 41 %), no debt, three index funds,
 *                 a weekly saving streak of more than a year (Unstoppable,
 *                 Thousand), two FI rungs, five rewards enjoyed — and no FI
 *                 date either, starting this late.
 *
 * The data is generated in memory as plain records (ids are short strings that
 * never leave the builder) and fed to the same `buildSnapshot` the export
 * route uses, with the clock frozen on the seed date — so the files are real,
 * deterministic snapshots, not hand-written JSON.
 */
import type { Account, Budget, Goal, Investment, InvestmentTransaction, Transaction } from '../db/database.js';
import type { Habit, Milestone, Reward, RewardClaim } from '../motivation/types.js';
import { DEFAULT_REWARDS } from '../motivation/types.js';
import { addDays, weekStart } from '../motivation/periods.js';
import { mulberry32 } from '../sim/montecarlo.js';
import { addMonths, round2 } from '../sim/math.js';
import { buildSnapshot, type SnapshotSource } from '../compare/snapshot.js';
import type { Snapshot } from '../compare/types.js';
import { FIN_SEED_DATE } from './fin.js';

export interface AnonymousPersona {
  label: string;
  source: SnapshotSource;
}

type TxnType = Transaction['type'];

/** Small in-memory record factory: sequential ids, fixed timestamps, nothing persisted. */
class Persona {
  readonly src: SnapshotSource = { accounts: [], transactions: [], investments: [], investmentTransactions: [], goals: [], budgets: [], habits: [], rewards: [], claims: [], milestones: [] };
  private n = 0;
  private readonly stamp: string;
  readonly rand: () => number;
  readonly months: string[];
  readonly asOfDay: number;
  readonly currentYm: string;

  constructor(readonly asOf: string, seed: number, historyMonths: number) {
    this.stamp = `${asOf}T09:00:00.000Z`;
    this.rand = mulberry32(seed);
    this.currentYm = asOf.slice(0, 7);
    this.months = [];
    for (let i = historyMonths; i >= 0; i--) this.months.push(addMonths(this.currentYm, -i));
    this.asOfDay = Number(asOf.slice(8, 10));
  }

  id(prefix: string): string { return `${prefix}${++this.n}`; }
  between(lo: number, hi: number): number { return round2(lo + this.rand() * (hi - lo)); }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.rand() * arr.length)]; }
  day(ym: string, d: number): string { return `${ym}-${String(Math.min(28, Math.max(1, d))).padStart(2, '0')}`; }
  /** Last day of the month that can carry a transaction (the current month stops at asOf). */
  limit(ym: string): number { return ym === this.currentYm ? this.asOfDay : 28; }

  account(name: string, type: Account['type'], balance: number): Account {
    const a: Account = { id: this.id('a'), userId: 'anon', name, type, balance, currency: 'USD', createdAt: this.stamp };
    this.src.accounts.push(a);
    return a;
  }

  txn(account: Account, type: TxnType, category: string, amount: number, date: string, description: string, tags: string[] = []): void {
    if (date > this.asOf) return;
    this.src.transactions.push({ id: this.id('t'), userId: 'anon', accountId: account.id, type, category, amount: round2(amount), description, date, tags });
  }

  /** The same amount on the same day of every month in the history (stopping at asOf in the current month). */
  monthly(account: Account, type: TxnType, category: string, amount: number | [number, number], day: number, description: string | string[], tags: string[] = []): void {
    for (const ym of this.months) {
      if (day > this.limit(ym)) continue;
      const value = Array.isArray(amount) ? this.between(amount[0], amount[1]) : amount;
      this.txn(account, type, category, value, this.day(ym, day), Array.isArray(description) ? this.pick(description) : description, tags);
    }
  }

  /** Transfer out of `from` into `to` on a day of the month (a pair of `Transfer` rows). */
  monthlyTransfer(from: Account, to: Account, amount: number, day: number, label: string): void {
    for (const ym of this.months) {
      if (day > this.limit(ym)) continue;
      this.txn(from, 'expense', 'Transfer', amount, this.day(ym, day), `Transfer to ${label}`, ['transfer']);
      this.txn(to, 'income', 'Transfer', amount, this.day(ym, day), `Transfer from ${from.name}`, ['transfer']);
    }
  }

  /** Weekly transfer every Monday of the history, skipping the given Mondays. */
  weeklyTransfer(from: Account, to: Account, amount: number, label: string, skip: string[] = []): void {
    for (let monday = weekStart(`${this.months[0]}-01`); monday <= this.asOf; monday = addDays(monday, 7)) {
      if (skip.includes(monday)) continue;
      this.txn(from, 'expense', 'Transfer', amount, monday, `Weekly transfer to ${label}`, ['transfer']);
      this.txn(to, 'income', 'Transfer', amount, monday, `Weekly transfer from ${from.name}`, ['transfer']);
    }
  }

  /** A holding with its monthly purchase trades (price interpolated from `price0` to `priceNow`) and quarterly dividends. */
  holding(symbol: string, name: string, type: Investment['type'], shares: number, avgCost: number, price0: number, priceNow: number, monthlyBuy: number, dividendPerShare = 0): Investment {
    const inv: Investment = { id: this.id('i'), userId: 'anon', symbol, name, type, shares, avgCost, currentPrice: priceNow, currency: 'USD', notes: '', createdAt: this.stamp };
    this.src.investments.push(inv);
    const steps = Math.max(1, this.months.length - 1);
    this.months.forEach((ym, i) => {
      const trend = price0 * Math.pow(priceNow / price0, i / steps);
      const price = round2(trend * (1 + (this.rand() - 0.5) * 0.06));
      const date = this.day(ym, 6);
      if (monthlyBuy > 0 && date <= this.asOf) {
        this.src.investmentTransactions.push({ id: this.id('x'), investmentId: inv.id, userId: 'anon', type: 'buy', shares: monthlyBuy, pricePerShare: price, totalAmount: round2(monthlyBuy * price), date, notes: '' });
        inv.avgCost = round2((inv.avgCost * inv.shares + price * monthlyBuy) / (inv.shares + monthlyBuy));
        inv.shares = round2(inv.shares + monthlyBuy);
      }
      if (dividendPerShare > 0 && i % 3 === 2 && this.day(ym, 25) <= this.asOf) {
        this.src.investmentTransactions.push({ id: this.id('x'), investmentId: inv.id, userId: 'anon', type: 'dividend', shares: inv.shares, pricePerShare: dividendPerShare, totalAmount: round2(inv.shares * dividendPerShare), date: this.day(ym, 25), notes: '' });
      }
    });
    return inv;
  }

  goal(name: string, category: string, priority: Goal['priority'], targetAmount: number, currentAmount: number, deadline: string): void {
    this.src.goals.push({ id: this.id('g'), userId: 'anon', name, targetAmount, currentAmount, deadline, category, priority, notes: '', createdAt: this.stamp });
  }

  /** Budgets for the current month; `spent` is computed from the transactions like the API does. */
  budget(category: string, amount: number): void {
    const d = new Date(`${this.asOf}T00:00:00Z`);
    const spent = this.src.transactions
      .filter(t => t.category === category && t.type === 'expense' && t.date.startsWith(this.currentYm))
      .reduce((s, t) => s + Math.abs(t.amount), 0);
    const b: Budget = { id: this.id('b'), userId: 'anon', category, amount, spent: round2(spent), period: 'monthly', month: d.getUTCMonth(), year: d.getUTCFullYear() };
    this.src.budgets.push(b);
  }

  habit(kind: Habit['kind'], name: string, cadence: Habit['cadence'], amount: number, startDate: string, extra: { category?: string; accountId?: string } = {}): void {
    const h: Habit = { id: this.id('h'), userId: 'anon', kind, name, cadence, amount, startDate, createdAt: this.stamp, ...extra };
    this.src.habits.push(h);
  }

  defaultRewards(): Record<string, Reward> {
    const out: Record<string, Reward> = {};
    for (const r of DEFAULT_REWARDS) {
      const reward: Reward = { id: this.id('r'), userId: 'anon', ...r, createdAt: this.stamp };
      this.src.rewards.push(reward);
      out[r.name] = reward;
    }
    return out;
  }

  claim(reward: Reward, date: string): void {
    if (date > this.asOf) return;
    const c: RewardClaim = { id: this.id('c'), userId: 'anon', rewardId: reward.id, name: reward.name, cost: reward.cost, note: reward.note, date, createdAt: this.stamp };
    this.src.claims.push(c);
  }

  milestone(m: Omit<Milestone, 'id' | 'userId' | 'createdAt'>): void {
    this.src.milestones.push({ id: this.id('m'), userId: 'anon', createdAt: this.stamp, ...m });
  }
}

/** Anonymous A — high earner, high spender, mid-forties. */
export function anonymousA(asOf = FIN_SEED_DATE): AnonymousPersona {
  const p = new Persona(asOf, 19790514, 24);
  const checking = p.account('Household checking', 'checking', 6200);
  const savings = p.account('Savings', 'savings', 15000);
  const brokerage = p.account('Brokerage cash', 'investment', 1900);
  const card = p.account('Platinum card', 'credit', 0);
  const carLoan = p.account('Car loan', 'credit', 14500);

  p.monthly(checking, 'income', 'Salary', 11200, 1, 'Salary', ['payroll']);
  p.txn(checking, 'income', 'Salary', 8000, '2025-03-14', 'Annual bonus', ['payroll']);
  p.txn(checking, 'income', 'Salary', 8500, '2026-03-13', 'Annual bonus', ['payroll']);
  p.monthly(checking, 'expense', 'Housing', 3600, 2, 'Mortgage payment', ['fixed']);
  p.monthly(checking, 'expense', 'Utilities', [300, 460], 8, 'Electricity, gas & water');
  p.monthly(checking, 'expense', 'Utilities', 95, 9, 'Phones & broadband', ['fixed']);
  p.monthly(checking, 'expense', 'Other', 320, 12, 'Insurance bundle', ['fixed']);
  p.monthly(checking, 'expense', 'Education', 150, 4, 'Kids\' classes');
  p.monthly(checking, 'expense', 'Transportation', [180, 280], 6, 'Fuel');
  p.monthly(checking, 'expense', 'Healthcare', [120, 380], 23, ['Pharmacy', 'Dentist', 'Specialist visit']);
  p.monthly(checking, 'expense', 'Gift', 150, 18, 'Family support');
  for (const d of [3, 10, 17, 24]) p.monthly(card, 'expense', 'Food & Dining', [150, 260], d, ['Supermarket', 'Wholesale club', 'Grocery delivery']);
  for (const d of [5, 13, 20, 27]) p.monthly(card, 'expense', 'Food & Dining', [45, 140], d, ['Restaurant', 'Takeaway', 'Brunch', 'Work lunches']);
  p.monthly(card, 'expense', 'Entertainment', [250, 700], 11, ['Concert tickets', 'Weekend trip', 'Golf', 'Theatre']);
  p.monthly(card, 'expense', 'Entertainment', 49.99, 14, 'Streaming bundle');
  p.monthly(card, 'expense', 'Shopping', [400, 900], 21, ['Clothing', 'Electronics', 'Home', 'Sports gear']);
  p.txn(card, 'expense', 'Shopping', 3200, '2025-11-22', 'New TV and sound system', ['big-ticket']);
  p.txn(card, 'expense', 'Entertainment', 6400, '2026-08-02', 'Family holiday — Italy', ['holiday', 'big-ticket']);
  p.txn(checking, 'expense', 'Transportation', 1250, '2026-02-17', 'Car service & tyres', ['big-ticket']);
  // Card paid in full on the 27th; what is owed today is this month's spend since the last pay-off.
  for (const ym of p.months) {
    if (27 > p.limit(ym)) continue;
    const spend = p.src.transactions.filter(t => t.accountId === card.id && t.type === 'expense' && t.date.startsWith(ym)).reduce((s, t) => s + t.amount, 0);
    p.txn(checking, 'expense', 'Transfer', round2(spend), p.day(ym, 27), 'Card payment', ['transfer']);
    p.txn(card, 'income', 'Transfer', round2(spend), p.day(ym, 27), 'Payment received', ['transfer']);
  }
  card.balance = round2(p.src.transactions.filter(t => t.accountId === card.id && t.type === 'expense' && t.date > `${p.currentYm}-27`).reduce((s, t) => s + t.amount, 0));
  p.monthly(carLoan, 'expense', 'Other', 85, 14, 'Loan interest');
  p.monthlyTransfer(checking, carLoan, 420, 15, 'car loan');
  p.monthlyTransfer(checking, savings, 800, 5, 'savings');
  p.monthly(checking, 'expense', 'Investment', 1500, 5, 'Transfer to brokerage', ['transfer']);
  p.monthly(savings, 'income', 'Investment', [28, 45], 28, 'Savings interest');
  void brokerage;

  p.holding('VOO', 'Vanguard S&P 500 ETF', 'etf', 100, 392, 430, 520, 2, 1.6);
  p.holding('QQQ', 'Invesco QQQ', 'etf', 45, 335, 380, 480, 1, 0.6);
  p.holding('AAPL', 'Apple Inc.', 'stock', 90, 140, 172, 231.4, 0, 0.25);
  p.holding('TSLA', 'Tesla', 'stock', 40, 210, 240, 250, 0);
  p.holding('BND', 'Vanguard Total Bond Market ETF', 'bond', 200, 73, 71, 73.5, 0, 0.19);
  p.holding('ETH', 'Ether', 'crypto', 3, 2400, 2600, 3100, 0);

  p.budget('Food & Dining', 1000);
  p.budget('Entertainment', 600);
  p.budget('Shopping', 800);
  p.budget('Transportation', 700);
  p.budget('Utilities', 450);

  p.goal('Kids\' college fund', 'Education', 'high', 120000, 38000, '2034-09-01');
  p.goal('Pay off the car', 'Debt', 'medium', 22000, 7500, '2028-06-30');
  p.goal('Kitchen renovation', 'House', 'medium', 35000, 12000, '2027-09-30');
  p.goal('Retire at 62', 'Retirement', 'low', 2500000, 0, '2041-05-14');

  p.src.profile = { birthDate: '1979-05-14', retirementAge: 62, safeWithdrawalRate: 0.04, planToAge: 92 };

  p.habit('invest', 'Monthly investing', 'monthly', 1500, '2025-11-01');
  p.habit('swap', 'Entertainment cap', 'monthly', 500, '2025-11-01', { category: 'Entertainment' });
  const rewards = p.defaultRewards();
  p.claim(rewards['Dinner for two'], '2026-06-20');
  p.claim(rewards['Brunch at the coffee shop'], '2026-10-17');

  // FI progress ≈ 7 %; on current habits the FI number is never reached before 92, so no FI date has ever been sighted.
  p.milestone({ kind: 'fi-progress', level: 5, value: 0.0541, date: '2026-02-25', detail: '5% of your FI number' });

  return { label: 'Anonymous A', source: p.src };
}

/** Anonymous B — frugal late starter, early fifties. */
export function anonymousB(asOf = FIN_SEED_DATE): AnonymousPersona {
  const p = new Persona(asOf, 19740930, 24);
  const checking = p.account('Current account', 'checking', 2900);
  const savings = p.account('Savings', 'savings', 26000);
  const pension = p.account('Pension cash', 'investment', 600);
  const wallet = p.account('Wallet', 'cash', 120);
  void pension; void wallet;

  p.monthly(checking, 'income', 'Salary', 3950, 1, 'Salary', ['payroll']);
  p.monthly(checking, 'expense', 'Housing', 1100, 2, 'Rent', ['fixed']);
  p.monthly(checking, 'expense', 'Utilities', [150, 230], 8, 'Energy & water');
  p.monthly(checking, 'expense', 'Utilities', 28, 9, 'Mobile', ['fixed']);
  p.monthly(checking, 'expense', 'Other', 70, 12, 'Insurance', ['fixed']);
  p.monthly(checking, 'expense', 'Transportation', 140, 6, 'Bus pass', ['fixed']);
  p.monthly(checking, 'expense', 'Healthcare', [60, 180], 19, ['Pharmacy', 'Optician', 'GP visit']);
  for (const d of [3, 10, 17, 24]) p.monthly(checking, 'expense', 'Food & Dining', [70, 120], d, ['Supermarket', 'Market', 'Bakery']);
  p.monthly(checking, 'expense', 'Food & Dining', [15, 35], 20, ['Café', 'Fish and chips']);
  p.monthly(checking, 'expense', 'Entertainment', [30, 90], 11, ['Cinema', 'Library fines', 'Garden centre', 'Day out']);
  p.monthly(checking, 'expense', 'Shopping', [40, 140], 21, ['Clothes', 'Hardware store', 'Gifts']);
  p.monthly(checking, 'expense', 'Gift', 40, 16, 'Grandchildren');
  p.txn(checking, 'expense', 'Healthcare', 480, '2025-08-11', 'New glasses');
  p.txn(checking, 'expense', 'Shopping', 650, '2026-01-20', 'Washing machine', ['big-ticket']);
  p.txn(checking, 'expense', 'Entertainment', 900, '2026-06-15', 'Coach holiday — Scotland', ['holiday']);
  p.txn(checking, 'income', 'Freelance', 600, '2026-05-22', 'Allotment produce & jam', ['side-income']);
  p.weeklyTransfer(checking, savings, 150, 'savings');
  p.monthly(checking, 'expense', 'Investment', 800, 5, 'Transfer to pension', ['transfer']);
  p.monthly(savings, 'income', 'Investment', [55, 80], 28, 'Savings interest');

  p.holding('VTI', 'Vanguard Total Stock Market ETF', 'etf', 180, 198, 205, 268, 3, 0.92);
  p.holding('VXUS', 'Vanguard Total International ETF', 'etf', 120, 55, 54, 64.2, 0, 0.55);
  p.holding('BND', 'Vanguard Total Bond Market ETF', 'bond', 110, 72, 71, 73.5, 0, 0.19);

  p.budget('Food & Dining', 400);
  p.budget('Utilities', 220);
  p.budget('Entertainment', 80);
  p.budget('Shopping', 80);

  p.goal('Retire at 67', 'Retirement', 'high', 900000, 56000, '2041-09-30');
  p.goal('Roof repair', 'House', 'high', 9000, 6500, '2027-04-30');
  p.goal('Visit family in New Zealand', 'Travel', 'medium', 5500, 2100, '2027-12-20');

  p.src.profile = { birthDate: '1974-09-30', retirementAge: 67, safeWithdrawalRate: 0.035, planToAge: 90 };

  p.habit('save', 'Weekly saving', 'weekly', 150, '2025-06-02', { accountId: savings.id });
  p.habit('invest', 'Monthly pension top-up', 'monthly', 800, '2025-06-01');
  const rewards = p.defaultRewards();
  p.claim(rewards['Brunch at the coffee shop'], '2025-09-06');
  p.claim(rewards['Dinner for two'], '2025-12-20');
  p.claim(rewards['Brunch at the coffee shop'], '2026-03-14');
  p.claim(rewards['Family dinner out'], '2026-06-27');
  p.claim(rewards['Dinner for two'], '2026-10-03');

  // FI progress ≈ 14 % (two rungs); starting at 50 the FI number stays out of reach, so there is no FI date.
  p.milestone({ kind: 'fi-progress', level: 5, value: 0.0612, date: '2024-12-25', detail: '5% of your FI number' });
  p.milestone({ kind: 'fi-progress', level: 10, value: 0.1003, date: '2026-06-25', detail: '10% of your FI number' });

  return { label: 'Anonymous B', source: p.src };
}

export function anonymousPersonas(asOf = FIN_SEED_DATE): AnonymousPersona[] {
  return [anonymousA(asOf), anonymousB(asOf)];
}

/** Build the snapshot of an anonymous persona as of the seed date. */
export function anonymousSnapshot(persona: AnonymousPersona, opts: { asOf?: string; appVersion?: string } = {}): Snapshot {
  const asOf = opts.asOf ?? FIN_SEED_DATE;
  return buildSnapshot(persona.source, { today: asOf, now: `${asOf}T09:00:00.000Z`, label: persona.label, appVersion: opts.appVersion });
}
