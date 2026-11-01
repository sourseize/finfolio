import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp } from '../helpers/server.js';
import { openApp, type Browser } from '../helpers/browser.js';
import { db } from '../../src/db/database.js';
import { seedFin } from '../../src/seed/fin.js';
import { seedPenny, PENNY_USERNAME, PENNY_PASSWORD } from '../../src/seed/penny.js';

/**
 * Headless UI smoke for the second persona: every page renders with penny's
 * data (two liabilities, weekly habits, three claims, no nudge) without errors.
 */
describe('UI (headless) with penny', () => {
  let app: TestApp;
  let b: Browser;

  before(async () => {
    app = await launch();
    await seedFin(db);
    await seedPenny(db);
    const token = (await app.login(PENNY_USERNAME, PENNY_PASSWORD)).token;
    b = await openApp({ baseUrl: app.baseUrl, token });
  });
  after(async () => { await app.close(); });

  const noErrors = () => assert.deepEqual(b.errors.map(e => e.stack || e.message), [], 'page errors');

  test('no sign-in nudge for penny (her last claim is recent)', async () => {
    await b.goto('dashboard');
    assert.equal(b.document.querySelector('dialog.nudge-dialog'), null);
    noErrors();
  });

  test('dashboard, accounts and transactions', async () => {
    let content = await b.goto('dashboard');
    assert.match(content.textContent, /Net Worth/);
    assert.match(content.textContent, /owed/, 'two liabilities are summarised');
    content = await b.goto('accounts');
    assert.match(content.textContent, /Student Loan/);
    assert.match(content.textContent, /Cashback Card/);
    assert.ok(!/Everyday Checking/.test(content.textContent), 'fin\'s accounts are not visible to penny');
    content = await b.goto('transactions');
    assert.match(content.textContent, /Weekly transfer to savings/);
    noErrors();
  });

  test('budgets, investments, goals, rewards, reports, simulate', async () => {
    let content = await b.goto('budgets');
    assert.equal(b.$$('#budgets-list .card').length, 6);
    content = await b.goto('investments');
    assert.match(content.textContent, /SCHD/);
    content = await b.goto('goals');
    assert.equal(b.$$('#goals-list .card').length, 4);
    assert.match(content.textContent, /Student loan gone/);
    content = await b.goto('rewards');
    assert.match(content.textContent, /Weekly saving/);
    assert.match(content.textContent, /Shopping swap/);
    assert.match(content.textContent, /Unstoppable/);
    content = await b.goto('reports');
    assert.match(content.textContent, /Income vs Expenses/);
    content = await b.goto('simulate');
    await b.waitFor(() => /Loan gone by 2027/.test(b.$('#page-content').textContent));
    assert.match(b.$('#page-content').textContent, /Move out in 2028/);
    noErrors();
  });
});
