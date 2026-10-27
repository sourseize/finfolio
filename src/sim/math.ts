/** Small financial-math helpers shared by the simulation modules. */

/** Convert an annual compound rate to the equivalent monthly rate. */
export function annualToMonthly(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

/** Growth factor after `months` at an annual rate. */
export function growthFactor(annualRate: number, months: number): number {
  return Math.pow(1 + annualRate, months / 12);
}

/** Level monthly payment that amortises `principal` over `years` at `annualRate`. */
export function amortizedPayment(principal: number, annualRate: number, years: number): number {
  const n = Math.max(1, Math.round(years * 12));
  if (principal <= 0) return 0;
  const r = annualRate / 12;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

/** Future value of a lump sum plus a level monthly contribution (contributed at month end). */
export function futureValue(lumpSum: number, monthly: number, annualRate: number, months: number): number {
  const r = annualToMonthly(annualRate);
  const fvLump = lumpSum * Math.pow(1 + r, months);
  const fvSeries = r === 0 ? monthly * months : monthly * ((Math.pow(1 + r, months) - 1) / r);
  return fvLump + fvSeries;
}

/** Round to cents to keep snapshots tidy and comparable. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to 4 decimals (fractions such as probabilities and progress). */
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Add `months` to a YYYY-MM-DD / YYYY-MM string and return YYYY-MM. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m] = isoDate.slice(0, 7).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** Whole months from `fromIso` to `toIso` (YYYY-MM-DD), counting calendar months. */
export function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm] = fromIso.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toIso.slice(0, 7).split('-').map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm);
}

/** Age in fractional years at `atIso` for someone born on `birthIso`. */
export function ageAt(birthIso: string, atIso: string): number {
  const b = new Date(birthIso + (birthIso.length === 10 ? 'T00:00:00Z' : ''));
  const a = new Date(atIso + (atIso.length === 10 ? 'T00:00:00Z' : ''));
  let years = a.getUTCFullYear() - b.getUTCFullYear();
  const monthDiff = a.getUTCMonth() - b.getUTCMonth();
  const dayDiff = a.getUTCDate() - b.getUTCDate();
  let months = monthDiff;
  if (dayDiff < 0) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return years + months / 12;
}

/** Month offset (from `asOfIso`) at which the person turns `targetAge`; 0 if already older. */
export function monthsUntilAge(birthIso: string, asOfIso: string, targetAge: number): number {
  const [by, bm] = birthIso.slice(0, 7).split('-').map(Number);
  const bd = Number(birthIso.slice(8, 10)) || 1;
  const [ay, am] = asOfIso.slice(0, 7).split('-').map(Number);
  const ad = Number(asOfIso.slice(8, 10)) || 1;
  // Birthday month index in "absolute months"
  const birthdayAbs = (by + targetAge) * 12 + (bm - 1);
  const asOfAbs = ay * 12 + (am - 1);
  let diff = birthdayAbs - asOfAbs;
  // If the birthday in that month is on/before the as-of day-of-month, it counts as that month.
  if (diff === 0 && bd < ad) diff = 0;
  return Math.max(0, diff);
}

/** Deterministic percentile (linear interpolation) on an unsorted array. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
