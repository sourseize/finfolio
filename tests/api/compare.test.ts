import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launch, type TestApp, TEST_TODAY } from '../helpers/server.js';
import { scanPrivacy } from '../helpers/privacy.js';
import { parsePdf } from '../helpers/pdf.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD } from '../../src/seed/fin.js';
import { seedPenny, PENNY_USERNAME, PENNY_PASSWORD } from '../../src/seed/penny.js';
import { writeSeedSnapshot, writeAnonymousSnapshots } from '../../src/seed/cli.js';
import { validateSnapshot } from '../../src/compare/schema.js';
import { SNAPSHOT_LIMITS } from '../../src/compare/types.js';

/** Text that identifies fin or penny and must never appear in an export. */
const FIN_SECRETS = ['fin', 'folio', 'Everyday Checking', 'High-Yield Savings', 'Travel Rewards Card', 'Brokerage Cash', 'Harbour', 'Northwind', 'Lisbon', '1986-07-10', 'parents'];
const PENNY_SECRETS = ['penny', 'wise', 'Everyday Current', 'Rainy-Day', 'Cashback Card', 'Fund Platform', 'Brightline', 'mum', '1993-03-22', 'flat share'];

async function dbHash(app: TestApp): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(path.join(app.dataDir, 'database.json'))).digest('hex');
}

describe('Compare: snapshot export', () => {
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

  test('GET /api/compare/format is public and lists what is shared and what is not', async () => {
    const res = await app.get('/api/compare/format');
    assert.equal(res.status, 200);
    assert.equal(res.body.format, 'finfolio-compare');
    assert.equal(res.body.version, 1);
    assert.equal(res.body.fileSuffix, '.finfolio-compare.json');
    assert.ok(res.body.includes.length >= 8);
    assert.ok(res.body.excludes.some((s: string) => /username/.test(s)));
    assert.equal(res.body.limits.label, SNAPSHOT_LIMITS.label);
  });

  test('GET /api/compare/snapshot requires a session', async () => {
    assert.equal((await app.get('/api/compare/snapshot')).status, 401);
  });

  test('the export is a download with a file name derived from the label, as of the server clock', async () => {
    const res = await app.get('/api/compare/snapshot?label=Fin', fin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="fin.finfolio-compare.json"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.body.label, 'Fin');
    assert.equal(res.body.asOf, TEST_TODAY);
    assert.equal(res.body.exportedAt, '2026-10-25T12:00:00.000Z');
    assert.equal(res.body.currency, 'USD');
    assert.equal(res.body.app.name, 'finfolio');
    const v = validateSnapshot(res.body);
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  test('label: empty → "A friend", whitespace collapsed, capped, file name sanitised', async () => {
    let res = await app.get('/api/compare/snapshot', fin);
    assert.equal(res.body.label, 'A friend');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="a-friend.finfolio-compare.json"');
    res = await app.get(`/api/compare/snapshot?label=${encodeURIComponent('  Fin   the  First ')}`, fin);
    assert.equal(res.body.label, 'Fin the First');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="fin-the-first.finfolio-compare.json"');
    res = await app.get(`/api/compare/snapshot?label=${encodeURIComponent('x'.repeat(200))}`, fin);
    assert.equal(res.body.label.length, SNAPSHOT_LIMITS.label);
    res = await app.get(`/api/compare/snapshot?label=${encodeURIComponent('"; rm -rf / #')}`, fin);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="rm-rf.finfolio-compare.json"');
  });

  test('nothing identifying is in the file: no ids, usernames, birth dates, account names or descriptions', async () => {
    // The envelope names the product ("finfolio"); the scan for the *user's* name runs over `data` and the label-free envelope fields.
    const f = (await app.get('/api/compare/snapshot?label=Me', fin)).body;
    assert.deepEqual(scanPrivacy(f.data, [...FIN_SECRETS, ...PENNY_SECRETS]), []);
    assert.deepEqual(scanPrivacy({ ...f, format: '', app: {}, data: {} }, [...FIN_SECRETS, ...PENNY_SECRETS]), []);
    const p = (await app.get('/api/compare/snapshot?label=Me', penny)).body;
    assert.deepEqual(scanPrivacy(p.data, [...PENNY_SECRETS, ...FIN_SECRETS]), []);
    // Goal / habit / holding names are the only free text, and they are the user's own short labels.
    const strings: string[] = [];
    const walk = (v: unknown) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(f.data);
    assert.ok(strings.every(s => s.length <= SNAPSHOT_LIMITS.string), 'no long free text');
    assert.ok(!strings.some(s => /Monthly salary|Rent —|Supermarket|Credit card payment/.test(s)), 'no transaction descriptions');
  });

  test('the figures agree with the dashboard, the outlook and the rewards page', async () => {
    const s = (await app.get('/api/compare/snapshot?label=Fin', fin)).body.data;
    const dash = (await app.get('/api/dashboard', fin)).body;
    const outlook = (await app.get('/api/simulate/outlook', fin)).body;
    const baseline = (await app.get('/api/simulate/baseline', fin)).body.baseline;
    const motivation = (await app.get('/api/motivation', fin)).body;
    assert.equal(s.position.netWorth, Math.round(dash.netWorth * 100) / 100);
    assert.equal(s.position.holdingsValue, dash.investmentValue);
    assert.equal(s.position.debt, dash.totalLiabilities);
    assert.equal(s.cashflow.monthlyIncome, baseline.monthlyIncome);
    assert.equal(s.cashflow.monthlyExpenses, baseline.monthlyExpenses);
    assert.equal(s.cashflow.monthlyInvested, 1200, 'fin moves 1 200 to the brokerage every month');
    assert.equal(s.cashflow.savingsRate, Math.round(((baseline.monthlyIncome - baseline.monthlyExpenses) / baseline.monthlyIncome) * 10000) / 10000);
    assert.deepEqual(s.outlook.fire, { fiNumber: outlook.fire.fiNumber, progress: outlook.fire.progress, fiDate: outlook.fire.fiDate, fiAge: outlook.fire.fiAge, coastFiMonth: outlook.fire.coastFiMonth, fiByRetirement: outlook.fire.fiByRetirement, retirementAge: outlook.fire.retirementAge });
    assert.deepEqual(s.outlook.runway, outlook.runway);
    assert.equal(s.outlook.netWorthAtRetirement, outlook.netWorthAtRetirement);
    assert.deepEqual(s.outlook.yearly, outlook.yearly);
    assert.equal(s.motivation.pointsEarned, motivation.points.earned);
    assert.equal(s.motivation.balance, motivation.points.balance);
    assert.equal(s.motivation.rewardsClaimed, 4);
    assert.equal(s.motivation.badgesUnlocked, 6);
    assert.deepEqual(s.motivation.habits.map((h: any) => [h.name, h.streak]), motivation.habits.map((h: any) => [h.name, h.streak]));
    assert.equal(s.profile.age, 40);
    assert.equal(s.budgets.items.length, 7);
    assert.equal(s.cashflow.series.length, 24);
    assert.equal(s.goals.length, 4);
    assert.equal(s.investments.holdings.length, 5);
    assert.equal(s.investments.holdings[0].symbol, 'VTI', 'largest holding first');
    assert.equal(s.outlook.montecarlo.trials, 300);
  });

  test('penny\'s snapshot tells her story: 18 months, two liabilities, weekly streak, FI under 5%', async () => {
    const s = (await app.get('/api/compare/snapshot?label=Penny', penny)).body.data;
    assert.equal(s.profile.age, 33);
    assert.equal(s.cashflow.series.length, 18);
    assert.equal(s.cashflow.series[0].month, '2025-04');
    assert.equal(s.position.accountsByType.credit.count, 2);
    assert.ok(s.cashflow.savingsRate < 0.4 && s.cashflow.savingsRate > 0.3);
    assert.ok(s.outlook.fire.progress < 0.05);
    assert.equal(s.motivation.habits[0].cadence, 'weekly');
    assert.ok(s.motivation.habits[0].streak >= 20);
    assert.equal(s.motivation.badges.filter((b: any) => b.unlockedOn).length, 5);
    assert.ok(!s.investments.holdings.some((h: any) => h.type === 'crypto'));
  });

  test('exporting writes nothing: database bytes unchanged, no FI milestone recorded for a fresh user', async () => {
    // A fresh user with four months of income and spending: /api/motivation would record FI milestones today.
    const { token, user } = await app.register('newcomer', 'pw');
    const acc = (await app.post('/api/accounts', { name: 'Main', type: 'checking', balance: 9000 }, token)).body;
    for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
      await app.post('/api/transactions', { accountId: acc.id, type: 'income', amount: 3000, category: 'Salary', date: `${m}-01` }, token);
      await app.post('/api/transactions', { accountId: acc.id, type: 'expense', amount: 1500, category: 'Housing', date: `${m}-02` }, token);
    }
    const before = await dbHash(app);
    const filesBefore = (await fs.readdir(app.dataDir)).sort();
    const res = await app.get('/api/compare/snapshot?label=New', token);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.outlook.fire.fiNumber > 0);
    assert.equal(db.getMilestones(user.id).length, 0, 'no milestone persisted by the export');
    assert.equal(await dbHash(app), before, 'database.json untouched');
    assert.deepEqual((await fs.readdir(app.dataDir)).sort(), filesBefore, 'no new files in the data dir');
    // …whereas the rewards page does record them (existing behaviour, for contrast)
    await app.get('/api/motivation', token);
    assert.ok(db.getMilestones(user.id).length > 0);
  });

  test('exports are deterministic under a frozen clock', async () => {
    const a = await app.request('GET', '/api/compare/snapshot?label=Fin', undefined, fin);
    const b = await app.request('GET', '/api/compare/snapshot?label=Fin', undefined, fin);
    assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
    assert.equal(a.body.checksum, b.body.checksum);
  });

  test('the seed writes both snapshots to a folder and they validate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finfolio-snapshots-'));
    try {
      const finUser = db.getUserByUsername(FIN_USERNAME)!;
      const pennyUser = db.getUserByUsername(PENNY_USERNAME)!;
      const f = await writeSeedSnapshot(finUser.id, 'Fin', dir);
      const p = await writeSeedSnapshot(pennyUser.id, 'Penny', dir);
      assert.equal(path.basename(f), 'fin.finfolio-compare.json');
      assert.equal(path.basename(p), 'penny.finfolio-compare.json');
      for (const file of [f, p]) {
        const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
        const v = validateSnapshot(parsed);
        assert.equal(v.ok, true, file);
        assert.equal(parsed.asOf, '2026-10-25');
        assert.deepEqual(scanPrivacy(parsed.data, [...FIN_SECRETS, ...PENNY_SECRETS]), []);
      }
      // The file equals the API export under the same clock (the seed freezes it on the seed date).
      const viaApi = (await app.get('/api/compare/snapshot?label=Penny', penny)).body;
      const viaSeed = JSON.parse(await fs.readFile(p, 'utf-8'));
      assert.equal(viaSeed.checksum, viaApi.checksum);
      assert.equal((await app.get('/api/meta')).body.now, '2026-10-25T12:00:00.000Z', 'the test clock is restored');
      // …plus the two anonymous personas, so every demo user has three files to try.
      const anon = await writeAnonymousSnapshots(dir);
      assert.deepEqual(anon.map(f => path.basename(f)), ['anonymous-a.finfolio-compare.json', 'anonymous-b.finfolio-compare.json']);
      for (const file of anon) {
        const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
        assert.equal(validateSnapshot(parsed).ok, true, file);
        assert.equal(parsed.app.version, viaApi.app.version);
      }
      const checksums = new Set([...anon, f, p].map(async file => JSON.parse(await fs.readFile(file, 'utf-8')).checksum));
      assert.equal((await Promise.all(checksums)).length, new Set(await Promise.all(checksums)).size, 'four distinct snapshots');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Compare: POST /api/compare (transient)', () => {
  let app: TestApp;
  let fin: string;
  let penny: string;
  let pennyFile: any;
  let finFile: any;

  before(async () => {
    app = await launch();
    await seedFin(db);
    await seedPenny(db);
    fin = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
    penny = (await app.login(PENNY_USERNAME, PENNY_PASSWORD)).token;
    pennyFile = (await app.get('/api/compare/snapshot?label=Penny', penny)).body;
    finFile = (await app.get('/api/compare/snapshot?label=Fin', fin)).body;
  });
  after(async () => { await app.close(); });

  test('requires a session and a snapshot', async () => {
    assert.equal((await app.post('/api/compare', { snapshot: pennyFile })).status, 401);
    const res = await app.post('/api/compare', {}, fin);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /snapshot required/);
  });

  test('fin imports penny: report + both snapshots, my side built live and labelled "You"', async () => {
    const res = await app.post('/api/compare', { snapshot: pennyFile }, fin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { report, mine, theirs } = res.body;
    assert.deepEqual(report.labels, { mine: 'You', theirs: 'Penny' });
    assert.equal(mine.label, 'You');
    assert.equal(mine.checksum, finFile.checksum, 'my side is the same snapshot I would export');
    assert.equal(theirs.checksum, pennyFile.checksum);
    assert.deepEqual(scanPrivacy(theirs.data, FIN_SECRETS), [], 'nothing of mine leaks into their side');
    assert.equal(report.metrics.find((m: any) => m.key === 'netWorth').mine, finFile.data.position.netWorth);
    assert.ok(report.score.mine > report.score.theirs);
    assert.equal(report.series.length, 24);
    assert.ok(report.insights.length >= 5);
    assert.deepEqual(report.warnings, []);
  });

  test('…and penny imports fin: the mirror image', async () => {
    const ab = (await app.post('/api/compare', { snapshot: pennyFile }, fin)).body.report;
    const ba = (await app.post('/api/compare', { snapshot: finFile }, penny)).body.report;
    assert.deepEqual(ba.labels, { mine: 'You', theirs: 'Fin' });
    assert.equal(ba.score.mine, ab.score.theirs);
    assert.equal(ba.score.theirs, ab.score.mine);
    for (const m of ab.metrics) {
      const mirrored = ba.metrics.find((x: any) => x.key === m.key);
      assert.equal(mirrored.mine, m.theirs, m.key);
      assert.equal(mirrored.theirs, m.mine, m.key);
    }
  });

  test('the importer can rename the label', async () => {
    const res = await app.post('/api/compare', { snapshot: pennyFile, label: '  My sister  ' }, fin);
    assert.equal(res.body.report.labels.theirs, 'My sister');
    assert.equal(res.body.theirs.label, 'My sister');
    assert.ok(res.body.report.insights.some((i: any) => /My sister/.test(i.text)));
  });

  test('your own snapshot is refused', async () => {
    const res = await app.post('/api/compare', { snapshot: finFile }, fin);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /your own snapshot/);
  });

  test('bad files are refused with a reason, not a 500', async () => {
    const cases: [unknown, RegExp][] = [
      [{ hello: 'world' }, /not a FinFolio comparison snapshot/],
      [{ ...pennyFile, version: 9 }, /newer FinFolio/],
      [{ ...pennyFile, data: { ...pennyFile.data, position: { ...pennyFile.data.position, netWorth: 1 } } }, /checksum/],
      [{ ...pennyFile, data: { ...pennyFile.data, goals: 'none' } }, /data\.goals: expected a list/],
      ['just a string', /expected an object/],
    ];
    for (const [snapshot, expected] of cases) {
      const res = await app.post('/api/compare', { snapshot }, fin);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, expected);
    }
  });

  test('transient: nothing is written, cached or kept — database bytes and data dir unchanged', async () => {
    const before = await dbHash(app);
    const files = (await fs.readdir(app.dataDir)).sort();
    const { user, token } = await app.register('observer', 'pw');
    await app.post('/api/accounts', { name: 'Sanity', type: 'cash', balance: 1 }, token); // a real write, so the hash check below is meaningful
    for (let i = 0; i < 3; i++) {
      assert.equal((await app.post('/api/compare', { snapshot: pennyFile, label: `Run ${i}` }, fin)).status, 200);
      assert.equal((await app.post('/api/compare', { snapshot: { ...pennyFile, version: 9 } }, fin)).status, 400);
    }
    assert.equal((await app.post('/api/compare', { snapshot: pennyFile }, token)).status, 200, 'a user with no data can still compare');
    assert.equal(db.getMilestones(user.id).length, 0);
    // The account above wrote the file; compare calls after that must not touch it.
    const afterRegister = await dbHash(app);
    await app.post('/api/compare', { snapshot: finFile }, token);
    await app.post('/api/compare', { snapshot: pennyFile }, fin);
    assert.equal(await dbHash(app), afterRegister, 'database.json untouched by compare calls');
    assert.deepEqual((await fs.readdir(app.dataDir)).sort(), files, 'no new files');
    assert.notEqual(before, afterRegister, 'sanity: the hash does detect writes');
    // No trace of the imported label anywhere on disk
    const raw = await fs.readFile(path.join(app.dataDir, 'database.json'), 'utf-8');
    assert.ok(!raw.includes('Run 0') && !raw.includes('finfolio-compare') && !raw.includes(pennyFile.checksum), 'the imported snapshot never reached the database');
  });

  test('a user with no history gets a report that says so', async () => {
    const { token } = await app.register('blank', 'pw');
    const res = await app.post('/api/compare', { snapshot: pennyFile }, token);
    assert.equal(res.status, 200);
    assert.ok(res.body.report.warnings.some((w: string) => /You have no income or spending history/.test(w)));
    assert.equal(res.body.report.series.filter((p: any) => p.mine).length, 0);
  });
});

describe('Compare: POST /api/compare/whatif (sliders)', () => {
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

  test('zero extra reproduces the outlook; the max is half of spending rounded to 25', async () => {
    const res = await app.post('/api/compare/whatif', { extraSaving: 0, extraInvesting: 0 }, penny);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const outlook = (await app.get('/api/simulate/outlook', penny)).body;
    assert.equal(res.body.base.fiDate, outlook.fire.fiDate);
    assert.equal(res.body.base.netWorthAtRetirement, outlook.netWorthAtRetirement);
    assert.equal(res.body.max, Math.floor((outlook.monthlyExpenses * 0.5) / 25) * 25);
    assert.deepEqual(res.body.both, res.body.base);
  });

  test('saving and investing more each bring FI earlier; both together most; values are clamped and snapped to 25', async () => {
    const res = (await app.post('/api/compare/whatif', { extraSaving: 310, extraInvesting: 190 }, penny)).body;
    assert.equal(res.saving.monthlyExpenses, Math.round((res.base.monthlyExpenses - 300) * 100) / 100, 'snapped to 300');
    assert.equal(res.investing.monthlyContribution, Math.round((res.base.monthlyContribution + 200) * 100) / 100, 'snapped to 200');
    assert.equal(res.investing.monthlyExpenses, Math.round((res.base.monthlyExpenses - 200) * 100) / 100, 'investing more also means spending less');
    assert.ok(res.saving.fiDate < res.base.fiDate);
    assert.ok(res.investing.fiDate < res.base.fiDate);
    assert.ok(res.both.fiDate < res.saving.fiDate && res.both.fiDate < res.investing.fiDate);
    assert.ok(res.both.savingsRate > res.base.savingsRate);
    assert.ok(res.both.netWorthAtRetirement! > res.base.netWorthAtRetirement!);
    const huge = (await app.post('/api/compare/whatif', { extraSaving: 1e9, extraInvesting: -50 }, penny)).body;
    assert.equal(huge.both.monthlyExpenses, Math.round((huge.base.monthlyExpenses - huge.max) * 100) / 100, 'clamped to max');
    assert.deepEqual(huge.investing, huge.base, 'negative → 0');
    const junk = await app.post('/api/compare/whatif', { extraSaving: 'lots' }, fin);
    assert.equal(junk.status, 200);
    assert.deepEqual(junk.body.both, junk.body.base);
  });

  test('writes nothing', async () => {
    const before = await dbHash(app);
    await app.post('/api/compare/whatif', { extraSaving: 500, extraInvesting: 500 }, fin);
    assert.equal(await dbHash(app), before);
    assert.equal((await app.post('/api/compare/whatif', {})).status, 401);
  });
});

describe('Compare: POST /api/compare/pdf', () => {
  let app: TestApp;
  let fin: string;
  let pennyFile: any;

  before(async () => {
    app = await launch();
    await seedFin(db);
    await seedPenny(db);
    fin = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
    const penny = (await app.login(PENNY_USERNAME, PENNY_PASSWORD)).token;
    pennyFile = (await app.get('/api/compare/snapshot?label=Penny', penny)).body;
  });
  after(async () => { await app.close(); });

  async function pdf(body: unknown, token?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${app.baseUrl}/api/compare/pdf`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  test('returns a PDF download; same rules as /api/compare (auth, bad file, own snapshot)', async () => {
    const res = await pdf({ snapshot: pennyFile, label: 'Sis', whatIf: { extraSaving: 500, extraInvesting: 300 } }, fin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="finfolio-compare-sis-2026-10-25.pdf"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(Number(res.headers.get('content-length')), res.bytes.length);
    assert.equal(res.bytes.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    const parsed = parsePdf(res.bytes);
    assert.equal(parsed.pages, 5);
    const all = parsed.strings.join('\n');
    assert.match(all, /You vs Sis/);
    assert.match(all, /save \+\$500 and invest \+\$300 a month/);
    assert.equal((await pdf({ snapshot: pennyFile })).status, 401);
    const bad = await pdf({ snapshot: { hello: 1 } }, fin);
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.bytes.toString()).error, /not a FinFolio comparison snapshot/);
    const own = await pdf({ snapshot: (await app.get('/api/compare/snapshot', fin)).body }, fin);
    assert.equal(own.status, 400);
  });

  test('writes nothing and is deterministic under the frozen clock', async () => {
    const before = await dbHash(app);
    const a = await pdf({ snapshot: pennyFile }, fin);
    const b = await pdf({ snapshot: pennyFile }, fin);
    assert.equal(a.bytes.equals(b.bytes), true);
    assert.equal(await dbHash(app), before);
  });
});
