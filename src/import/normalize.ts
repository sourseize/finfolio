/**
 * Value normalisation shared by every parser: dates in many shapes → ISO,
 * amounts in many shapes → number, bank narrative → comparable text, and the
 * fingerprint used for duplicate detection.
 */
import crypto from 'node:crypto';
import type { DateOrder, NumberFormat } from './types.js';

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function validDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function fullYear(y: number, digits: number): number {
  if (digits === 4) return y;
  return y <= 69 ? 2000 + y : 1900 + y;
}

/** Strip OFX/QIF oddities: time zones, `'` year separators, padding spaces. */
function cleanDateText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').replace(/'/g, '/').replace(/\/ /g, '/');
}

/**
 * Parse a date string. ISO-like inputs are accepted regardless of `order`;
 * numeric day/month forms use `order` (DMY / MDY). Returns null when invalid.
 */
export function parseDate(input: string, order: DateOrder = 'YMD'): string | null {
  if (!input) return null;
  const s = cleanDateText(input);
  let m: RegExpMatchArray | null;

  // 2026-09-03, 2026/09/03, 2026.09.03, 20260903, 2026-09-03T10:15:00Z, OFX 20260903120000.000[-5:EST]
  if ((m = s.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})(?:[T\s]\d|\d{6}|$|\[)/)) || (m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // 03/09/2026, 3.9.26, 03-09-2026, 9/3/26
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const a = Number(m[1]), b = Number(m[2]), y = fullYear(Number(m[3]), m[3].length);
    return order === 'MDY' ? validDate(y, a, b) : validDate(y, b, a);
  }
  // 03 Sep 2026, 3-Sep-26, 03 September 2026
  if ((m = s.match(/^(\d{1,2})[ \-/]([A-Za-z]{3,9})\.?,?[ \-/](\d{2}|\d{4})$/))) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? validDate(fullYear(Number(m[3]), m[3].length), mon, Number(m[1])) : null;
  }
  // Sep 3, 2026 / September 03 2026
  if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/))) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? validDate(Number(m[3]), mon, Number(m[2])) : null;
  }
  return null;
}

export interface DateOrderInference {
  order: DateOrder;
  /** True when the data could not decide between DMY and MDY. */
  ambiguous: boolean;
}

/** Locale → preferred day/month order when the data cannot tell. */
export function dateOrderForLocale(locale?: string): DateOrder {
  const l = (locale || '').toLowerCase();
  if (/^en-(us|ph)\b/.test(l) || l === 'en') return 'MDY';
  if (/^(ja|zh|ko|hu|lt|mn|sv|bt)\b/.test(l)) return 'YMD';
  if (!l) return 'YMD';
  return 'DMY';
}

/**
 * Decide the day/month order from all date strings in a file. Any day > 12
 * settles it; otherwise the locale hint decides and `ambiguous` is true.
 */
export function inferDateOrder(values: string[], localeHint?: string): DateOrderInference {
  let sawNumeric = false;
  for (const v of values) {
    const s = cleanDateText(v || '');
    if (/^\d{4}[-/.]?\d{2}[-/.]?\d{2}/.test(s)) return { order: 'YMD', ambiguous: false };
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
    if (!m) continue;
    sawNumeric = true;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) return { order: 'DMY', ambiguous: false };
    if (b > 12 && a <= 12) return { order: 'MDY', ambiguous: false };
  }
  if (!sawNumeric) return { order: 'YMD', ambiguous: false }; // textual months or ISO only
  const fallback = dateOrderForLocale(localeHint);
  return { order: fallback === 'YMD' ? 'DMY' : fallback, ambiguous: true };
}

/**
 * Parse a money amount. Handles "1,234.56", "1.234,56", "1 234,56", "(12.34)",
 * "12.34-", "12.34 DR", "CR 12.34", "$-45.50", "€45,50", "-45.50 USD".
 */
export function parseAmount(input: string | number | null | undefined, numberFormat?: NumberFormat): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  const drcr = s.match(/\b(DR|CR|DB|D|C|DEBIT|CREDIT)\b/i);
  if (drcr) {
    const tag = drcr[1].toUpperCase();
    if (tag === 'DR' || tag === 'DB' || tag === 'D' || tag === 'DEBIT') negative = true;
    s = s.replace(drcr[0], '');
  }
  s = s.replace(/[A-Za-z$€£¥₹₽₩¢\u00a0\s]/g, '').trim();
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!s) return null;

  const fmt = numberFormat ?? inferNumberFormatForValue(s);
  if (fmt === 'comma') s = s.replace(/\./g, '').replace(/'/g, '').replace(',', '.');
  else s = s.replace(/,/g, '').replace(/'/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '.' ) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Per-value guess: the last separator is the decimal one when both appear. */
function inferNumberFormatForValue(s: string): NumberFormat {
  const lastComma = s.lastIndexOf(','), lastPoint = s.lastIndexOf('.');
  if (lastComma !== -1 && lastPoint !== -1) return lastComma > lastPoint ? 'comma' : 'point';
  if (lastComma !== -1) {
    const after = s.length - lastComma - 1;
    const commas = (s.match(/,/g) || []).length;
    // "1,234" or "1,234,567" → thousands separators; "45,50" / "45,5" → decimal comma
    if (after === 3 && commas >= 1) return 'point';
    return 'comma';
  }
  return 'point';
}

/** Decide the number format for a whole column. */
export function inferNumberFormat(values: string[]): NumberFormat {
  let comma = 0, point = 0;
  for (const raw of values) {
    const s = (raw || '').replace(/[^\d.,]/g, '');
    if (!s) continue;
    const lc = s.lastIndexOf(','), lp = s.lastIndexOf('.');
    if (lc !== -1 && lp !== -1) { if (lc > lp) comma++; else point++; continue; }
    if (lc !== -1) { if (s.length - lc - 1 === 2 || s.length - lc - 1 === 1) comma++; else point++; continue; }
    if (lp !== -1) { if (s.length - lp - 1 === 2 || s.length - lp - 1 === 1) point++; else comma++; }
  }
  return comma > point ? 'comma' : 'point';
}

/** Words banks prepend/append that say nothing about the payee. */
const NOISE_WORDS = new Set([
  'POS', 'CARD', 'PAYMENT', 'PAYMENTS', 'TO', 'FROM', 'DEBIT', 'CREDIT', 'PURCHASE', 'CONTACTLESS', 'REF', 'REFERENCE',
  'VISA', 'MASTERCARD', 'MAESTRO', 'AMEX', 'DEPOSIT', 'ON', 'AT', 'THE', 'BGC', 'DD', 'SO', 'FPI', 'FPO', 'TFR', 'CHQ',
  'PENDING', 'AUTHORISATION', 'AUTHORIZATION', 'TRANSACTION', 'ONLINE', 'MOBILE', 'APP', 'EFTPOS', 'SEPA', 'LASTSCHRIFT', 'GUTSCHRIFT',
]);

/**
 * Reduce a bank narrative to comparable text: upper-case ASCII, no punctuation,
 * no masked card numbers, embedded dates, reference numbers or filler words.
 * "CARD PAYMENT TO RENT - 14 HARBOUR ST XXXX5678 03SEP26" → "RENT 14 HARBOUR ST"
 */
export function normalizeDescription(input: string): string {
  const upper = (input || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/&/g, ' AND ');
  const tokens = upper.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of tokens) {
    if (/^[X*#]{2,}\d{0,6}$/.test(tok) || /^\d{0,4}[X*]{3,}\d{0,4}$/.test(tok)) continue; // masked card numbers
    if (/^\d{1,2}[A-Z]{3}\d{0,4}$/.test(tok)) continue;          // 03SEP26
    if (/^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?,?$/.test(tok)) continue; // 03/09, 03/09/26
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) continue;               // 2026-09-03
    const clean = tok.replace(/[^A-Z0-9]/g, '');
    if (!clean) continue;
    if (/^\d{6,}$/.test(clean)) continue;                        // long reference numbers
    if (NOISE_WORDS.has(clean)) continue;
    out.push(clean);
  }
  return out.join(' ');
}

/** Duplicate-detection key: same account, date, direction, cents and normalised text. */
export function fingerprint(accountId: string, date: string, type: 'income' | 'expense', amount: number, normalizedDescription: string): string {
  const cents = Math.round(Math.abs(amount) * 100);
  return crypto.createHash('sha256').update(`${accountId}|${date}|${type}|${cents}|${normalizedDescription}`).digest('hex');
}

/** Row amount (bank convention) → FinFolio type + positive amount. */
export function toTypeAndAmount(signed: number): { type: 'income' | 'expense'; amount: number } {
  return { type: signed < 0 ? 'expense' : 'income', amount: Math.round(Math.abs(signed) * 100) / 100 };
}

export const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
