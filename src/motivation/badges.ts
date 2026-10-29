/**
 * Badges: no points, just recognition. Most are derived from the trail
 * (so they need no storage and can never be out of sync); the FI ones come
 * from the observed milestones.
 */
import type { BadgeIcon, BadgeStatus, Habit, Milestone, PeriodResult, RewardClaim } from './types.js';
import { isFiDateImprovement } from './milestones.js';

interface BadgeDef {
  id: string;
  name: string;
  description: string;
  icon: BadgeIcon;
}

export const BADGE_CATALOG: readonly BadgeDef[] = [
  { id: 'first-step', name: 'First step', description: 'Earn your first points', icon: 'footprint' },
  { id: 'century', name: 'Century', description: 'Earn 100 points all-time', icon: 'hundred' },
  { id: 'thousand', name: 'Thousand', description: 'Earn 1,000 points all-time', icon: 'thousand' },
  { id: 'on-fire', name: 'On fire', description: 'Hit a habit 4 times in a row', icon: 'flame' },
  { id: 'unstoppable', name: 'Unstoppable', description: 'Hit a habit 12 times in a row', icon: 'bolt' },
  { id: 'treat', name: 'Treat yourself', description: 'Claim your first reward', icon: 'gift' },
  { id: 'fi-5', name: 'First brick', description: 'Reach 5% of your FI number', icon: 'brick' },
  { id: 'fi-10', name: 'Seedling', description: 'Reach 10% of your FI number', icon: 'seedling' },
  { id: 'fi-25', name: 'Sprout', description: 'Reach 25% of your FI number', icon: 'sprout' },
  { id: 'fi-50', name: 'Halfway tree', description: 'Reach 50% of your FI number', icon: 'tree' },
  { id: 'fi-75', name: 'Summit in sight', description: 'Reach 75% of your FI number', icon: 'mountain' },
  { id: 'fi-100', name: 'Free', description: 'Reach 100% of your FI number — financially independent', icon: 'flag' },
  { id: 'closer', name: 'Closer', description: 'Bring your FI date at least a month earlier', icon: 'arrow' },
];

export interface BadgeInput {
  habits: Habit[];
  /** All scored periods per habit id (oldest first). */
  periods: Map<string, PeriodResult[]>;
  /** Ascending by date. */
  claims: RewardClaim[];
  milestones: Milestone[];
}

/** Earliest date a habit reached `length` in a row, with which habit. */
function firstStreak(input: BadgeInput, length: number): { date: string; detail: string } | null {
  let best: { date: string; detail: string } | null = null;
  for (const h of input.habits) {
    for (const p of input.periods.get(h.id) ?? []) {
      if (p.met && p.streak === length && p.scoredOn && (!best || p.scoredOn < best.date)) {
        best = { date: p.scoredOn, detail: `${length} in a row · ${h.name}` };
      }
    }
  }
  return best;
}

/** Earliest date the all-time points earned reached `target`. */
function firstEarned(input: BadgeInput, target: number): { date: string; detail: string } | null {
  const hits: { date: string; points: number }[] = [];
  for (const h of input.habits) for (const p of input.periods.get(h.id) ?? []) if (p.met && p.scoredOn) hits.push({ date: p.scoredOn, points: p.points });
  hits.sort((a, b) => a.date.localeCompare(b.date));
  let sum = 0;
  for (const h of hits) {
    sum += h.points;
    if (sum >= target) return { date: h.date, detail: `${sum.toLocaleString('en-US')} points earned` };
  }
  return null;
}

export function deriveBadges(input: BadgeInput): BadgeStatus[] {
  const unlocked = new Map<string, { date: string; detail: string }>();
  const first = firstEarned(input, 1);
  if (first) unlocked.set('first-step', { date: first.date, detail: 'The trail begins' });
  const century = firstEarned(input, 100);
  if (century) unlocked.set('century', century);
  const thousand = firstEarned(input, 1000);
  if (thousand) unlocked.set('thousand', thousand);
  const four = firstStreak(input, 4);
  if (four) unlocked.set('on-fire', four);
  const twelve = firstStreak(input, 12);
  if (twelve) unlocked.set('unstoppable', twelve);
  if (input.claims.length) unlocked.set('treat', { date: input.claims[0].date, detail: input.claims[0].name });
  for (const m of input.milestones) {
    if (m.kind === 'fi-progress' && m.level !== undefined) {
      const id = `fi-${m.level}`;
      if (!unlocked.has(id) || m.date < unlocked.get(id)!.date) unlocked.set(id, { date: m.date, detail: m.detail });
    } else if (isFiDateImprovement(m)) {
      if (!unlocked.has('closer') || m.date < unlocked.get('closer')!.date) unlocked.set('closer', { date: m.date, detail: m.detail });
    }
  }
  return BADGE_CATALOG.map(b => {
    const u = unlocked.get(b.id);
    return { ...b, unlockedOn: u ? u.date : null, detail: u ? u.detail : '' };
  });
}
