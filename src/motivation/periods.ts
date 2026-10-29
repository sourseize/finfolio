/**
 * Calendar periods for habits. All dates are `YYYY-MM-DD` strings interpreted
 * in UTC (the same convention as the rest of the app), so results do not
 * depend on the server's time zone.
 *
 *   weekly  → key is the Monday of the week (ISO weeks, Monday–Sunday)
 *   monthly → key is `YYYY-MM`
 */
import type { Cadence } from './types.js';

const DAY_MS = 86_400_000;

export function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return toIso(new Date(toUtc(date).getTime() + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / DAY_MS);
}

/** Monday of the ISO week containing `date`. */
export function weekStart(date: string): string {
  const d = toUtc(date);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return toIso(new Date(d.getTime() - dow * DAY_MS));
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function periodKey(cadence: Cadence, date: string): string {
  return cadence === 'weekly' ? weekStart(date) : monthKey(date);
}

export function periodRange(cadence: Cadence, key: string): { start: string; end: string } {
  if (cadence === 'weekly') return { start: key, end: addDays(key, 6) };
  const [y, m] = key.split('-').map(Number);
  const start = `${key}-01`;
  const end = toIso(new Date(Date.UTC(y, m, 0))); // day 0 of next month = last day of this month
  return { start, end };
}

export function nextPeriodKey(cadence: Cadence, key: string): string {
  if (cadence === 'weekly') return addDays(key, 7);
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 1-based → this is next month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Every period key from the one containing `from` to the one containing `to`, oldest first. */
export function listPeriods(cadence: Cadence, from: string, to: string): string[] {
  const keys: string[] = [];
  if (from > to) return keys;
  let key = periodKey(cadence, from);
  const last = periodKey(cadence, to);
  while (key <= last) {
    keys.push(key);
    key = nextPeriodKey(cadence, key);
  }
  return keys;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Week of 19 Oct 2026" / "October 2026". */
export function periodLabel(cadence: Cadence, key: string): string {
  if (cadence === 'weekly') {
    const d = toUtc(key);
    return `Week of ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const [y, m] = key.split('-').map(Number);
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${full[m - 1]} ${y}`;
}
