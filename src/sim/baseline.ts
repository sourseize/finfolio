import { isLiabilityAccount, isIncomeTxn, isSpendingTxn, type Account, type Transaction, type Investment, type InvestmentTransaction } from '../db/database.js';
import type { Baseline } from './types.js';
import { addMonths, round2 } from './math.js';

export interface BaselineSource {
  accounts: Account[];
  transactions: Transaction[];
  investments: Investment[];
  investmentTransactions: InvestmentTransaction[];
}

export interface BaselineOptions {
  /** YYYY-MM-DD; simulation month 0. */
  asOf: string;
  /** Calendar months of history to average (default 12). The current, partial month is excluded. */
  lookbackMonths?: number;
}

/**
 * Derive the simulation starting point from what the user has actually recorded.
 *
 * - Liquid / invested / debt come from account balances and holdings *today*.
 * - Monthly income / expenses / contribution are averages over the last
 *   `lookbackMonths` complete calendar months. If history is shorter, the
 *   average is over the months that do have activity, so a new user with a
 *   single month of data still gets a sensible run-rate.
 */
export function deriveBaseline(src: BaselineSource, opts: BaselineOptions): Baseline {
  const lookback = Math.max(1, Math.round(opts.lookbackMonths ?? 12));
  const asOfMonth = opts.asOf.slice(0, 7);

  // ── Balances ──
  let liquid = 0;
  let debt = 0;
  let investedAccounts = 0;
  const accounts = src.accounts.map(a => {
    let bucket: 'liquid' | 'invested' | 'debt';
    if (isLiabilityAccount(a)) {
      bucket = 'debt';
      // Credit balance = amount owed (positive). A negative balance is an overpayment
      // sitting on the card, which is effectively cash.
      if (a.balance >= 0) debt += a.balance;
      else liquid += -a.balance;
    } else if (a.type === 'investment') {
      bucket = 'invested';
      investedAccounts += a.balance;
    } else {
      // checking / savings / cash (and anything unknown) is treated as spendable cash
      bucket = 'liquid';
      liquid += a.balance;
    }
    return { id: a.id, name: a.name, type: a.type, balance: a.balance, bucket };
  });

  const holdingsValue = src.investments.reduce((s, i) => s + i.shares * i.currentPrice, 0);
  const invested = holdingsValue + investedAccounts;

  // ── Cash-flow window: the `lookback` complete months before asOf's month ──
  const windowEnd = addMonths(asOfMonth, -1); // last complete month (YYYY-MM)
  const windowStart = addMonths(asOfMonth, -lookback);

  const inWindow = (date: string) => {
    const m = date.slice(0, 7);
    return m >= windowStart && m <= windowEnd;
  };

  let txns = src.transactions.filter(t => inWindow(t.date));
  let trades = src.investmentTransactions.filter(t => inWindow(t.date));

  // Fallback for thin histories: use everything up to and including the current month.
  let usedFallback = false;
  if (txns.length === 0) {
    txns = src.transactions.filter(t => t.date.slice(0, 7) <= asOfMonth);
    trades = src.investmentTransactions.filter(t => t.date.slice(0, 7) <= asOfMonth);
    usedFallback = true;
  }

  const monthsWithActivity = new Set<string>();
  for (const t of txns) monthsWithActivity.add(t.date.slice(0, 7));
  const monthCount = usedFallback ? Math.max(1, monthsWithActivity.size) : lookback;

  let income = 0;
  let expenses = 0;
  const expenseByCategory: Record<string, number> = {};
  for (const t of txns) {
    if (isIncomeTxn(t)) income += t.amount;
    else if (isSpendingTxn(t)) {
      expenses += Math.abs(t.amount);
      expenseByCategory[t.category] = (expenseByCategory[t.category] || 0) + Math.abs(t.amount);
    }
  }
  const contributions = trades.filter(t => t.type === 'buy').reduce((s, t) => s + t.totalAmount, 0);

  for (const k of Object.keys(expenseByCategory)) expenseByCategory[k] = round2(expenseByCategory[k] / monthCount);

  return {
    asOf: opts.asOf,
    liquid: round2(liquid),
    invested: round2(invested),
    debt: round2(debt),
    monthlyIncome: round2(income / monthCount),
    monthlyExpenses: round2(expenses / monthCount),
    monthlyContribution: round2(contributions / monthCount),
    lookbackMonths: monthCount,
    detail: {
      accounts,
      holdingsValue: round2(holdingsValue),
      incomeMonths: monthsWithActivity.size,
      windowStart: usedFallback ? (txns[0] ? [...monthsWithActivity].sort()[0] : asOfMonth) : windowStart,
      windowEnd: usedFallback ? asOfMonth : windowEnd,
      expenseByCategory,
    },
  };
}
