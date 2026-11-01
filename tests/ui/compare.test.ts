import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp } from '../helpers/server.js';
import { openApp, type Browser } from '../helpers/browser.js';
import { flush } from '../helpers/dom.js';
import { db } from '../../src/db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD } from '../../src/seed/fin.js';
import { seedPenny, PENNY_USERNAME, PENNY_PASSWORD } from '../../src/seed/penny.js';
import { anonymousA, anonymousSnapshot } from '../../src/seed/anonymous.js';

/**
 * Headless UI: the Compare page — share panel, import of a snapshot file,
 * the side-by-side report, the what-if sliders, rename, discard, and the
 * guarantee that nothing imported ever reaches storage.
 */
describe('UI (headless): Compare page', () => {
  let app: TestApp;
  let fin: string;
  let b: Browser;
  let pennyFile: any;

  before(async () => {
    app = await launch();
    await seedFin(db);
    await seedPenny(db);
    fin = (await app.login(FIN_USERNAME, FIN_PASSWORD)).token;
    const penny = (await app.login(PENNY_USERNAME, PENNY_PASSWORD)).token;
    pennyFile = (await app.get('/api/compare/snapshot?label=Penny', penny)).body;
    b = await openApp({ baseUrl: app.baseUrl, token: fin });
    const nudge = b.document.querySelector('dialog.nudge-dialog');
    if (nudge) await b.$('#nudge-later').click();
  });
  after(async () => { await app.close(); });

  const noErrors = () => assert.deepEqual(b.errors.map(e => e.stack || e.message), [], 'page errors');
  const asFile = (obj: unknown, name = 'penny.finfolio-compare.json') => ({ name, bytes: new TextEncoder().encode(JSON.stringify(obj)) });

  test('sidebar entry and the two panels; the includes / excludes lists come from the server', async () => {
    assert.ok(b.$('.sidebar-link[data-page="compare"]'));
    const content = await b.goto('compare');
    assert.match(content.textContent, /Share your snapshot/);
    assert.match(content.textContent, /Compare with someone/);
    assert.match(content.textContent, /Your username or any account, transaction or holding identifier/);
    assert.match(content.textContent, /No comparison yet/);
    assert.ok(b.$('#compare-file-input'));
    noErrors();
  });

  test('preview and download use the label; the download is remembered when the browser cannot save files', async () => {
    await b.goto('compare');
    const label = b.$('#compare-label');
    label.value = 'Fin';
    await label.fire('input');
    await b.$('#compare-preview-btn').click();
    await b.waitFor(() => /Preview of what/.test(b.$('#compare-share').textContent));
    const share = b.$('#compare-share').textContent;
    assert.match(share, /Preview of what Fin shares/);
    assert.match(share, /Savings rate44%/);
    assert.match(share, /FI dateMay 2043/);
    await b.$('#compare-download-btn').click();
    await b.waitFor(() => !!b.App.compareState.lastDownload);
    const dl = b.App.compareState.lastDownload;
    assert.equal(dl.name, 'fin.finfolio-compare.json');
    const parsed = JSON.parse(dl.text);
    assert.equal(parsed.label, 'Fin');
    assert.equal(parsed.format, 'finfolio-compare');
    assert.ok(!dl.text.includes('"username"') && !dl.text.includes('Everyday Checking'));
    noErrors();
  });

  test('import penny\'s file: banner, scoreboard, insights, metrics, charts, goals, habits, badges', async () => {
    await b.goto('compare');
    await b.App.compareImportFiles([asFile(pennyFile)]);
    await b.waitFor(() => !!b.App.compareState.report);
    await flush(3);
    const text = b.$('#page-content').textContent;
    assert.match(text, /Comparing you \(as of Oct 25, 2026\) with Penny/);
    assert.match(text, /lives in this tab only/);
    assert.match(text, /You lead on\s*21/);
    assert.match(text, /Penny leads on\s*3/);
    assert.match(text, /Penny's longest streak is 26 in a row/);
    assert.match(text, /Where you stand/);
    assert.match(text, /Net worth/);
    assert.match(text, /Savings rate/);
    assert.match(text, /Student loan gone/, 'penny\'s goals');
    assert.match(text, /Weekly saving/, 'penny\'s habits');
    assert.match(text, /Unstoppable/, 'badges');
    assert.match(text, /circumstance, not scored/);
    assert.equal(b.$$('.compare-table tr.lead').length + b.$$('.compare-table tr.behind').length >= 20, true);
    await b.waitFor(() => !!(b.$('#compare-cashflow') as any).__ctxCalls);
    assert.ok((b.$('#compare-cashflow') as any).__ctxCalls.length > 0, 'cash-flow chart drawn');
    assert.ok((b.$('#compare-projection') as any).__ctxCalls.length > 0, 'projection drawn');
    assert.ok((b.$('#compare-mix-mine') as any).__ctxCalls.length > 0 && (b.$('#compare-mix-theirs') as any).__ctxCalls.length > 0, 'both doughnuts drawn');
    assert.match(b.$('#compare-import').textContent, /Currently comparing with Penny/);
    noErrors();
  });

  test('what-if sliders re-run my outlook and show the fixed points against the other side', async () => {
    await b.waitFor(() => !!b.App.compareState.whatIf.result);
    await flush(2);
    const card = b.$('#compare-whatif');
    assert.match(card.textContent, /You now/);
    assert.match(card.textContent, /Penny/);
    const saving = b.$('#compare-slider-saving');
    assert.equal(saving.getAttribute('max'), String(b.App.compareState.whatIf.result.max));
    assert.ok(Number(saving.getAttribute('max')) >= 1000, 'fin can cut up to half his spending');
    saving.value = '500';
    await saving.fire('input');
    const investing = b.$('#compare-slider-investing');
    investing.value = '300';
    await investing.fire('input');
    await b.waitFor(() => b.App.compareState.whatIf.result && b.App.compareState.whatIf.result.both.monthlyContribution > 1300, 3000);
    await flush(2);
    const W = b.App.compareState.whatIf;
    assert.equal(W.saving, 500);
    assert.equal(W.investing, 300);
    assert.ok(W.result.both.fiDate < W.result.base.fiDate, 'FI comes earlier');
    const tableText = b.$('#compare-whatif-table').textContent;
    assert.match(tableText, /FI .* earlier/);
    assert.match(b.$('#compare-saving-label').textContent, /\$500/);
    assert.ok(b.$('#compare-slider-saving') === saving, 'the slider element was not replaced while in use');
    noErrors();
  });

  test('Export PDF posts the in-memory snapshot and the slider values; the download is remembered here', async () => {
    await b.$('#compare-pdf-btn').click();
    await b.waitFor(() => !!(b.App.compareState.lastDownload && /\.pdf$/.test(b.App.compareState.lastDownload.name)), 5000);
    const dl = b.App.compareState.lastDownload;
    assert.equal(dl.name, 'finfolio-compare-penny-2026-10-25.pdf');
    assert.equal(dl.type, 'application/pdf');
    assert.ok(dl.size > 8000, `pdf size ${dl.size}`);
    assert.equal(b.$('#compare-pdf-btn').disabled, false);
    noErrors();
  });

  test('rename changes the label everywhere without re-reading the file', async () => {
    await b.$('#compare-rename-btn').click();
    await b.waitFor(() => !!b.document.querySelector('#compare-rename'));
    b.$('#compare-rename').value = 'My sister';
    await b.$('#modal-form').fire('submit');
    await b.waitFor(() => b.App.compareState.report && b.App.compareState.report.labels.theirs === 'My sister');
    await flush(2);
    assert.match(b.$('#page-content').textContent, /with My sister/);
    noErrors();
  });

  test('a crafted file cannot inject markup; bad files are refused with a reason', async () => {
    const evil = JSON.parse(JSON.stringify(pennyFile));
    evil.label = '<img src=x onerror="alert(1)">';
    evil.data.goals[0].name = '<script>alert(1)</script>';
    // checksum still matches: the label is outside `data`, the goal name changes it → recompute is not possible client-side,
    // so use the label attack only and keep data intact.
    evil.data = pennyFile.data;
    await b.App.compareImportFiles([asFile(evil, 'evil.json')]);
    await b.waitFor(() => b.App.compareState.report && /img/.test(b.App.compareState.report.labels.theirs));
    await flush(2);
    const html = b.$('#page-content').innerHTML;
    assert.ok(html.includes('&lt;img src=x onerror="alert(1)"&gt;'), 'label is escaped as text (the mini-DOM re-encodes only < > & in text)');
    assert.equal(b.document.querySelector('img'), null, 'no element was created from the label');
    assert.equal(b.$$('[onerror]').length, 0, 'no attribute breakout');
    // bad files
    await b.App.compareImportFiles([{ name: 'notes.json', bytes: new TextEncoder().encode('{"hello":"world"}') }]);
    await b.waitFor(() => /Could not compare/.test(b.$('#compare-import').textContent));
    assert.match(b.$('#compare-import').textContent, /not a FinFolio comparison snapshot/);
    await b.App.compareImportFiles([{ name: 'broken.json', bytes: new TextEncoder().encode('{not json') }]);
    await b.waitFor(() => /not valid JSON/.test(b.$('#compare-import').textContent));
    const tampered = JSON.parse(JSON.stringify(pennyFile));
    tampered.data.position.netWorth = 1;
    await b.App.compareImportFiles([asFile(tampered)]);
    await b.waitFor(() => /checksum/.test(b.$('#compare-import').textContent));
    assert.ok(b.App.compareState.report, 'the previous comparison is still shown after a failed import');
    noErrors();
  });

  test('your own snapshot is refused', async () => {
    const mine = (await app.get('/api/compare/snapshot?label=Fin', fin)).body;
    await b.App.compareImportFiles([asFile(mine, 'fin.finfolio-compare.json')]);
    await b.waitFor(() => /your own snapshot/.test(b.$('#compare-import').textContent));
    noErrors();
  });

  test('discard clears the report; nothing was ever written to localStorage', async () => {
    await b.$('#compare-discard-btn').click();
    await flush(2);
    assert.equal(b.App.compareState.report, null);
    assert.equal(b.App.compareState.theirs, null);
    assert.match(b.$('#compare-report').textContent, /No comparison yet/);
    const keys = [...(b.window.localStorage as any).map.keys()];
    assert.ok(keys.every((k: string) => !/compare|snapshot/i.test(k)), `localStorage keys: ${keys.join(', ')}`);
    noErrors();
  });

  test('an imported comparison survives navigating away and back, but not signing out', async () => {
    await b.goto('compare');
    await b.App.compareImportFiles([asFile(anonymousSnapshot(anonymousA()), 'anonymous-a.finfolio-compare.json')]);
    await b.waitFor(() => !!b.App.compareState.report);
    await b.goto('dashboard');
    let content = await b.goto('compare');
    await flush(2);
    assert.match(content.textContent, /with Anonymous A/);
    assert.match(content.textContent, /not in sight/, 'Anonymous A has no FI date');
    await b.$('#logout-btn').click();
    await flush(2);
    assert.equal(b.App.compareState, null, 'sign-out drops everything imported');
    noErrors();
  });
});
