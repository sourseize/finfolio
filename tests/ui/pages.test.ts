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
    assert.match(b.$('#clock-frozen').textContent, /Today is 2026-10-25/, 'a frozen clock is visible in the sidebar');
    noErrors();
  });

  test('sign-in nudge: a once-a-day pop-up when a reward has been affordable for 30+ days', async () => {
    // App.init() ran in `before`; fin has had brunch within reach since 5 Sep (50 days).
    await b.waitFor(() => !!b.document.querySelector('dialog.nudge-dialog'));
    const dlg = b.$('dialog.nudge-dialog');
    assert.match(dlg.textContent, /You have earned a treat/);
    assert.match(dlg.textContent, /With 295 points you can treat yourself to Brunch at the coffee shop \(100 pts, since Sep 5, 2026 — 50 days\), Dinner for two \(250 pts, since Oct 5, 2026 — 20 days\)/);
    assert.match(dlg.textContent, /Go for Dinner for two — you have earned it/);
    assert.match(dlg.textContent, /Or keep banking: 205 more and Family dinner out is yours/);
    assert.match(dlg.textContent, /Last one enjoyed: Dinner for two on Sep 5, 2026/);
    assert.match(dlg.textContent, /As of Oct 25, 2026 — the server clock is frozen/);
    await b.$('#nudge-later').click();
    assert.equal(b.document.querySelector('dialog.nudge-dialog'), null, 'Later closes it');
    await b.App.checkNudge();
    await flush(3);
    assert.equal(b.document.querySelector('dialog.nudge-dialog'), null, 'not shown again the same day');
    assert.equal(b.window.localStorage.getItem(`finfolio-nudge-seen:${(await app.get('/api/motivation', token)).body.nudge.rewardId}`), '2026-10-25');
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

  test('dashboard: the habits & rewards card shows the balance, the bar towards the next reward, a ready reward and the latest trail lines', async () => {
    const content = await b.goto('dashboard');
    await b.waitFor(() => /Habits & rewards/.test(content.textContent) && /enjoyed/.test(content.textContent));
    const m = (await app.get('/api/motivation', token)).body;
    const card = b.$('#rewards-row');
    assert.match(card.textContent, /295\s*points/);
    assert.match(card.textContent, /205 more for Family dinner out \(500\)/);
    assert.equal(b.$('#rewards-row .rewards-points .progress-fill').style.width, '59%', 'the bar fills towards the next reward, not the next 100-step');
    assert.equal(b.$$('#rewards-row .chip.ready').length, 2, 'brunch and dinner are affordable');
    assert.match(b.$('#rewards-claim-link').textContent, /Dinner for two/, 'the banner names the biggest reward within reach');
    assert.equal(b.$('#rewards-claim-link').getAttribute('href'), '#rewards');
    assert.equal(b.$$('#rewards-habits .habit-row').length, 3);
    assert.equal(b.$$('#rewards-habits .habit-row.met').length, 2, 'saving and investing are done for October');
    assert.match(b.$('#rewards-habits .habit-row.track').textContent, /of the \$175 cap/);
    assert.ok(b.$$('#rewards-habits .chip.streak').length >= 2, 'streak chips');
    assert.equal(b.$$('#rewards-recent .trail-line').length, 5, 'five latest trail lines');
    assert.match(b.$('#rewards-recent').textContent, /points doubled/);
    assert.ok(b.$$('#rewards-recent .trail-line.miss').length >= 1, 'misses are shown too');
    assert.equal(b.$$('#rewards-badges .badge-tile').length, 13, 'badge strip');
    assert.equal(b.$$('#rewards-badges .badge-tile.unlocked').length, m.badges.filter((x: any) => x.unlockedOn).length);
    assert.ok(b.$$('#rewards-badges svg.badge-svg').length === 13, 'inline SVG icons');
    assert.equal(m.points.balance, 295);
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

  test('transactions page: edit a transaction and re-categorise to/from Uncategorized', async () => {
    await b.goto('transactions');
    const firstRow = b.$$('#txn-table-body tr')[0];
    const id = firstRow.getAttribute('data-id')!;
    const before = (await app.get('/api/transactions', token)).body.find((t: any) => t.id === id);
    assert.ok(b.$('#txn-table-body .edit-txn-btn'), 'edit buttons rendered');

    await b.$(`.edit-txn-btn[data-id="${id}"]`).click();
    await b.waitFor(() => !!b.document.querySelector('#modal-form'));
    assert.match(b.document.body.textContent, /Edit Transaction/);
    assert.equal(b.$('#txn-amount').value, String(before.amount), 'form pre-filled');
    assert.equal(b.$('#txn-category').value, before.category);
    assert.ok(b.$$('#txn-category option').some(o => o.value === 'Uncategorized'), 'Uncategorized is offered');

    b.$('#txn-category').value = 'Uncategorized';
    b.$('#txn-desc').value = 'edited via ui';
    await b.$('#modal-form').fire('submit');
    await b.waitFor(() => !b.document.querySelector('#modal-form'));
    await b.waitFor(() => /edited via ui/.test(b.document.body.textContent));
    assert.ok(b.$$('#txn-table-body .badge-uncategorized').length >= 1, 'dashed badge for Uncategorized');

    const after = (await app.get('/api/transactions', token)).body.find((t: any) => t.id === id);
    assert.equal(after.category, 'Uncategorized');
    assert.equal(after.description, 'edited via ui');
    assert.equal(after.amount, before.amount);

    // put it back so the golden data stays intact for later tests
    await app.put(`/api/transactions/${id}`, { category: before.category, description: before.description }, token);
    noErrors();
  });

  test('transactions page: 🔗 marker for rows matched from a skipped statement row', async () => {
    // Simulate what the importer will write on "Skip: already recorded" (WP3) and check the list shows it.
    const txn = (await app.get('/api/transactions?limit=1', token)).body[0];
    const stored = db.getTransaction(txn.id)!;
    stored.import = { source: 'csv', fingerprint: 'f', rawDescription: 'BANK TEXT', matchedFrom: { filename: 'sep.csv', date: txn.date, amount: txn.amount, rawDescription: 'BANK TEXT', matchedAt: '2026-10-25T12:00:00.000Z' } };
    await b.goto('transactions');
    const marker = b.$(`#txn-table-body tr[data-id="${txn.id}"] .txn-matched`);
    assert.match(marker.getAttribute('title')!, /sep\.csv/);
    assert.match(marker.getAttribute('title')!, /BANK TEXT/);
    delete stored.import;
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
    assert.match(content.textContent, /live under/, 'goals page points to Rewards');
    assert.ok(b.$('.sidebar-link[data-page="rewards"]'), 'Rewards has its own sidebar entry');
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

  describe('rewards page', () => {
    test('reward list, habits, trail with filters and the rule set render from fin\'s data', async () => {
      const content = await b.goto('rewards');
      await b.waitFor(() => /Trail/.test(content.textContent));
      assert.equal(b.$('.sidebar-link.active').getAttribute('data-page'), 'rewards');
      assert.equal(b.$$('#reward-cards .reward-card').length, 4);
      assert.equal(b.$$('#reward-cards .reward-card.ready').length, 2, 'brunch and dinner are affordable');
      assert.equal(b.$$('#reward-cards .claim-reward-btn').length, 2);
      assert.match(b.$('#reward-cards').textContent, /enjoyed ×2/);
      assert.match(b.$('#reward-cards').textContent, /205 more/);
      // Where did the 700 go? A visible history, and the "enjoyed" figure filters the trail
      assert.match(b.$('#enjoyed-list').textContent, /700 points · 4 rewards/);
      assert.equal(b.$$('#enjoyed-list .pts.minus').length, 4);
      assert.match(b.$('#enjoyed-list').textContent, /Jul 10, 2026.*Dinner for two/s);
      await b.$('.enjoyed-link').click();
      assert.equal(b.$('#trail-filter').value, 'reward');
      assert.equal(b.$$('#trail-list .trail-line').length, 4);
      b.$('#trail-filter').value = 'all';
      await b.$('#trail-filter').fire('change');
      assert.equal(b.$$('#habit-cards .habit-card').length, 3);
      assert.match(b.$('#habit-cards').textContent, /Save \$900 a month/);
      assert.match(b.$('#habit-cards').textContent, /Keep Food & Dining under \$175 a week/);
      assert.match(b.$('#habit-cards').textContent, /Met 10 of 10 months/);
      assert.ok(b.$$('#habit-cards .dots .dot').length >= 20, 'period dots');
      const m = (await app.get('/api/motivation', token)).body;
      assert.equal(b.$$('#trail-list .trail-line').length, 30, 'first page of the trail');
      assert.equal(b.$('#trail-more').style.display, '', 'more to show');
      await b.$('#trail-more').click();
      assert.equal(b.$$('#trail-list .trail-line').length, Math.min(80, m.ledger.length));
      const filter = b.$('#trail-filter');
      filter.value = 'miss';
      await filter.fire('change');
      assert.ok(b.$$('#trail-list .trail-line').length > 5);
      assert.ok(b.$$('#trail-list .trail-line').every(l => l.className.includes('miss')), 'misses only');
      filter.value = 'reward';
      await filter.fire('change');
      assert.equal(b.$$('#trail-list .trail-line').length, 4, 'four claims');
      assert.match(b.$('#trail-list').textContent, /Reward: Dinner for two/);
      filter.value = 'milestone';
      await filter.fire('change');
      assert.equal(b.$$('#trail-list .trail-line').length, m.badges.filter((x: any) => x.unlockedOn).length, 'one trail line per unlocked badge');
      assert.match(b.$('#trail-list').textContent, /Badge: Closer/);
      assert.match(b.$('#trail-list').textContent, /Badge: First brick/);
      filter.value = m.habits[0].id;
      await filter.fire('change');
      assert.equal(b.$$('#trail-list .trail-line').length, 10, 'monthly saving: ten lines, Jan–Oct');
      filter.value = 'all';
      await filter.fire('change');
      assert.match(b.$('.rewards-rules').textContent, /points double/);
      // Badges section: catalog with locked/unlocked states and the FI line
      assert.equal(b.$$('#badge-grid .badge-tile').length, 13);
      assert.match(b.$('#badge-grid .badge-tile[data-id="on-fire"]').className, /unlocked/);
      assert.match(b.$('#badge-grid .badge-tile[data-id="fi-5"]').className, /unlocked/);
      assert.match(b.$('#badge-grid .badge-tile[data-id="fi-10"]').className, /locked/);
      assert.match(b.$('#badge-grid .badge-tile[data-id="fi-10"]').getAttribute('title')!, /Reach 10% of your FI number/);
      assert.match(content.textContent, /8\.9% of the way to your FI number, FI in May 2043/);
      noErrors();
    });

    test('claim flow: confirm dialog → claim → trail line, balance and bar update → undo today\'s claim', async () => {
      await b.goto('rewards');
      await b.waitFor(() => !!b.document.querySelector('.claim-reward-btn'));
      void b.$('.claim-reward-btn').click();
      await flush();
      const dlg = b.$('dialog.dialog');
      assert.match(dlg.textContent, /Claim your reward\?/);
      assert.match(dlg.textContent, /Use 100 of your 295 points for Brunch at the coffee shop \(~\$25\)/);
      await b.$('#dialog-confirm').click();
      await b.waitFor(() => /Claimed today/.test(b.$('#page-content').textContent));
      const m = (await app.get('/api/motivation', token)).body;
      assert.equal(m.points.balance, 195);
      assert.equal(m.claims.length, 5);
      assert.match(b.$('#page-content').textContent, /195\s*points/);
      assert.match(b.$('#page-content').textContent, /55 more for Dinner for two/, 'dinner is no longer affordable, so it is the next target');
      assert.equal(b.$('.rewards-points .progress-fill').style.width, '78%');
      assert.equal(b.$$('#reward-cards .claim-reward-btn').length, 1, 'brunch is still affordable');
      assert.match(b.$('#reward-cards').textContent, /enjoyed ×3/);
      assert.equal(b.document.querySelector('.nudge'), null, 'the claim silences the nudge');
      assert.equal(b.$$('#trail-list .trail-line')[0].className.includes('reward'), true, 'newest trail line is the claim');
      assert.match(b.$$('#trail-list .trail-line')[0].textContent, /-100/);
      await b.$('.undo-claim').click();
      await b.waitFor(() => !/Claimed today/.test(b.$('#page-content').textContent));
      assert.equal((await app.get('/api/motivation', token)).body.points.balance, 295, 'golden data restored');
      noErrors();
    });

    test('reward form: create, edit and delete round-trip', async () => {
      await b.goto('rewards');
      await b.waitFor(() => !!b.document.querySelector('#add-reward-btn'));
      await b.$('#add-reward-btn').click();
      await b.waitFor(() => !!b.document.querySelector('#reward-name'));
      assert.equal(b.$('#reward-cost').value, '100', 'sensible default');
      b.$('#reward-name').value = 'Massage';
      b.$('#reward-cost').value = '150';
      b.$('#reward-note').value = '~$70';
      await b.$('#modal-form').fire('submit');
      await b.waitFor(() => b.$$('#reward-cards .reward-card').length === 5);
      const created = (await app.get('/api/rewards', token)).body.find((r: any) => r.name === 'Massage');
      assert.equal(created.cost, 150);
      assert.equal(b.$$('#reward-cards .reward-card')[1].textContent.includes('Massage'), true, 'sorted by cost: between brunch and dinner');
      assert.match(b.$(`.reward-card[data-id="${created.id}"]`).textContent, /Claim/, '295 ≥ 150');
      await b.$(`.edit-reward-btn[data-id="${created.id}"]`).click();
      await b.waitFor(() => !!b.document.querySelector('#reward-name'));
      assert.equal(b.$('#reward-name').value, 'Massage');
      b.$('#reward-cost').value = '300';
      await b.$('#modal-form').fire('submit');
      await b.waitFor(() => /5 more/.test(b.$(`.reward-card[data-id="${created.id}"]`).textContent));
      void b.$(`.delete-reward-btn[data-id="${created.id}"]`).click();
      await flush();
      assert.match(b.$('dialog.dialog').textContent, /Remove this reward/);
      await b.$('#dialog-confirm').click();
      await b.waitFor(() => b.$$('#reward-cards .reward-card').length === 4);
      noErrors();
    });

    test('habit form: kind switches fields and suggestions; create, edit and delete round-trip', async () => {
      await b.goto('rewards');
      await b.waitFor(() => !!b.document.querySelector('#add-habit-btn'));
      await b.$('#add-habit-btn').click();
      await b.waitFor(() => !!b.document.querySelector('#habit-kind'));
      await flush(2);
      assert.equal(b.$('#habit-name').value, 'Weekly saving', 'name auto-filled');
      assert.match(b.$('#habit-amount-help').textContent, /saved about \$900 a month/);
      assert.equal(b.$('#habit-category-group').style.display, 'none');
      assert.equal(b.$('#habit-account-group').style.display, '');
      await b.$('#habit-kind button[data-kind="swap"]').click();
      assert.equal(b.$('#habit-category-group').style.display, '');
      assert.equal(b.$('#habit-account-group').style.display, 'none');
      assert.equal(b.$('#habit-amount-label').textContent, 'Spending cap');
      assert.match(b.$('#habit-name').value, /swap$/);
      const cadence = b.$('#habit-cadence');
      cadence.value = 'monthly';
      await cadence.fire('change');
      assert.match(b.$('#habit-points-help').textContent, /15 points each month — 30 once you are 4 in a row/);
      b.$('#habit-category').value = 'Entertainment';
      await b.$('#habit-category').fire('change');
      b.$('#habit-amount').value = '150';
      b.$('#habit-start').value = '2026-08-01';
      await b.$('#modal-form').fire('submit');
      await b.waitFor(() => !b.document.querySelector('#modal-form'));
      await b.waitFor(() => b.$$('#habit-cards .habit-card').length === 4);
      const created = (await app.get('/api/habits', token)).body.find((h: any) => h.category === 'Entertainment');
      assert.ok(created, 'habit stored');
      assert.equal(created.cadence, 'monthly');
      assert.equal(created.amount, 150);
      assert.equal(created.name, 'Entertainment swap');

      await b.$(`.edit-habit-btn[data-id="${created.id}"]`).click();
      await b.waitFor(() => !!b.document.querySelector('#habit-kind'));
      await flush(2);
      assert.equal(b.$('#habit-amount').value, '150', 'form pre-filled');
      b.$('#habit-amount').value = '175';
      await b.$('#modal-form').fire('submit');
      await b.waitFor(() => !b.document.querySelector('#modal-form'));
      await b.waitFor(() => /under \$175 a month/.test(b.$('#habit-cards').textContent));
      assert.equal((await app.get('/api/habits', token)).body.find((h: any) => h.id === created.id).amount, 175);

      void b.$(`.delete-habit-btn[data-id="${created.id}"]`).click();
      await flush();
      assert.match(b.$('dialog.dialog').textContent, /Delete this habit\?/);
      await b.$('#dialog-confirm').click();
      await b.waitFor(() => b.$$('#habit-cards .habit-card').length === 3);
      assert.equal((await app.get('/api/habits', token)).body.length, 3, 'golden data restored');
      noErrors();
    });
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

  test('regression: the URL hash follows navigation, so a "#rewards" link works right after signing in', async () => {
    // Sign out while on Rewards (hash stays "#rewards"), sign in again (dashboard), click a "#rewards" link.
    await b.goto('rewards');
    assert.equal(b.window.location.hash, '#rewards');
    await b.$('#logout-btn').click();
    assert.ok(b.$('#login-form'));
    b.$('#login-username').value = 'fin';
    b.$('#login-password').value = 'folio';
    await b.$('#login-form').fire('submit');
    await b.waitFor(() => !!b.document.querySelector('#page-content') && /Net Worth/.test(b.document.body.textContent));
    assert.equal(b.window.location.hash, '#dashboard', 'navigate() re-synced the hash on sign-in');
    // Dismiss the sign-in nudge if it popped (same day → it should not, but be safe)
    const nudge = b.document.querySelector('dialog.nudge-dialog');
    if (nudge) await b.$('#nudge-later').click();
    // A real browser fires hashchange only when the hash changes — which it now does
    b.window.location.hash = '#rewards';
    b.window.dispatchEvent({ type: 'hashchange' });
    await b.waitFor(() => /Your rewards/.test(b.$('#page-content').textContent));
    assert.equal(b.App.currentPage, 'rewards');
    noErrors();
  });

  test('an expired session (e.g. after a server restart) signs the user out immediately', async () => {
    await b.goto('dashboard');
    b.API._token = 'stale-token-from-before-the-restart';
    await assert.rejects(() => b.API.getDashboard(), /Session expired|Unauthorized|Invalid/);
    await flush(3);
    assert.equal(b.API.isLoggedIn(), false, 'token cleared');
    assert.equal(b.window.localStorage.getItem('token'), null);
    assert.ok(b.$('#login-form'), 'back on the sign-in form without asking the user to sign out');
    assert.match(b.$('#toast-container').textContent, /session has expired/);
    // sign back in for the remaining tests
    b.$('#login-username').value = 'fin';
    b.$('#login-password').value = 'folio';
    await b.$('#login-form').fire('submit');
    await b.waitFor(() => /Net Worth/.test(b.document.body.textContent));
    noErrors();
  });

  test('sign out returns to the login form', async () => {
    await b.$('#logout-btn').click();
    assert.ok(b.$('#login-form'));
    assert.equal(b.API.isLoggedIn(), false);
    noErrors();
  });
});
