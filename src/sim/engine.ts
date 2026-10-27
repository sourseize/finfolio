import type {
  Baseline,
  FireMetrics,
  LifeEvent,
  MonthSnapshot,
  RunwayMetrics,
  Scenario,
  SimulationInput,
  SimulationResult,
  SimulationSummary,
  YearSnapshot,
} from './types.js';
import { deterministicReturn } from './economy.js';
import { isActive } from './events.js';
import { addMonths, ageAt, amortizedPayment, annualToMonthly, growthFactor, monthsUntilAge, round2, round4 } from './math.js';

export interface EngineOptions {
  /** Market return for month `t` (fraction). Default: deterministic expected return + shocks. */
  marketReturn?: (t: number) => number;
  /** Internal: the runway sub-simulation sets this to avoid recursion. */
  skipRunway?: boolean;
}

/** Ratio of the full FI number that counts as "Lean FI". */
export const LEAN_FI_RATIO = 0.7;
export const MIN_HORIZON_MONTHS = 12;
export const MAX_HORIZON_MONTHS = 80 * 12;

export const DEFAULT_POLICY = { emergencyFundMonths: 6, investSurplus: true, contributionFollowsWages: true } as const;

interface Mortgage {
  balance: number;
  monthlyRate: number;
  payment: number;
  /** Month the loan was taken; the first payment (and amortisation) is the month after. */
  startMonth: number;
}

/** Apply scenario overrides on top of the derived baseline. */
export function effectiveBaseline(baseline: Baseline, scenario: Scenario): Baseline {
  const o = scenario.overrides ?? {};
  const pick = (key: keyof typeof o, fallback: number) => {
    const v = o[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    ...baseline,
    liquid: pick('liquid', baseline.liquid),
    invested: pick('invested', baseline.invested),
    debt: pick('debt', baseline.debt),
    monthlyIncome: pick('monthlyIncome', baseline.monthlyIncome),
    monthlyExpenses: pick('monthlyExpenses', baseline.monthlyExpenses),
    monthlyContribution: pick('monthlyContribution', baseline.monthlyContribution),
  };
}

export function resolveHorizonMonths(input: SimulationInput): number {
  const { scenario, profile, baseline } = input;
  let months: number;
  if (scenario.horizonYears && scenario.horizonYears > 0) {
    months = Math.round(scenario.horizonYears * 12);
  } else {
    months = monthsUntilAge(profile.birthDate, baseline.asOf, profile.planToAge);
  }
  return Math.min(MAX_HORIZON_MONTHS, Math.max(MIN_HORIZON_MONTHS, months));
}

export function resolveRetirementMonth(input: SimulationInput): number {
  const retireEvents = input.scenario.events.filter((e): e is Extract<LifeEvent, { kind: 'retirement' }> => e.kind === 'retirement');
  if (retireEvents.length) return Math.min(...retireEvents.map(e => e.startMonth));
  return monthsUntilAge(input.profile.birthDate, input.baseline.asOf, input.profile.retirementAge);
}

/**
 * Project the household month by month.
 *
 * Order of operations inside a month:
 *  1. income & expenses for the month (base × growth, then event modifiers)
 *  2. one-off events (windfall, purchase, debt payoff, property)
 *  3. cash flow: liquid += income − expenses; debt accrues interest
 *  4. allocation: pay revolving debt → target contribution → sweep surplus above the
 *     cash buffer (deficits are covered by selling investments, then become shortfall)
 *  5. growth: market return on invested, cash yield on liquid, appreciation on property,
 *     mortgage amortisation
 */
export function simulate(input: SimulationInput, opts: EngineOptions = {}): SimulationResult {
  const { profile, scenario } = input;
  const baseline = effectiveBaseline(input.baseline, scenario);
  const economy = scenario.economy;
  const policy = { ...DEFAULT_POLICY, ...scenario.policy };
  const events = scenario.events;
  const horizon = resolveHorizonMonths(input);
  const retirementMonth = resolveRetirementMonth(input);

  const inflM = annualToMonthly(economy.inflation);
  const wageM = annualToMonthly(economy.wageGrowth);
  const cashM = annualToMonthly(economy.cashYield);
  const debtM = annualToMonthly(economy.debtRate);
  const propM = annualToMonthly(economy.propertyAppreciation);
  const marketReturn = opts.marketReturn ?? ((t: number) => deterministicReturn(economy, t));

  let liquid = baseline.liquid;
  let invested = baseline.invested;
  let debt = baseline.debt;
  let property = 0;
  let shortfall = 0; // deficits financed after all assets are gone (no interest, see docs)
  const mortgages: Mortgage[] = [];
  let depletedMonth: number | null = null;

  const months: MonthSnapshot[] = [];
  let fI = 1; // inflation factor for month t
  let fW = 1; // wage factor for month t
  const startAge = ageAt(profile.birthDate, baseline.asOf);

  for (let t = 0; t < horizon; t++) {
    const retired = t >= retirementMonth;

    // ── 1. income & expenses ──
    let incomeMult = 1;
    let incomeAdd = 0;
    let expenseAdd = 0;
    let contribMult = 1;
    let contribAdd = 0;
    for (const e of events) {
      if (!isActive(e, t)) continue;
      switch (e.kind) {
        case 'income':
          if (e.percent !== undefined) incomeMult *= 1 + e.percent;
          if (e.amount !== undefined) incomeAdd += e.amount * fI;
          break;
        case 'expense':
          expenseAdd += e.amount * fI;
          break;
        case 'property':
          // once owned: rent disappears, ownership costs appear (mortgage handled below)
          expenseAdd += (e.ownershipCosts - e.rentReplaced) * fI;
          break;
        case 'contribution':
          if (e.percent !== undefined) contribMult *= 1 + e.percent;
          if (e.amount !== undefined) contribAdd += e.amount * fI;
          break;
        default:
          break;
      }
    }
    const earned = retired ? 0 : baseline.monthlyIncome * fW * incomeMult;
    const income = Math.max(0, earned + incomeAdd);
    const mortgagePayments = mortgages.reduce((s, m) => s + m.payment, 0);
    const expenses = Math.max(0, baseline.monthlyExpenses * fI + expenseAdd + mortgagePayments);
    const contributionTarget = retired
      ? 0
      : Math.max(0, baseline.monthlyContribution * (policy.contributionFollowsWages ? fW : fI) * contribMult + contribAdd);

    // ── 2. one-off events ──
    for (const e of events) {
      if (e.startMonth !== t) continue;
      switch (e.kind) {
        case 'one_off':
          liquid += e.amount * fI;
          break;
        case 'debt_payoff': {
          const pay = Math.min(e.amount * fI, debt, Math.max(0, liquid));
          liquid -= pay;
          debt -= pay;
          break;
        }
        case 'property': {
          const price = e.price * fI;
          const down = Math.min(price, e.downPayment * fI);
          const principal = price - down;
          liquid -= down;
          property += price;
          if (principal > 0) {
            mortgages.push({
              balance: principal,
              monthlyRate: e.mortgageRate / 12,
              payment: amortizedPayment(principal, e.mortgageRate, e.mortgageYears),
              startMonth: t,
            });
          }
          break;
        }
        default:
          break;
      }
    }

    // ── 3. cash flow ──
    liquid += income - expenses;
    debt *= 1 + debtM;

    // ── 4. allocation ──
    let contribution = 0;
    if (debt > 0 && liquid > 0) {
      // Revolving debt is the most expensive money there is: clear it before saving.
      const pay = Math.min(debt, liquid);
      debt -= pay;
      liquid -= pay;
    }
    if (contributionTarget > 0 && liquid > 0) {
      const c = Math.min(contributionTarget, liquid);
      liquid -= c;
      invested += c;
      contribution += c;
    }
    if (policy.investSurplus && !retired) {
      const buffer = policy.emergencyFundMonths * expenses;
      if (liquid > buffer) {
        const sweep = liquid - buffer;
        liquid -= sweep;
        invested += sweep;
        contribution += sweep;
      }
    }
    if (liquid < 0) {
      const sell = Math.min(invested, -liquid);
      invested -= sell;
      liquid += sell;
      contribution -= sell;
      if (liquid < 0) {
        // Nothing left to sell: the deficit becomes an uncovered shortfall. It is
        // tracked without interest so the output answers "how much short are you"
        // rather than compounding into meaningless numbers.
        shortfall += -liquid;
        liquid = 0;
        if (depletedMonth === null) depletedMonth = t;
      }
    }
    if (debt < 1e-9) debt = 0;

    // ── 5. growth ──
    const r = marketReturn(t);
    invested *= 1 + r;
    if (liquid > 0) liquid *= 1 + cashM;
    property *= 1 + propM;
    for (let i = mortgages.length - 1; i >= 0; i--) {
      const m = mortgages[i];
      if (m.startMonth === t) continue; // first payment is next month
      const interest = m.balance * m.monthlyRate;
      const principalPaid = Math.min(m.balance, m.payment - interest);
      m.balance -= principalPaid;
      if (m.balance <= 0.005) mortgages.splice(i, 1);
    }
    const mortgageTotal = mortgages.reduce((s, m) => s + m.balance, 0);
    const netWorth = liquid + invested + property - debt - mortgageTotal - shortfall;

    months.push({
      t,
      period: addMonths(baseline.asOf, t),
      age: round2(startAge + t / 12),
      income: round2(income),
      expenses: round2(expenses),
      contribution: round2(contribution),
      liquid: round2(liquid),
      invested: round2(invested),
      property: round2(property),
      debt: round2(debt),
      mortgage: round2(mortgageTotal),
      shortfall: round2(shortfall),
      netWorth: round2(netWorth),
      realNetWorth: round2(netWorth / fI),
      marketReturn: round4(r),
      retired,
    });

    fI *= 1 + inflM;
    fW *= 1 + wageM;
  }

  const yearly = buildYearly(months, baseline.asOf);
  const fire = computeFire(input, baseline, months, retirementMonth, startAge);
  const runway = computeRunway(input, baseline, opts);
  const startNetWorth = round2(baseline.liquid + baseline.invested - baseline.debt);
  const summary = buildSummary(months, horizon, startNetWorth, retirementMonth, depletedMonth, fire, runway);

  return { scenarioName: scenario.name, asOf: baseline.asOf, months, yearly, summary };
}

function buildYearly(months: MonthSnapshot[], asOf: string): YearSnapshot[] {
  const out: YearSnapshot[] = [];
  let income = 0;
  let expenses = 0;
  let contribution = 0;
  months.forEach((m, i) => {
    income += m.income;
    expenses += m.expenses;
    contribution += m.contribution;
    const endOfBlock = (i + 1) % 12 === 0 || i === months.length - 1;
    if (!endOfBlock) return;
    out.push({
      year: Number(addMonths(asOf, m.t).slice(0, 4)),
      age: m.age,
      t: m.t,
      netWorth: m.netWorth,
      realNetWorth: m.realNetWorth,
      liquid: m.liquid,
      invested: m.invested,
      property: m.property,
      debt: m.debt,
      mortgage: m.mortgage,
      income: round2(income),
      expenses: round2(expenses),
      contribution: round2(contribution),
    });
    income = 0;
    expenses = 0;
    contribution = 0;
  });
  return out;
}

function computeFire(
  input: SimulationInput,
  baseline: Baseline,
  months: MonthSnapshot[],
  retirementMonth: number,
  startAge: number,
): FireMetrics {
  const swr = input.profile.safeWithdrawalRate;
  const economy = input.scenario.economy;
  const annualExpensesToday = baseline.monthlyExpenses * 12;
  const fiNumber = swr > 0 ? annualExpensesToday / swr : Infinity;
  const investableToday = baseline.liquid + baseline.invested - baseline.debt;

  const target = (m: MonthSnapshot) => (swr > 0 ? (m.expenses * 12) / swr : Infinity);
  const investable = (m: MonthSnapshot) => m.liquid + m.invested - m.debt;

  let fiMonth: number | null = null;
  let leanFiMonth: number | null = null;
  let coastFiMonth: number | null = null;

  // Coast: what invested assets must be at month t to grow (untouched) to the FI target by retirement.
  const retIdx = Math.min(retirementMonth, months.length - 1);
  const targetAtRetirement = months.length ? target(months[retIdx]) : fiNumber;
  const coastFiNumber = targetAtRetirement / growthFactor(economy.expectedReturn, Math.max(0, retirementMonth));

  for (const m of months) {
    const inv = investable(m);
    const tgt = target(m);
    if (fiMonth === null && inv >= tgt) fiMonth = m.t;
    if (leanFiMonth === null && inv >= tgt * LEAN_FI_RATIO) leanFiMonth = m.t;
    if (coastFiMonth === null && m.t <= retirementMonth) {
      const need = targetAtRetirement / growthFactor(economy.expectedReturn, retirementMonth - m.t);
      if (inv >= need) coastFiMonth = m.t;
    }
  }

  return {
    safeWithdrawalRate: swr,
    annualExpensesToday: round2(annualExpensesToday),
    fiNumber: round2(fiNumber),
    leanFiNumber: round2(fiNumber * LEAN_FI_RATIO),
    coastFiNumber: round2(coastFiNumber),
    investableToday: round2(investableToday),
    progress: fiNumber > 0 && Number.isFinite(fiNumber) ? round4(investableToday / fiNumber) : 0,
    fiMonth,
    leanFiMonth,
    coastFiMonth,
    fiDate: fiMonth === null ? null : addMonths(baseline.asOf, fiMonth),
    fiAge: fiMonth === null ? null : round2(startAge + fiMonth / 12),
    retirementMonth,
    retirementAge: round2(startAge + retirementMonth / 12),
    fiByRetirement: fiMonth !== null && fiMonth <= retirementMonth,
  };
}

function computeRunway(input: SimulationInput, baseline: Baseline, opts: EngineOptions): RunwayMetrics {
  const exp = baseline.monthlyExpenses;
  const cashMonths = exp > 0 ? round2(Math.max(0, baseline.liquid) / exp) : null;
  const totalMonths = exp > 0 ? round2(Math.max(0, baseline.liquid + baseline.invested - baseline.debt) / exp) : null;

  let simulatedMonths: number | null = null;
  if (!opts.skipRunway) {
    const jobLoss: LifeEvent = { id: '__runway__', label: 'Income stops', kind: 'income', startMonth: 0, percent: -1 };
    const sub = simulate(
      {
        ...input,
        scenario: {
          ...input.scenario,
          name: `${input.scenario.name} (runway)`,
          events: [...input.scenario.events.filter(e => e.kind !== 'retirement'), jobLoss],
          overrides: { ...input.scenario.overrides, monthlyContribution: 0 },
        },
      },
      { ...opts, skipRunway: true },
    );
    simulatedMonths = sub.summary.depletedMonth;
  }

  return { cashMonths, totalMonths, simulatedMonths };
}

function buildSummary(
  months: MonthSnapshot[],
  horizon: number,
  startNetWorth: number,
  retirementMonth: number,
  depletedMonth: number | null,
  fire: FireMetrics,
  runway: RunwayMetrics,
): SimulationSummary {
  const last = months[months.length - 1];
  let peak = -Infinity;
  let min = Infinity;
  let totalIncome = 0;
  let totalExpenses = 0;
  let totalContributions = 0;
  for (const m of months) {
    if (m.netWorth > peak) peak = m.netWorth;
    if (m.netWorth < min) min = m.netWorth;
    totalIncome += m.income;
    totalExpenses += m.expenses;
    totalContributions += m.contribution;
  }
  return {
    horizonMonths: horizon,
    startNetWorth,
    endNetWorth: last.netWorth,
    endRealNetWorth: last.realNetWorth,
    peakNetWorth: peak,
    minNetWorth: min,
    depletedMonth,
    endShortfall: last.shortfall,
    netWorthAtRetirement: retirementMonth < months.length ? months[retirementMonth].netWorth : null,
    totalIncome: round2(totalIncome),
    totalExpenses: round2(totalExpenses),
    totalContributions: round2(totalContributions),
    fire,
    runway,
  };
}
