/**
 * Financial-independence milestones.
 *
 * The simulator tells us, for today, how far along the FI number we are and
 * when FI is reached on current habits. We cannot reconstruct those for past
 * dates (investment prices are only known today), so milestones are recorded
 * the day they are first *observed*: crossing a progress rung, or the FI date
 * landing at least a month earlier than the last recorded one.
 */
import { FI_LEVELS, type Milestone } from './types.js';
import { periodLabel } from './periods.js';

export interface FiSnapshot {
  /** investable ÷ FI number, 0..∞ */
  progress: number;
  /** YYYY-MM or null when not reached within the horizon */
  fiDate: string | null;
  fiNumber: number;
}

export type NewMilestone = Omit<Milestone, 'id' | 'userId' | 'createdAt'>;

/** True for a recorded FI-date milestone that is an improvement (not the first sighting). */
export function isFiDateImprovement(m: Pick<Milestone, 'kind' | 'detail'>): boolean {
  return m.kind === 'fi-date' && m.detail.startsWith('FI date moved');
}

/** Whole months between two YYYY-MM keys (b − a). */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

/**
 * Compare today's FI snapshot with what has been recorded and return the
 * milestones that are new today (possibly none). Pure; the caller stores them.
 */
export function observeFi(existing: Milestone[], fi: FiSnapshot | null, today: string): NewMilestone[] {
  if (!fi) return [];
  const out: NewMilestone[] = [];
  const pct = fi.progress * 100;
  const have = new Set(existing.filter(m => m.kind === 'fi-progress').map(m => m.level));
  for (const level of FI_LEVELS) {
    if (pct + 1e-9 >= level && !have.has(level)) {
      out.push({ kind: 'fi-progress', level, value: Math.round(fi.progress * 10000) / 10000, date: today, detail: level >= 100 ? 'Financially independent on current habits' : `${level}% of your FI number` });
    }
  }
  if (fi.fiDate) {
    const dates = existing.filter(m => m.kind === 'fi-date').sort((a, b) => a.date.localeCompare(b.date));
    const last = dates[dates.length - 1];
    if (!last) {
      out.push({ kind: 'fi-date', value: fi.fiDate, date: today, detail: `FI date first in sight: ${periodLabel('monthly', fi.fiDate)}` });
    } else if (last.date.slice(0, 7) !== today.slice(0, 7)) {
      const gained = monthsBetween(fi.fiDate, String(last.value));
      if (gained >= 1) {
        out.push({ kind: 'fi-date', value: fi.fiDate, date: today, detail: `FI date moved ${gained} month${gained === 1 ? '' : 's'} earlier — ${periodLabel('monthly', fi.fiDate)}, was ${periodLabel('monthly', String(last.value))}` });
      }
    }
  }
  return out;
}
