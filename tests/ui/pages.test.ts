import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp } from '../helpers/server.js';
import { openApp, type Browser } from '../helpers/browser.js';
import { flush } from '../helpers/dom.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD } from '../../src/seed/fin.js';

/**
 * Headless UI smoke: every page renders with fin's data, without runtime errors,
 * and the numbers the API returns show up in the HTML.
 */
describe('UI (headless) with fin', () => {
  let app: TestApp;
  let token: string;
  let b: Browser;

  before(async () => {
    app = await launch();
    await seedFin(db);
    token = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
    b = await openApp({ baseUrl: app.baseUrl, token });
  });
  after(async () => { await app.close(); });

  const noErrors = () => assert.deepEqual(b.errors.map(e => e.stack || e.message), [], 'page errors');

  test('shell renders with the Simulate nav item and server clock', async () => {
    assert.ok(b.$('.sidebar-link[data-page="simulate"]'));
    assert.equal(b.App.today, '2026-10-25', 'today comes from the frozen server clock');
    noErrors();
  });

  test('dashboard shows KPIs, outlook cards and charts', async () => {
    const content = await b.goto('dashboard');
    const dash = (await app.get('/api/dashboard', token)).body;
    const text = content.textContent;
    assert.match(text, /Net Worth/);
    assert.ok(text.includes(dash.netWorth.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')), 'net worth rendered');
    assert.match(text, /owed/, 'liabilities mentioned');
    assert.match(text, /excl\. transfers/);
    await b.waitFor(() => /Runway/.test(content.textContent) && !/Loading outlook/.test(content.textContent));
    assert.match(content.textContent, /Financial independence/);
    assert.match(content.textContent, /of your FI number/);
    const doughnut = b.$('#doughnut-chart');
    assert.ok((doughnut as any).__ctxCalls.length > 0, 'doughnut drawn');
    assert.equal(doughnut.style.width, doughnut.style.height, 'doughnut is square, not stretched');
    assert.equal(doughnut.style.margin, '0 auto');
    assert.equal(doughnut.width, doughnut.height, 'bitmap is square');
    assert.ok(b.$$('#budget-health-list .progress-bar').length >= 5);
    noErrors();
  });

  test('accounts page: liability rendering', async () => {
    const content = await b.goto('accounts');
    const text = content.textContent;
    assert.match(text, /Total Assets/);
    assert.match(text, /Total Owed/);
    assert.match(text, /amount owed/);
    assert.doesNotMatch(text, /−-\$|--\$/, 'no double negative');
    const cardValue = b.$$('.card-value.red');
    assert.ok(cardValue.length >= 1, 'credit card rendered in red');
    assert.match(cardValue[0].textContent, /^\$[\d,]+\.\d{2}$/);
    noErrors();
  });

  test('delete uses a native dialog and cancelling keeps the account', async () => {
    await b.goto('accounts');
    const before = b.$$('#accounts-list .card').length;
    void b.$$('.delete-account-btn')[0].click(); // handler awaits the dialog — do not await it here
    await flush();
    const dlg = b.$('dialog.dialog');
    assert.ok(dlg.open, 'dialog is open');
    assert.match(dlg.textContent, /Delete this account\?/);
    await b.$('#dialog-cancel').click();
    assert.equal(b.document.querySelector('dialog.dialog'), null, 'dialog removed after close');
    assert.equal(b.$$('#accounts-list .card').length, before);
    assert.equal((await app.get('/api/accounts', token)).body.length, 5);
    noErrors();
  });

  test('account modal relabels balance for credit accounts', async () => {
    await b.goto('accounts');
    await b.$('#add-account-btn').click();
    assert.equal(b.$('#acc-balance-label').textContent, 'Balance');
    const type = b.$('#acc-type');
    type.value = 'credit';
    await type.fire('change');
    assert.equal(b.$('#acc-balance-label').textContent, 'Amount Owed');
    assert.match(b.$('#acc-balance-hint').textContent, /positive number/);
    await b.$('#modal-cancel').click();
    assert.equal(b.document.querySelector('.modal-overlay'), null);
    noErrors();
  });

  test('transactions page with transfer badges and filters', async () => {
    const content = await b.goto('transactions');
    assert.ok(b.$$('#txn-table-body tr').length >= 50);
    assert.ok(b.$$('#txn-table-body .badge-budget').length > 0, 'transfers get the neutral badge');
    b.$('#filter-category').value = 'Housing';
    await b.$('#txn-filter-form').fire('submit');
    await b.waitFor(() => b.$$('#txn-table-body .badge').every(x => x.textContent === 'Housing'));
    assert.ok(b.$$('#txn-table-body tr').length > 10);
    assert.ok(content.textContent.includes('Transfer'), 'Transfer is a category option');
    noErrors();
  });

  test('budgets, investments, goals, reports render', async () => {
    let content = await b.goto('budgets');
    assert.ok(b.$$('#budgets-list .card').length === 7);
    assert.match(content.textContent, /Over budget|% used/);
    content = await b.goto('investments');
    assert.match(content.textContent, /VTI/);
    assert.match(content.textContent, /Portfolio Value/);
    await b.$$('.invest-card')[0].click();
    await b.waitFor(() => !!b.document.querySelector('#detail-close'));
    assert.match(b.document.body.textContent, /Transaction History/);
    await b.$('#detail-close').click();
    content = await b.goto('goals');
    assert.ok(b.$$('#goals-list .card').length === 4);
    assert.match(content.textContent, /Flat deposit/);
    content = await b.goto('reports');
    assert.match(content.textContent, /Income vs Expenses/);
    assert.match(content.textContent, /Liabilities/);
    await b.waitFor(() => !!(b.$('#trend-chart') as any).__ctxCalls); // charts draw on a 100 ms timeout
    assert.ok((b.$('#trend-chart') as any).__ctxCalls.length > 0, 'trend chart drawn');
    assert.ok((b.$('#balance-chart') as any).__ctxCalls.length > 0, 'balance chart drawn');
    const trend = b.$('#trend-chart');
    assert.equal(trend.style.width, '100%');
    assert.equal(trend.width, 800, 'bitmap width = element CSS width × dpr');
    assert.ok(trend.height >= 200 && trend.height <= 340);
    assert.ok((trend as any).__ctxCalls.includes('setTransform'), 'DPR handled via setTransform');
    noErrors();
  });

  describe('simulate page', () => {
    const simReady = async () => {
      await b.waitFor(() => !!b.App.sim.run && b.$$('#sim-stats .stat-card').length === 6, 15000);
      await flush(3);
    };

    test('renders the builder, stats, chart and detail cards from a live run', async () => {
      const content = await b.goto('simulate');
      await simReady();
      const text = content.textContent;
      assert.match(text, /Net worth at retirement \(65\)/);
      assert.match(text, /Financial independence/);
      assert.match(text, /Runway/);
      assert.match(text, /Chance of success/);
      assert.match(text, /FIRE milestones/);
      assert.match(text, /Monte Carlo runs/);
      assert.match(text, /Milestones/);
      assert.match(text, /Goals under this scenario/);
      assert.match(text, /Flat deposit/);
      assert.match(text, /What does it really cost\?/);
      assert.match(text, /Your profile/);
      assert.match(text, /born Jul 10, 1986/);
      assert.ok((b.$('#sim-chart') as any).__ctxCalls.length > 0, 'projection drawn');
      assert.ok(b.$$('#sim-saved-select option').length === 6, 'five saved scenarios + unsaved');
      const run = b.App.sim.run;
      assert.equal(run.montecarlo.trials, 300);
      assert.ok(run.result.summary.fire.fiDate);
      // Derived placeholders filled from the baseline
      assert.equal(b.$('[data-override="monthlyIncome"]').getAttribute('placeholder'), String(Math.round(run.baseline.monthlyIncome)));
      noErrors();
    });

    test('adding a life event re-runs and changes the outcome', async () => {
      await b.goto('simulate');
      await simReady();
      const before = b.App.sim.run.result.summary.endNetWorth;
      await b.$('#sim-add-event').click();
      const tpl = b.$('#ev-template');
      tpl.value = 'child';
      await tpl.fire('change');
      assert.match(b.$('#ev-desc').textContent, /child/i);
      b.$('[data-field="startMonth"]').value = '6';
      b.$('[data-field="amount"]').value = '1200';
      await b.$('#modal-form').fire('submit');
      assert.equal(b.App.sim.scenario.events.length, 1);
      assert.equal(b.App.sim.scenario.events[0].kind, 'expense');
      assert.equal(b.App.sim.scenario.events[0].amount, 1200);
      assert.equal(b.App.sim.scenario.events[0].startMonth, 6);
      assert.ok(b.$$('#sim-events .event-item').length === 1);
      assert.match(b.$('#sim-events').textContent, /New child/);
      await b.waitFor(() => b.App.sim.run && b.App.sim.run.result.summary.endNetWorth !== before, 15000);
      assert.ok(b.App.sim.run.result.summary.endNetWorth < before, 'a child costs money');
      assert.match(b.$('#sim-stats').textContent, /vs baseline/);
      noErrors();
    });

    test('economy preset switch, shock modal and custom inputs', async () => {
      const preset = b.$('#sim-preset');
      preset.value = 'stagflation';
      await preset.fire('change');
      assert.equal(b.App.sim.scenario.economy.preset, 'stagflation');
      assert.equal(b.App.sim.scenario.economy.inflation, 0.06);
      await b.$('#sim-econ-toggle').click();
      const ret = b.$('[data-econ="expectedReturn"]');
      ret.value = '5';
      await ret.fire('change');
      assert.equal(b.App.sim.scenario.economy.expectedReturn, 0.05);
      assert.equal(b.App.sim.scenario.economy.preset, undefined, 'custom once edited');
      await b.$('#sim-add-shock').click();
      b.$('#sh-drop').value = '40';
      await b.$('#modal-form').fire('submit');
      assert.equal(b.App.sim.scenario.economy.shocks.length, 1);
      assert.equal(b.App.sim.scenario.economy.shocks[0].drop, -0.4);
      assert.match(b.$('#sim-shocks').textContent, /-40%/);
      noErrors();
    });

    test('overrides, policy, real-money toggle and band toggle', async () => {
      const inc = b.$('[data-override="monthlyExpenses"]');
      inc.value = '3000';
      await inc.fire('change');
      assert.equal(b.App.sim.scenario.overrides.monthlyExpenses, 3000);
      const payload = JSON.parse(JSON.stringify(b.App.simScenarioPayload()));
      assert.deepEqual(payload.overrides, { monthlyExpenses: 3000 });
      b.$('#sim-sweep').checked = false;
      await b.$('#sim-sweep').fire('change');
      assert.equal(b.App.sim.scenario.policy.investSurplus, false);
      await b.$('#sim-money-toggle button[data-v="real"]').click();
      assert.equal(b.App.sim.showReal, true);
      assert.match(b.$('#sim-stats').textContent, /today's money/);
      await b.$('#sim-band-toggle button[data-v="off"]').click();
      assert.equal(b.App.sim.showBand, false);
      assert.doesNotMatch(b.$('#sim-legend').textContent, /Monte Carlo/);
      await b.$('#sim-band-toggle button[data-v="on"]').click();
      noErrors();
    });

    test('save, reload from the dropdown, and delete a scenario', async () => {
      b.$('#sim-name').value = 'Headless test scenario';
      await b.$('#sim-name').fire('input');
      void b.$('#sim-save-btn').click();
      await flush();
      const prompt = b.$('dialog.dialog');
      assert.equal(b.$('#dialog-input').value, 'Headless test scenario', 'prompt prefilled with the scenario name');
      await b.$('#dialog-form').fire('submit');
      assert.equal(prompt.open, false);
      await b.waitFor(() => !!b.App.sim.savedId);
      const id = b.App.sim.savedId;
      const stored = (await app.get(`/api/scenarios/${id}`, token)).body;
      assert.equal(stored.name, 'Headless test scenario');
      assert.equal(stored.events.length, 1);
      assert.equal(stored.economy.shocks.length, 1);
      assert.deepEqual(stored.overrides, { monthlyExpenses: 3000 });
      assert.match(b.$('#sim-save-btn').textContent, /Saved/);

      // Switch to a seeded scenario and back
      const sel = b.$('#sim-saved-select');
      const flat = (await app.get('/api/scenarios', token)).body.find((s: any) => s.name === 'Buy a flat in 2028');
      sel.value = flat.id;
      await sel.fire('change');
      assert.equal(b.App.sim.scenario.name, 'Buy a flat in 2028');
      assert.match(b.$('#sim-events').textContent, /Buy a flat/);
      await b.waitFor(() => b.App.sim.run && b.App.sim.run.scenario.name === 'Buy a flat in 2028', 15000);
      assert.match(b.$('#sim-milestones').textContent, /retire/);

      sel.value = id;
      await sel.fire('change');
      assert.equal(b.App.sim.scenario.name, 'Headless test scenario');
      void b.$('#sim-delete-btn').click();
      await flush();
      assert.match(b.$('dialog.dialog').textContent, /Headless test scenario/);
      await b.$('#dialog-confirm').click();
      await b.waitFor(() => b.App.sim.savedId === null);
      assert.equal((await app.get(`/api/scenarios/${id}`, token)).status, 404);
      assert.equal(b.$$('#sim-saved-select option').length, 6);
      noErrors();
    });

    test('profile modal updates the profile and re-runs', async () => {
      await b.$('#sim-edit-profile').click();
      b.$('#pf-retire').value = '60';
      await b.$('#modal-form').fire('submit');
      await b.waitFor(() => b.App.sim.profile.retirementAge === 60);
      assert.match(b.$('#sim-side').textContent, /Retire at60|Retire at\s*60/);
      await b.waitFor(() => b.App.sim.run && b.App.sim.run.profile.retirementAge === 60, 15000);
      assert.equal((await app.get('/api/profile', token)).body.retirementAge, 60);
      // restore for other tests
      await b.$('#sim-edit-profile').click();
      b.$('#pf-retire').value = '65';
      await b.$('#modal-form').fire('submit');
      await b.waitFor(() => b.App.sim.profile.retirementAge === 65);
      noErrors();
    });

    test('compare modal runs several scenarios', async () => {
      await b.$('#sim-compare-btn').click();
      await b.waitFor(() => !!b.document.querySelector('#cmp-table table'), 15000);
      const rows = b.$$('#cmp-table tbody tr');
      assert.equal(rows.length, 2, 'current + baseline by default');
      assert.match(b.$('#cmp-table').textContent, /FI reached|Money runs out/);
      // tick every saved scenario and re-run
      b.$$('#cmp-choices input').forEach(i => { i.checked = true; });
      await b.$('#cmp-run').click();
      await b.waitFor(() => b.$$('#cmp-table tbody tr').length === 7, 15000); // current + baseline + 5 saved
      assert.ok((b.$('#cmp-chart') as any).__ctxCalls.length > 0);
      await b.$('#cmp-close').click();
      assert.equal(b.document.querySelector('#cmp-table'), null);
      noErrors();
    });

    test('opportunity cost calculator', async () => {
      b.$('#oc-oneoff').value = '30000';
      await b.$('#oc-oneoff').fire('input');
      await b.waitFor(() => /You'd spend/.test(b.$('#oc-result').textContent) && /\$75,000\.00/.test(b.$('#oc-result').textContent), 5000);
      assert.match(b.$('#oc-result').textContent, /Invested instead, at age 65/);
      assert.ok((b.$('#oc-chart') as any).__ctxCalls.length > 0);
      noErrors();
    });
  });

  test('sign out returns to the login form', async () => {
    await b.$('#logout-btn').click();
    assert.ok(b.$('#login-form'));
    assert.equal(b.API.isLoggedIn(), false);
    noErrors();
  });
});
