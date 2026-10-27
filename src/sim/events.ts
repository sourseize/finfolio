import type { LifeEvent, LifeEventKind } from './types.js';

/**
 * Catalog of life-event templates. The UI presents these; each produces a
 * concrete `LifeEvent` with sensible defaults that the user can then tweak.
 * Amounts are in today's money.
 */
export interface EventTemplate {
  id: string;
  label: string;
  icon: string;
  description: string;
  kind: LifeEventKind;
  /** Default field values (excluding id/label/startMonth). */
  defaults: Record<string, number | undefined>;
  /** Which fields the UI should expose for this template. */
  fields: { key: string; label: string; type: 'months' | 'money' | 'percent' | 'rate' | 'years' }[];
}

const F = {
  startMonth: { key: 'startMonth', label: 'Starts in (months)', type: 'months' as const },
  duration: { key: 'durationMonths', label: 'Duration (months, blank = permanent)', type: 'months' as const },
  amount: { key: 'amount', label: 'Amount', type: 'money' as const },
  percent: { key: 'percent', label: 'Change (%)', type: 'percent' as const },
};

export const EVENT_CATALOG: EventTemplate[] = [
  {
    id: 'job_loss', label: 'Job loss', icon: '🧳', kind: 'income',
    description: 'Earned income stops for a period (severance is a separate windfall).',
    defaults: { percent: -1, durationMonths: 6 },
    fields: [F.startMonth, F.duration],
  },
  {
    id: 'sabbatical', label: 'Sabbatical / career break', icon: '🏖️', kind: 'income',
    description: 'Take time off without pay, then return to the same income.',
    defaults: { percent: -1, durationMonths: 12 },
    fields: [F.startMonth, F.duration],
  },
  {
    id: 'raise', label: 'Pay rise / promotion', icon: '📈', kind: 'income',
    description: 'Permanent percentage increase in earned income.',
    defaults: { percent: 0.10 },
    fields: [F.startMonth, F.percent],
  },
  {
    id: 'pay_cut', label: 'Pay cut / part-time', icon: '📉', kind: 'income',
    description: 'Reduce earned income by a percentage.',
    defaults: { percent: -0.20 },
    fields: [F.startMonth, F.percent, F.duration],
  },
  {
    id: 'second_income', label: 'Partner / second income', icon: '👥', kind: 'income',
    description: 'Add a fixed monthly income stream (partner salary, side business, pension).',
    defaults: { amount: 2500 },
    fields: [F.startMonth, { ...F.amount, label: 'Monthly amount' }, F.duration],
  },
  {
    id: 'child', label: 'New child', icon: '👶', kind: 'expense',
    description: 'Recurring monthly cost of raising a child, typically for ~18 years.',
    defaults: { amount: 900, durationMonths: 216 },
    fields: [F.startMonth, { ...F.amount, label: 'Monthly cost' }, F.duration],
  },
  {
    id: 'lifestyle', label: 'Lifestyle change', icon: '🍽️', kind: 'expense',
    description: 'Permanently raise (or lower, with a negative amount) monthly spending.',
    defaults: { amount: 400 },
    fields: [F.startMonth, { ...F.amount, label: 'Monthly change' }, F.duration],
  },
  {
    id: 'relocation', label: 'Relocation', icon: '🚚', kind: 'expense',
    description: 'Move to a cheaper or more expensive city: change monthly living costs.',
    defaults: { amount: -500 },
    fields: [F.startMonth, { ...F.amount, label: 'Monthly change' }],
  },
  {
    id: 'healthcare', label: 'Health / care costs', icon: '🏥', kind: 'expense',
    description: 'Recurring medical or elder-care costs for a period.',
    defaults: { amount: 600, durationMonths: 36 },
    fields: [F.startMonth, { ...F.amount, label: 'Monthly cost' }, F.duration],
  },
  {
    id: 'windfall', label: 'Windfall / inheritance', icon: '🎁', kind: 'one_off',
    description: 'One-off cash inflow.',
    defaults: { amount: 50000 },
    fields: [F.startMonth, F.amount],
  },
  {
    id: 'big_purchase', label: 'Big purchase', icon: '🚗', kind: 'one_off',
    description: 'One-off outflow such as a car, wedding or renovation.',
    defaults: { amount: -30000 },
    fields: [F.startMonth, F.amount],
  },
  {
    id: 'buy_home', label: 'Buy a home', icon: '🏠', kind: 'property',
    description: 'Down payment from cash, mortgage for the rest, rent replaced by ownership costs.',
    defaults: { price: 400000, downPayment: 80000, mortgageRate: 0.05, mortgageYears: 30, rentReplaced: 1800, ownershipCosts: 500 },
    fields: [
      F.startMonth,
      { key: 'price', label: 'Price', type: 'money' },
      { key: 'downPayment', label: 'Down payment', type: 'money' },
      { key: 'mortgageRate', label: 'Mortgage rate', type: 'rate' },
      { key: 'mortgageYears', label: 'Term (years)', type: 'years' },
      { key: 'rentReplaced', label: 'Rent no longer paid (monthly)', type: 'money' },
      { key: 'ownershipCosts', label: 'Ownership costs (monthly)', type: 'money' },
    ],
  },
  {
    id: 'pay_off_debt', label: 'Pay off debt', icon: '💳', kind: 'debt_payoff',
    description: 'Use cash to clear revolving debt in one go.',
    defaults: { amount: 5000 },
    fields: [F.startMonth, F.amount],
  },
  {
    id: 'retire', label: 'Retire (early or late)', icon: '🌅', kind: 'retirement',
    description: 'Stop earned income at a chosen month instead of the profile retirement age.',
    defaults: {},
    fields: [F.startMonth],
  },
  {
    id: 'contribution', label: 'Change investing rate', icon: '💸', kind: 'contribution',
    description: 'Raise or lower the amount invested each month.',
    defaults: { amount: 500 },
    fields: [F.startMonth, { ...F.amount, label: 'Monthly change' }, F.duration],
  },
];

export function getEventTemplate(id: string): EventTemplate {
  const t = EVENT_CATALOG.find(e => e.id === id);
  if (!t) throw new Error(`Unknown event template: ${id}`);
  return t;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Instantiate a template into a concrete event, applying overrides. */
export function createEvent(templateId: string, overrides: Record<string, unknown> = {}): LifeEvent {
  const tpl = getEventTemplate(templateId);
  const raw = {
    id: String(overrides.id ?? nextId(tpl.id)),
    label: String(overrides.label ?? tpl.label),
    template: tpl.id,
    kind: tpl.kind,
    startMonth: 0,
    ...tpl.defaults,
    ...overrides,
  };
  return normalizeEvent(raw);
}

/** True when the event is in effect during month `t`. */
export function isActive(e: { startMonth: number; durationMonths?: number }, t: number): boolean {
  if (t < e.startMonth) return false;
  if (e.durationMonths === undefined || e.durationMonths === null) return true;
  return t < e.startMonth + e.durationMonths;
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Validate and coerce an untrusted object (API payload / stored JSON) into a `LifeEvent`.
 * Throws with a readable message on structural problems.
 */
export function normalizeEvent(raw: any, index = 0): LifeEvent {
  if (!raw || typeof raw !== 'object') throw new Error(`Event #${index + 1} must be an object`);
  const kind = raw.kind as LifeEventKind;
  const base = {
    id: String(raw.id ?? `event-${index + 1}`),
    label: String(raw.label ?? raw.kind ?? 'Event'),
    startMonth: Math.max(0, Math.round(num(raw.startMonth, 0))),
    durationMonths: raw.durationMonths === undefined || raw.durationMonths === null || raw.durationMonths === ''
      ? undefined
      : Math.max(1, Math.round(num(raw.durationMonths, 1))),
    template: raw.template ? String(raw.template) : undefined,
  };

  switch (kind) {
    case 'income': {
      const percent = optNum(raw.percent);
      const amount = optNum(raw.amount);
      if (percent === undefined && amount === undefined) throw new Error(`Event "${base.label}": income change needs percent or amount`);
      return { ...base, kind, percent: percent === undefined ? undefined : Math.max(-1, percent), amount };
    }
    case 'expense':
      return { ...base, kind, amount: num(raw.amount) };
    case 'one_off':
      return { ...base, kind, amount: num(raw.amount), durationMonths: undefined };
    case 'property': {
      const price = Math.max(0, num(raw.price));
      return {
        ...base,
        kind,
        durationMonths: undefined,
        price,
        downPayment: Math.min(price, Math.max(0, num(raw.downPayment))),
        mortgageRate: Math.max(0, num(raw.mortgageRate, 0.05)),
        mortgageYears: Math.max(1, num(raw.mortgageYears, 30)),
        rentReplaced: Math.max(0, num(raw.rentReplaced)),
        ownershipCosts: Math.max(0, num(raw.ownershipCosts)),
      };
    }
    case 'debt_payoff':
      return { ...base, kind, amount: Math.max(0, num(raw.amount)), durationMonths: undefined };
    case 'retirement':
      return { ...base, kind, durationMonths: undefined };
    case 'contribution': {
      const percent = optNum(raw.percent);
      const amount = optNum(raw.amount);
      if (percent === undefined && amount === undefined) throw new Error(`Event "${base.label}": contribution change needs percent or amount`);
      return { ...base, kind, percent: percent === undefined ? undefined : Math.max(-1, percent), amount };
    }
    default:
      throw new Error(`Event #${index + 1}: unknown kind "${String(kind)}"`);
  }
}

export function normalizeEvents(raw: unknown): LifeEvent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('events must be an array');
  return raw.map((e, i) => normalizeEvent(e, i));
}
