import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, type TestApp } from '../helpers/server.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD } from '../../src/seed/fin.js';

/**
 * Golden-file regression for the demo user "fin".
 *
 * The seed, the clock and the Monte Carlo PRNG are all deterministic, so the
 * numbers below must not change unless the engine, the seed or the dashboard
 * semantics intentionally change. When they do, re-baseline with:
 *
 *   npm run test:update-golden
 *
 * and review the diff of tests/golden/fin.snapshot.json in code review.
 */
const SNAPSHOT = path.resolve(process.cwd(), 'tests/golden/fin.snapshot.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface Snapshot {
  dashboard: Record<string, unknown>;
  baseline: Record<string, unknown>;
  outlook: Record<string, unknown>;
  scenarios: Record<string, { summary: unknown; yearlyNetWorth: number[]; montecarlo: unknown; goals: unknown }>;
}

async function capture(app: TestApp, token: string): Promise<Snapshot> {
  const dash = (await app.get('/api/dashboard', token)).body;
  const { recentTransactions: _r, ...dashboard } = dash;
  const baseline = (await app.get('/api/simulate/baseline', token)).body.baseline;
  const { detail, ...baselineCore } = baseline;
  const outlook = (await app.get('/api/simulate/outlook', token)).body;
  const { yearly: _y, ...outlookCore } = outlook;
  const scenarios: Snapshot['scenarios'] = {};
  for (const s of (await app.get('/api/scenarios', token)).body) {
    const run = (await app.get(`/api/scenarios/${s.id}/run?months=0&montecarlo=1&trials=200&seed=42`, token)).body;
    const mc = run.montecarlo;
    scenarios[s.name] = {
      summary: run.result.summary,
      yearlyNetWorth: run.result.yearly.map((y: any) => y.netWorth),
      montecarlo: {
        successProbability: mc.successProbability,
        fiByRetirementProbability: mc.fiByRetirementProbability,
        fiMonth: mc.fiMonth,
        endNetWorth: mc.endNetWorth,
        bandsAt10y: mc.netWorthBands[9],
      },
      goals: run.goals.map((g: any) => ({ name: g.name, status: g.status, fundedBy: g.fundedBy, allocatedMonthly: g.allocatedMonthly })),
    };
  }
  return {
    dashboard: { ...dashboard, budgetHealth: dash.budgetHealth, topExpenseCategories: dash.topExpenseCategories },
    baseline: { ...baselineCore, expenseByCategory: detail.expenseByCategory, window: [detail.windowStart, detail.windowEnd] },
    outlook: outlookCore,
    scenarios,
  };
}

describe('Golden: fin', () => {
  let app: TestApp;
  let token: string;
  before(async () => {
    app = await launch();
    await seedFin(db);
    token = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
  });
  after(async () => { await app.close(); });

  test('snapshot matches tests/golden/fin.snapshot.json', async () => {
    const actual = await capture(app, token);
    const json = JSON.stringify(actual, null, 2) + '\n';
    let expected: string | null = null;
    try { expected = await fs.readFile(SNAPSHOT, 'utf-8'); } catch { /* missing */ }
    if (UPDATE || expected === null) {
      await fs.writeFile(SNAPSHOT, json);
      if (!UPDATE) assert.fail(`Golden snapshot was missing and has been written to ${SNAPSHOT}; re-run the tests.`);
      return;
    }
    assert.deepEqual(actual, JSON.parse(expected), 'fin snapshot drifted — if intentional run `npm run test:update-golden` and review the diff');
  });

  test('the snapshot itself is sane', async () => {
    const snap: Snapshot = JSON.parse(await fs.readFile(SNAPSHOT, 'utf-8'));
    assert.equal(Object.keys(snap.scenarios).length, 5);
    for (const [name, s] of Object.entries(snap.scenarios)) {
      const sum: any = s.summary;
      assert.equal(sum.depletedMonth, null, name);
      assert.ok(s.yearlyNetWorth.length >= 49, name);
      assert.ok(s.yearlyNetWorth[0] < s.yearlyNetWorth[20], `${name}: net worth grows over 20 years`);
    }
  });
});
