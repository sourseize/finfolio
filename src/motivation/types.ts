/**
 * Motivation: habits → points → rewards.
 *
 * The rule set is deliberately small (explainable in two minutes):
 *
 *   • A habit is "save X per week/month", "invest X per week/month" or
 *     "keep <category> under X per week/month" (a spending swap).
 *   • Hitting a habit's target earns points: 10 for a weekly save/invest,
 *     25 for a monthly one; a spending cap earns 5 (weekly) / 15 (monthly).
 *   • Four in a row is a streak — while the streak is alive, points double.
 *   • Every 100 points unlocks a reward (the user's own list, Phase 2).
 *
 * Points are always recomputed from the transactions, never stored as a
 * running total, so back-dated entries, edits, deletions and statement imports
 * correct the trail automatically.
 */

export type HabitKind = 'save' | 'invest' | 'swap';
export type Cadence = 'weekly' | 'monthly';

export interface Habit {
  id: string;
  userId: string;
  kind: HabitKind;
  /** Short label shown in the trail, e.g. "Weekly saving", "Coffee swap". */
  name: string;
  cadence: Cadence;
  /** Target (save / invest) or spending cap (swap) per period. */
  amount: number;
  /** Swap only: the spending category kept under the cap. */
  category?: string;
  /** Save only: count transfers into this account only (default: every savings account). */
  accountId?: string;
  /** First day that counts (YYYY-MM-DD). Periods containing this date and later are scored. */
  startDate: string;
  createdAt: string;
}

/** Points for meeting a habit once, by kind and cadence. */
export const HABIT_POINTS: Record<Cadence, Record<HabitKind, number>> = {
  weekly: { save: 10, invest: 10, swap: 5 },
  monthly: { save: 25, invest: 25, swap: 15 },
};

/** A streak of this many consecutive periods doubles the points (for that period and every one after while it lasts). */
export const STREAK_BONUS_AT = 4;
export const STREAK_MULTIPLIER = 2;

/** Points per reward step (Phase 2 adds tiers that are multiples of this). */
export const REWARD_STEP = 100;

/** At most this many habits per user — keeps the trail readable. */
export const MAX_HABITS = 8;
/** At most this many rewards on the list. */
export const MAX_REWARDS = 8;

/** A treat the user has chosen for themselves, priced in points. */
export interface Reward {
  id: string;
  userId: string;
  name: string;
  /** Points needed. */
  cost: number;
  /** Free text, typically the rough money cost: "~$60". */
  note: string;
  createdAt: string;
}

/** A reward the user cashed in. The name/cost are copied so history survives edits to the list. */
export interface RewardClaim {
  id: string;
  userId: string;
  rewardId: string;
  name: string;
  cost: number;
  note: string;
  /** YYYY-MM-DD */
  date: string;
  createdAt: string;
}

/** Offered when the list is empty. Multiples of REWARD_STEP so "100 points = a reward" stays true. */
export const DEFAULT_REWARDS: ReadonlyArray<Pick<Reward, 'name' | 'cost' | 'note'>> = [
  { name: 'Brunch at the coffee shop', cost: 100, note: '~$25' },
  { name: 'Dinner for two', cost: 250, note: '~$80' },
  { name: 'Family dinner out', cost: 500, note: '~$150' },
  { name: 'Weekend away', cost: 1000, note: '~$400' },
];

/** After this many days of being able to afford a reward without claiming, nudge gently. */
export const NUDGE_AFTER_DAYS = 30;

/** FI-progress rungs (percent of the FI number) that earn a badge. */
export const FI_LEVELS = [5, 10, 25, 50, 75, 100] as const;

/**
 * A financial-independence milestone, recorded the day it is first observed
 * (the simulator's baseline run is the source of truth for FI progress and date).
 */
export interface Milestone {
  id: string;
  userId: string;
  kind: 'fi-progress' | 'fi-date';
  /** fi-progress: the rung reached (5, 10, 25 …). */
  level?: number;
  /** fi-progress: the progress fraction observed; fi-date: the FI month (YYYY-MM). */
  value: number | string;
  /** YYYY-MM-DD the milestone was observed. */
  date: string;
  detail: string;
  createdAt: string;
}

export type BadgeIcon = 'footprint' | 'hundred' | 'thousand' | 'flame' | 'bolt' | 'gift' | 'brick' | 'seedling' | 'sprout' | 'tree' | 'mountain' | 'flag' | 'arrow';

export interface BadgeStatus {
  id: string;
  name: string;
  /** How to earn it, phrased for the locked state. */
  description: string;
  icon: BadgeIcon;
  /** YYYY-MM-DD, or null while locked. */
  unlockedOn: string | null;
  /** Shown on the unlocked badge, e.g. "12 in a row · Monthly saving". */
  detail: string;
}

export interface PeriodResult {
  /** Period key: Monday's date for weekly, YYYY-MM for monthly. */
  key: string;
  start: string;
  end: string;
  /** Amount saved / invested / spent in the period. */
  progress: number;
  target: number;
  /** True when the habit was met in this period. */
  met: boolean;
  /** True when the period has ended (a miss is only a miss once the period is over). */
  completed: boolean;
  /** Points earned for this period (0 when missed or still in progress). */
  points: number;
  /** Streak length including this period (0 when missed). */
  streak: number;
  /** Day the target was reached (save / invest), or the period end (swap). */
  scoredOn: string | null;
}

export interface HabitStatus {
  id: string;
  kind: HabitKind;
  name: string;
  cadence: Cadence;
  amount: number;
  category?: string;
  accountId?: string;
  startDate: string;
  /** Base points for one period (before the streak bonus). */
  pointsPerPeriod: number;
  current: PeriodResult;
  /** Consecutive periods met, counting back from the current period (or the last completed one when the current is still open). */
  streak: number;
  bestStreak: number;
  periodsMet: number;
  /** Completed periods plus the current one when it is already met. */
  periodsScored: number;
  pointsEarned: number;
  /** Last periods, oldest first, for the dots strip (includes the current one). */
  recent: PeriodResult[];
  /** True while the streak is one short of the bonus — the nudge text uses it. */
  bonusNext: boolean;
}

export type LedgerKind = 'habit' | 'miss' | 'reward' | 'milestone';

export interface LedgerEntry {
  date: string;
  kind: LedgerKind;
  habitId?: string;
  habitKind?: HabitKind;
  title: string;
  detail: string;
  points: number;
  /** Points balance after this entry (oldest → newest running total). */
  balance: number;
  periodKey?: string;
}

export interface RewardStatus extends Reward {
  /** True when the balance covers the cost. */
  ready: boolean;
  /** Points still missing (0 when ready). */
  shortBy: number;
  /** How many times it has been claimed. */
  timesClaimed: number;
  /** YYYY-MM-DD since when the balance has continuously covered it (any claim restarts the clock); null when not ready. */
  readySince: string | null;
  /** Days since `readySince` (0 when not ready). */
  readyDays: number;
}

export interface MotivationSummary {
  today: string;
  enabled: boolean;
  points: {
    earned: number;
    spent: number;
    balance: number;
    rewardStep: number;
    /** Points still needed for the next reward not yet affordable (or the next 100-step when the list is empty). */
    toNextReward: number;
    /** The reward the bar is filling towards (null when every reward is affordable). */
    nextReward: { id: string | null; name: string; cost: number } | null;
    /** Fill of the bar, 0..1: balance ÷ next reward cost, 1 when everything is affordable. */
    progress: number;
    /** Rewards on the list the balance can pay for right now. */
    rewardsAvailable: number;
  };
  habits: HabitStatus[];
  rewards: RewardStatus[];
  /** Newest first. */
  claims: RewardClaim[];
  /** Set when the cheapest reward has been affordable for NUDGE_AFTER_DAYS without a claim. */
  nudge: { rewardId: string; name: string; cost: number; since: string; days: number } | null;
  /** Every badge in the catalog, unlocked or not, in display order. */
  badges: BadgeStatus[];
  /** FI snapshot the milestones were judged against (null without history). */
  fi: { progress: number; fiDate: string | null; fiNumber: number } | null;
  /** Newest first. */
  ledger: LedgerEntry[];
  rules: {
    points: typeof HABIT_POINTS;
    streakBonusAt: number;
    streakMultiplier: number;
    rewardStep: number;
  };
  /** Starting values for the habit form, derived from the last complete months. */
  suggestions: {
    monthlySaving: number;
    monthlyInvesting: number;
    spendingByCategory: Record<string, number>;
    /** Categories with the highest average monthly spend, best first. */
    swapCandidates: string[];
  };
}
