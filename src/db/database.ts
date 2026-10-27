import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, nowIso } from '../util/clock.js';
import type { Profile, Scenario } from '../sim/types.js';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

/**
 * Account balance convention:
 *  - Asset accounts (checking, savings, cash, investment): balance is what you own.
 *  - Credit accounts: balance is what you OWE, stored as a positive number.
 *    An expense on a credit account increases the balance; an income (payment,
 *    refund) decreases it. See `isLiabilityAccount` / `signedBalance`.
 */
export interface Account {
  id: string;
  userId: string;
  name: string;
  type: 'checking' | 'savings' | 'investment' | 'credit' | 'cash';
  balance: number;
  currency: string;
  createdAt: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  userId: string;
  type: 'income' | 'expense' | 'transfer' | 'investment';
  category: string;
  amount: number;
  description: string;
  date: string;
  tags: string[];
}

export interface Budget {
  id: string;
  userId: string;
  category: string;
  amount: number;
  spent: number;
  period: 'weekly' | 'monthly' | 'yearly';
  month: number;
  year: number;
}

export interface Investment {
  id: string;
  userId: string;
  symbol: string;
  name: string;
  type: 'stock' | 'crypto' | 'etf' | 'mutual_fund' | 'bond' | 'real_estate' | 'other';
  shares: number;
  avgCost: number;
  currentPrice: number;
  currency: string;
  notes: string;
  createdAt: string;
}

export interface InvestmentTransaction {
  id: string;
  investmentId: string;
  userId: string;
  type: 'buy' | 'sell' | 'dividend';
  shares: number;
  pricePerShare: number;
  totalAmount: number;
  date: string;
  notes: string;
}

export interface Goal {
  id: string;
  userId: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  deadline: string;
  category: string;
  priority: 'low' | 'medium' | 'high';
  notes: string;
  createdAt: string;
}

/** Per-user planning assumptions used by the simulator. */
export interface UserProfile extends Profile {
  userId: string;
  updatedAt: string;
}

/** A saved what-if scenario. */
export interface StoredScenario extends Scenario {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Transaction category semantics shared by the dashboard and the simulator:
 *  - `Transfer`: money moved between your own accounts — never income, never spending.
 *  - `Investment` as an expense: money put into investments — saving, not spending.
 *    `Investment` as income (dividends, interest) is real income.
 */
export const TRANSFER_CATEGORY = 'Transfer';
export const INVESTMENT_CATEGORY = 'Investment';

/** True when the transaction counts as take-home income. */
export function isIncomeTxn(t: Pick<Transaction, 'type' | 'category'>): boolean {
  return t.type === 'income' && t.category !== TRANSFER_CATEGORY;
}

/** True when the transaction counts as consumption (spending). */
export function isSpendingTxn(t: Pick<Transaction, 'type' | 'category'>): boolean {
  return t.type === 'expense' && t.category !== TRANSFER_CATEGORY && t.category !== INVESTMENT_CATEGORY;
}

/** Bump when stored data needs a migration (see `migrate`). */
export const SCHEMA_VERSION = 2;

/** True for account types whose balance represents money owed. */
export function isLiabilityAccount(account: Pick<Account, 'type'>): boolean {
  return account.type === 'credit';
}

/** Balance as a contribution to net worth: assets positive, liabilities negative. */
export function signedBalance(account: Pick<Account, 'type' | 'balance'>): number {
  return isLiabilityAccount(account) ? -account.balance : account.balance;
}

/** Apply a transaction's effect to an account balance (or reverse it with `direction = -1`). */
export function applyTransactionToBalance(account: Account, txn: Pick<Transaction, 'type' | 'amount'>, direction: 1 | -1 = 1): void {
  const amount = Math.abs(txn.amount) * direction;
  if (txn.type === 'income') account.balance += isLiabilityAccount(account) ? -amount : amount;
  else if (txn.type === 'expense') account.balance += isLiabilityAccount(account) ? amount : -amount;
}

interface DBData {
  schemaVersion?: number;
  users: User[];
  accounts: Account[];
  transactions: Transaction[];
  budgets: Budget[];
  investments: Investment[];
  investmentTransactions: InvestmentTransaction[];
  goals: Goal[];
  profiles: UserProfile[];
  scenarios: StoredScenario[];
}

/**
 * Resolve the directory the JSON database lives in.
 * Priority: explicit argument → FINFOLIO_DATA_DIR env var → ./data
 */
export function resolveDataDir(dataDir?: string): string {
  return path.resolve(dataDir || process.env.FINFOLIO_DATA_DIR || path.join(process.cwd(), 'data'));
}

export class Database {
  private data!: DBData;
  private dbPath: string = path.join(resolveDataDir(), 'database.json');

  /** Absolute path of the backing JSON file. */
  get filePath(): string {
    return this.dbPath;
  }

  private getDefaultData(): DBData {
    return {
      schemaVersion: SCHEMA_VERSION,
      users: [],
      accounts: [],
      transactions: [],
      budgets: [],
      investments: [],
      investmentTransactions: [],
      goals: [],
      profiles: [],
      scenarios: [],
    };
  }

  /**
   * Load the database from disk (creating an empty one if missing).
   * @param dataDir optional directory override; see `resolveDataDir`.
   */
  async init(dataDir?: string): Promise<void> {
    this.dbPath = path.join(resolveDataDir(dataDir), 'database.json');
    try {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
      const raw = await fs.readFile(this.dbPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.data = { ...this.getDefaultData(), ...parsed, schemaVersion: parsed.schemaVersion ?? 1 };
    } catch {
      this.data = this.getDefaultData();
      await this.persist();
    }
    if (this.migrate()) await this.persist();
  }

  /**
   * Upgrade older on-disk layouts in place. Returns true when something changed.
   *
   * v1 → v2: credit balances were implicitly "negative = owed" (expenses subtracted).
   *          They are now stored as a positive amount owed.
   */
  migrate(): boolean {
    let changed = false;
    const version = this.data.schemaVersion ?? 1;
    if (version < 2) {
      for (const a of this.data.accounts) {
        if (isLiabilityAccount(a) && a.balance < 0) {
          a.balance = Math.abs(a.balance);
          changed = true;
        }
      }
    }
    if (version !== SCHEMA_VERSION) {
      this.data.schemaVersion = SCHEMA_VERSION;
      changed = true;
    }
    return changed;
  }

  get schemaVersion(): number {
    return this.data.schemaVersion ?? 1;
  }

  /** Drop all in-memory data and write an empty database (test/seed helper). */
  async reset(): Promise<void> {
    this.data = this.getDefaultData();
    await this.persist();
  }

  async persist(): Promise<void> {
    await fs.writeFile(this.dbPath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  createUser(username: string, password: string): User | null {
    if (this.data.users.find(u => u.username === username)) return null;
    const user: User = {
      id: crypto.randomUUID(),
      username,
      passwordHash: this.hashPassword(password),
      createdAt: nowIso(),
    };
    this.data.users.push(user);
    return user;
  }

  authenticateUser(username: string, password: string): User | null {
    const user = this.data.users.find(u => u.username === username);
    if (!user) return null;
    if (user.passwordHash !== this.hashPassword(password)) return null;
    return user;
  }

  getUser(id: string): User | undefined {
    return this.data.users.find(u => u.id === id);
  }

  getUserByUsername(username: string): User | undefined {
    return this.data.users.find(u => u.username === username);
  }

  getAccounts(userId: string): Account[] {
    return this.data.accounts.filter(a => a.userId === userId);
  }

  getAccount(id: string): Account | undefined {
    return this.data.accounts.find(a => a.id === id);
  }

  createAccount(account: Omit<Account, 'id' | 'createdAt'>): Account {
    const newAccount: Account = {
      ...account,
      id: crypto.randomUUID(),
      createdAt: nowIso(),
    };
    this.data.accounts.push(newAccount);
    return newAccount;
  }

  updateAccount(id: string, updates: Partial<Account>): Account | null {
    const idx = this.data.accounts.findIndex(a => a.id === id);
    if (idx === -1) return null;
    this.data.accounts[idx] = { ...this.data.accounts[idx], ...updates };
    return this.data.accounts[idx];
  }

  deleteAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex(a => a.id === id);
    if (idx === -1) return false;
    this.data.accounts.splice(idx, 1);
    this.data.transactions = this.data.transactions.filter(t => t.accountId !== id);
    return true;
  }

  getTransactions(userId: string, filters?: { accountId?: string; category?: string; from?: string; to?: string; limit?: number }): Transaction[] {
    let txns = this.data.transactions.filter(t => t.userId === userId);
    if (filters?.accountId) txns = txns.filter(t => t.accountId === filters.accountId);
    if (filters?.category) txns = txns.filter(t => t.category === filters.category);
    if (filters?.from) txns = txns.filter(t => t.date >= filters.from!);
    if (filters?.to) txns = txns.filter(t => t.date <= filters.to!);
    txns.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    if (filters?.limit) txns = txns.slice(0, filters.limit);
    return txns;
  }

  createTransaction(txn: Omit<Transaction, 'id'>): Transaction {
    const newTxn: Transaction = { ...txn, id: crypto.randomUUID() };
    this.data.transactions.push(newTxn);
    const account = this.data.accounts.find(a => a.id === txn.accountId);
    if (account) applyTransactionToBalance(account, txn, 1);
    return newTxn;
  }

  deleteTransaction(id: string): boolean {
    const idx = this.data.transactions.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const txn = this.data.transactions[idx];
    const account = this.data.accounts.find(a => a.id === txn.accountId);
    if (account) applyTransactionToBalance(account, txn, -1);
    this.data.transactions.splice(idx, 1);
    return true;
  }

  getBudgets(userId: string): Budget[] {
    return this.data.budgets.filter(b => b.userId === userId);
  }

  createBudget(budget: Omit<Budget, 'id'>): Budget {
    const newBudget: Budget = { ...budget, id: crypto.randomUUID() };
    this.data.budgets.push(newBudget);
    return newBudget;
  }

  updateBudget(id: string, updates: Partial<Budget>): Budget | null {
    const idx = this.data.budgets.findIndex(b => b.id === id);
    if (idx === -1) return null;
    this.data.budgets[idx] = { ...this.data.budgets[idx], ...updates };
    return this.data.budgets[idx];
  }

  deleteBudget(id: string): boolean {
    const idx = this.data.budgets.findIndex(b => b.id === id);
    if (idx === -1) return false;
    this.data.budgets.splice(idx, 1);
    return true;
  }

  recalculateBudgetSpent(userId: string, category: string, month: number, year: number): void {
    const budgets = this.data.budgets.filter(
      b => b.userId === userId && b.category === category && b.month === month && b.year === year
    );
    if (budgets.length === 0) return;
    const totalSpent = this.data.transactions
      .filter(t => t.userId === userId && t.category === category && t.type === 'expense')
      .filter(t => {
        const d = new Date(t.date);
        return d.getMonth() === month && d.getFullYear() === year;
      })
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    for (const budget of budgets) {
      const bIdx = this.data.budgets.findIndex(b => b.id === budget.id);
      if (bIdx !== -1) this.data.budgets[bIdx].spent = totalSpent;
    }
  }

  getInvestments(userId: string): Investment[] {
    return this.data.investments.filter(i => i.userId === userId);
  }

  createInvestment(inv: Omit<Investment, 'id' | 'createdAt'>): Investment {
    const newInv: Investment = {
      ...inv,
      id: crypto.randomUUID(),
      createdAt: nowIso(),
    };
    this.data.investments.push(newInv);
    return newInv;
  }

  updateInvestment(id: string, updates: Partial<Investment>): Investment | null {
    const idx = this.data.investments.findIndex(i => i.id === id);
    if (idx === -1) return null;
    this.data.investments[idx] = { ...this.data.investments[idx], ...updates };
    return this.data.investments[idx];
  }

  deleteInvestment(id: string): boolean {
    const idx = this.data.investments.findIndex(i => i.id === id);
    if (idx === -1) return false;
    this.data.investments.splice(idx, 1);
    this.data.investmentTransactions = this.data.investmentTransactions.filter(t => t.investmentId !== id);
    return true;
  }

  getInvestmentTransactions(investmentId: string): InvestmentTransaction[] {
    return this.data.investmentTransactions
      .filter(t => t.investmentId === investmentId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  createInvestmentTransaction(txn: Omit<InvestmentTransaction, 'id'>): InvestmentTransaction {
    const newTxn: InvestmentTransaction = { ...txn, id: crypto.randomUUID() };
    this.data.investmentTransactions.push(newTxn);
    const inv = this.data.investments.find(i => i.id === txn.investmentId);
    if (inv) {
      if (txn.type === 'buy') {
        inv.avgCost = ((inv.avgCost * inv.shares) + (txn.pricePerShare * txn.shares)) / (inv.shares + txn.shares);
        inv.shares += txn.shares;
      } else if (txn.type === 'sell') {
        inv.shares -= txn.shares;
        if (inv.shares < 0) inv.shares = 0;
      }
    }
    return newTxn;
  }

  getGoals(userId: string): Goal[] {
    return this.data.goals.filter(g => g.userId === userId);
  }

  createGoal(goal: Omit<Goal, 'id' | 'createdAt'>): Goal {
    const newGoal: Goal = {
      ...goal,
      id: crypto.randomUUID(),
      createdAt: nowIso(),
    };
    this.data.goals.push(newGoal);
    return newGoal;
  }

  updateGoal(id: string, updates: Partial<Goal>): Goal | null {
    const idx = this.data.goals.findIndex(g => g.id === id);
    if (idx === -1) return null;
    this.data.goals[idx] = { ...this.data.goals[idx], ...updates };
    return this.data.goals[idx];
  }

  deleteGoal(id: string): boolean {
    const idx = this.data.goals.findIndex(g => g.id === id);
    if (idx === -1) return false;
    this.data.goals.splice(idx, 1);
    return true;
  }

  // ── Profiles ──

  getProfile(userId: string): UserProfile | undefined {
    return this.data.profiles.find(p => p.userId === userId);
  }

  upsertProfile(userId: string, profile: Profile): UserProfile {
    const record: UserProfile = { ...profile, userId, updatedAt: nowIso() };
    const idx = this.data.profiles.findIndex(p => p.userId === userId);
    if (idx === -1) this.data.profiles.push(record);
    else this.data.profiles[idx] = record;
    return record;
  }

  // ── Scenarios ──

  getScenarios(userId: string): StoredScenario[] {
    return this.data.scenarios.filter(s => s.userId === userId);
  }

  getScenario(id: string): StoredScenario | undefined {
    return this.data.scenarios.find(s => s.id === id);
  }

  createScenario(userId: string, scenario: Scenario): StoredScenario {
    const ts = nowIso();
    const record: StoredScenario = { ...scenario, id: crypto.randomUUID(), userId, createdAt: ts, updatedAt: ts };
    this.data.scenarios.push(record);
    return record;
  }

  updateScenario(id: string, scenario: Scenario): StoredScenario | null {
    const idx = this.data.scenarios.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const prev = this.data.scenarios[idx];
    this.data.scenarios[idx] = { ...scenario, id: prev.id, userId: prev.userId, createdAt: prev.createdAt, updatedAt: nowIso() };
    return this.data.scenarios[idx];
  }

  deleteScenario(id: string): boolean {
    const idx = this.data.scenarios.findIndex(s => s.id === id);
    if (idx === -1) return false;
    this.data.scenarios.splice(idx, 1);
    return true;
  }

  /** Everything the simulator needs to derive a baseline for a user. */
  getSimulationSource(userId: string) {
    const investments = this.getInvestments(userId);
    const ids = new Set(investments.map(i => i.id));
    return {
      accounts: this.getAccounts(userId),
      transactions: this.data.transactions.filter(t => t.userId === userId),
      investments,
      investmentTransactions: this.data.investmentTransactions.filter(t => ids.has(t.investmentId)),
      goals: this.getGoals(userId),
    };
  }

  getDashboard(userId: string) {
    const current = now();
    const month = current.getMonth();
    const year = current.getFullYear();

    const accounts = this.data.accounts.filter(a => a.userId === userId);
    const totalBalance = accounts.filter(a => !isLiabilityAccount(a)).reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = accounts.filter(a => isLiabilityAccount(a)).reduce((s, a) => s + a.balance, 0);
    const transactions = this.data.transactions.filter(t => t.userId === userId);

    const monthlyTxns = transactions.filter(t => {
      const d = new Date(t.date);
      return d.getMonth() === month && d.getFullYear() === year;
    });

    const monthlyIncome = monthlyTxns.filter(isIncomeTxn).reduce((s, t) => s + t.amount, 0);
    const monthlyExpenses = monthlyTxns.filter(isSpendingTxn).reduce((s, t) => s + Math.abs(t.amount), 0);
    const monthlyInvested = monthlyTxns.filter(t => t.type === 'expense' && t.category === INVESTMENT_CATEGORY).reduce((s, t) => s + Math.abs(t.amount), 0);

    const investments = this.data.investments.filter(i => i.userId === userId);
    const investmentValue = investments.reduce((s, i) => s + (i.currentPrice * i.shares), 0);

    const netWorth = totalBalance + investmentValue - totalLiabilities;

    const budgets = this.data.budgets.filter(b => b.userId === userId && b.month === month && b.year === year);
    const budgetHealth = budgets.map(b => ({
      category: b.category,
      budgeted: b.amount,
      spent: b.spent,
      remaining: b.amount - b.spent,
      percentUsed: b.amount > 0 ? Math.round((b.spent / b.amount) * 100) : 0,
    }));

    const recentTransactions = [...transactions]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 10);

    const expenseByCat = monthlyTxns
      .filter(isSpendingTxn)
      .reduce<Record<string, number>>((acc, t) => {
        acc[t.category] = (acc[t.category] || 0) + Math.abs(t.amount);
        return acc;
      }, {});
    const totalExpenses = Object.values(expenseByCat).reduce((s, v) => s + v, 0);
    const topExpenseCategories = Object.entries(expenseByCat)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([category, amount]) => ({
        category,
        amount,
        percentage: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0,
      }));

    const savingsRate = monthlyIncome > 0 ? Math.round(((monthlyIncome - monthlyExpenses) / monthlyIncome) * 100) : 0;

    const goals = this.data.goals.filter(g => g.userId === userId);
    const goalProgress = goals.map(g => ({
      name: g.name,
      current: g.currentAmount,
      target: g.targetAmount,
      percentage: g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0,
    }));

    return {
      totalBalance,
      totalLiabilities,
      monthlyIncome,
      monthlyInvested,
      monthlyExpenses,
      netWorth,
      investmentValue,
      budgetHealth,
      recentTransactions,
      topExpenseCategories,
      savingsRate,
      goalProgress,
    };
  }
}

export const db = new Database();
