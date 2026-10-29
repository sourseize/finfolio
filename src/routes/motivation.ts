/**
 * Motivation routes: habits and rewards CRUD, claiming, and the computed points / trail.
 *
 *   GET    /api/habits              list habits
 *   POST   /api/habits              { kind, cadence, amount, name?, category?, accountId?, startDate? }
 *                                   (the first habit also seeds the default reward list when it is empty)
 *   PUT    /api/habits/:id          any subset of the above
 *   DELETE /api/habits/:id
 *   GET    /api/rewards             the reward list
 *   POST   /api/rewards             { name, cost, note? }
 *   POST   /api/rewards/defaults    add the suggested four (only the ones not already present by name)
 *   PUT    /api/rewards/:id         { name?, cost?, note? }
 *   DELETE /api/rewards/:id
 *   POST   /api/rewards/:id/claim   cash in (400 when the balance does not cover the cost)
 *   DELETE /api/rewards/claims/:id  undo a claim made today
 *   GET    /api/motivation          points, habits, rewards, claims, nudge, badges, fi, ledger (trail), rules, suggestions
 *                                   (also observes today's FI progress / date and records new milestones)
 */
import { router } from '../server/router.js';
import { db, TRANSACTION_CATEGORIES, TRANSFER_CATEGORY, INVESTMENT_CATEGORY, UNCATEGORIZED_CATEGORY, type Habit, type Reward } from '../db/database.js';
import { today } from '../util/clock.js';
import { computeMotivation, observeFi, DEFAULT_REWARDS, MAX_HABITS, MAX_REWARDS, type Cadence, type HabitKind } from '../motivation/index.js';
import { fiSnapshotFor } from './simulate.js';
import type { ServerResponse } from 'node:http';

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: HabitKind[] = ['save', 'invest', 'swap'];
const CADENCES: Cadence[] = ['weekly', 'monthly'];
const NOT_SWAPPABLE = new Set([TRANSFER_CATEGORY, INVESTMENT_CATEGORY, UNCATEGORIZED_CATEGORY, 'Salary', 'Freelance']);

export function defaultHabitName(kind: HabitKind, cadence: Cadence, category?: string): string {
  const per = cadence === 'weekly' ? 'Weekly' : 'Monthly';
  if (kind === 'save') return `${per} saving`;
  if (kind === 'invest') return `${per} investing`;
  return `${category ?? 'Spending'} swap`;
}

/** Validate a create/update body. Returns the clean fields or an error message. */
function validate(userId: string, body: any, existing?: Habit): { ok: true; value: Omit<Habit, 'id' | 'userId' | 'createdAt'> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body required' };
  const kind = body.kind ?? existing?.kind;
  if (!KINDS.includes(kind)) return { ok: false, error: 'kind must be save, invest or swap' };
  const cadence = body.cadence ?? existing?.cadence ?? 'weekly';
  if (!CADENCES.includes(cadence)) return { ok: false, error: 'cadence must be weekly or monthly' };
  const amount = Number(body.amount ?? existing?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'amount must be a positive number' };
  const startDate = body.startDate ?? existing?.startDate ?? today();
  if (typeof startDate !== 'string' || !ISO_DATE.test(startDate) || Number.isNaN(new Date(startDate).getTime())) return { ok: false, error: 'startDate must be YYYY-MM-DD' };

  let category: string | undefined;
  if (kind === 'swap') {
    category = body.category ?? existing?.category;
    if (typeof category !== 'string' || !TRANSACTION_CATEGORIES.includes(category) || NOT_SWAPPABLE.has(category)) return { ok: false, error: 'category must be a spending category' };
  }
  let accountId: string | undefined;
  if (kind === 'save') {
    accountId = body.accountId === null ? undefined : (body.accountId ?? existing?.accountId);
    if (accountId !== undefined) {
      if (accountId === '') accountId = undefined;
      else {
        const acc = db.getAccount(accountId);
        if (!acc || acc.userId !== userId) return { ok: false, error: 'Unknown account' };
      }
    }
  }
  const rawName = body.name ?? existing?.name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 60) : defaultHabitName(kind, cadence, category);
  const value: Omit<Habit, 'id' | 'userId' | 'createdAt'> = { kind, name, cadence, amount: Math.round(amount * 100) / 100, startDate };
  if (category) value.category = category;
  if (accountId) value.accountId = accountId;
  return { ok: true, value };
}

router.get('/api/habits', async (req, res) => {
  json(res, db.getHabits((req as any).userId));
});

router.post('/api/habits', async (req, res, _m, body) => {
  const userId = (req as any).userId;
  if (db.getHabits(userId).length >= MAX_HABITS) return json(res, { error: `At most ${MAX_HABITS} habits — keep it simple` }, 400);
  const v = validate(userId, body);
  if (v.ok === false) return json(res, { error: v.error }, 400);
  const habit = db.createHabit({ userId, ...v.value });
  // First habit ever and nothing on the reward list: offer the suggested four so the loop is complete from day one.
  if (db.getRewards(userId).length === 0 && db.getRewardClaims(userId).length === 0 && db.getHabits(userId).length === 1) addDefaultRewards(userId);
  await db.persist();
  json(res, habit, 201);
});

router.put('/api/habits/:id', async (req, res, match, body) => {
  const userId = (req as any).userId;
  const existing = db.getHabit(match[1]);
  if (!existing || existing.userId !== userId) return json(res, { error: 'Not found' }, 404);
  const v = validate(userId, body, existing);
  if (v.ok === false) return json(res, { error: v.error }, 400);
  const updates: Partial<Habit> = { ...v.value };
  // Explicitly clear fields that no longer apply (kind changed, or "any savings account" chosen).
  if (!v.value.category) updates.category = undefined;
  if (!v.value.accountId) updates.accountId = undefined;
  const habit = db.updateHabit(existing.id, updates)!;
  await db.persist();
  json(res, habit);
});

router.delete('/api/habits/:id', async (req, res, match) => {
  const userId = (req as any).userId;
  const existing = db.getHabit(match[1]);
  if (!existing || existing.userId !== userId) return json(res, { error: 'Not found' }, 404);
  db.deleteHabit(existing.id);
  await db.persist();
  json(res, { success: true });
});

// ── Rewards ──

function addDefaultRewards(userId: string): Reward[] {
  const have = new Set(db.getRewards(userId).map(r => r.name.toLowerCase()));
  const added: Reward[] = [];
  for (const d of DEFAULT_REWARDS) {
    if (have.has(d.name.toLowerCase()) || db.getRewards(userId).length >= MAX_REWARDS) continue;
    added.push(db.createReward({ userId, ...d }));
  }
  return added;
}

function validateReward(body: any, existing?: Reward): { ok: true; value: Pick<Reward, 'name' | 'cost' | 'note'> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body required' };
  const rawName = body.name ?? existing?.name;
  if (typeof rawName !== 'string' || !rawName.trim()) return { ok: false, error: 'name required' };
  const cost = Number(body.cost ?? existing?.cost);
  if (!Number.isInteger(cost) || cost <= 0) return { ok: false, error: 'cost must be a whole number of points' };
  const note = body.note === undefined ? (existing?.note ?? '') : String(body.note).slice(0, 80);
  return { ok: true, value: { name: rawName.trim().slice(0, 60), cost, note } };
}

router.get('/api/rewards', async (req, res) => {
  json(res, db.getRewards((req as any).userId));
});

router.post('/api/rewards', async (req, res, _m, body) => {
  const userId = (req as any).userId;
  if (db.getRewards(userId).length >= MAX_REWARDS) return json(res, { error: `At most ${MAX_REWARDS} rewards — keep the list short and tempting` }, 400);
  const v = validateReward(body);
  if (v.ok === false) return json(res, { error: v.error }, 400);
  const reward = db.createReward({ userId, ...v.value });
  await db.persist();
  json(res, reward, 201);
});

router.post('/api/rewards/defaults', async (req, res) => {
  const userId = (req as any).userId;
  const added = addDefaultRewards(userId);
  await db.persist();
  json(res, added, 201);
});

router.put('/api/rewards/:id', async (req, res, match, body) => {
  const userId = (req as any).userId;
  const existing = db.getReward(match[1]);
  if (!existing || existing.userId !== userId) return json(res, { error: 'Not found' }, 404);
  const v = validateReward(body, existing);
  if (v.ok === false) return json(res, { error: v.error }, 400);
  const reward = db.updateReward(existing.id, v.value)!;
  await db.persist();
  json(res, reward);
});

router.delete('/api/rewards/:id', async (req, res, match) => {
  const userId = (req as any).userId;
  const existing = db.getReward(match[1]);
  if (!existing || existing.userId !== userId) return json(res, { error: 'Not found' }, 404);
  db.deleteReward(existing.id);
  await db.persist();
  json(res, { success: true });
});

/** Cash in a reward: the balance must cover it. Claims are dated today and become a −cost line in the trail. */
router.post('/api/rewards/:id/claim', async (req, res, match) => {
  const userId = (req as any).userId;
  const reward = db.getReward(match[1]);
  if (!reward || reward.userId !== userId) return json(res, { error: 'Not found' }, 404);
  const before = await motivationFor(userId);
  if (before.points.balance < reward.cost) {
    return json(res, { error: `Not enough points yet — ${reward.cost - before.points.balance} more for ${reward.name}`, balance: before.points.balance, cost: reward.cost }, 400);
  }
  const claim = db.createRewardClaim({ userId, rewardId: reward.id, name: reward.name, cost: reward.cost, note: reward.note, date: today() });
  await db.persist();
  const after = await motivationFor(userId);
  json(res, { claim, balance: after.points.balance, points: after.points }, 201);
});

/** Undo a claim made today (a mis-click). Older claims are history. */
router.delete('/api/rewards/claims/:id', async (req, res, match) => {
  const userId = (req as any).userId;
  const claim = db.getRewardClaims(userId).find(c => c.id === match[1]);
  if (!claim) return json(res, { error: 'Not found' }, 404);
  if (claim.date !== today()) return json(res, { error: 'Only a claim made today can be undone' }, 400);
  db.deleteRewardClaim(claim.id);
  await db.persist();
  json(res, { success: true });
});

/** Full motivation picture; records any FI milestone first observed today. */
export async function motivationFor(userId: string) {
  const now = today();
  let fi: ReturnType<typeof fiSnapshotFor> = null;
  try { fi = fiSnapshotFor(userId); } catch { /* a broken profile must not take the page down */ }
  const fresh = observeFi(db.getMilestones(userId), fi, now);
  if (fresh.length) {
    for (const m of fresh) db.createMilestone({ userId, ...m });
    await db.persist();
  }
  return computeMotivation({ ...db.getMotivationSource(userId), today: now, fi });
}

router.get('/api/motivation', async (req, res) => {
  json(res, await motivationFor((req as any).userId));
});
