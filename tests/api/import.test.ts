import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp } from '../helpers/server.js';
import { getFile, getScenario } from '../helpers/statements.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD } from '../../src/seed/fin.js';
import { _resetSessions } from '../../src/import/session.js';
import type { ScenarioFile } from '../../src/testing/statements/index.js';

/**
 * HTTP regression for the import API using the generated scenarios (workbook §7/§9).
 * Scenario expectations (samples/statements/README.md) are asserted here one by one.
 */
describe('API: statement import', () => {
  let app: TestApp;
  before(async () => { app = await launch(); _resetSessions(); });
  after(async () => { await app.close(); });

  const upload = (f: ScenarioFile | ScenarioFile[], accountId: string, token: string, options: Record<string, unknown> = {}, localeHint = 'en-GB') =>
    app.post('/api/import/preview', { accountId, localeHint, files: (Array.isArray(f) ? f : [f]).map(x => ({ name: x.name, content: x.bytes.toString('base64') })), options }, token);
  const commit = (previewId: string, token: string, body: Record<string, unknown> = {}) => app.post('/api/import/commit', { previewId, ...body }, token);
  const summaryOf = (res: { body: any }) => ({ new: res.body.summary.new, recorded: res.body.summary.recorded, possible: res.body.summary.possible, excluded: res.body.summary.excluded });

  test('GET /api/import/formats is public and lists formats, categories and limits', async () => {
    const res = await app.get('/api/import/formats');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.formats.map((f: any) => f.format), ['csv', 'ofx', 'qif', 'openbanking']);
    assert.ok(res.body.categories.includes('Uncategorized'));
    assert.equal(res.body.dedupe.possibleDays, 2);
    assert.equal(res.body.limits.maxFiles, 10);
  });

  describe('into the demo user fin (everything already recorded)', () => {
    let token: string;
    let checking: string;
    let card: string;
    before(async () => {
      await seedFin(db);
      token = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
      const accounts = (await app.get('/api/accounts', token)).body;
      checking = accounts.find((a: any) => a.name === 'Everyday Checking').id;
      card = accounts.find((a: any) => a.name === 'Travel Rewards Card').id;
    });

    test('S1: every format of the clean statement → all rows already recorded (R2)', async () => {
      for (const f of (await getScenario('S1')).files) {
        const res = await upload(f, checking, token);
        assert.equal(res.status, 200, `${f.name}: ${JSON.stringify(res.body.error)}`);
        assert.deepEqual(summaryOf(res), { new: 0, recorded: 12, possible: 0, excluded: 0 }, f.name);
        assert.deepEqual(res.body.summary.byRule, { R2: 12 }, f.name);
        assert.equal(res.body.files[0].format, f.format);
        assert.equal(res.body.balance.before, 7850.4);
        assert.equal(res.body.balance.deltaNew, 0);
      }
    });

    test('S2: bank-style descriptions and carried categories → still all recorded', async () => {
      for (const f of (await getScenario('S2')).files) {
        const res = await upload(f, checking, token);
        assert.deepEqual(summaryOf(res), { new: 0, recorded: 12, possible: 0, excluded: 0 }, f.name);
      }
    });

    test('S3: overlapping window → fin\'s own rows recorded, the six catch-up rows new and reconciled', async () => {
      const res = await upload(await getFile('S3', 'obie'), checking, token);
      assert.deepEqual(summaryOf(res), { new: 6, recorded: 12, possible: 0, excluded: 0 });
      assert.deepEqual(res.body.rows.filter((r: any) => r.status === 'new').map((r: any) => r.externalId), ['CATCHUP-1', 'CATCHUP-2', 'CATCHUP-3', 'CATCHUP-4', 'CATCHUP-5', 'CATCHUP-6']);
      assert.deepEqual(res.body.rows.filter((r: any) => r.status === 'new').map((r: any) => r.category), ['Healthcare', 'Shopping', 'Entertainment', 'Transfer', 'Uncategorized', 'Transportation']);
      assert.equal(res.body.balance.deltaNew, -165.99);
      assert.equal(Math.round((res.body.balance.before + res.body.balance.deltaNew) * 100) / 100, res.body.balance.statementClosing, 'importing the catch-up rows reconciles with the statement');
      assert.equal(res.body.balance.statementClosing, 7684.41);
    });

    test('S4: shifted rows → two Keep/Skip decisions, three new; commit is refused until decided', async () => {
      const f = await getFile('S4', 'ofx1');
      const res = await upload(f, checking, token);
      assert.deepEqual(summaryOf(res), { new: 3, recorded: 9, possible: 2, excluded: 0 });
      const possible = res.body.rows.filter((r: any) => r.status === 'possible');
      assert.deepEqual(possible.map((r: any) => r.externalId).sort(), ['PLANT-1DAY', 'PLANT-2DAY']);
      assert.deepEqual(possible.map((r: any) => r.match.rule), ['P1', 'P1']);
      assert.deepEqual(possible.map((r: any) => r.match.daysApart).sort(), [1, 2]);
      assert.deepEqual(res.body.rows.filter((r: any) => r.status === 'new').map((r: any) => r.externalId).sort(), ['PLANT-3DAY', 'PLANT-CENT', 'PLANT-REWORD']);
      const refused = await commit(res.body.previewId, token, {});
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'undecided');
      assert.deepEqual(refused.body.rows, possible.map((r: any) => r.idx));
      // the preview is still there afterwards
      assert.equal((await commit(res.body.previewId, token, { decisions: { [possible[0].idx]: 'bogus' } })).status, 400);
    });

    test('S5: verbatim repeat asks (CSV/QIF) or is new with distinct ids (OFX/OBIE); coffees are new', async () => {
      const csv = await upload(await getFile('S5', 'us.csv'), checking, token);
      assert.deepEqual(summaryOf(csv), { new: 2, recorded: 12, possible: 1, excluded: 0 });
      assert.equal(csv.body.rows.find((r: any) => r.status === 'possible').match.rule, 'P2');
      assert.deepEqual(csv.body.rows.filter((r: any) => r.status === 'new').map((r: any) => r.description).sort(), ['Coffee & pastries', 'Espresso bar']);
      const ofx = await upload(await getFile('S5', 'ofx1'), checking, token);
      assert.deepEqual(summaryOf(ofx), { new: 3, recorded: 12, possible: 0, excluded: 0 });
    });

    test('S6: EUR rows excluded and never written; GBP file blocked', async () => {
      const res = await upload(await getFile('S6', 'withCurrency'), checking, token);
      assert.deepEqual(summaryOf(res), { new: 0, recorded: 12, possible: 0, excluded: 3 });
      assert.deepEqual(res.body.summary.byReason, { currency: 3 });
      const before = (await app.get('/api/transactions?limit=500', token)).body.length;
      const done = await commit(res.body.previewId, token);
      assert.equal(done.status, 201);
      assert.equal(done.body.counts.imported, 0);
      assert.equal(done.body.counts.excluded, 3);
      assert.equal((await app.get('/api/transactions?limit=500', token)).body.length, before, 'nothing written');
      const gbp = await upload(await getFile('S6', 'gbp.ofx2'), checking, token);
      assert.equal(gbp.body.files[0].blocked.reason, 'currency');
      assert.equal(gbp.body.summary.excluded, 12);
      assert.equal(gbp.body.summary.recorded, 0, 'blocked rows are not even matched');
    });

    test('S7: pending excluded by default, importable with includePending (re-preview without re-upload)', async () => {
      const res = await upload(await getFile('S7', 'berlin'), checking, token);
      assert.deepEqual(res.body.summary.byReason, { pending: 2, future: 1 });
      assert.equal(res.body.rows.find((r: any) => r.externalId === 'FUTURE-1').reason, 'future');
      const again = await app.post('/api/import/preview', { previewId: res.body.previewId, options: { includePending: true } }, token);
      assert.equal(again.status, 200);
      assert.equal(again.body.previewId, res.body.previewId);
      assert.equal(again.body.summary.excluded, 1, 'the future row stays excluded');
      assert.equal(again.body.summary.new, 2);
      assert.equal(again.body.options.includePending, true);
    });

    test('S9/S10: the card statement into the card account → recorded, liability convention', async () => {
      const res = await upload(await getFile('S10', 'ofx1'), card, token);
      assert.deepEqual(summaryOf(res), { new: 0, recorded: 12, possible: 0, excluded: 0 });
      const payment = res.body.rows.find((r: any) => /Payment received/.test(r.description));
      assert.equal(payment.type, 'income');
      assert.equal(res.body.balance.statementClosing, 0, 'bank -0 → 0 owed');
      assert.equal(res.body.account.type, 'credit');
    });

    test('S11: invalid single file → 400 with the parser message; mixed upload → 200 with a per-file error', async () => {
      const s11 = await getScenario('S11');
      const byName = (n: string) => s11.files.find(f => f.name === n)!;
      for (const [name, code] of [['garbage.csv', 'unsupported'], ['empty.csv', 'empty'], ['brokerage.qif', 'investment'], ['brokerage.ofx', 'investment'], ['no-transactions.json', 'invalid'], ['headers-only.csv', 'invalid']] as const) {
        const res = await upload(byName(name), checking, token);
        assert.equal(res.status, 400, name);
        assert.equal(res.body.code, code, name);
      }
      const trunc = await upload(byName('truncated.ofx'), checking, token);
      assert.equal(trunc.status, 200);
      assert.equal(trunc.body.summary.excluded, 1, 'the cut-off transaction is excluded as invalid');
      assert.ok(trunc.body.files[0].warnings.some((w: string) => /truncated/.test(w)));
      const mixed = await upload([byName('brokerage.qif'), await getFile('S1', 'us.csv')], checking, token);
      assert.equal(mixed.status, 200);
      assert.equal(mixed.body.files[0].error.code, 'investment');
      assert.equal(mixed.body.files[1].rows, 12);
    });

    test('validation: account ownership/type, file count, body shape', async () => {
      const f = await getFile('S1', 'us.csv');
      assert.equal((await upload(f, 'nope', token)).status, 400);
      const brokerage = (await app.get('/api/accounts', token)).body.find((a: any) => a.type === 'investment');
      const inv = await upload(f, brokerage.id, token);
      assert.equal(inv.status, 400);
      assert.match(inv.body.error, /investment accounts/);
      assert.equal((await app.post('/api/import/preview', { accountId: checking }, token)).status, 400);
      assert.equal((await app.post('/api/import/preview', { accountId: checking, files: [{ name: 'x' }] }, token)).status, 400);
      assert.equal((await upload(Array(11).fill(f), checking, token)).status, 400);
      assert.equal((await app.post('/api/import/preview', {}, token)).status, 400);
      assert.equal((await app.post('/api/import/preview', { accountId: checking, files: [] })).status, 401, 'auth required');
    });
  });

  describe('fresh user: import, re-import, decisions, stamping, reconciliation', () => {
    let token: string;
    let other: string;
    let chk: string;
    let cardAcc: string;
    before(async () => {
      token = (await app.register('importer', 'pw')).token;
      other = (await app.register('someone-else', 'pw')).token;
      chk = (await app.post('/api/accounts', { name: 'Chk', type: 'checking', balance: 5606.7, currency: 'USD' }, token)).body.id; // statement opening balance
      cardAcc = (await app.post('/api/accounts', { name: 'Card', type: 'credit', balance: 0, currency: 'USD' }, token)).body.id;
      await app.post('/api/budgets', { category: 'Utilities', amount: 300, month: 8, year: 2026 }, token);
    });

    test('S1 CSV: all new → commit writes transactions with import metadata, balances and budgets follow', async () => {
      const f = await getFile('S1', 'us.csv');
      const res = await upload(f, chk, token, {}, 'en-US');
      assert.deepEqual(summaryOf(res), { new: 12, recorded: 0, possible: 0, excluded: 0 });
      assert.equal(res.body.files[0].mapping.mapping.dateOrder, 'MDY');
      assert.equal(res.body.balance.before, 5606.7);
      assert.equal(res.body.balance.statementClosing, 6202.01);
      assert.equal(Math.round((res.body.balance.before + res.body.balance.deltaNew) * 100) / 100, 6202.01, 'opening + rows = closing');
      assert.ok(res.body.expiresAt > new Date().toISOString());

      const done = await commit(res.body.previewId, token, { saveProfile: true });
      assert.equal(done.status, 201, JSON.stringify(done.body));
      assert.deepEqual(done.body.counts, { imported: 12, recorded: 0, skipped: 0, excluded: 0, stamped: 0, profilesSaved: 1 });
      assert.equal(done.body.balance.final, 6202.01);
      assert.equal(done.body.balance.adjustment, 0);
      assert.equal(done.body.batchIds.length, 1);

      const txns = (await app.get(`/api/transactions?batchId=${done.body.batchIds[0]}`, token)).body;
      assert.equal(txns.length, 12);
      const rent = txns.find((t: any) => /Rent/.test(t.description));
      assert.equal(rent.category, 'Housing');
      assert.equal(rent.type, 'expense');
      assert.equal(rent.amount, 1950);
      assert.equal(rent.import.source, 'csv');
      assert.equal(rent.import.batchId, done.body.batchIds[0]);
      assert.ok(rent.import.fingerprint);
      assert.equal(rent.import.rawDescription, 'Rent — 14 Harbour St');
      assert.equal(rent.import.externalId, undefined, 'CSV has no ids');
      const budgets = (await app.get('/api/budgets', token)).body;
      assert.equal(budgets[0].spent, 176.75 + 65 + 49.99 + 128, 'Utilities budget for September picked up the imported rows');
      assert.equal((await app.get(`/api/accounts/${chk}`, token)).body.balance, 6202.01);
      // the session is gone after commit
      assert.equal((await commit(res.body.previewId, token)).status, 410);
    });

    test('exact same file again → banner + all recorded; QIF/OFX of the same statement → all recorded', async () => {
      const again = await upload(await getFile('S1', 'us.csv'), chk, token);
      assert.equal(again.body.files[0].fileDuplicate.accountName, 'Chk');
      assert.equal(again.body.files[0].fileDuplicate.rows, 12);
      assert.equal(again.body.files[0].mapping.profileApplied, true, 'remembered CSV mapping applied');
      assert.deepEqual(summaryOf(again), { new: 0, recorded: 12, possible: 0, excluded: 0 });
      for (const part of ['uk.qif', 'ofx2', 'plaid']) {
        const res = await upload(await getFile('S1', part), chk, token);
        assert.deepEqual(summaryOf(res), { new: 0, recorded: 12, possible: 0, excluded: 0 }, part);
        assert.equal(res.body.files[0].fileDuplicate, undefined, 'different bytes → no exact-file banner');
      }
      const profiles = (await app.get('/api/import/profiles', token)).body;
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].dateOrder, 'MDY');
    });

    test('S4: Keep imports, Skip stamps the matched transaction (visible matchedFrom) and is recognised next time (R1)', async () => {
      const f = await getFile('S4', 'obie');
      const res = await upload(f, chk, token);
      assert.deepEqual(summaryOf(res), { new: 3, recorded: 9, possible: 2, excluded: 0 });
      const [keepRow, skipRow] = res.body.rows.filter((r: any) => r.status === 'possible');
      const done = await commit(res.body.previewId, token, { decisions: { [keepRow.idx]: 'keep', [skipRow.idx]: 'skip' } });
      assert.equal(done.status, 201);
      assert.deepEqual(done.body.counts, { imported: 4, recorded: 9, skipped: 1, excluded: 0, stamped: 1, profilesSaved: 0 });

      const all = (await app.get('/api/transactions?limit=500', token)).body;
      const stamped = all.find((t: any) => t.id === skipRow.match.txnId);
      assert.equal(stamped.import.externalId, skipRow.externalId, 'bank id now stored on the hand-entered transaction');
      assert.equal(stamped.import.matchedFrom.filename, f.name);
      assert.equal(stamped.import.matchedFrom.date, skipRow.date);
      assert.equal(stamped.import.matchedFrom.amount, skipRow.amount);
      assert.equal(stamped.import.matchedFrom.matchedAt, '2026-10-25T12:00:00.000Z');
      assert.equal(stamped.date, skipRow.match.date, 'the existing transaction keeps its own date');
      assert.ok(all.some((t: any) => t.import?.externalId === keepRow.externalId), 'kept row imported as its own transaction');

      const third = await upload(f, chk, token);
      assert.deepEqual(summaryOf(third), { new: 0, recorded: 14, possible: 0, excluded: 0 });
      assert.deepEqual(third.body.summary.byRule, { R2: 9, R1: 5 });
    });

    test('balance reconciliation: statement mode and manual mode record an adjustment', async () => {
      const f = await getFile('S12', 'us.csv');
      const side = (await app.post('/api/accounts', { name: 'Side', type: 'checking', balance: 0, currency: 'USD' }, token)).body.id;
      const res = await upload(f, side, token, {}, 'en-US');
      assert.equal(res.body.summary.new, res.body.summary.total);
      assert.equal((await commit(res.body.previewId, token, { balance: { mode: 'manual' } })).status, 400, 'manual needs a value');
      const done = await commit(res.body.previewId, token, { balance: { mode: 'statement' } });
      assert.equal(done.status, 201);
      assert.equal(done.body.balance.mode, 'statement');
      assert.equal(done.body.balance.final, res.body.balance.statementClosing);
      assert.equal(done.body.balance.adjustment, Math.round((res.body.balance.statementClosing - res.body.balance.deltaNew) * 100) / 100);
      assert.equal((await app.get(`/api/accounts/${side}`, token)).body.balance, res.body.balance.statementClosing);

      const ofx = await upload(await getFile('S12', 'ofx2'), side, token);
      assert.equal(ofx.body.summary.recorded, ofx.body.summary.total);
      const manual = await commit(ofx.body.previewId, token, { balance: { mode: 'manual', value: 1234.56 } });
      assert.equal(manual.body.balance.final, 1234.56);
      assert.equal((await app.get(`/api/accounts/${side}`, token)).body.balance, 1234.56);
      const qif = await upload(await getFile('S12', 'iso.qif'), side, token);
      assert.equal((await commit(qif.body.previewId, token, { balance: { mode: 'statement' } })).status, 400, 'QIF carries no closing balance');
    });

    test('S9: card statement first, then checking → the pay-off pairs as a Transfer', async () => {
      const cardRes = await upload(await getFile('S10', 'ofx1'), cardAcc, token);
      assert.equal(cardRes.body.summary.new, 12);
      assert.equal((await commit(cardRes.body.previewId, token)).status, 201);
      assert.equal((await app.get(`/api/accounts/${cardAcc}`, token)).body.balance, 0, 'purchases minus the payment → nothing owed');

      const chkRes = await upload(await getFile('S9', 'everyday-checking'), chk, token);
      const payoff = chkRes.body.rows.find((r: any) => /Credit card payment/.test(r.description));
      assert.equal(payoff.status, 'recorded', 'already imported with S1');
      // a fresh checking account shows the pairing on a new row
      const chk2 = (await app.post('/api/accounts', { name: 'Chk2', type: 'checking', balance: 0, currency: 'USD' }, token)).body.id;
      const res2 = await upload(await getFile('S9', 'everyday-checking'), chk2, token);
      const pay2 = res2.body.rows.find((r: any) => /Credit card payment/.test(r.description));
      assert.equal(pay2.status, 'new');
      assert.equal(pay2.transferWith.accountName, 'Card');
      assert.match(pay2.transferWith.description, /Payment received/);
      assert.equal(pay2.category, 'Transfer');
      assert.equal(pay2.categorySource, 'transfer');
      assert.equal(res2.body.summary.transfers, 1);
    });

    test('S8: ambiguous dates follow the locale and can be overridden per file; mapping changes re-preview', async () => {
      const f = await getFile('S8', 'ambiguous');
      const gb = await upload(f, chk, token, {}, 'en-GB');
      assert.equal(gb.body.files[0].mapping.mapping.dateOrder, 'DMY');
      assert.equal(gb.body.files[0].mapping.mapping.dateOrderAmbiguous, true);
      assert.equal(gb.body.summary.recorded, gb.body.summary.total, 'true dates → all recorded');
      const us = await app.post('/api/import/preview', { previewId: gb.body.previewId, options: { mappings: { 0: { dateOrder: 'MDY' } } } }, token);
      assert.equal(us.body.files[0].mapping.mapping.dateOrder, 'MDY');
      assert.equal(us.body.files[0].mapping.mapping.dateOrderAmbiguous, false);
      assert.ok(us.body.summary.new > 0, 'swapped day/month → rows look new');
    });

    test('sessions are private and expire', async () => {
      const res = await upload(await getFile('S1', 'us.csv'), chk, token);
      assert.equal((await commit(res.body.previewId, other)).status, 410, 'another user cannot see it');
      assert.equal((await app.post('/api/import/preview', { previewId: res.body.previewId }, other)).status, 410);
      assert.equal((await app.post('/api/import/preview', { previewId: 'missing' }, token)).status, 410);
      assert.equal((await commit('missing', token)).status, 410);
      assert.equal((await app.post('/api/import/commit', {}, token)).status, 400);
      // profiles are private too
      const mine = (await app.get('/api/import/profiles', token)).body;
      assert.equal((await app.del(`/api/import/profiles/${mine[0].id}`, other)).status, 404);
      assert.equal((await app.del(`/api/import/profiles/${mine[0].id}`, token)).status, 200);
      assert.equal((await app.get('/api/import/profiles', token)).body.length, 0);
    });
  });
});
