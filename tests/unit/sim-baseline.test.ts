import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBaseline } from '../../src/sim/baseline.js';
import type { Account, Transaction, Investment, InvestmentTransaction } from '../../src/db/database.js';

const U = 'user-1';
const acc = (id: string, type: Account['type'], balance: number): Account => ({ id, userId: U, name: id, type, balance, currency: 'USD', createdAt: '' });
const txn = (accountId: string, type: Transaction['type'], category: string, amount: number, date: string): Transaction =>
  ({ id: `${date}-${category}-${amount}`, userId: U, accountId, type, category, amount, description: '', date, tags: [] });
const trade = (type: InvestmentTransaction['type'], total: number, date: string): InvestmentTransaction =>
  ({ id: `${date}-${type}`, userId: U, investmentId: 'inv-1', type, shares: 1, pricePerShare: total, totalAmount: total, date, notes: '' });

/** 12 complete months (Oct 2025 – Sep 2026) of salary, rent, groceries and a monthly investment transfer. */
function history() {
  const transactions: Transaction[] = [];
  const trades: InvestmentTransaction[] = [];
  for (let i = 0; i < 12; i++) {
    const ym = i < 3 ? `2025-${String(10 + i).padStart(2, '0')}` : `2026-${String(i - 2).padStart(2, '0')}`;
    transactions.push(txn('chk', 'income', 'Salary', 6000, `${ym}-01`));
    transactions.push(txn('chk', 'expense', 'Housing', 1800, `${ym}-02`));
    transactions.push(txn('chk', 'expense', 'Food & Dining', 600, `${ym}-15`));
    transactions.push(txn('chk', 'expense', 'Investment', 1000, `${ym}-03`)); // transfer to brokerage: not spending
    trades.push(trade('buy', 1000, `${ym}-04`));
  }
  // Current (partial) month must be ignored by the window.
  transactions.push(txn('chk', 'income', 'Salary', 99999, '2026-10-01'));
  transactions.push(txn('chk', 'expense', 'Shopping', 99999, '2026-10-20'));
  trades.push(trade('buy', 99999, '2026-10-05'));
  // One bonus in the window so income is not perfectly flat.
  transactions.push(txn('chk', 'income', 'Freelance', 2400, '2026-06-20'));
  // A card payment recorded as income on the card account is a transfer, not income.
  transactions.push(txn('cc', 'income', 'Transfer', 5000, '2026-06-21'));
  transactions.push(txn('chk', 'expense', 'Transfer', 5000, '2026-06-21'));
  return { transactions, trades };
}

describe('sim/baseline', () => {
  test('buckets accounts and values holdings', () => {
    const b = deriveBaseline(
      {
        accounts: [acc('chk', 'checking', 4000), acc('sav', 'savings', 20000), acc('cash', 'cash', 300), acc('cc', 'credit', 1500), acc('cc-overpaid', 'credit', -100), acc('brk', 'investment', 5000)],
        transactions: [],
        investments: [{ id: 'inv-1', userId: U, symbol: 'VTI', name: 'VTI', type: 'etf', shares: 100, avgCost: 200, currentPrice: 250, currency: 'USD', notes: '', createdAt: '' }],
        investmentTransactions: [],
      },
      { asOf: '2026-10-25' },
    );
    assert.equal(b.liquid, 24400, 'an overpaid card counts as cash');
    assert.equal(b.debt, 1500);
    assert.equal(b.invested, 25000 + 5000);
    assert.equal(b.detail.holdingsValue, 25000);
    assert.deepEqual(b.detail.accounts.map(a => a.bucket), ['liquid', 'liquid', 'liquid', 'debt', 'debt', 'invested']);
    assert.equal(b.monthlyIncome, 0);
    assert.equal(b.monthlyExpenses, 0);
    assert.equal(b.lookbackMonths, 1, 'no history → single-month fallback');
  });

  test('averages the last 12 complete months and ignores transfers and the partial month', () => {
    const { transactions, trades } = history();
    const b = deriveBaseline({ accounts: [acc('chk', 'checking', 1000)], transactions, investments: [], investmentTransactions: trades }, { asOf: '2026-10-25' });
    assert.equal(b.lookbackMonths, 12);
    assert.equal(b.detail.windowStart, '2025-10');
    assert.equal(b.detail.windowEnd, '2026-09');
    assert.equal(b.monthlyIncome, 6200); // (12×6000 + 2400) / 12
    assert.equal(b.monthlyExpenses, 2400); // 1800 + 600; 'Investment' excluded
    assert.equal(b.monthlyContribution, 1000);
    assert.deepEqual(b.detail.expenseByCategory, { Housing: 1800, 'Food & Dining': 600 });
    assert.equal(b.detail.incomeMonths, 12);
  });

  test('shorter look-back window', () => {
    const { transactions, trades } = history();
    const b = deriveBaseline({ accounts: [], transactions, investments: [], investmentTransactions: trades }, { asOf: '2026-10-25', lookbackMonths: 3 });
    assert.equal(b.lookbackMonths, 3);
    assert.equal(b.detail.windowStart, '2026-07');
    assert.equal(b.monthlyIncome, 6000); // bonus in June is outside
  });

  test('thin history falls back to the months that exist (including the current one)', () => {
    const transactions = [
      txn('chk', 'income', 'Salary', 5000, '2026-10-01'),
      txn('chk', 'expense', 'Housing', 1500, '2026-10-02'),
    ];
    const b = deriveBaseline({ accounts: [], transactions, investments: [], investmentTransactions: [] }, { asOf: '2026-10-25' });
    assert.equal(b.lookbackMonths, 1);
    assert.equal(b.monthlyIncome, 5000);
    assert.equal(b.monthlyExpenses, 1500);
    assert.equal(b.detail.windowStart, '2026-10');
    assert.equal(b.detail.windowEnd, '2026-10');
  });

  test('future-dated transactions are ignored', () => {
    const transactions = [txn('chk', 'income', 'Salary', 5000, '2026-09-01'), txn('chk', 'income', 'Salary', 77777, '2027-01-01')];
    const b = deriveBaseline({ accounts: [], transactions, investments: [], investmentTransactions: [] }, { asOf: '2026-10-25', lookbackMonths: 1 });
    assert.equal(b.monthlyIncome, 5000);
  });
});
