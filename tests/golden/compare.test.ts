import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, type TestApp } from '../helpers/server.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD } from '../../src/seed/fin.js';
import { seedPenny, PENNY_USERNAME, PENNY_PASSWORD } from '../../src/seed/penny.js';
import { anonymousPersonas, anonymousSnapshot } from '../../src/seed/anonymous.js';

/**
 * Golden-file regression for the comparison snapshots of both demo users, the
 * two anonymous personas, and the fin-vs-penny report.
 *
 * The snapshot is what a user shares, so its content must not drift silently:
 * a change here means either the engines, a seed, the snapshot format or the
 * comparison rules moved.
 * Re-baseline intentionally with `npm run test:update-golden` and review the diff.
 */
const SNAPSHOT = path.resolve(process.cwd(), 'tests/golden/compare.snapshot.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

describe('Golden: comparison snapshots', () => {
  let app: TestApp;
  let fin: string;
  let penny: string;
  before(async () => {
    app = await launch();
    await seedFin(db);
    await seedPenny(db);
    fin = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
    penny = (await app.login(PENNY_USERNAME, PENNY_PASSWORD)).token;
  });
  after(async () => { await app.close(); });

  test('snapshots and the fin-vs-penny report match tests/golden/compare.snapshot.json', async () => {
    const finFile = (await app.get('/api/compare/snapshot?label=Fin', fin)).body;
    const pennyFile = (await app.get('/api/compare/snapshot?label=Penny', penny)).body;
    const [a, b] = anonymousPersonas().map(p => anonymousSnapshot(p, { appVersion: finFile.app.version }));
    const report = (await app.post('/api/compare', { snapshot: pennyFile }, fin)).body.report;
    const actual = { fin: finFile, penny: pennyFile, anonymousA: a, anonymousB: b, finVsPenny: report };
    const json = JSON.stringify(actual, null, 2) + '\n';
    let expected: string | null = null;
    try { expected = await fs.readFile(SNAPSHOT, 'utf-8'); } catch { /* missing */ }
    if (UPDATE || expected === null) {
      await fs.writeFile(SNAPSHOT, json);
      if (!UPDATE) assert.fail(`Golden snapshot was missing and has been written to ${SNAPSHOT}; re-run the tests.`);
      return;
    }
    assert.deepEqual(actual, JSON.parse(expected), 'comparison snapshots drifted — if intentional run `npm run test:update-golden` and review the diff');
  });

  test('the golden file is sane', async () => {
    const snap = JSON.parse(await fs.readFile(SNAPSHOT, 'utf-8'));
    for (const who of ['fin', 'penny']) {
      const s = snap[who];
      assert.equal(s.format, 'finfolio-compare');
      assert.equal(s.asOf, '2026-10-25');
      assert.ok(s.data.cashflow.hasHistory);
      assert.ok(s.data.outlook.yearly.length > 40);
      assert.equal(s.data.motivation.badges.length, 13);
    }
    assert.ok(snap.fin.data.position.netWorth > snap.penny.data.position.netWorth);
    assert.ok(snap.fin.data.cashflow.savingsRate > snap.penny.data.cashflow.savingsRate);
    assert.ok(snap.penny.data.motivation.habits[0].streak > snap.fin.data.motivation.habits[0].streak, 'penny\'s weekly streak is longer');
    assert.notEqual(snap.fin.checksum, snap.penny.checksum);
    assert.equal(new Set([snap.fin, snap.penny, snap.anonymousA, snap.anonymousB].map((s: any) => s.checksum)).size, 4);
    const r = snap.finVsPenny;
    assert.deepEqual(r.labels, { mine: 'You', theirs: 'Penny' });
    assert.equal(r.metrics.length, 33);
    assert.equal(r.score.mine + r.score.theirs + r.score.ties, r.score.scored);
    assert.ok(r.insights.length >= 5);
  });
});
