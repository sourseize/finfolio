import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareSnapshots, goalSummary, type ComparisonReport } from '../../src/compare/engine.js';
import type { Snapshot } from '../../src/compare/types.js';
import { anonymousA, anonymousB, anonymousSnapshot } from '../../src/seed/anonymous.js';

const GOLDEN = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'tests/golden/compare.snapshot.json'), 'utf-8'));
const fin = (): Snapshot => JSON.parse(JSON.stringify({ ...GOLDEN.fin, label: 'You' }));
const penny = (): Snapshot => JSON.parse(JSON.stringify(GOLDEN.penny));
const NOW = '2026-10-25T12:00:00.000Z';

/** Swap the two sides of a report so it can be compared with the mirrored run. */
function mirror(r: ComparisonReport): ComparisonReport {
  const flip = (l: any) => (l === 'mine' ? 'theirs' : l === 'theirs' ? 'mine' : l);
  return {
    ...r,
    labels: { mine: r.labels.theirs, theirs: r.labels.mine },
    asOf: { mine: r.asOf.theirs, theirs: r.asOf.mine, daysApart: r.asOf.daysApart },
    currency: { mine: r.currency.theirs, theirs: r.currency.mine, same: r.currency.same },
    profile: { mine: r.profile.theirs, theirs: r.profile.mine },
    score: { mine: r.score.theirs, theirs: r.score.mine, ties: r.score.ties, scored: r.score.scored },
    metrics: r.metrics.map(m => ({ ...m, mine: m.theirs, theirs: m.mine, delta: m.delta === null ? null : (m.delta === 0 ? 0 : -m.delta), leader: flip(m.leader) })),
    spending: r.spending.map(c => ({ ...c, mine: c.theirs, theirs: c.mine, shareDelta: c.shareDelta === 0 ? 0 : -c.shareDelta })),
    series: r.series.map(p => ({ month: p.month, mine: p.theirs, theirs: p.mine })),
    projection: r.projection.map(p => ({ age: p.age, mine: p.theirs, theirs: p.mine, mineReal: p.theirsReal, theirsReal: p.mineReal })),
    goals: { mine: r.goals.theirs, theirs: r.goals.mine, summary: { mine: r.goals.summary.theirs, theirs: r.goals.summary.mine } },
    habits: { mine: r.habits.theirs, theirs: r.habits.mine },
    badges: r.badges.map(b => ({ ...b, mine: b.theirs, theirs: b.mine })),
    insights: [],
    warnings: [],
  };
}

describe('compare/engine', () => {
  test('fin vs penny: scoreboard, leaders and notes', () => {
    const r = compareSnapshots(fin(), penny(), { now: NOW });
    assert.equal(r.generatedAt, NOW);
    assert.deepEqual(r.labels, { mine: 'You', theirs: 'Penny' });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.asOf.daysApart, 0);
    const by = Object.fromEntries(r.metrics.map(m => [m.key, m]));
    assert.equal(by.netWorth.leader, 'mine');
    assert.equal(by.debt.leader, 'mine', 'less debt is better');
    assert.equal(by.monthlyIncome.leader, null, 'income is not scored');
    assert.equal(by.monthlyIncome.note, 'circumstance, not scored');
    assert.equal(by.savingsRate.leader, 'mine');
    assert.equal(by.bestStreak.leader, 'theirs');
    assert.equal(by.goalsOnTrack.leader, 'theirs');
    assert.equal(by.fiDate.mine, '2043-05');
    assert.equal(by.fiDate.theirs, '2050-04');
    assert.equal(by.fiDate.delta, -83, 'months: mine − theirs');
    assert.equal(by.fiDate.leader, 'mine', 'earlier is better');
    assert.equal(by.fiByRetirement.leader, 'tie');
    assert.equal(by.successProbability.unit, 'percent');
    assert.equal(r.score.scored, r.metrics.filter(m => m.leader !== null).length);
    assert.equal(r.score.mine + r.score.theirs + r.score.ties, r.score.scored);
    assert.ok(r.score.mine > r.score.theirs);
    assert.ok(r.insights.some(i => i.tone === 'behind' && /streak/.test(i.text)), 'penny leads on streaks');
    assert.ok(r.insights.some(i => i.tone === 'lead' && /financial independence/.test(i.text)));
    assert.ok(r.insights.some(i => /in today's money/.test(i.text)), 'age-aligned projection in real terms');
  });

  test('symmetry: compare(b, a) is the mirror image of compare(a, b)', () => {
    const ab = compareSnapshots(fin(), penny(), { now: NOW });
    const ba = compareSnapshots({ ...penny(), label: 'You' }, { ...fin(), label: 'Fin' }, { now: NOW });
    const strip = (r: ComparisonReport) => ({ ...r, insights: [], warnings: [], labels: { mine: '', theirs: '' } });
    assert.deepEqual(strip(ba), strip(mirror(ab)));
    assert.equal(ab.score.mine, ba.score.theirs);
  });

  test('cash-flow series are aligned by calendar month; the shorter history shows nulls', () => {
    const r = compareSnapshots(fin(), penny(), { now: NOW });
    assert.equal(r.series.length, 24);
    assert.equal(r.series[0].month, '2024-10');
    assert.ok(r.series[0].mine && r.series[0].theirs === null, 'penny starts later');
    assert.equal(r.series.filter(p => p.theirs).length, 18);
    assert.equal(r.series[23].month, '2026-09');
    assert.ok(r.series[23].mine && r.series[23].theirs);
  });

  test('projection is aligned by whole age in both nominal and real terms', () => {
    const r = compareSnapshots(fin(), penny(), { now: NOW });
    const ages = r.projection.map(p => p.age);
    assert.deepEqual(ages, [...ages].sort((a, b) => a - b));
    assert.equal(new Set(ages).size, ages.length);
    const at40 = r.projection.find(p => p.age === 40)!;
    assert.equal(at40.mine, null, 'fin is already 40 — his projection starts at 41');
    assert.ok(at40.theirs! > 0 && at40.theirsReal! > 0 && at40.theirsReal! < at40.theirs!);
    const at60 = r.projection.find(p => p.age === 60)!;
    assert.ok(at60.mine! > 0 && at60.theirs! > 0);
  });

  test('spending mix: union of categories, sorted by the larger share, deltas signed mine − theirs', () => {
    const r = compareSnapshots(fin(), penny(), { now: NOW });
    assert.equal(r.spending[0].category, 'Housing');
    const gift = r.spending.find(c => c.category === 'Gift')!;
    assert.ok(gift.mine && gift.theirs);
    assert.equal(gift.shareDelta, Math.round((gift.mine!.share - gift.theirs!.share) * 10000) / 10000);
    for (let i = 1; i < r.spending.length; i++) {
      const big = (c: typeof gift) => Math.max(c.mine?.share ?? 0, c.theirs?.share ?? 0);
      assert.ok(big(r.spending[i - 1]) >= big(r.spending[i]));
    }
  });

  test('badges: one row per catalog badge with both unlock dates', () => {
    const r = compareSnapshots(fin(), penny(), { now: NOW });
    assert.equal(r.badges.length, 13);
    const unstoppable = r.badges.find(b => b.key === 'unstoppable')!;
    assert.equal(unstoppable.mine, null);
    assert.equal(unstoppable.theirs, '2026-07-13');
    assert.ok(r.insights.some(i => /Badges Penny has that you do not yet: Unstoppable/.test(i.text)));
  });

  test('different currencies: money metrics are shown but not scored; rates still are', () => {
    const t = penny();
    t.currency = 'EUR';
    const r = compareSnapshots(fin(), t, { now: NOW });
    assert.equal(r.currency.same, false);
    assert.ok(r.warnings.some(w => /EUR/.test(w) && /not converted/.test(w)));
    const by = Object.fromEntries(r.metrics.map(m => [m.key, m]));
    assert.equal(by.netWorth.leader, null);
    assert.equal(by.netWorth.note, 'different currencies — not scored');
    assert.equal(by.netWorth.delta, null);
    assert.equal(by.savingsRate.leader, 'mine');
    assert.ok(!r.insights.some(i => /in today's money/.test(i.text)), 'no cross-currency money insight');
  });

  test('stale and thin snapshots warn', () => {
    const t = penny();
    t.asOf = '2026-01-10';
    const r = compareSnapshots(fin(), t, { now: NOW });
    assert.ok(r.warnings.some(w => /288 days/.test(w)));
    const empty = penny();
    empty.data.cashflow.hasHistory = false;
    const r2 = compareSnapshots(fin(), empty, { now: NOW });
    assert.ok(r2.warnings.some(w => /no income or spending history/.test(w)));
  });

  test('no FI date on one or both sides', () => {
    const a = anonymousSnapshot(anonymousA());
    const b = anonymousSnapshot(anonymousB());
    const r = compareSnapshots(fin(), a, { now: NOW });
    const fi = r.metrics.find(m => m.key === 'fiDate')!;
    assert.equal(fi.theirs, null);
    assert.equal(fi.delta, null);
    assert.equal(fi.leader, null);
    assert.equal(fi.note, 'not in sight for at least one side');
    assert.ok(r.insights.some(i => i.tone === 'lead' && /Your FI date is in sight/.test(i.text)));
    const r2 = compareSnapshots({ ...a, label: 'You' }, b, { now: NOW });
    assert.ok(r2.insights.some(i => i.tone === 'neutral' && /Neither of you reaches the FI number/.test(i.text)));
    assert.equal(r2.metrics.find(m => m.key === 'yearsToFi')!.leader, null);
  });

  test('goal summary', () => {
    const g = goalSummary([
      { name: 'a', category: 'x', priority: 'high', target: 100, current: 100, deadline: null, progress: 1, status: 'funded', fundedBy: null },
      { name: 'b', category: 'x', priority: 'low', target: 100, current: 150, deadline: null, progress: 1.5, status: 'funded', fundedBy: null },
      { name: 'c', category: 'x', priority: 'low', target: 200, current: 50, deadline: null, progress: 0.25, status: 'at_risk', fundedBy: null },
    ]);
    assert.deepEqual(g, { count: 3, onTrack: 2, funded: 2, weightedProgress: 0.625 });
    assert.deepEqual(goalSummary([]), { count: 0, onTrack: 0, funded: 0, weightedProgress: 0 });
  });
});
