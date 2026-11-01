// ── Compare: share a snapshot, import a friend's, see the two side by side ──
//
// Everything imported here lives in App.compareState (memory) for the life of
// the tab: never localStorage, never the server's database. Sign-out, Discard
// and a reload clear it. The report itself comes from POST /api/compare, which
// validates the file, compares it with a snapshot of the signed-in user built
// on the spot, and forgets it.

const COMPARE_COLORS = { mine: '#00d4ff', theirs: '#b388ff' };
const COMPARE_GROUPS = [
  ['position', 'Where you stand'],
  ['cashflow', 'Cash flow (last 12 months)'],
  ['investments', 'Investments'],
  ['goals', 'Goals'],
  ['motivation', 'Habits & rewards'],
  ['outlook', 'Outlook on current habits'],
];
const COMPARE_BADGE_ICONS = {
  'first-step': 'footprint', century: 'hundred', thousand: 'thousand', 'on-fire': 'flame', unstoppable: 'bolt', treat: 'gift',
  'fi-5': 'brick', 'fi-10': 'seedling', 'fi-25': 'sprout', 'fi-50': 'tree', 'fi-75': 'mountain', 'fi-100': 'flag', closer: 'arrow',
};

/** "2043-05" → "May 2043". */
function formatMonthKey(key) {
  if (!key) return '—';
  const [y, m] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** A metric value for the table, by unit. */
function formatMetricValue(v, unit, currency) {
  if (v === null || v === undefined) return '<span class="text-muted">—</span>';
  switch (unit) {
    case 'money': return formatCurrency(v, currency);
    case 'percent': return formatPercent(v, 1);
    case 'months': return `${v.toFixed(1)} mo`;
    case 'years': return `${v.toFixed(1)} yrs`;
    case 'age': return v.toFixed(1);
    case 'month': return formatMonthKey(v);
    case 'bool': return v ? 'yes' : 'no';
    default: return Math.round(v).toLocaleString();
  }
}

function formatMetricDelta(m, currency) {
  if (m.delta === null || m.delta === undefined) return '';
  const sign = m.delta > 0 ? '+' : m.delta < 0 ? '−' : '';
  const abs = Math.abs(m.delta);
  switch (m.unit) {
    case 'money': return `${sign}${formatCurrency(abs, currency)}`;
    case 'percent': return `${sign}${(abs * 100).toFixed(1)} pp`;
    case 'months': return `${sign}${abs.toFixed(1)} mo`;
    case 'years': return `${sign}${abs.toFixed(1)} yrs`;
    case 'age': return `${sign}${abs.toFixed(1)}`;
    case 'month': return `${sign}${abs} mo`;
    case 'bool': return '';
    default: return `${sign}${Math.round(abs).toLocaleString()}`;
  }
}

App.compareReset = function() {
  if (this.compareState && this.compareState.whatIfTimer) clearTimeout(this.compareState.whatIfTimer);
  this.compareState = null;
};

App.compareInit = function() {
  if (!this.compareState) {
    this.compareState = {
      format: null,
      label: '',
      preview: null,
      error: null,
      busy: false,
      // The imported side — memory only
      theirs: null,
      mine: null,
      report: null,
      whatIf: { saving: 0, investing: 0, result: null, busy: false },
      whatIfTimer: null,
      lastDownload: null,
    };
  }
  return this.compareState;
};

// ── Page ────────────────────────────────────────────────────────────────────

App.renderCompare = async function(container) {
  const S = this.compareInit();
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading…</div>';
  try {
    if (!S.format) S.format = await API.getCompareFormat();
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
    return;
  }
  container.innerHTML = `
    <div class="page-header">
      <h1>⚖️ Compare</h1>
      <div class="text-sm text-muted">See how you are doing next to someone else — on habits, not just numbers.</div>
    </div>
    <div class="grid grid-2 gap-2 compare-top">
      <div class="card" id="compare-share"></div>
      <div class="card" id="compare-import"></div>
    </div>
    <div id="compare-report" class="mt-2"></div>
  `;
  this.renderCompareShare();
  this.renderCompareImport();
  this.renderCompareReport();
};

// ── Share panel ──

App.renderCompareShare = function() {
  const S = this.compareState;
  const el = document.getElementById('compare-share');
  if (!el) return;
  const f = S.format;
  el.innerHTML = `
    <div class="card-header"><span class="card-title">📤 Share your snapshot</span></div>
    <p class="text-sm text-muted">A small file of figures — averages, rates, progress, the outlook — that a friend can import on their Compare page. No usernames, no ids, no transactions.</p>
    <div class="form-group mt-2">
      <label>Shown to them as</label>
      <input type="text" id="compare-label" maxlength="${f.limits.label}" placeholder="${escapeHtml(f.defaultLabel)}" value="${escapeHtml(S.label)}" autocomplete="off">
      <div class="help">Any name you like — it is the only text you add. Empty means "${escapeHtml(f.defaultLabel)}".</div>
    </div>
    <details class="compare-details">
      <summary class="link text-sm">What is in the file — and what is not</summary>
      <div class="grid grid-2 gap-2 mt-1">
        <div><div class="section-title">Included</div><ul class="compare-list ok">${f.includes.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>
        <div><div class="section-title">Never included</div><ul class="compare-list no">${f.excludes.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>
      </div>
    </details>
    <div id="compare-preview" class="mt-2"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="compare-preview-btn" ${S.busy ? 'disabled' : ''}>Preview figures</button>
      <button class="btn btn-primary" id="compare-download-btn" ${S.busy ? 'disabled' : ''}>⬇ Download snapshot</button>
    </div>
  `;
  document.getElementById('compare-label').addEventListener('input', e => { S.label = e.target.value; });
  document.getElementById('compare-preview-btn').addEventListener('click', () => this.comparePreview());
  document.getElementById('compare-download-btn').addEventListener('click', () => this.compareDownload());
  this.renderComparePreview();
};

App.renderComparePreview = function() {
  const S = this.compareState;
  const el = document.getElementById('compare-preview');
  if (!el) return;
  const p = S.preview;
  if (!p) { el.innerHTML = ''; return; }
  const d = p.data;
  const c = p.currency;
  const chip = (label, value) => `<div class="compare-chip"><span class="k">${escapeHtml(label)}</span><span class="v">${value}</span></div>`;
  el.innerHTML = `
    <div class="compare-preview">
      <div class="text-xs text-muted mb-2">Preview of what <strong>${escapeHtml(p.label)}</strong> shares — as of ${formatDate(p.asOf)}, ${escapeHtml(c)} · ${(JSON.stringify(p).length / 1024).toFixed(1)} KB</div>
      <div class="compare-chips">
        ${chip('Age', d.profile.age)}
        ${chip('Net worth', formatCurrency(d.position.netWorth, c))}
        ${chip('Savings rate', formatPercent(d.cashflow.savingsRate, 0))}
        ${chip('Investing rate', formatPercent(d.cashflow.investingRate, 0))}
        ${chip('Months of history', d.cashflow.series.length)}
        ${chip('Holdings', d.investments.count)}
        ${chip('Goals', d.goals.length)}
        ${chip('Habits', d.motivation.habits.length)}
        ${chip('Points earned', d.motivation.pointsEarned)}
        ${chip('Badges', `${d.motivation.badgesUnlocked} / ${d.motivation.badges.length}`)}
        ${chip('FI date', d.outlook.fire.fiDate ? formatMonthKey(d.outlook.fire.fiDate) : 'not in sight')}
      </div>
    </div>
  `;
};

App.comparePreview = async function() {
  const S = this.compareState;
  S.busy = true;
  try {
    S.preview = await API.getCompareSnapshot(S.label);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    S.busy = false;
  }
  this.renderCompareShare();
};

/** Hand a Blob to the browser as a download; false in environments without object URLs (the test harness). */
function downloadBlob(name, blob) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Hand a text file to the browser; in environments without Blob/URL (the test harness) remember it instead. */
function downloadTextFile(name, text, type = 'application/json') {
  if (typeof Blob !== 'function') return false;
  return downloadBlob(name, new Blob([text], { type }));
}

App.compareDownload = async function() {
  const S = this.compareState;
  S.busy = true;
  this.renderCompareShare();
  try {
    const snapshot = await API.getCompareSnapshot(S.label);
    S.preview = snapshot;
    const name = `${(snapshot.label || 'snapshot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'snapshot'}${S.format.fileSuffix}`;
    const text = JSON.stringify(snapshot, null, 2);
    S.lastDownload = { name, text };
    if (downloadTextFile(name, text)) showToast(`Downloaded ${name}`);
    else showToast(`Snapshot ready as ${name}`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    S.busy = false;
  }
  this.renderCompareShare();
};

// ── Import panel ──

App.renderCompareImport = function() {
  const S = this.compareState;
  const el = document.getElementById('compare-import');
  if (!el) return;
  el.innerHTML = `
    <div class="card-header"><span class="card-title">📥 Compare with someone</span></div>
    <p class="text-sm text-muted">Drop the <code>${escapeHtml(S.format.fileSuffix)}</code> file a friend sent you. It is read in this tab, compared with your own figures and <strong>never saved</strong> — not on this device, not on the server.</p>
    <div class="drop-zone mt-2" id="compare-drop">
      <div class="icon">⚖️</div>
      <div><strong>Drop a snapshot here</strong> or <label for="compare-file-input" class="link">browse</label></div>
      <div class="text-xs text-muted mt-1">One file · ${escapeHtml(S.format.fileSuffix)} · up to ${Math.round(S.format.limits.bytes / 1024)} KB</div>
      <input type="file" id="compare-file-input" accept=".json,application/json" style="display:none">
    </div>
    ${S.error ? `<div class="import-banner error mt-2"><strong>Could not compare:</strong> ${escapeHtml(S.error)}</div>` : ''}
    ${S.busy && !S.report ? '<div class="text-sm text-muted mt-2">Comparing…</div>' : ''}
    ${S.report ? `<div class="text-sm mt-2">Currently comparing with <strong>${escapeHtml(S.report.labels.theirs)}</strong> — drop another file to replace it.</div>` : ''}
  `;
  const input = document.getElementById('compare-file-input');
  input.addEventListener('change', () => { this.compareImportFiles(input.files); input.value = ''; });
  const drop = document.getElementById('compare-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer) this.compareImportFiles(e.dataTransfer.files); });
  drop.addEventListener('click', e => { if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT' && input.click) input.click(); });
};

/** Read one snapshot file (a File, or { name, bytes } / { name, text } in tests) and compare. */
App.compareImportFiles = async function(list) {
  const S = this.compareInit();
  const files = Array.from(list || []);
  if (!files.length) return;
  const f = files[0];
  if (files.length > 1) showToast('One snapshot at a time — using the first file', 'info');
  let text;
  try {
    if (typeof f.text === 'string') text = f.text;
    else {
      const bytes = await readFileBytes(f); // shared with the statement importer (page-import.js)
      if (bytes.byteLength > S.format.limits.bytes) throw new Error(`The file is ${(bytes.byteLength / 1024).toFixed(0)} KB — a snapshot is a few tens of KB`);
      text = new TextDecoder('utf-8').decode(bytes);
    }
  } catch (err) {
    S.error = `${f.name || 'File'}: ${err.message}`;
    this.renderCompareImport();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    S.error = `${f.name || 'File'} is not valid JSON`;
    this.renderCompareImport();
    return;
  }
  await this.compareImportSnapshot(parsed);
};

/** Compare a parsed snapshot object (kept in memory only). */
App.compareImportSnapshot = async function(snapshot, label) {
  const S = this.compareInit();
  S.busy = true;
  S.error = null;
  this.renderCompareImport();
  try {
    const res = await API.compare(snapshot, label);
    S.theirs = res.theirs;
    S.mine = res.mine;
    S.report = res.report;
    S.whatIf = { saving: 0, investing: 0, result: null, busy: false };
    showToast(`Comparing you with ${res.report.labels.theirs} — nothing was saved`);
  } catch (err) {
    S.error = err.message;
  } finally {
    S.busy = false;
  }
  this.renderCompareImport();
  this.renderCompareReport();
  if (S.report) {
    this.compareWhatIfRun();
    const el = document.getElementById('compare-report');
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

/** Build the PDF on the server from the in-memory snapshot (still transient) and download it. */
App.compareExportPdf = async function() {
  const S = this.compareState;
  if (!S || !S.theirs || S.pdfBusy) return;
  S.pdfBusy = true;
  const btn = document.getElementById('compare-pdf-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Building PDF…'; }
  try {
    const W = S.whatIf;
    const whatIf = W && (W.saving > 0 || W.investing > 0) ? { extraSaving: W.saving, extraInvesting: W.investing } : undefined;
    const { blob, filename } = await API.comparePdf(S.theirs, S.report.labels.theirs, whatIf);
    S.lastDownload = { name: filename, size: blob.size, type: blob.type };
    if (downloadBlob(filename, blob)) showToast(`Downloaded ${filename}`);
    else showToast(`PDF ready as ${filename} (${Math.round(blob.size / 1024)} KB)`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    S.pdfBusy = false;
    const b = document.getElementById('compare-pdf-btn');
    if (b) { b.disabled = false; b.textContent = '🖨 Export PDF'; }
  }
};

App.compareDiscard = function() {
  const S = this.compareInit();
  S.theirs = null;
  S.mine = null;
  S.report = null;
  S.error = null;
  S.whatIf = { saving: 0, investing: 0, result: null, busy: false };
  if (S.whatIfTimer) { clearTimeout(S.whatIfTimer); S.whatIfTimer = null; }
  showToast('Comparison discarded — nothing was ever saved', 'info');
  this.renderCompareImport();
  this.renderCompareReport();
};

App.compareRename = function() {
  const S = this.compareState;
  if (!S || !S.theirs) return;
  this.showModal('Show them as', `
    <div class="form-group">
      <label>Name in this report</label>
      <input type="text" id="compare-rename" maxlength="${S.format.limits.label}" value="${escapeHtml(S.report.labels.theirs)}" required>
    </div>
  `, async () => {
    const label = document.getElementById('compare-rename').value.trim();
    if (!label) throw new Error('Give them a name');
    await this.compareImportSnapshot(S.theirs, label);
  });
};

// ── Report ──

App.renderCompareReport = function() {
  const S = this.compareState;
  const el = document.getElementById('compare-report');
  if (!el) return;
  if (!S.report) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="icon">⚖️</div>
        <h3>No comparison yet</h3>
        <p class="text-muted text-sm">Download your snapshot to share it, or drop a friend's file above to see the two of you side by side.</p>
      </div>`;
    return;
  }
  const r = S.report;
  const them = escapeHtml(r.labels.theirs);
  const cur = r.currency.mine;
  const curTheirs = r.currency.theirs;
  const scoredPct = r.score.scored ? Math.round((r.score.mine / r.score.scored) * 100) : 0;

  const headline = ['netWorth', 'savingsRate', 'investingRate', 'cashMonths', 'fiDate', 'badgesUnlocked']
    .map(k => r.metrics.find(m => m.key === k)).filter(Boolean);

  el.innerHTML = `
    <div class="card compare-banner">
      <div class="flex justify-between items-center gap-2" style="flex-wrap:wrap">
        <div>
          <div class="text-sm">Comparing <strong>you</strong> (as of ${formatDate(r.asOf.mine)}) with <strong>${them}</strong> (as of ${formatDate(r.asOf.theirs)}, ${escapeHtml(curTheirs)}, age ${r.profile.theirs.age})</div>
          <div class="text-xs text-muted">🔒 This comparison lives in this tab only — nothing from ${them}'s file has been saved, and it is gone when you sign out or reload.</div>
        </div>
        <div class="flex gap-1">
          <button class="btn btn-sm btn-secondary" id="compare-rename-btn">✎ Rename</button>
          <button class="btn btn-sm btn-secondary" id="compare-pdf-btn" ${S.pdfBusy ? 'disabled' : ''}>${S.pdfBusy ? 'Building PDF…' : '🖨 Export PDF'}</button>
          <button class="btn btn-sm btn-danger" id="compare-discard-btn">Discard</button>
        </div>
      </div>
      ${r.warnings.length ? `<div class="import-banner warn mt-2"><ul>${r.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : ''}
    </div>

    <div class="card mt-2 compare-score">
      <div class="card-header"><span class="card-title">🏁 Scoreboard</span><span class="text-xs text-muted">${r.score.scored} metrics scored · income, spending and portfolio size are shown but never scored</span></div>
      <div class="compare-score-line">
        <span class="you">You lead on <strong>${r.score.mine}</strong></span>
        <span class="text-muted">${r.score.ties} tie${r.score.ties === 1 ? '' : 's'}</span>
        <span class="them">${them} leads on <strong>${r.score.theirs}</strong></span>
      </div>
      <div class="compare-score-bar" title="${r.score.mine} vs ${r.score.theirs}"><div class="you" style="width:${scoredPct}%"></div></div>
      <div class="compare-headline mt-2">
        ${headline.map(m => `
          <div class="compare-head ${m.leader === 'mine' ? 'lead' : m.leader === 'theirs' ? 'behind' : ''}">
            <div class="k">${escapeHtml(m.label)}</div>
            <div class="v you">${formatMetricValue(m.mine, m.unit, cur)}</div>
            <div class="v them">${formatMetricValue(m.theirs, m.unit, curTheirs)}</div>
          </div>`).join('')}
      </div>
      <div class="legend"><span><span class="swatch" style="background:${COMPARE_COLORS.mine}"></span>You</span><span><span class="swatch" style="background:${COMPARE_COLORS.theirs}"></span>${them}</span></div>
    </div>

    <div class="grid grid-2 gap-2 mt-2 compare-two">
      <div class="card">
        <div class="card-header"><span class="card-title">💡 What this says</span></div>
        <ul class="compare-insights">
          ${r.insights.map(i => `<li class="${i.tone}"><span class="mark">${i.tone === 'lead' ? '▲' : i.tone === 'behind' ? '▼' : '•'}</span>${escapeHtml(i.text)}</li>`).join('')}
        </ul>
      </div>
      <div class="card" id="compare-whatif"></div>
    </div>

    <div class="card mt-2">
      <div class="card-header"><span class="card-title">📋 All metrics</span><span class="text-xs text-muted">delta = you − ${them}</span></div>
      <div class="table-container">
        <table class="compare-table">
          <thead><tr><th>Metric</th><th class="text-right">You</th><th class="text-right">${them}</th><th class="text-right">Delta</th><th>Leads</th></tr></thead>
          <tbody>
            ${COMPARE_GROUPS.map(([group, title]) => `
              <tr class="group"><td colspan="5">${escapeHtml(title)}</td></tr>
              ${r.metrics.filter(m => m.group === group).map(m => `
                <tr class="${m.leader === 'mine' ? 'lead' : m.leader === 'theirs' ? 'behind' : ''}">
                  <td>${escapeHtml(m.label)}${m.note ? `<div class="text-xs text-muted">${escapeHtml(m.note)}</div>` : ''}</td>
                  <td class="text-right you">${formatMetricValue(m.mine, m.unit, cur)}</td>
                  <td class="text-right them">${formatMetricValue(m.theirs, m.unit, curTheirs)}</td>
                  <td class="text-right text-muted">${formatMetricDelta(m, cur)}</td>
                  <td>${m.leader === 'mine' ? '<span class="chip ok">you</span>' : m.leader === 'theirs' ? `<span class="chip warn">${them}</span>` : m.leader === 'tie' ? '<span class="chip">tie</span>' : ''}</td>
                </tr>`).join('')}
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid grid-2 gap-2 mt-2 compare-two">
      <div class="chart-container">
        <h3>📈 Spending and income by month</h3>
        <canvas id="compare-cashflow"></canvas>
        <div class="legend">
          <span><span class="swatch" style="background:${COMPARE_COLORS.mine}"></span>Your spending</span>
          <span><span class="swatch" style="background:${COMPARE_COLORS.theirs}"></span>${them}'s spending</span>
          <span><span class="swatch dashed" style="color:${COMPARE_COLORS.mine}"></span>Your income</span>
          <span><span class="swatch dashed" style="color:${COMPARE_COLORS.theirs}"></span>${them}'s income</span>
        </div>
      </div>
      <div class="chart-container">
        <h3>📉 Net worth by age (projection on current habits)</h3>
        <canvas id="compare-projection"></canvas>
        <div class="legend">
          <span><span class="swatch" style="background:${COMPARE_COLORS.mine}"></span>You</span>
          <span><span class="swatch" style="background:${COMPARE_COLORS.theirs}"></span>${them}</span>
          <span class="text-muted">nominal · aligned by age, so different ages line up</span>
        </div>
      </div>
    </div>

    <div class="card mt-2">
      <div class="card-header"><span class="card-title">🍩 Spending mix</span><span class="text-xs text-muted">share of spending — comparable across incomes and currencies</span></div>
      <div class="compare-mix">
        <div class="text-center"><div class="text-sm mb-1">You</div><canvas id="compare-mix-mine"></canvas></div>
        <div class="table-container">
          <table class="compare-table">
            <thead><tr><th>Category</th><th class="text-right">You</th><th class="text-right">${them}</th><th class="text-right">Delta</th></tr></thead>
            <tbody>
              ${r.spending.map(c => `
                <tr>
                  <td>${escapeHtml(c.category)}</td>
                  <td class="text-right you">${c.mine ? `${formatPercent(c.mine.share, 0)} <span class="text-xs text-muted">${formatCurrency(c.mine.monthly, cur)}</span>` : '<span class="text-muted">—</span>'}</td>
                  <td class="text-right them">${c.theirs ? `${formatPercent(c.theirs.share, 0)} <span class="text-xs text-muted">${formatCurrency(c.theirs.monthly, curTheirs)}</span>` : '<span class="text-muted">—</span>'}</td>
                  <td class="text-right text-muted">${c.shareDelta > 0 ? '+' : c.shareDelta < 0 ? '−' : ''}${(Math.abs(c.shareDelta) * 100).toFixed(0)} pp</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="text-center"><div class="text-sm mb-1">${them}</div><canvas id="compare-mix-theirs"></canvas></div>
      </div>
    </div>

    <div class="grid grid-2 gap-2 mt-2 compare-two">
      <div class="card">
        <div class="card-header"><span class="card-title">🎯 Goals</span><span class="text-xs text-muted">you ${r.goals.summary.mine.onTrack}/${r.goals.summary.mine.count} on track · ${them} ${r.goals.summary.theirs.onTrack}/${r.goals.summary.theirs.count}</span></div>
        <div class="compare-cols">
          ${[['You', r.goals.mine, cur], [them, r.goals.theirs, curTheirs]].map(([who, goals, c]) => `
            <div>
              <div class="section-title">${who}</div>
              ${goals.length ? goals.map(g => `
                <div class="compare-goal">
                  <div class="flex justify-between text-sm"><span>${escapeHtml(g.name)} <span class="text-xs text-muted">${escapeHtml(g.category)}</span></span><span class="chip ${g.status === 'funded' || g.status === 'on_track' ? 'ok' : g.status === 'at_risk' ? 'warn' : 'bad'}">${g.status.replace('_', ' ')}</span></div>
                  <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, Math.round(g.progress * 100))}%"></div></div>
                  <div class="text-xs text-muted">${formatCurrency(g.current, c)} of ${formatCurrency(g.target, c)} · ${Math.round(g.progress * 100)}%${g.deadline ? ` · by ${formatDate(g.deadline)}` : ''}</div>
                </div>`).join('') : '<div class="text-sm text-muted">No goals</div>'}
            </div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">🔁 Habits</span></div>
        <div class="compare-cols">
          ${[['You', r.habits.mine, cur], [them, r.habits.theirs, curTheirs]].map(([who, habits, c]) => `
            <div>
              <div class="section-title">${who}</div>
              ${habits.length ? habits.map(h => `
                <div class="compare-habit">
                  <div class="text-sm">${h.kind === 'save' ? '🏦' : h.kind === 'invest' ? '📈' : '🔁'} ${escapeHtml(h.name)}</div>
                  <div class="text-xs text-muted">${h.kind === 'swap' ? `${escapeHtml(h.category || '')} under ` : ''}${formatCurrency(h.amount, c)} ${h.cadence} · streak ${h.streak} (best ${h.bestStreak}) · hit ${h.periodsMet}/${h.periodsScored} · ${h.pointsEarned} pts</div>
                </div>`).join('') : '<div class="text-sm text-muted">No habits yet</div>'}
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card mt-2">
      <div class="card-header"><span class="card-title">🏅 Badges</span><span class="text-xs text-muted">you ${r.badges.filter(b => b.mine).length} · ${them} ${r.badges.filter(b => b.theirs).length}</span></div>
      <div class="compare-badges">
        ${r.badges.map(b => `
          <div class="compare-badge ${b.mine ? 'mine' : ''} ${b.theirs ? 'theirs' : ''}" title="${escapeHtml(b.name)}${b.mine ? ` · you ${formatDate(b.mine)}` : ''}${b.theirs ? ` · ${them} ${formatDate(b.theirs)}` : ''}">
            <div class="badge-tile ${b.mine || b.theirs ? 'unlocked' : 'locked'} tone-${badgeTone({ id: b.key })}">${badgeSvg(COMPARE_BADGE_ICONS[b.key] || 'footprint', 26)}</div>
            <div class="badge-name">${escapeHtml(b.name)}</div>
            <div class="who"><span class="you ${b.mine ? 'on' : ''}">you</span><span class="them ${b.theirs ? 'on' : ''}">${them}</span></div>
          </div>`).join('')}
      </div>
    </div>
  `;

  document.getElementById('compare-discard-btn').addEventListener('click', () => this.compareDiscard());
  document.getElementById('compare-rename-btn').addEventListener('click', () => this.compareRename());
  document.getElementById('compare-pdf-btn').addEventListener('click', () => this.compareExportPdf());
  this.renderCompareWhatIf();

  // Charts draw once the layout has settled (same pattern as the other pages).
  setTimeout(() => this.drawCompareCharts(), 100);
};

App.drawCompareCharts = function() {
  const S = this.compareState;
  if (!S || !S.report) return;
  const r = S.report;
  const num = v => (v === null || v === undefined ? NaN : v);

  const cash = document.getElementById('compare-cashflow');
  if (cash && r.series.length) {
    Chart.projection(cash, r.series.map(p => formatMonthKey(p.month).replace(' 20', " '")), [
      { label: 'Your spending', data: r.series.map(p => num(p.mine && p.mine.spending)), color: COMPARE_COLORS.mine, width: 2.5 },
      { label: 'Their spending', data: r.series.map(p => num(p.theirs && p.theirs.spending)), color: COMPARE_COLORS.theirs, width: 2.5 },
      { label: 'Your income', data: r.series.map(p => num(p.mine && p.mine.income)), color: COMPARE_COLORS.mine, dash: [4, 4], width: 1.5 },
      { label: 'Their income', data: r.series.map(p => num(p.theirs && p.theirs.income)), color: COMPARE_COLORS.theirs, dash: [4, 4], width: 1.5 },
    ], { heightRatio: 0.5, xLabelEvery: Math.max(1, Math.ceil(r.series.length / 6)) });
  }

  const proj = document.getElementById('compare-projection');
  if (proj && r.projection.length) {
    const markers = [];
    const mineRet = r.profile.mine.retirementAge;
    const theirsRet = r.profile.theirs.retirementAge;
    const idx = age => r.projection.findIndex(p => p.age === age);
    if (idx(mineRet) >= 0) markers.push({ index: idx(mineRet), label: `you retire ${mineRet}`, color: COMPARE_COLORS.mine });
    if (idx(theirsRet) >= 0 && theirsRet !== mineRet) markers.push({ index: idx(theirsRet), label: `${r.labels.theirs} ${theirsRet}`, color: COMPARE_COLORS.theirs });
    Chart.projection(proj, r.projection.map(p => String(p.age)), [
      { label: 'You', data: r.projection.map(p => num(p.mine)), color: COMPARE_COLORS.mine, width: 2.5 },
      { label: r.labels.theirs, data: r.projection.map(p => num(p.theirs)), color: COMPARE_COLORS.theirs, width: 2.5 },
    ], { heightRatio: 0.5, markers, xLabelEvery: Math.max(1, Math.ceil(r.projection.length / 8)) });
  }

  const palette = ['#00d4ff', '#00e676', '#ff5252', '#ffab40', '#b388ff', '#ffd740', '#7c4dff', '#4dd0e1', '#ff8a65', '#aed581', '#90a4ae', '#f06292'];
  const cats = r.spending.map(c => c.category);
  const colors = cats.map((_, i) => palette[i % palette.length]);
  const mineEl = document.getElementById('compare-mix-mine');
  const theirsEl = document.getElementById('compare-mix-theirs');
  const mineData = r.spending.map(c => (c.mine ? c.mine.monthly : 0));
  const theirsData = r.spending.map(c => (c.theirs ? c.theirs.monthly : 0));
  if (mineEl && mineData.some(v => v > 0)) Chart.doughnut(mineEl, cats, mineData, colors);
  if (theirsEl && theirsData.some(v => v > 0)) Chart.doughnut(theirsEl, cats, theirsData, colors);
};

// ── What if I saved / invested more? ──

App.renderCompareWhatIf = function() {
  const S = this.compareState;
  const el = document.getElementById('compare-whatif');
  if (!el || !S.report) return;
  const r = S.report;
  const them = escapeHtml(r.labels.theirs);
  const W = S.whatIf;
  const max = W.result ? W.result.max : 0;
  const cur = r.currency.mine;
  el.innerHTML = `
    <div class="card-header"><span class="card-title">🎚 What if you did a bit more?</span><span class="text-xs text-muted" id="compare-whatif-status"></span></div>
    <p class="text-xs text-muted">Move the sliders: your own outlook is re-run on the spot with that much more per month — spending less and keeping it, or spending less and investing it. Nothing is saved.</p>
    <div class="compare-slider">
      <div class="flex justify-between text-sm"><span>Save <strong id="compare-saving-label">+${formatCurrency(W.saving, cur)}</strong> more a month</span><span class="text-xs text-muted">spend less, keep it</span></div>
      <input type="range" id="compare-slider-saving" min="0" max="${max}" step="25" value="${W.saving}" ${max === 0 ? 'disabled' : ''}>
    </div>
    <div class="compare-slider">
      <div class="flex justify-between text-sm"><span>Invest <strong id="compare-investing-label">+${formatCurrency(W.investing, cur)}</strong> more a month</span><span class="text-xs text-muted">spend less, invest it</span></div>
      <input type="range" id="compare-slider-investing" min="0" max="${max}" step="25" value="${W.investing}" ${max === 0 ? 'disabled' : ''}>
    </div>
    <div id="compare-whatif-table" class="mt-1"></div>
  `;
  const wire = (id, key, labelId) => {
    const input = document.getElementById(id);
    const onChange = () => {
      W[key] = Number(input.value) || 0;
      document.getElementById(labelId).textContent = `+${formatCurrency(W[key], cur)}`;
      if (S.whatIfTimer) clearTimeout(S.whatIfTimer);
      S.whatIfTimer = setTimeout(() => this.compareWhatIfRun(), 200);
    };
    input.addEventListener('input', onChange);
    input.addEventListener('change', onChange);
  };
  wire('compare-slider-saving', 'saving', 'compare-saving-label');
  wire('compare-slider-investing', 'investing', 'compare-investing-label');
  this.renderCompareWhatIfTable();
};

/** Only the results part — so a slider being dragged is never replaced under the pointer. */
App.renderCompareWhatIfTable = function() {
  const S = this.compareState;
  const el = document.getElementById('compare-whatif-table');
  if (!el || !S.report) return;
  const r = S.report;
  const them = escapeHtml(r.labels.theirs);
  const W = S.whatIf;
  const res = W.result;
  const cur = r.currency.mine;
  const status = document.getElementById('compare-whatif-status');
  if (status) status.textContent = W.busy ? 'running…' : (res && (W.saving || W.investing) ? `+${formatCurrency(W.saving + W.investing, cur)} a month` : '');
  if (!res) { el.innerHTML = '<div class="text-sm text-muted">Running your outlook…</div>'; return; }
  const theirsBy = Object.fromEntries(r.metrics.map(m => [m.key, m.theirs]));
  const money = v => (v === null || v === undefined ? '—' : formatCurrency(v, cur));
  const row = (label, key, fmt) => {
    const changed = JSON.stringify(res.base[key]) !== JSON.stringify(res.both[key]);
    return `<tr><td>${label}</td><td class="text-right">${fmt(res.base[key])}</td><td class="text-right you ${changed ? 'changed' : ''}">${fmt(res.both[key])}</td><td class="text-right them">${fmt(theirsBy[key])}</td></tr>`;
  };
  el.innerHTML = `
    <div class="table-container">
      <table class="compare-table whatif">
        <thead><tr><th></th><th class="text-right">You now</th><th class="text-right">You, doing more</th><th class="text-right">${them}</th></tr></thead>
        <tbody>
          ${row('Savings rate', 'savingsRate', v => formatPercent(v, 0))}
          ${row('FI date', 'fiDate', v => (v ? formatMonthKey(v) : 'not in sight'))}
          ${row('Age at FI', 'fiAge', v => (v === null || v === undefined ? '—' : v.toFixed(1)))}
          ${row('Months of spending in cash', 'cashMonths', v => (v === null || v === undefined ? '—' : `${v.toFixed(1)} mo`))}
          ${row('Net worth at retirement', 'netWorthAtRetirement', money)}
        </tbody>
      </table>
    </div>
    ${res.both.fiDate && res.base.fiDate && res.both.fiDate < res.base.fiDate ? `<div class="text-sm mt-1" style="color:var(--green)">▲ FI ${formatMonthsLabel(res.base.fiDate, res.both.fiDate)} earlier — ${formatMonthKey(res.both.fiDate)} instead of ${formatMonthKey(res.base.fiDate)}.</div>` : ''}
    ${!res.base.fiDate && res.both.fiDate ? `<div class="text-sm mt-1" style="color:var(--green)">▲ That brings an FI date into sight: ${formatMonthKey(res.both.fiDate)}.</div>` : ''}
    ${(W.saving > 0 && W.investing > 0) ? `<div class="text-xs text-muted mt-1">Saving alone: FI ${res.saving.fiDate ? formatMonthKey(res.saving.fiDate) : 'not in sight'} · investing alone: FI ${res.investing.fiDate ? formatMonthKey(res.investing.fiDate) : 'not in sight'}</div>` : ''}
  `;
};

/** "2050-04" → "2045-01": "5 years 3 months". */
function formatMonthsLabel(fromKey, toKey) {
  const [fy, fm] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  return formatMonths(Math.abs((fy * 12 + fm) - (ty * 12 + tm)));
}

App.compareWhatIfRun = async function() {
  const S = this.compareState;
  if (!S || !S.report) return;
  const W = S.whatIf;
  W.busy = true;
  try {
    const result = await API.compareWhatIf(W.saving, W.investing);
    if (!S.report || S.whatIf !== W) return; // discarded or replaced meanwhile
    W.result = result;
    W.saving = Math.min(W.saving, result.max);
    W.investing = Math.min(W.investing, result.max);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    W.busy = false;
  }
  // First result: the sliders need their range. Afterwards only the table changes.
  const slider = document.getElementById('compare-slider-saving');
  if (!slider || Number(slider.getAttribute('max')) !== (W.result ? W.result.max : 0)) this.renderCompareWhatIf();
  else this.renderCompareWhatIfTable();
};
