import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

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

interface DBData {
  users: User[];
  accounts: Account[];
  transactions: Transaction[];
  budgets: Budget[];
  investments: Investment[];
  investmentTransactions: InvestmentTransaction[];
  goals: Goal[];
}

const DB_PATH = path.join(process.cwd(), 'data', 'database.json');

export class Database {
  private data!: DBData;

  private getDefaultData(): DBData {
    return {
      users: [],
      accounts: [],
      transactions: [],
      budgets: [],
      investments: [],
      investmentTransactions: [],
      goals: [],
    };
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
      const raw = await fs.readFile(DB_PATH, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = this.getDefaultData();
      await this.persist();
    }
  }

  async persist(): Promise<void> {
    await fs.writeFile(DB_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
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
      createdAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
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
    if (account) {
      if (txn.type === 'income') account.balance += txn.amount;
      else if (txn.type === 'expense') account.balance -= txn.amount;
    }
    return newTxn;
  }

  deleteTransaction(id: string): boolean {
    const idx = this.data.transactions.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const txn = this.data.transactions[idx];
    const account = this.data.accounts.find(a => a.id === txn.accountId);
    if (account) {
      if (txn.type === 'income') account.balance -= txn.amount;
      else if (txn.type === 'expense') account.balance += txn.amount;
    }
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
      createdAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
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

  getDashboard(userId: string) {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();

    const accounts = this.data.accounts.filter(a => a.userId === userId);
    const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);
    const transactions = this.data.transactions.filter(t => t.userId === userId);

    const monthlyTxns = transactions.filter(t => {
      const d = new Date(t.date);
      return d.getMonth() === month && d.getFullYear() === year;
    });

    const monthlyIncome = monthlyTxns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const monthlyExpenses = monthlyTxns.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0);

    const investments = this.data.investments.filter(i => i.userId === userId);
    const investmentValue = investments.reduce((s, i) => s + (i.currentPrice * i.shares), 0);

    const liabilities = accounts.filter(a => a.type === 'credit').reduce((s, a) => s + a.balance, 0);
    const netWorth = totalBalance + investmentValue - Math.abs(liabilities);

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
      .filter(t => t.type === 'expense')
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
      monthlyIncome,
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
