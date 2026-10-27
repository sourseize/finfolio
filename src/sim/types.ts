/**
 * Simulation domain types.
 *
 * Conventions used throughout the engine:
 *  - All rates are annual fractions (0.07 = 7 %/yr) unless the name says "monthly".
 *  - Money amounts supplied by the user (events, overrides) are in TODAY's money;
 *    the engine inflates them to the month in which they occur.
 *  - Month index `t` is an offset from the simulation start: 0 = the month of `asOf`.
 *  - Taxes are out of scope: gains are tax free and income is take-home.
 */

// ── Profile ─────────────────────────────────────────────────────────────────

export interface Profile {
  /** YYYY-MM-DD */
  birthDate: string;
  /** Age at which earned income stops (unless a `retirement` event overrides it). */
  retirementAge: number;
  /** Safe withdrawal rate used for the FI number (0.04 = 4 % rule). */
  safeWithdrawalRate: number;
  /** Default projection end age when a scenario does not set `horizonYears`. */
  planToAge: number;
}

// ── Baseline (derived from the user's actual data) ──────────────────────────

export interface Baseline {
  /** YYYY-MM-DD the snapshot was taken (simulation month 0). */
  asOf: string;
  /** Cash-like: checking + savings + cash accounts. */
  liquid: number;
  /** Investment holdings (shares × price) + investment-type accounts. */
  invested: number;
  /** Revolving consumer debt (credit accounts), positive number. */
  debt: number;
  /** Average take-home income per month over the look-back window. */
  monthlyIncome: number;
  /** Average spending per month (excludes transfers / investment purchases). */
  monthlyExpenses: number;
  /** Average new money invested per month (buy trades). */
  monthlyContribution: number;
  /** How many calendar months of history were averaged. */
  lookbackMonths: number;
  /** Transparency breakdown for the UI. */
  detail: {
    accounts: { id: string; name: string; type: string; balance: number; bucket: 'liquid' | 'invested' | 'debt' }[];
    holdingsValue: number;
    incomeMonths: number;
    windowStart: string;
    windowEnd: string;
    expenseByCategory: Record<string, number>;
  };
}

// ── Economy ─────────────────────────────────────────────────────────────────

export interface MarketShock {
  id: string;
  label: string;
  /** Month offset at which the drop is applied. */
  startMonth: number;
  /** Fractional drop, negative (−0.30 = −30 %). */
  drop: number;
  /** Months over which the loss is recovered back to trend. 0 = permanent loss. */
  recoveryMonths: number;
}

export interface EconomyAssumptions {
  /** Name of the preset the numbers came from (informational). */
  preset?: string;
  /** Expected nominal annual return on invested assets. */
  expectedReturn: number;
  /** Annual standard deviation of returns (used by Monte Carlo). */
  volatility: number;
  /** Annual CPI inflation applied to expenses and today's-money inputs. */
  inflation: number;
  /** Annual growth of earned income. */
  wageGrowth: number;
  /** Annual interest earned on liquid cash. */
  cashYield: number;
  /** Annual interest charged on revolving debt. */
  debtRate: number;
  /** Annual appreciation of property bought via a `property` event. */
  propertyAppreciation: number;
  /** Scheduled market shocks layered on top of the expected return. */
  shocks: MarketShock[];
}

// ── Life events ─────────────────────────────────────────────────────────────

interface EventBase {
  id: string;
  label: string;
  /** Month offset at which the event starts (0 = now). */
  startMonth: number;
  /** How long the effect lasts; omitted = until the end of the horizon. */
  durationMonths?: number;
  /** Catalog template this was created from (informational, for the UI). */
  template?: string;
}

/** Change earned income: `percent` multiplies (−1 = job loss), `amount` adds a fixed monthly sum (today's money). */
export interface IncomeEvent extends EventBase {
  kind: 'income';
  percent?: number;
  amount?: number;
}

/** Add (or, when negative, remove) a recurring monthly expense in today's money. */
export interface ExpenseEvent extends EventBase {
  kind: 'expense';
  amount: number;
}

/** A single lump sum: positive = inflow (windfall), negative = outflow (big purchase). Today's money. */
export interface OneOffEvent extends EventBase {
  kind: 'one_off';
  amount: number;
}

/** Buy a property: down payment leaves liquid, the rest becomes an amortising mortgage. */
export interface PropertyEvent extends EventBase {
  kind: 'property';
  price: number;
  downPayment: number;
  mortgageRate: number;
  mortgageYears: number;
  /** Monthly rent that disappears once the property is owned (today's money). */
  rentReplaced: number;
  /** Extra monthly running costs of ownership (maintenance, tax, insurance; today's money). */
  ownershipCosts: number;
}

/** Use liquid cash to pay down revolving debt. */
export interface DebtPayoffEvent extends EventBase {
  kind: 'debt_payoff';
  amount: number;
}

/** Override the retirement month (earned income stops at `startMonth`). */
export interface RetirementEvent extends EventBase {
  kind: 'retirement';
}

/** Change the target monthly investment contribution (today's money). */
export interface ContributionEvent extends EventBase {
  kind: 'contribution';
  amount?: number;
  percent?: number;
}

export type LifeEvent =
  | IncomeEvent
  | ExpenseEvent
  | OneOffEvent
  | PropertyEvent
  | DebtPayoffEvent
  | RetirementEvent
  | ContributionEvent;

export type LifeEventKind = LifeEvent['kind'];

// ── Scenario ────────────────────────────────────────────────────────────────

export interface SavingsPolicy {
  /** Cash buffer to keep before sweeping surplus into investments (months of expenses). */
  emergencyFundMonths: number;
  /** Sweep liquid above the buffer into investments each month. */
  investSurplus: boolean;
  /** Grow the baseline contribution with wages. */
  contributionFollowsWages: boolean;
}

export interface Scenario {
  id?: string;
  name: string;
  description?: string;
  /** Years to project. Omitted = until `profile.planToAge`. */
  horizonYears?: number;
  economy: EconomyAssumptions;
  events: LifeEvent[];
  policy: SavingsPolicy;
  /** Replace derived baseline figures ("assume my expenses are 3 500"). */
  overrides?: Partial<Pick<Baseline, 'liquid' | 'invested' | 'debt' | 'monthlyIncome' | 'monthlyExpenses' | 'monthlyContribution'>>;
}

// ── Simulation input/output ─────────────────────────────────────────────────

export interface SimulationInput {
  baseline: Baseline;
  profile: Profile;
  scenario: Scenario;
}

export interface MonthSnapshot {
  /** Month offset from start. */
  t: number;
  /** YYYY-MM of this month. */
  period: string;
  age: number;
  income: number;
  expenses: number;
  /** New money moved into investments this month (can be negative when drawing down). */
  contribution: number;
  liquid: number;
  invested: number;
  property: number;
  debt: number;
  mortgage: number;
  /** Cumulative deficits that could not be covered by any asset (no interest). */
  shortfall: number;
  netWorth: number;
  /** Net worth deflated to today's money. */
  realNetWorth: number;
  /** Return applied to invested assets this month (fraction). */
  marketReturn: number;
  retired: boolean;
}

export interface YearSnapshot {
  year: number;
  age: number;
  t: number;
  netWorth: number;
  realNetWorth: number;
  liquid: number;
  invested: number;
  property: number;
  debt: number;
  mortgage: number;
  /** Sum over the 12 months ending here. */
  income: number;
  expenses: number;
  contribution: number;
}

export interface FireMetrics {
  safeWithdrawalRate: number;
  /** Annual expenses today (baseline × 12). */
  annualExpensesToday: number;
  /** Assets needed today to retire: annual expenses ÷ SWR. */
  fiNumber: number;
  leanFiNumber: number;
  /** Assets that, left untouched, would grow to the FI number by retirement age. */
  coastFiNumber: number;
  /** Investable net assets today (liquid + invested − debt). */
  investableToday: number;
  /** investableToday ÷ fiNumber, as a fraction. */
  progress: number;
  /** Month offsets (null = not reached within the horizon). */
  fiMonth: number | null;
  leanFiMonth: number | null;
  coastFiMonth: number | null;
  /** YYYY-MM / age equivalents for convenience. */
  fiDate: string | null;
  fiAge: number | null;
  /** Planned retirement month from the profile/event. */
  retirementMonth: number;
  retirementAge: number;
  /** Whether the FI number is reached on or before the planned retirement month. */
  fiByRetirement: boolean;
}

export interface RunwayMetrics {
  /** Liquid cash ÷ monthly expenses (null when expenses are zero). */
  cashMonths: number | null;
  /** (liquid + invested − debt) ÷ monthly expenses (null when expenses are zero). */
  totalMonths: number | null;
  /** Months until assets are exhausted if income stopped today (engine run; null = never within horizon). */
  simulatedMonths: number | null;
}

export interface SimulationSummary {
  horizonMonths: number;
  startNetWorth: number;
  endNetWorth: number;
  endRealNetWorth: number;
  peakNetWorth: number;
  minNetWorth: number;
  /** First month where a deficit could not be covered by any asset; null = never. */
  depletedMonth: number | null;
  /** Total uncovered deficit at the end of the horizon (0 when never depleted). */
  endShortfall: number;
  /** Net worth at the planned retirement month (null if beyond horizon). */
  netWorthAtRetirement: number | null;
  totalIncome: number;
  totalExpenses: number;
  totalContributions: number;
  fire: FireMetrics;
  runway: RunwayMetrics;
}

export interface SimulationResult {
  scenarioName: string;
  asOf: string;
  months: MonthSnapshot[];
  yearly: YearSnapshot[];
  summary: SimulationSummary;
}
