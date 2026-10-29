import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp } from '../helpers/server.js';
import { openApp, type Browser } from '../helpers/browser.js';
import { flush } from '../helpers/dom.js';
import { getFile } from '../helpers/statements.js';
import { _resetSessions } from '../../src/import/session.js';

/**
 * SMOKE TESTS — hotfix release gate for statement import.
 *
 * Two end-to-end journeys through the real UI against the real server:
 *   SMOKE-1  import a clean statement → the transactions and the balance are right
 *   SMOKE-2  import a statement with near-duplicates → the wizard stops and asks,
 *            Keep/Skip remove rows, the result is written as decided
 * Plus the navigation glue (sidebar entry, deep links, post-import filter).
 * The same journeys are written for a human tester in docs/IMPORT_TEST_SUITE.md §1.0.
 */
describe('UI smoke: statement import wizard', () => {
  let app: TestApp;
  let token: string;
  let b: Browser;
  let checkingId: string;

  before(async () => {
    app = await launch();
    _resetSessions();
    token = (await app.register('smoke', 'pw')).token;
    checkingId = (await app.post('/api/accounts', { name: 'Smoke Checking', type: 'checking', balance: 5606.7, currency: 'USD' }, token)).body.id;
    await app.post('/api/accounts', { name: 'Smoke Brokerage', type: 'investment', balance: 100, currency: 'USD' }, token);
    b = await openApp({ baseUrl: app.baseUrl, token });
  });
  after(async () => { await app.close(); });

  const noErrors = () => assert.deepEqual(b.errors.map(e => e.stack || e.message), [], 'page errors');
  const text = () => b.document.getElementById('page-content')!.textContent.replace(/\s+/g, ' ');
  const dropFile = async (scenario: string, namePart: string) => {
    const f = await getFile(scenario, namePart);
    await b.App.importFiles([{ name: f.name, bytes: new Uint8Array(f.bytes) }]);
    await flush(3);
    return f;
  };
  const click = async (selector: string) => { await b.$(selector).click(); await flush(5); };

  test('navigation: sidebar entry, Transactions button, Account-card deep link preselects the account', async () => {
    assert.ok(b.$('.sidebar-link[data-page="import"]'), 'sidebar has Import');
    await b.goto('transactions');
    assert.equal(b.$('#import-txn-btn').getAttribute('href'), '#import');
    await b.goto('accounts');
    const link = b.$(`.import-account-btn[href="#import?account=${checkingId}"]`);
    assert.ok(link, 'checking account card has an Import button');
    assert.equal(b.$$('.import-account-btn').length, 1, 'the investment account gets none');
    await b.goto(`import?account=${checkingId}`);
    assert.equal(b.$('#import-account').value, checkingId, 'account preselected from the deep link');
    assert.ok(!b.$$('#import-account option').some(o => /Brokerage/.test(o.textContent)), 'investment accounts are not offered');
    assert.ok(b.$('#import-continue').disabled, 'Continue waits for a file');
    noErrors();
  });

  test('regression: real browser File objects are read correctly (Blob.bytes() is a method, not data)', async () => {
    b.App.importReset({ account: checkingId });
    await b.goto('import');
    const f = await getFile('S1', 'us.csv');
    const data = new Uint8Array(f.bytes);
    // Exactly what Chrome / Firefox hand over from the drop zone: a File with arrayBuffer() AND a bytes() method.
    const browserFile = {
      name: f.name,
      size: data.byteLength,
      type: 'text/csv',
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      bytes: async () => data,
      text: async () => Buffer.from(data).toString('utf8'),
    };
    await b.App.importFiles([browserFile]);
    await flush(2);
    const S = b.App.importState;
    assert.equal(S.files.length, 1);
    assert.equal(S.files[0].size, f.bytes.length, 'full file size, not 0 bytes');
    assert.equal(Buffer.from(S.files[0].content, 'base64').equals(f.bytes), true, 'payload is the file, byte for byte');
    assert.match(text(), /\(\d+\.\d KB\)/, 'size rendered');

    // other shapes still work: ArrayBuffer, Uint8Array, bytes() only, and an older browser with FileReader only
    b.App.importReset({ account: checkingId });
    await b.App.importFiles([{ name: 'a.csv', bytes: data.buffer.slice(0) }, { name: 'b.csv', bytes: data }, { name: 'c.csv', bytes: async () => data }]);
    assert.deepEqual(Array.from(b.App.importState.files, (x: any) => x.size), [f.bytes.length, f.bytes.length, f.bytes.length]);
    b.window.FileReader = class {
      result: ArrayBuffer | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; error = null;
      readAsArrayBuffer(blob: any) { this.result = blob.__data.buffer.slice(0); setTimeout(() => this.onload && this.onload(), 0); }
    };
    b.App.importReset({ account: checkingId });
    await b.App.importFiles([{ name: 'legacy.csv', __data: data }]);
    assert.equal(b.App.importState.files[0].size, f.bytes.length);
    delete b.window.FileReader;

    // an empty file is refused client-side with a toast, never uploaded
    b.App.importReset({ account: checkingId });
    await b.App.importFiles([{ name: 'empty.csv', bytes: new Uint8Array(0) }]);
    assert.equal(b.App.importState.files.length, 0);
    await b.waitFor(() => /is empty \(0 bytes\)/.test(b.document.body.textContent));
    noErrors();
  });

  test('SMOKE-1: import a clean CSV statement, then verify the transactions and the balance', async () => {
    b.App.importReset();
    await b.goto(`import?account=${checkingId}`);
    const f = await dropFile('S1', 'us.csv');
    assert.match(text(), new RegExp(f.name.replace(/\./g, '\\.')), 'file listed');
    assert.ok(!b.$('#import-continue').disabled);

    // Step 2: mapping (CSV) — inferred columns are shown and can be left as is
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('.import-mapping'));
    assert.ok(b.$('.import-step[data-step="2"]').classList.contains('active'));
    assert.match(text(), /12 \/ 12 rows parse/);
    assert.equal(b.$('.map-date-order').value, 'MDY', 'US dates inferred');
    assert.equal(b.$('.map-role[data-col="0"]').value, 'date');
    assert.equal(b.$('.map-role[data-col="1"]').value, 'description');
    assert.equal(b.$('.map-role[data-col="2"]').value, 'amount');
    assert.equal(b.$('.map-role[data-col="3"]').value, 'balance');
    assert.equal(b.$$('.import-sample tbody tr').length, 5, 'five sample rows');

    // Step 3: nothing needs attention
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('#import-attention'));
    assert.match(text(), /New 12/);
    assert.match(text(), /Needs decision 0/);
    assert.match(text(), /Nothing needs your attention/);
    assert.ok(!b.$('#import-continue').disabled);

    // Step 4: balance reconciles with the statement
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('#import-balance'));
    assert.equal(b.$('#import-count-imported').textContent, '12');
    assert.match(b.$('#import-balance-after').textContent, /\$6,202\.01/);
    assert.match(text(), /Statement closing balance.*\$6,202\.01 ✔ reconciled/);
    assert.match(b.$('#import-commit').textContent, /Import 12 transactions/);

    // Commit
    await click('#import-commit');
    await b.waitFor(() => !!b.document.querySelector('#import-result-imported'));
    assert.equal(b.$('#import-result-imported').textContent, '12');
    assert.match(text(), /Smoke Checking balance.*\$6,202\.01/);

    // Verify: the transactions are there, categorised, with import metadata; the balance moved
    const txns = (await app.get('/api/transactions?limit=100', token)).body;
    assert.equal(txns.length, 12);
    const rent = txns.find((t: any) => /Rent/.test(t.description));
    assert.equal(rent.amount, 1950);
    assert.equal(rent.type, 'expense');
    assert.equal(rent.category, 'Housing');
    assert.equal(rent.date, '2026-09-02');
    assert.equal(rent.import.source, 'csv');
    assert.equal((await app.get(`/api/accounts/${checkingId}`, token)).body.balance, 6202.01);

    // The "view imported transactions" link filters the list by batch
    const href = b.$('#import-view').getAttribute('href')!;
    assert.match(href, /^#transactions\?batchId=/);
    const content = await b.goto(href.slice(1));
    assert.equal(b.$$('#txn-table-body tr').length, 12);
    assert.match(content.textContent, /written by your latest import/);
    assert.match(content.textContent, /Monthly salary — Northwind Analytics/);
    noErrors();
  });

  test('SMOKE-2: a statement with duplicates stops at "Needs decision"; Keep/Skip clear the rows and are honoured', async () => {
    await b.goto('import');
    b.$('#import-account').value = checkingId;
    await b.$('#import-account').fire('change');
    await dropFile('S4', 'obie.json');
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('#import-attention'));
    assert.ok(b.$('.import-step[data-step="2"]').classList.contains('skipped'), 'no mapping step for JSON');

    // 9 recorded, 2 to decide, 3 new — and the wizard will not go on
    assert.match(text(), /Already recorded \(skipped\) 9/);
    assert.match(text(), /Needs decision 2/);
    assert.match(text(), /New 3/);
    assert.ok(b.$('#import-continue').disabled, 'Continue is blocked while rows are undecided');
    const decideRows = b.$$('#import-attention tbody tr');
    assert.equal(decideRows.length, 2);
    assert.match(b.$('#import-attention').textContent, /1 day earlier/);
    assert.match(b.$('#import-attention').textContent, /2 days earlier/);
    const rentRow = decideRows.find(r => /Rent/.test(r.textContent))!;
    const savingsRow = decideRows.find(r => /Transfer to savings/.test(r.textContent))!;

    // Keep the rent → it leaves the table
    await rentRow.querySelector('.decide-btn[data-act="keep"]')!.click();
    await b.waitFor(() => b.$$('#import-attention tbody tr').length === 1);
    assert.match(text(), /Needs decision 1/);
    assert.ok(b.$('#import-continue').disabled);
    // Skip the savings transfer → list empty, Continue enabled, decisions reviewable
    await b.$(`.decide-btn[data-act="skip"][data-idx="${savingsRow.getAttribute('data-idx')}"]`).click();
    await b.waitFor(() => /Nothing needs your attention/.test(text()));
    assert.match(text(), /Needs decision 0/);
    assert.ok(!b.$('#import-continue').disabled);
    await click('#import-toggle-decided');
    assert.match(text(), /✅ Keep/);
    assert.match(text(), /⏭ Skip/);

    // Confirm shows the decided counts; commit
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('#import-balance'));
    assert.equal(b.$('#import-count-imported').textContent, '4', '3 new + 1 kept');
    assert.match(text(), /Skipped by you\s*1/);
    assert.match(b.$('#import-balance-after').textContent, /\$3,676\.26/);
    await click('#import-commit');
    await b.waitFor(() => !!b.document.querySelector('#import-result-imported'));
    assert.equal(b.$('#import-result-imported').textContent, '4');
    assert.match(text(), /1 recorded row marked 🔗/);

    // Verify: 16 transactions, the skipped match carries the 🔗 marker on the Transactions page
    const txns = (await app.get('/api/transactions?limit=100', token)).body;
    assert.equal(txns.length, 16);
    const stamped = txns.find((t: any) => t.import && t.import.matchedFrom);
    assert.equal(stamped.description, 'Transfer to savings');
    assert.equal(stamped.date, '2026-09-05');
    assert.equal(stamped.import.externalId, 'PLANT-2DAY');
    await b.goto('transactions');
    const marker = b.$(`#txn-table-body tr[data-id="${stamped.id}"] .txn-matched`);
    assert.match(marker.getAttribute('title')!, /2026-09-07/);
    assert.match(marker.getAttribute('title')!, /obie\.json/);
    assert.equal((await app.get(`/api/accounts/${checkingId}`, token)).body.balance, 3676.26);

    // Importing the same file once more: everything is recorded now, nothing to decide
    await b.goto('import');
    b.$('#import-account').value = checkingId;
    await b.$('#import-account').fire('change');
    await dropFile('S4', 'obie.json');
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('#import-attention'));
    assert.match(text(), /Already recorded \(skipped\) 14/);
    assert.match(text(), /Needs decision 0/);
    noErrors();
  });

  test('currency mismatch and invalid files are surfaced in the wizard', async () => {
    b.App.importReset({ account: checkingId }); // the wizard keeps its state across navigation; start afresh
    await b.goto('import');
    assert.equal(b.$('#import-account').value, checkingId);
    await dropFile('S6', 'gbp.ofx2');
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('#import-attention'));
    assert.match(text(), /statement is in GBP but the account is in USD/);
    assert.match(text(), /Excluded 12/);
    await click('#import-continue');
    await b.waitFor(() => !!b.document.querySelector('#import-commit'));
    assert.equal(b.$('#import-count-imported').textContent, '0');

    b.App.importReset({ account: checkingId });
    await b.goto('import');
    await dropFile('S11', 'brokerage.qif');
    await click('#import-continue');
    await b.waitFor(() => /investment imports are not supported/.test(text()));
    assert.ok(b.$('.import-step[data-step="1"]').classList.contains('active'), 'stays on step 1');
    noErrors();
  });
});
