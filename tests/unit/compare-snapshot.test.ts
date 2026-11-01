import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, canonicalJson, checksumOf, normalizeLabel, snapshotFileName, type SnapshotSource } from '../../src/compare/snapshot.js';
import { validateSnapshot } from '../../src/compare/schema.js';
import { DEFAULT_LABEL, SNAPSHOT_LIMITS, SNAPSHOT_VERSION } from '../../src/compare/types.js';
import { scanPrivacy } from '../helpers/privacy.js';
import type { Account, Transaction } from '../../src/db/database.js';

const TODAY = '2026-10-25';
const NOW = '2026-10-25T12:00:00.000Z';

function emptySource(): SnapshotSource {
  return { accounts: [], transactions: [], investments: [], investmentTransactions: [], goals: [], budgets: [], habits: [], rewards: [], claims: [], milestones: [] };
}

/** A small but complete user: two accounts, six months of salary / rent / groceries / savings transfers, one holding, a goal and a habit. */
function smallSource(): SnapshotSource {
  const src = emptySource();
  const checking: Account = { id: 'acc-checking', userId: 'u1', name: 'Main', type: 'checking', balance: 4000, currency: 'USD', createdAt: NOW };
  const savings: Account = { id: 'acc-savings', userId: 'u1', name: 'Stash', type: 'savings', balance: 6000, currency: 'USD', createdAt: NOW };
  src.accounts.push(checking, savings);
  let n = 0;
  const add = (accountId: string, type: Transaction['type'], category: string, amount: number, date: string): void => {
    src.transactions.push({ id: `t${n++}`, userId: 'u1', accountId, type, category, amount, description: `secret ${n}`, date, tags: ['x'] });
  };
  for (const m of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
    add(checking.id, 'income', 'Salary', 3000, `${m}-01`);
    add(checking.id, 'expense', 'Housing', 1200, `${m}-02`);
    add(checking.id, 'expense', 'Food & Dining', 400, `${m}-10`);
    add(checking.id, 'expense', 'Transfer', 500, `${m}-05`);
    add(savings.id, 'income', 'Transfer', 500, `${m}-05`);
    add(checking.id, 'expense', 'Investment', 200, `${m}-06`);
  }
  src.investments.push({ id: 'inv-1', userId: 'u1', symbol: 'VT', name: 'World', type: 'etf', shares: 10, avgCost: 100, currentPrice: 120, currency: 'USD', notes: 'private note', createdAt: NOW });
  src.investmentTransactions.push({ id: 'it-1', investmentId: 'inv-1', userId: 'u1', type: 'buy', shares: 2, pricePerShare: 100, totalAmount: 200, date: '2026-09-06', notes: '' });
  src.goals.push({ id: 'g-1', userId: 'u1', name: 'Holiday', targetAmount: 2000, currentAmount: 500, deadline: '2027-06-30', category: 'Travel', priority: 'low', notes: 'with mum', createdAt: NOW });
  src.budgets.push({ id: 'b-1', userId: 'u1', category: 'Food & Dining', amount: 450, spent: 400, period: 'monthly', month: 9, year: 2026 });
  src.habits.push({ id: 'h-1', userId: 'u1', kind: 'save', name: 'Monthly saving', cadence: 'monthly', amount: 500, startDate: '2026-05-01', createdAt: NOW });
  src.rewards.push({ id: 'r-1', userId: 'u1', name: 'Brunch', cost: 100, note: '~$25', createdAt: NOW });
  src.profile = { birthDate: '1990-01-15', retirementAge: 62, safeWithdrawalRate: 0.04, planToAge: 90 };
  return src;
}

describe('compare/snapshot builder', () => {
  test('an empty user produces a valid snapshot with no history', () => {
    const s = buildSnapshot(emptySource(), { today: TODAY, now: NOW });
    assert.equal(s.format, 'finfolio-compare');
    assert.equal(s.version, SNAPSHOT_VERSION);
    assert.equal(s.label, DEFAULT_LABEL);
    assert.equal(s.currency, 'USD');
    assert.equal(s.data.cashflow.hasHistory, false);
    assert.deepEqual(s.data.cashflow.series, []);
    assert.equal(s.data.position.netWorth, 0);
    assert.equal(s.data.motivation.enabled, false);
    assert.equal(s.data.outlook.hasHistory, false);
    assert.equal(s.data.motivation.badges.length, 13);
    const v = validateSnapshot(JSON.parse(JSON.stringify(s)));
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  test('a small user: figures derive from the transactions and the engines agree', () => {
    const s = buildSnapshot(smallSource(), { today: TODAY, now: NOW, label: '  Sam   Example ', appVersion: '1.2.3' });
    assert.equal(s.label, 'Sam Example');
    assert.equal(s.app.version, '1.2.3');
    assert.equal(s.asOf, TODAY);
    const d = s.data;
    assert.equal(d.profile.age, 36);
    assert.equal(d.profile.retirementAge, 62);
    assert.equal(d.position.liquid, 10000);
    assert.equal(d.position.invested, 1200);
    assert.equal(d.position.netWorth, 11200);
    assert.deepEqual(d.position.accountsByType, { checking: { count: 1, balance: 4000 }, savings: { count: 1, balance: 6000 } });
    // 12-month window 2025-10..2026-09 averaged over 12 months, 6 of them active.
    assert.equal(d.cashflow.windowStart, '2025-10');
    assert.equal(d.cashflow.windowEnd, '2026-09');
    assert.equal(d.cashflow.monthlyIncome, 1500);
    assert.equal(d.cashflow.monthlyExpenses, 800);
    assert.equal(d.cashflow.monthlySaved, 700);
    assert.equal(d.cashflow.monthlyInvested, 100);
    assert.equal(d.cashflow.savingsRate, 0.4667);
    assert.equal(d.cashflow.investingRate, 0.0667);
    assert.equal(d.cashflow.historyMonths, 7);
    assert.equal(d.cashflow.expenseByCategory.Housing.share, 0.75);
    assert.equal(d.cashflow.series.length, 6, 'complete months with activity only');
    assert.deepEqual(d.cashflow.series[0], { month: '2026-04', income: 3000, spending: 1600, invested: 200, saved: 500, net: 1400 });
    assert.equal(d.cashflow.series[5].month, '2026-09');
    assert.deepEqual(d.budgets, { month: '2026-10', items: [{ category: 'Food & Dining', budgeted: 450, spent: 400 }] });
    assert.equal(d.investments.value, 1200);
    assert.equal(d.investments.cost, 1000);
    assert.equal(d.investments.gainPct, 0.2);
    assert.deepEqual(d.investments.byType, { etf: 1 });
    assert.deepEqual(d.investments.holdings, [{ symbol: 'VT', type: 'etf', value: 1200, cost: 1000, weight: 1 }]);
    assert.equal(d.goals.length, 1);
    assert.equal(d.goals[0].progress, 0.25);
    assert.ok(['on_track', 'funded', 'at_risk', 'unreachable'].includes(d.goals[0].status));
    assert.equal(d.motivation.enabled, true);
    assert.equal(d.motivation.habits[0].name, 'Monthly saving');
    assert.ok(d.motivation.pointsEarned > 0);
    assert.equal(d.motivation.habits[0].hitRate, 1);
    assert.ok(d.outlook.fire.fiNumber > 0);
    assert.ok(d.outlook.yearly.length > 10);
    assert.equal(d.outlook.montecarlo?.trials, 300);
    assert.ok(d.outlook.runway.cashMonths! > 0);
  });

  test('nothing identifying leaves the builder', () => {
    const s = buildSnapshot(smallSource(), { today: TODAY, now: NOW, label: 'Sam' });
    const findings = scanPrivacy(s, ['secret', 'private note', 'with mum', 'Main', 'Stash', 'u1', 'acc-', 'inv-1', '1990-01-15']);
    assert.deepEqual(findings, []);
  });

  test('deterministic: same input, same bytes and checksum', () => {
    const a = buildSnapshot(smallSource(), { today: TODAY, now: NOW });
    const b = buildSnapshot(smallSource(), { today: TODAY, now: NOW });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.match(a.checksum, /^sha256:[0-9a-f]{64}$/);
  });

  test('canonical JSON ignores key order; the checksum follows', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] }), '{"a":[{"x":1,"y":2}],"b":1}');
    assert.equal(canonicalJson({ u: undefined }), '{"u":null}');
    const s = buildSnapshot(smallSource(), { today: TODAY, now: NOW });
    const reordered: any = {};
    for (const k of Object.keys(s.data).reverse()) reordered[k] = (s.data as any)[k];
    const { netWorth, ...restOfPosition } = reordered.position;
    reordered.position = { ...restOfPosition, netWorth }; // a nested key moved to the end
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(s.data));
    assert.equal(checksumOf(reordered), s.checksum);
  });

  test('labels and file names', () => {
    assert.equal(normalizeLabel(undefined), DEFAULT_LABEL);
    assert.equal(normalizeLabel('   '), DEFAULT_LABEL);
    assert.equal(normalizeLabel(' Fin  the\tFirst '), 'Fin the First');
    assert.equal(normalizeLabel('x'.repeat(100)).length, SNAPSHOT_LIMITS.label);
    assert.equal(snapshotFileName('Penny'), 'penny.finfolio-compare.json');
    assert.equal(snapshotFileName('A friend'), 'a-friend.finfolio-compare.json');
    assert.equal(snapshotFileName('Émilie / 2026!'), 'milie-2026.finfolio-compare.json');
    assert.equal(snapshotFileName('!!!'), 'snapshot.finfolio-compare.json');
  });
});

describe('compare/schema validation', () => {
  const good = () => JSON.parse(JSON.stringify(buildSnapshot(smallSource(), { today: TODAY, now: NOW, label: 'Sam' })));

  test('accepts what the builder produces, and returns an equal copy', () => {
    const raw = good();
    const v = validateSnapshot(raw);
    assert.equal(v.ok, true, JSON.stringify(v));
    if (v.ok) assert.deepEqual(v.snapshot, raw);
  });

  test('rejects the wrong format, a newer version and non-objects', () => {
    for (const bad of [null, 42, 'x', [], {}]) {
      const v = validateSnapshot(bad);
      assert.equal(v.ok, false);
    }
    let v = validateSnapshot({ ...good(), format: 'finfolio-backup' });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors[0], /not a FinFolio comparison snapshot/);
    v = validateSnapshot({ ...good(), version: 2 });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors[0], /newer FinFolio/);
  });

  test('edited numbers fail the checksum; a tampered label does not (it is not covered) but is capped', () => {
    const raw = good();
    raw.data.position.netWorth += 1;
    const v = validateSnapshot(raw);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors[0], /checksum/);
    const r2 = good();
    r2.label = ' <b>Sam</b>' + 'x'.repeat(100);
    const v2 = validateSnapshot(r2);
    assert.equal(v2.ok, true);
    if (v2.ok) assert.equal(v2.snapshot.label.length, SNAPSHOT_LIMITS.label);
  });

  test('type errors are reported with a path', () => {
    const r = good();
    r.data.goals[0].target = 'lots';
    const v = validateSnapshot(r);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors[0], /data\.goals\[0\]\.target: expected a finite number/);
    const r2 = good();
    r2.data.cashflow.series = [{ month: '2026-01', income: 1, spending: 1, invested: 0, saved: 0, net: 0 }, { month: '2025-12', income: 1, spending: 1, invested: 0, saved: 0, net: 0 }];
    const v2 = validateSnapshot(r2);
    assert.equal(v2.ok, false);
    if (!v2.ok) assert.match(v2.errors[0], /ascending/);
    const r3 = good();
    r3.data.goals[0].status = 'maybe';
    const v3 = validateSnapshot(r3);
    assert.equal(v3.ok, false);
    if (!v3.ok) assert.match(v3.errors[0], /status/);
  });

  test('Infinity from JSON (1e999) and oversized arrays are rejected', () => {
    const text = JSON.stringify(good()).replace(/"netWorth":[-0-9.]+/, '"netWorth":1e999');
    const v = validateSnapshot(JSON.parse(text));
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors[0], /finite number/);
    const r = good();
    r.data.investments.holdings = Array.from({ length: SNAPSHOT_LIMITS.holdings + 1 }, () => ({ symbol: 'X', type: 'etf', value: 1, cost: 1, weight: 0 }));
    const v2 = validateSnapshot(r);
    assert.equal(v2.ok, false);
    if (!v2.ok) assert.match(v2.errors[0], /at most 50/);
  });

  test('control characters are stripped from text and strings are capped', () => {
    const r = good();
    r.data.goals[0].name = 'Holi\u0000day\u001f' + 'y'.repeat(200);
    r.checksum = checksumOf(r.data);
    const v = validateSnapshot(r);
    assert.equal(v.ok, true, JSON.stringify(v));
    if (v.ok) {
      assert.ok(v.snapshot.data.goals[0].name.startsWith('Holiday'));
      assert.equal(v.snapshot.data.goals[0].name.length, SNAPSHOT_LIMITS.string);
    }
  });

  test('unknown fields are dropped from the validated copy', () => {
    const r = good();
    r.data.extra = { userId: 'leak' };
    r.secret = 1;
    r.checksum = checksumOf(r.data);
    const v = validateSnapshot(r);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal('extra' in v.snapshot.data, false);
      assert.equal('secret' in v.snapshot, false);
    }
  });
});
