/**
 * Compare: share a snapshot of your finances, import a friend's, see the two
 * side by side.
 *
 * A snapshot is a file of *derived metrics and series*, never of records:
 * no usernames, no ids of any kind (accounts, transactions, holdings, rewards,
 * import batches), no birth date (age instead), no transaction descriptions,
 * no account names, no notes. Everything in it is computed by the same pure
 * engines the dashboard, the simulator and the rewards page already use, so a
 * snapshot built for export is exactly what the comparison uses for "my side".
 */

export const SNAPSHOT_FORMAT = 'finfolio-compare';
export const SNAPSHOT_VERSION = 1;
/** File name suffix: `<label>.finfolio-compare.json`. */
export const SNAPSHOT_FILE_SUFFIX = '.finfolio-compare.json';
/** Shown when the exporter leaves the label empty. */
export const DEFAULT_LABEL = 'A friend';

/** Upper bounds enforced on import — the file is untrusted input. */
export const SNAPSHOT_LIMITS = {
  label: 40,
  string: 80,
  series: 120,
  categories: 20,
  budgets: 20,
  holdings: 50,
  goals: 50,
  habits: 8,
  badges: 13,
  yearly: 100,
  accountTypes: 8,
  /** Largest accepted file (bytes) — a real snapshot is a few tens of KB. */
  bytes: 512 * 1024,
} as const;

/** Months of cash-flow history carried in the series (complete months before `asOf`). */
export const SERIES_MONTHS = 24;
/** Monte Carlo settings baked into every snapshot so the numbers are reproducible. */
export const SNAPSHOT_MONTECARLO = { trials: 300, seed: 42 } as const;

export interface SnapshotProfile {
  /** Whole years on `asOf`. */
  age: number;
  retirementAge: number;
  safeWithdrawalRate: number;
  planToAge: number;
}

export interface SnapshotPosition {
  netWorth: number;
  /** checking + savings + cash. */
  liquid: number;
  /** holdings value + investment-type accounts. */
  invested: number;
  /** credit accounts, positive. */
  debt: number;
  holdingsValue: number;
  /** Per account type: how many and their summed balance (credit = amount owed). */
  accountsByType: Record<string, { count: number; balance: number }>;
}

export interface SnapshotMonth {
  /** YYYY-MM */
  month: string;
  income: number;
  spending: number;
  /** Money put into investments (`Investment` expenses). */
  invested: number;
  /** Transfers received by savings accounts. */
  saved: number;
  /** income − spending. */
  net: number;
}

export interface SnapshotCashflow {
  /** Calendar months averaged for the monthly figures. */
  lookbackMonths: number;
  /** False when there is no income and no spending in the window. */
  hasHistory: boolean;
  /** Months with any activity in the whole history (capped by SERIES_MONTHS). */
  historyMonths: number;
  windowStart: string;
  windowEnd: string;
  monthlyIncome: number;
  monthlyExpenses: number;
  /** monthlyIncome − monthlyExpenses. */
  monthlySaved: number;
  monthlyInvested: number;
  /** monthlySaved ÷ monthlyIncome, 0 when no income. */
  savingsRate: number;
  /** monthlyInvested ÷ monthlyIncome, 0 when no income. */
  investingRate: number;
  /** Average per month and share of total spending, by category. */
  expenseByCategory: Record<string, { monthly: number; share: number }>;
  /** Oldest first, complete months only. */
  series: SnapshotMonth[];
}

export interface SnapshotBudgets {
  /** YYYY-MM the budgets belong to. */
  month: string;
  items: { category: string; budgeted: number; spent: number }[];
}

export interface SnapshotHolding {
  symbol: string;
  type: string;
  value: number;
  cost: number;
  /** value ÷ portfolio value. */
  weight: number;
}

export interface SnapshotInvestments {
  count: number;
  value: number;
  cost: number;
  /** (value − cost) ÷ cost, 0 when cost is 0. */
  gainPct: number;
  /** Share of value by asset type. */
  byType: Record<string, number>;
  topHoldingShare: number;
  holdings: SnapshotHolding[];
}

export interface SnapshotGoal {
  name: string;
  category: string;
  priority: string;
  target: number;
  current: number;
  deadline: string | null;
  /** current ÷ target, 0..1+ */
  progress: number;
  status: 'funded' | 'on_track' | 'at_risk' | 'unreachable';
  /** YYYY-MM, from the simulator's priority waterfall. */
  fundedBy: string | null;
}

export interface SnapshotHabit {
  kind: string;
  name: string;
  cadence: string;
  amount: number;
  category?: string;
  streak: number;
  bestStreak: number;
  periodsMet: number;
  periodsScored: number;
  /** periodsMet ÷ periodsScored, 0 when nothing scored yet. */
  hitRate: number;
  pointsEarned: number;
}

export interface SnapshotMotivation {
  enabled: boolean;
  pointsEarned: number;
  pointsSpent: number;
  balance: number;
  rewardsClaimed: number;
  habits: SnapshotHabit[];
  /** Catalog key (e.g. `first-step`), name and unlock date of every badge, locked ones included. */
  badges: { key: string; name: string; unlockedOn: string | null }[];
  badgesUnlocked: number;
}

export interface SnapshotOutlook {
  hasHistory: boolean;
  fire: {
    fiNumber: number;
    progress: number;
    fiDate: string | null;
    fiAge: number | null;
    coastFiMonth: number | null;
    fiByRetirement: boolean;
    retirementAge: number;
  };
  runway: { cashMonths: number | null; totalMonths: number | null; simulatedMonths: number | null };
  netWorthAtRetirement: number | null;
  endNetWorth: number;
  endRealNetWorth: number;
  /** One point per projected year. */
  yearly: { year: number; age: number; netWorth: number; realNetWorth: number }[];
  montecarlo: {
    trials: number;
    seed: number;
    successProbability: number;
    fiByRetirementProbability: number;
    endNetWorth: { p10: number; p50: number; p90: number };
  } | null;
}

export interface SnapshotData {
  profile: SnapshotProfile;
  position: SnapshotPosition;
  cashflow: SnapshotCashflow;
  budgets: SnapshotBudgets;
  investments: SnapshotInvestments;
  goals: SnapshotGoal[];
  motivation: SnapshotMotivation;
  outlook: SnapshotOutlook;
}

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  /** ISO timestamp of the export. */
  exportedAt: string;
  /** YYYY-MM-DD the figures are as of (the exporter's "today"). */
  asOf: string;
  /** How the exporter wants to be shown in the other person's report. */
  label: string;
  /** Currency most of the accounts are in. */
  currency: string;
  app: { name: string; version: string };
  /** `sha256:<hex>` of the canonical JSON of `data`. */
  checksum: string;
  data: SnapshotData;
}

/** What the share panel and the format endpoint tell the user. */
export const SNAPSHOT_INCLUDES: readonly string[] = [
  'Your age (not your birth date), retirement age and safe-withdrawal rate',
  'Net worth, cash, investments and debt — totals and by account type, no account names',
  'Monthly income, spending, saving and investing averaged over the last 12 months, and a 24-month series',
  'Spending by category (average and share)',
  'This month\'s budgets (category, budgeted, spent)',
  'Holdings: symbol, asset type, value, cost and weight',
  'Goals: name, category, priority, target, progress, deadline and whether they are on track',
  'Habits and their streaks, points earned and spent, rewards claimed (count), badges unlocked',
  'Outlook on current habits: FI number and date, runway, net worth at retirement, the yearly projection and the Monte Carlo odds',
];

export const SNAPSHOT_EXCLUDES: readonly string[] = [
  'Your username or any account, transaction or holding identifier',
  'Your birth date',
  'Transactions — no dates, amounts, descriptions or tags',
  'Account names, notes on holdings, goals or rewards',
  'Saved scenarios and statement-import history',
];
