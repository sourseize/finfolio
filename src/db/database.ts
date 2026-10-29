import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, nowIso } from '../util/clock.js';
import type { Profile, Scenario } from '../sim/types.js';
import type { Habit, Milestone, Reward, RewardClaim } from '../motivation/types.js';

export type { Habit, Milestone, Reward, RewardClaim } from '../motivation/types.js';

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

export type ImportSource = 'csv' | 'ofx' | 'qif' | 'openbanking';

/**
 * Bookkeeping attached to a transaction by the statement importer.
 * Written when a row is imported, or — `matchedFrom` — when the user skips an
 * imported row because this (possibly hand-entered) transaction already
 * records it. Both cases let later imports recognise the row automatically.
 */
export interface TransactionImportMeta {
  /** Import batch that created this transaction (absent when only stamped via `matchedFrom`). */
  batchId?: string;
  source: ImportSource;
  /** Bank-assigned unique id (OFX FITID, Open Banking TransactionId …). */
  externalId?: string;
  /** sha256(accountId | date | type | amountCents | normalisedDescription). */
  fingerprint: string;
  /** Description exactly as the bank exported it. */
  rawDescription: string;
  /** Set when the user confirmed an imported row as "already recorded = this transaction". */
  matchedFrom?: {
    filename: string;
    date: string;
    amount: number;
    rawDescription: string;
    matchedAt: string;
  };
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
  import?: TransactionImportMeta;
}

/** One committed statement file. Internal bookkeeping: exact-file detection and the post-import link. */
export interface ImportBatch {
  id: string;
  userId: string;
  accountId: string;
  format: ImportSource;
  filename: string;
  /** sha256 of the uploaded bytes. */
  fileHash: string;
  importedAt: string;
  dateFrom: string;
  dateTo: string;
  counts: { imported: number; recorded: number; skipped: number; excluded: number };
  /** What the balance-reconciliation step changed on the account, if anything. */
  balanceAdjustment?: number;
}

/** A remembered CSV column mapping, re-applied when a file with the same header signature is uploaded. */
export interface ImportProfile {
  id: string;
  userId: string;
  headerSignature: string;
  delimiter: string;
  dateOrder: 'YMD' | 'DMY' | 'MDY';
  numberFormat: 'point' | 'comma';
  columns: {
    date: number;
    description: number;
    amount?: number;
    debit?: number;
    credit?: number;
    balance?: number;
    category?: number;
    currency?: number;
    reference?: number;
  };
  createdAt: string;
  lastUsedAt: string;
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
/** Default for imported rows no rule recognises; the user re-categorises from the transactions list. */
export const UNCATEGORIZED_CATEGORY = 'Uncategorized';

/** Every category a transaction may carry (mirrored by the UI in utils.js). */
export const TRANSACTION_CATEGORIES: readonly string[] = [
  'Food & Dining', 'Transportation', 'Housing', 'Utilities', 'Entertainment', 'Shopping', 'Healthcare',
  'Education', 'Salary', 'Freelance', INVESTMENT_CATEGORY, 'Gift', TRANSFER_CATEGORY, 'Other', UNCATEGORIZED_CATEGORY,
];

/** True when the transaction counts as take-home income. */
export function isIncomeTxn(t: Pick<Transaction, 'type' | 'category'>): boolean {
  return t.type === 'income' && t.category !== TRANSFER_CATEGORY;
}

/** True when the transaction counts as consumption (spending). */
export function isSpendingTxn(t: Pick<Transaction, 'type' | 'category'>): boolean {
  return t.type === 'expense' && t.category !== TRANSFER_CATEGORY && t.category !== INVESTMENT_CATEGORY;
}

/** Bump when stored data needs a migration (see `migrate`). */
export const SCHEMA_VERSION = 6;

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
  importBatches: ImportBatch[];
  importProfiles: ImportProfile[];
  habits: Habit[];
  rewards: Reward[];
  rewardClaims: RewardClaim[];
  milestones: Milestone[];
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
      importBatches: [],
      importProfiles: [],
      habits: [],
      rewards: [],
      rewardClaims: [],
      milestones: [],
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
   * v2 → v3: statement import — `importBatches` and `importProfiles` collections
   *          (created empty by `getDefaultData`) and the optional `import` block on
   *          transactions. Nothing to rewrite; the version is bumped.
   * v3 → v4: motivation — the `habits` collection (created empty by `getDefaultData`).
   *          Nothing to rewrite; the version is bumped.
   * v4 → v5: rewards — `rewards` and `rewardClaims` collections. Nothing to rewrite.
   * v5 → v6: badges — the `milestones` collection (observed FI milestones). Nothing to rewrite.
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
    this.data.importBatches = this.data.importBatches.filter(b => b.accountId !== id);
    for (const h of this.data.habits) if (h.accountId === id) delete h.accountId;
    return true;
  }

  getTransactions(userId: string, filters?: { accountId?: string; category?: string; from?: string; to?: string; limit?: number; batchId?: string }): Transaction[] {
    let txns = this.data.transactions.filter(t => t.userId === userId);
    if (filters?.accountId) txns = txns.filter(t => t.accountId === filters.accountId);
    if (filters?.batchId) txns = txns.filter(t => t.import?.batchId === filters.batchId);
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

  getTransaction(id: string): Transaction | undefined {
    return this.data.transactions.find(t => t.id === id);
  }

  /**
   * Edit a transaction. The old balance effect is reversed on the old account and
   * the new effect applied on the (possibly different) new account, so balances
   * stay consistent whatever changed. Budget totals are the caller's concern
   * (see `recalculateBudgetSpent`), as for create/delete.
   */
  updateTransaction(id: string, updates: Partial<Pick<Transaction, 'accountId' | 'type' | 'category' | 'amount' | 'description' | 'date' | 'tags'>>): Transaction | null {
    const idx = this.data.transactions.findIndex(t => t.id === id);
    if (idx === -1) return null;
    const prev = this.data.transactions[idx];
    const next: Transaction = { ...prev, ...updates, id: prev.id, userId: prev.userId };
    const oldAccount = this.data.accounts.find(a => a.id === prev.accountId);
    if (oldAccount) applyTransactionToBalance(oldAccount, prev, -1);
    const newAccount = this.data.accounts.find(a => a.id === next.accountId);
    if (newAccount) applyTransactionToBalance(newAccount, next, 1);
    this.data.transactions[idx] = next;
    return next;
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

  // ── Statement import bookkeeping ──

  getImportBatches(userId: string): ImportBatch[] {
    return this.data.importBatches.filter(b => b.userId === userId);
  }

  findImportBatchByHash(userId: string, fileHash: string): ImportBatch | undefined {
    return this.data.importBatches.find(b => b.userId === userId && b.fileHash === fileHash);
  }

  createImportBatch(batch: Omit<ImportBatch, 'id' | 'importedAt'>): ImportBatch {
    const record: ImportBatch = { ...batch, id: crypto.randomUUID(), importedAt: nowIso() };
    this.data.importBatches.push(record);
    return record;
  }

  getImportProfiles(userId: string): ImportProfile[] {
    return this.data.importProfiles.filter(p => p.userId === userId);
  }

  findImportProfile(userId: string, headerSignature: string): ImportProfile | undefined {
    return this.data.importProfiles.find(p => p.userId === userId && p.headerSignature === headerSignature);
  }

  /** Create or replace the profile for a header signature; bumps `lastUsedAt`. */
  upsertImportProfile(profile: Omit<ImportProfile, 'id' | 'createdAt' | 'lastUsedAt'>): ImportProfile {
    const ts = nowIso();
    const idx = this.data.importProfiles.findIndex(p => p.userId === profile.userId && p.headerSignature === profile.headerSignature);
    if (idx === -1) {
      const record: ImportProfile = { ...profile, id: crypto.randomUUID(), createdAt: ts, lastUsedAt: ts };
      this.data.importProfiles.push(record);
      return record;
    }
    const prev = this.data.importProfiles[idx];
    this.data.importProfiles[idx] = { ...profile, id: prev.id, createdAt: prev.createdAt, lastUsedAt: ts };
    return this.data.importProfiles[idx];
  }

  deleteImportProfile(id: string): boolean {
    const idx = this.data.importProfiles.findIndex(p => p.id === id);
    if (idx === -1) return false;
    this.data.importProfiles.splice(idx, 1);
    return true;
  }

  // ── Habits (motivation) ──

  getHabits(userId: string): Habit[] {
    return this.data.habits.filter(h => h.userId === userId);
  }

  getHabit(id: string): Habit | undefined {
    return this.data.habits.find(h => h.id === id);
  }

  createHabit(habit: Omit<Habit, 'id' | 'createdAt'>): Habit {
    const record: Habit = { ...habit, id: crypto.randomUUID(), createdAt: nowIso() };
    this.data.habits.push(record);
    return record;
  }

  updateHabit(id: string, updates: Partial<Omit<Habit, 'id' | 'userId' | 'createdAt'>>): Habit | null {
    const idx = this.data.habits.findIndex(h => h.id === id);
    if (idx === -1) return null;
    const next: Habit = { ...this.data.habits[idx], ...updates };
    if (updates.accountId === undefined && 'accountId' in updates) delete next.accountId;
    if (updates.category === undefined && 'category' in updates) delete next.category;
    this.data.habits[idx] = next;
    return next;
  }

  deleteHabit(id: string): boolean {
    const idx = this.data.habits.findIndex(h => h.id === id);
    if (idx === -1) return false;
    this.data.habits.splice(idx, 1);
    return true;
  }

  // ── Rewards ──

  getRewards(userId: string): Reward[] {
    return this.data.rewards.filter(r => r.userId === userId);
  }

  getReward(id: string): Reward | undefined {
    return this.data.rewards.find(r => r.id === id);
  }

  createReward(reward: Omit<Reward, 'id' | 'createdAt'>): Reward {
    const record: Reward = { ...reward, id: crypto.randomUUID(), createdAt: nowIso() };
    this.data.rewards.push(record);
    return record;
  }

  updateReward(id: string, updates: Partial<Pick<Reward, 'name' | 'cost' | 'note'>>): Reward | null {
    const idx = this.data.rewards.findIndex(r => r.id === id);
    if (idx === -1) return null;
    this.data.rewards[idx] = { ...this.data.rewards[idx], ...updates };
    return this.data.rewards[idx];
  }

  /** Remove a reward from the list. Past claims keep their copied name/cost. */
  deleteReward(id: string): boolean {
    const idx = this.data.rewards.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.data.rewards.splice(idx, 1);
    return true;
  }

  getRewardClaims(userId: string): RewardClaim[] {
    return this.data.rewardClaims.filter(c => c.userId === userId);
  }

  createRewardClaim(claim: Omit<RewardClaim, 'id' | 'createdAt'>): RewardClaim {
    const record: RewardClaim = { ...claim, id: crypto.randomUUID(), createdAt: nowIso() };
    this.data.rewardClaims.push(record);
    return record;
  }

  deleteRewardClaim(id: string): boolean {
    const idx = this.data.rewardClaims.findIndex(c => c.id === id);
    if (idx === -1) return false;
    this.data.rewardClaims.splice(idx, 1);
    return true;
  }

  // ── Milestones (observed FI progress) ──

  getMilestones(userId: string): Milestone[] {
    return this.data.milestones.filter(m => m.userId === userId);
  }

  createMilestone(milestone: Omit<Milestone, 'id' | 'createdAt'>): Milestone {
    const record: Milestone = { ...milestone, id: crypto.randomUUID(), createdAt: nowIso() };
    this.data.milestones.push(record);
    return record;
  }

  deleteMilestone(id: string): boolean {
    const idx = this.data.milestones.findIndex(m => m.id === id);
    if (idx === -1) return false;
    this.data.milestones.splice(idx, 1);
    return true;
  }

  /** Everything the points engine needs for a user. */
  getMotivationSource(userId: string) {
    return {
      habits: this.getHabits(userId),
      transactions: this.data.transactions.filter(t => t.userId === userId),
      accounts: this.getAccounts(userId),
      rewards: this.getRewards(userId),
      claims: this.getRewardClaims(userId),
      milestones: this.getMilestones(userId),
    };
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
