// ── IMPORT (statement import wizard) ──
//
// Step 1  Upload & account      choose the target account, drop files
// Step 2  Mapping               CSV / generic JSON only: correct the inferred columns
// Step 3  Needs attention       Keep / Skip the rows that might be duplicates
// Step 4  Confirm               balance reconciliation, write everything
//
// Nothing is written before the Import button in step 4. The server keeps the
// upload for 30 minutes so options can change without re-uploading; if the
// preview expired the page silently uploads again.

const IMPORT_ROLES = [
  ['ignore', 'Ignore'], ['date', 'Date'], ['postedDate', 'Posted date'], ['description', 'Description'], ['memo', 'Memo'],
  ['amount', 'Amount (signed)'], ['debit', 'Debit / money out'], ['credit', 'Credit / money in'], ['indicator', 'DR/CR indicator'],
  ['balance', 'Balance'], ['category', 'Category'], ['currency', 'Currency'], ['reference', 'Reference'],
];

App.importState = null;

App.importReset = function(params) {
  this.importState = {
    step: 1,
    accountId: (params && params.account) || '',
    accounts: [],
    files: [],
    preview: null,
    previewId: null,
    options: { includePending: false, mappings: {} },
    decisions: {},
    saveProfile: false,
    balanceMode: 'keep',
    manualBalance: '',
    showDecided: false,
    busy: false,
    uploadError: null,
    result: null,
  };
  return this.importState;
};

App.renderImport = async function(container) {
  const params = this.pageParams || {};
  let S = this.importState;
  // A deep link to another account is an explicit new intent; otherwise the wizard keeps its state while you navigate around.
  if (!S || S.result || (params.account && params.account !== S.accountId)) S = this.importReset(params);
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading import...</div>';
  try {
    S.accounts = (await API.getAccounts()).filter(a => a.type !== 'investment');
    if (!S.accountId && S.accounts.length === 1) S.accountId = S.accounts[0].id;
    container.innerHTML = `
      <div class="page-header">
        <h1>⬆️ Import statement</h1>
        <a class="btn btn-secondary" href="#transactions">💳 Transactions</a>
      </div>
      <div class="import-steps" id="import-steps"></div>
      <div id="import-body"></div>
    `;
    this.renderImportStep();
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

App.renderImportStep = function() {
  const S = this.importState;
  const steps = ['Upload & account', 'Mapping', 'Needs attention', 'Confirm'];
  const stepsEl = document.getElementById('import-steps');
  if (stepsEl) {
    stepsEl.innerHTML = steps.map((label, i) => {
      const n = i + 1;
      const skipped = n === 2 && S.preview && !this.importMappingFiles().length;
      return `<div class="import-step ${n === S.step ? 'active' : ''} ${n < S.step ? 'done' : ''} ${skipped ? 'skipped' : ''}" data-step="${n}"><span class="num">${n < S.step ? '✓' : n}</span><span>${label}</span></div>`;
    }).join('');
  }
  const body = document.getElementById('import-body');
  if (!body) return;
  if (S.result) return this.renderImportResult(body);
  switch (S.step) {
    case 1: return this.renderImportUpload(body);
    case 2: return this.renderImportMapping(body);
    case 3: return this.renderImportAttention(body);
    case 4: return this.renderImportConfirm(body);
  }
};

// ── helpers ──

App.importAccount = function() {
  const S = this.importState;
  return S.accounts.find(a => a.id === S.accountId) || (S.preview && S.preview.account) || null;
};

App.importMappingFiles = function() {
  const S = this.importState;
  return S.preview ? S.preview.files.filter(f => f.mapping) : [];
};

/** Signed display amount in the account's currency: expenses negative. */
App.importAmount = function(row) {
  const acc = this.importAccount();
  const cur = (acc && acc.currency) || 'USD';
  if (row.amount === null || row.amount === undefined) return '—';
  const signed = row.type === 'expense' ? -row.amount : row.amount;
  return (signed < 0 ? '−' : '+') + formatCurrency(Math.abs(signed), cur);
};

/** Effect of one row on the account balance (app convention; credit = amount owed). */
App.importEffect = function(row) {
  const acc = this.importAccount();
  const liability = acc && acc.type === 'credit';
  const amt = row.amount || 0;
  if (row.type === 'income') return liability ? -amt : amt;
  return liability ? amt : -amt;
};

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Read the bytes of a File / Blob (drop zone, file picker) or of a plain
 * { name, bytes } object (tests, programmatic use). Browsers now ship
 * Blob.prototype.bytes() as a *method*, so the Blob API is checked first and a
 * `bytes` property is only trusted when it actually holds data.
 */
async function readFileBytes(f) {
  if (f && typeof f.arrayBuffer === 'function') return new Uint8Array(await f.arrayBuffer());
  if (f && ArrayBuffer.isView(f.bytes)) return new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  if (f && f.bytes instanceof ArrayBuffer) return new Uint8Array(f.bytes);
  if (f && typeof f.bytes === 'function') return new Uint8Array(await f.bytes());
  if (f && typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
      reader.readAsArrayBuffer(f);
    });
  }
  throw new Error('Unsupported file object');
}

/**
 * Add files to the upload list. Accepts File objects (drop / picker) or
 * plain { name, bytes } objects (tests, programmatic use).
 */
App.importFiles = async function(list) {
  const S = this.importState || this.importReset();
  const files = Array.from(list || []);
  for (const f of files) {
    let bytes;
    try {
      bytes = await readFileBytes(f);
    } catch (err) {
      showToast(`${f.name || 'File'}: ${err.message}`, 'error');
      continue;
    }
    const size = bytes.byteLength;
    if (size === 0) { showToast(`${f.name || 'File'} is empty (0 bytes) — not added`, 'error'); continue; }
    if (S.files.some(x => x.name === f.name && x.size === size)) continue;
    if (S.files.length >= 10) { showToast('At most 10 files per import', 'error'); break; }
    S.files.push({ name: f.name, size, content: bytesToBase64(bytes) });
  }
  S.uploadError = null;
  if (S.step === 1) this.renderImportStep();
};

/** Run (or re-run) the preview. `fresh` uploads the files; otherwise the cached upload is reused. */
App.importRunPreview = async function(fresh) {
  const S = this.importState;
  S.busy = true;
  this.renderImportStep();
  try {
    let preview;
    const localeHint = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    if (!fresh && S.previewId) {
      try {
        preview = await API.importPreview({ previewId: S.previewId, accountId: S.accountId, options: S.options });
      } catch (err) {
        if (err.status !== 410) throw err;
        preview = null; // expired → upload again below
      }
    }
    if (!preview) {
      preview = await API.importPreview({ accountId: S.accountId, localeHint, files: S.files.map(f => ({ name: f.name, content: f.content })), options: S.options });
    }
    S.preview = preview;
    S.previewId = preview.previewId;
    S.decisions = {};
    S.uploadError = null;
    return preview;
  } catch (err) {
    S.uploadError = err.data && err.data.files ? err.data : { error: err.message };
    showToast(err.message, 'error');
    return null;
  } finally {
    S.busy = false;
  }
};

// ── Step 1: upload & account ──

App.renderImportUpload = function(body) {
  const S = this.importState;
  const canContinue = !!S.accountId && S.files.length > 0 && !S.busy;
  body.innerHTML = `
    <div class="card mb-2">
      <div class="form-group">
        <label>Import into account</label>
        <select id="import-account">
          <option value="">Select account…</option>
          ${S.accounts.map(a => `<option value="${a.id}" ${a.id === S.accountId ? 'selected' : ''}>${escapeHtml(a.name)} · ${a.type} · ${a.currency}${a.type === 'credit' ? ' · ' + formatCurrency(a.balance, a.currency) + ' owed' : ' · ' + formatCurrency(a.balance, a.currency)}</option>`).join('')}
        </select>
        <div class="help">Only rows in the account's currency can be imported. Investment accounts are not offered.</div>
      </div>
      <div class="drop-zone" id="import-drop">
        <div class="icon">📄</div>
        <div><strong>Drop statement files here</strong> or <label for="import-file-input" class="link">browse</label></div>
        <div class="text-xs text-muted mt-1">CSV / TSV · OFX / QFX · QIF · Open Banking JSON — up to 10 files</div>
        <input type="file" id="import-file-input" multiple accept=".csv,.tsv,.txt,.ofx,.qfx,.qif,.json" style="display:none">
      </div>
      ${S.files.length ? `
        <ul class="import-file-list" id="import-file-list">
          ${S.files.map((f, i) => `<li><span>📎 ${escapeHtml(f.name)} <span class="text-muted text-xs">(${(f.size / 1024).toFixed(1)} KB)</span></span><button type="button" class="btn btn-sm btn-secondary remove-file-btn" data-i="${i}" title="Remove">✕</button></li>`).join('')}
        </ul>` : ''}
      ${S.uploadError ? `
        <div class="import-banner error">
          <strong>${escapeHtml(S.uploadError.error || 'The files could not be read')}</strong>
          ${S.uploadError.files ? `<ul>${S.uploadError.files.map(f => `<li>${escapeHtml(f.name)}: ${escapeHtml(f.error ? f.error.message : 'ok')}</li>`).join('')}</ul>` : ''}
        </div>` : ''}
      <div class="modal-actions">
        <button class="btn btn-primary" id="import-continue" ${canContinue ? '' : 'disabled'}>${S.busy ? 'Reading…' : 'Continue →'}</button>
      </div>
    </div>
  `;
  document.getElementById('import-account').addEventListener('change', e => { S.accountId = e.target.value; this.renderImportStep(); });
  const input = document.getElementById('import-file-input');
  input.addEventListener('change', () => { this.importFiles(input.files); input.value = ''; });
  const drop = document.getElementById('import-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer) this.importFiles(e.dataTransfer.files); });
  drop.addEventListener('click', e => { if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT' && input.click) input.click(); });
  $$('.remove-file-btn').forEach(btn => btn.addEventListener('click', () => { S.files.splice(Number(btn.dataset.i), 1); this.renderImportStep(); }));
  document.getElementById('import-continue').addEventListener('click', async () => {
    S.previewId = null; // a new upload
    const preview = await this.importRunPreview(true);
    if (!preview) return this.renderImportStep();
    S.step = this.importMappingFiles().length ? 2 : 3;
    this.renderImportStep();
  });
};

// ── File facts panel (steps 2–4) ──

App.renderImportFilesPanel = function() {
  const S = this.importState;
  const acc = this.importAccount();
  return `
    <div class="import-files">
      ${S.preview.files.map(f => {
        const d = f.detected || {};
        const facts = [];
        if (f.format) facts.push(`${f.format.toUpperCase()}${f.dialect && f.dialect !== f.format ? ' · ' + escapeHtml(f.dialect) : ''}`);
        if (d.currency) facts.push(d.currency);
        if (d.accountExternalId) facts.push(`account ${escapeHtml(d.accountExternalId)}`);
        if (d.dateFrom) facts.push(`${formatDate(d.dateFrom)} – ${formatDate(d.dateTo)}`);
        if (!f.error) facts.push(`${f.rows} row${f.rows === 1 ? '' : 's'}`);
        return `
          <div class="import-file">
            <div class="flex items-center justify-between gap-2" style="flex-wrap:wrap">
              <strong>📎 ${escapeHtml(f.name)}</strong>
              <span class="text-xs text-muted">${facts.join(' · ')}</span>
            </div>
            ${f.error ? `<div class="import-banner error">Not imported — ${escapeHtml(f.error.message)}</div>` : ''}
            ${f.blocked ? `<div class="import-banner error">⛔ ${escapeHtml(f.blocked.message)}</div>` : ''}
            ${f.fileDuplicate ? `<div class="import-banner warn">⚠️ This exact file was imported on ${formatDate(f.fileDuplicate.importedAt)} into ${escapeHtml(f.fileDuplicate.accountName)} (${f.fileDuplicate.rows} rows). Its rows will show as already recorded.</div>` : ''}
            ${f.warnings.map(w => `<div class="import-banner warn">⚠️ ${escapeHtml(w)}</div>`).join('')}
          </div>`;
      }).join('')}
      ${acc ? `<div class="text-xs text-muted mt-1">Importing into <strong>${escapeHtml(acc.name)}</strong> (${acc.type}, ${acc.currency})</div>` : ''}
    </div>
  `;
};

// ── Step 2: CSV mapping ──

App.renderImportMapping = function(body) {
  const S = this.importState;
  const files = this.importMappingFiles();
  body.innerHTML = `
    <div class="card mb-2">${this.renderImportFilesPanel()}</div>
    ${files.map(f => {
      const m = f.mapping.mapping;
      const roleOf = idx => (Object.entries(m.columns).find(([, v]) => v === idx) || ['ignore'])[0];
      return `
        <div class="card mb-2 import-mapping" data-file="${f.index}">
          <div class="card-header"><span class="card-title">Columns of ${escapeHtml(f.name)}</span>
            <span class="text-sm ${f.mapping.parsedOk === f.mapping.total ? 'text-muted' : 'text-warn'}">${f.mapping.parsedOk} / ${f.mapping.total} rows parse${f.mapping.profileApplied ? ' · remembered mapping applied' : ''}</span></div>
          <div class="sim-inline mb-2" style="grid-template-columns:repeat(3,1fr)">
            <div class="form-group">
              <label>Date order ${m.dateOrderAmbiguous ? '<span class="chip warn">ambiguous — please check</span>' : ''}</label>
              <select class="map-date-order">
                ${[['YMD', 'Year / month / day (2026-09-03)'], ['DMY', 'Day / month / year (03/09/2026)'], ['MDY', 'Month / day / year (09/03/2026)']].map(([v, l]) => `<option value="${v}" ${m.dateOrder === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Numbers</label>
              <select class="map-number-format">
                <option value="point" ${m.numberFormat === 'point' ? 'selected' : ''}>1,234.56</option>
                <option value="comma" ${m.numberFormat === 'comma' ? 'selected' : ''}>1.234,56</option>
              </select>
            </div>
            <div class="form-group">
              <label>Amount sign</label>
              <select class="map-sign">
                <option value="signed" ${m.signConvention === 'signed' ? 'selected' : ''}>Signed amount column</option>
                <option value="debitCredit" ${m.signConvention === 'debitCredit' ? 'selected' : ''}>Separate debit / credit columns</option>
                <option value="indicator" ${m.signConvention === 'indicator' ? 'selected' : ''}>Amount + DR/CR indicator</option>
              </select>
            </div>
          </div>
          <div class="table-container">
            <table class="import-sample">
              <thead>
                <tr>${m.headers.map((h, i) => `<th><div class="text-xs text-muted">${escapeHtml(h)}</div><select class="map-role" data-col="${i}">${IMPORT_ROLES.map(([v, l]) => `<option value="${v}" ${roleOf(i) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></th>`).join('')}</tr>
              </thead>
              <tbody>${f.mapping.sample.map(r => `<tr>${m.headers.map((_, i) => `<td class="text-sm">${escapeHtml(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
            </table>
          </div>
          <label class="flex items-center gap-1 mt-2 text-sm"><input type="checkbox" class="map-remember" ${S.saveProfile ? 'checked' : ''}> Remember this mapping for files with the same columns</label>
        </div>`;
    }).join('')}
    <div class="modal-actions">
      <button class="btn btn-secondary" id="import-back">← Back</button>
      <button class="btn btn-primary" id="import-continue" ${S.busy ? 'disabled' : ''}>Continue →</button>
    </div>
  `;
  const apply = async (card) => {
    const fileIndex = Number(card.dataset.file);
    const f = files.find(x => x.index === fileIndex);
    const current = f.mapping.mapping;
    const columns = {};
    for (const k of Object.keys(current.columns)) columns[k] = -1; // drop roles the user removed
    card.querySelectorAll('.map-role').forEach(sel => { if (sel.value !== 'ignore') columns[sel.value] = Number(sel.dataset.col); });
    S.options.mappings[fileIndex] = {
      delimiter: current.delimiter,
      headerRow: current.headerRow,
      dateOrder: card.querySelector('.map-date-order').value,
      numberFormat: card.querySelector('.map-number-format').value,
      signConvention: card.querySelector('.map-sign').value,
      columns,
    };
    await this.importRunPreview(false);
    this.renderImportStep();
  };
  $$('.import-mapping').forEach(card => {
    card.querySelectorAll('.map-role, .map-date-order, .map-number-format, .map-sign').forEach(el => el.addEventListener('change', () => apply(card)));
    card.querySelector('.map-remember').addEventListener('change', e => { S.saveProfile = e.target.checked; });
  });
  document.getElementById('import-back').addEventListener('click', () => { S.step = 1; this.renderImportStep(); });
  document.getElementById('import-continue').addEventListener('click', () => { S.step = 3; this.renderImportStep(); });
};

// ── Step 3: needs attention ──

App.importRowsByStatus = function() {
  const S = this.importState;
  const rows = S.preview.rows;
  const possible = rows.filter(r => r.status === 'possible');
  return {
    fresh: rows.filter(r => r.status === 'new'),
    recorded: rows.filter(r => r.status === 'recorded'),
    excluded: rows.filter(r => r.status === 'excluded'),
    possible,
    undecided: possible.filter(r => !S.decisions[r.idx]),
    decided: possible.filter(r => !!S.decisions[r.idx]),
    kept: possible.filter(r => S.decisions[r.idx] === 'keep'),
    skipped: possible.filter(r => S.decisions[r.idx] === 'skip'),
  };
};

App.renderImportRow = function(r, extraCells = '') {
  const uncategorized = r.category === UNCATEGORIZED_CATEGORY;
  return `
    <tr data-idx="${r.idx}">
      <td class="text-sm">${r.date ? formatDate(r.date) : '—'}</td>
      <td class="text-sm" title="${escapeHtml(r.rawDescription || '')}">${escapeHtml(r.description)}${r.transferWith ? ` <span class="chip" title="Pairs with ${escapeHtml(r.transferWith.description)} on ${escapeHtml(r.transferWith.accountName)}">⇄ ${escapeHtml(r.transferWith.accountName)}</span>` : ''}</td>
      <td class="text-sm" style="text-align:right;color:${r.type === 'income' ? 'var(--green)' : 'var(--red)'}">${this.importAmount(r)}</td>
      <td><span class="badge ${uncategorized ? 'badge-uncategorized' : r.category === TRANSFER_CATEGORY ? 'badge-budget' : 'badge-' + (r.type || 'expense')}" title="${escapeHtml(r.categoryVia ? `${r.categorySource}: ${r.categoryVia}` : r.categorySource || '')}">${escapeHtml(r.category)}</span></td>
      ${extraCells}
    </tr>`;
};

App.renderImportAttention = function(body) {
  const S = this.importState;
  const g = this.importRowsByStatus();
  const sum = S.preview.summary;
  const chip = (label, n, cls) => `<span class="chip ${cls} ${n ? '' : 'dim'}">${label} <strong>${n}</strong></span>`;
  const matchText = r => {
    const m = r.match;
    const signed = m.type === 'expense' ? -m.amount : m.amount;
    const acc = this.importAccount();
    return `${formatDate(m.date)} · ${(signed < 0 ? '−' : '+') + formatCurrency(Math.abs(signed), (acc && acc.currency) || 'USD')} · ${escapeHtml(m.description)}`;
  };
  const table = (rows, extraHead = '', extra = () => '') => rows.length ? `
    <div class="table-container"><table>
      <thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th><th>Category</th>${extraHead}</tr></thead>
      <tbody>${rows.map(r => this.renderImportRow(r, extra(r))).join('')}</tbody>
    </table></div>` : '<div class="text-muted text-sm">None</div>';

  body.innerHTML = `
    <div class="card mb-2">${this.renderImportFilesPanel()}</div>
    <div class="card mb-2">
      <div class="chip-row">
        ${chip('New', g.fresh.length, 'ok')}
        ${chip('Already recorded (skipped)', g.recorded.length, '')}
        ${chip('Needs decision', g.undecided.length, g.undecided.length ? 'warn' : 'ok')}
        ${chip('Excluded', g.excluded.length, g.excluded.length ? 'danger' : '')}
        ${chip('Uncategorized', sum.uncategorized, '')}
        ${chip('Transfers', sum.transfers, '')}
      </div>
      <label class="flex items-center gap-1 mt-2 text-sm"><input type="checkbox" id="import-include-pending" ${S.options.includePending ? 'checked' : ''} ${S.busy ? 'disabled' : ''}> Include pending (not yet booked) rows</label>
    </div>

    <div class="card mb-2" id="import-attention">
      <div class="card-header">
        <span class="card-title">⚠️ Needs decision <span class="text-muted">(${g.undecided.length})</span></span>
        ${g.undecided.length ? `<div class="flex gap-1"><button class="btn btn-sm btn-secondary" id="import-keep-all">Keep all</button><button class="btn btn-sm btn-secondary" id="import-skip-all">Skip all remaining</button></div>` : ''}
      </div>
      ${g.undecided.length ? `
        <p class="text-sm text-muted">Each row below has the same amount and description as something already recorded 1–2 days apart, or repeats a row earlier in this upload. <strong>Keep</strong> imports it as a new transaction; <strong>Skip</strong> treats it as already recorded and marks the recorded transaction (🔗) so it is not asked again.</p>
        <div class="table-container"><table>
          <thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th><th>Category</th><th>Matches</th><th></th></tr></thead>
          <tbody>${g.undecided.map(r => this.renderImportRow(r, `
            <td class="text-sm"><div>${matchText(r)}</div><div class="text-xs text-muted">${escapeHtml(r.match.explanation)}</div></td>
            <td style="white-space:nowrap;text-align:right"><button class="btn btn-sm btn-primary decide-btn" data-act="keep" data-idx="${r.idx}">Keep</button> <button class="btn btn-sm btn-secondary decide-btn" data-act="skip" data-idx="${r.idx}">Skip</button></td>`)).join('')}</tbody>
        </table></div>` : `<div class="import-empty">✅ Nothing needs your attention${g.possible.length ? ` — ${g.decided.length} decision${g.decided.length === 1 ? '' : 's'} made` : ''}.</div>`}
      ${g.decided.length ? `
        <div class="mt-2 text-sm"><a id="import-toggle-decided" class="link">${S.showDecided ? 'Hide' : 'Show'} decided (${g.decided.length})</a></div>
        ${S.showDecided ? table(g.decided, '<th>Decision</th><th></th>', r => `<td class="text-sm">${S.decisions[r.idx] === 'keep' ? '✅ Keep' : '⏭ Skip'}</td><td style="text-align:right"><a class="link change-decision" data-idx="${r.idx}">change</a></td>`) : ''}` : ''}
    </div>

    <details class="card mb-2"><summary>New — will be imported (${g.fresh.length})</summary>${table(g.fresh)}</details>
    <details class="card mb-2"><summary>Already recorded — skipped automatically (${g.recorded.length})</summary>${table(g.recorded, '<th>Matches</th>', r => `<td class="text-sm"><div>${matchText(r)}</div><div class="text-xs text-muted">${escapeHtml(r.match.explanation)}</div></td>`)}</details>
    <details class="card mb-2"><summary>Excluded — never imported (${g.excluded.length})</summary>${table(g.excluded, '<th>Reason</th>', r => `<td class="text-sm"><span class="chip danger">${escapeHtml(r.reason)}</span> ${escapeHtml(r.errors[0] || '')}</td>`)}</details>

    <div class="modal-actions">
      <button class="btn btn-secondary" id="import-back">← Back</button>
      <button class="btn btn-primary" id="import-continue" ${g.undecided.length || S.busy ? 'disabled' : ''} title="${g.undecided.length ? 'Decide every row first' : ''}">Continue →</button>
    </div>
  `;

  const decide = (idx, act) => {
    S.decisions[idx] = act;
    const tr = body.querySelector(`#import-attention tr[data-idx="${idx}"]`);
    if (tr) {
      tr.classList.add('row-leaving');
      setTimeout(() => this.renderImportStep(), 180);
    } else this.renderImportStep();
  };
  body.querySelectorAll('.decide-btn').forEach(btn => btn.addEventListener('click', () => decide(Number(btn.dataset.idx), btn.dataset.act)));
  const keepAll = document.getElementById('import-keep-all');
  if (keepAll) keepAll.addEventListener('click', () => { g.undecided.forEach(r => { S.decisions[r.idx] = 'keep'; }); this.renderImportStep(); });
  const skipAll = document.getElementById('import-skip-all');
  if (skipAll) skipAll.addEventListener('click', () => { g.undecided.forEach(r => { S.decisions[r.idx] = 'skip'; }); this.renderImportStep(); });
  const toggle = document.getElementById('import-toggle-decided');
  if (toggle) toggle.addEventListener('click', () => { S.showDecided = !S.showDecided; this.renderImportStep(); });
  body.querySelectorAll('.change-decision').forEach(a => a.addEventListener('click', () => { delete S.decisions[Number(a.dataset.idx)]; this.renderImportStep(); }));
  document.getElementById('import-include-pending').addEventListener('change', async e => {
    S.options.includePending = e.target.checked;
    await this.importRunPreview(false);
    this.renderImportStep();
  });
  document.getElementById('import-back').addEventListener('click', () => { S.step = this.importMappingFiles().length ? 2 : 1; this.renderImportStep(); });
  document.getElementById('import-continue').addEventListener('click', () => { if (!this.importRowsByStatus().undecided.length) { S.step = 4; this.renderImportStep(); } });
};

// ── Step 4: confirm & reconcile ──

App.renderImportConfirm = function(body) {
  const S = this.importState;
  const g = this.importRowsByStatus();
  const acc = this.importAccount();
  const cur = (acc && acc.currency) || 'USD';
  const bal = S.preview.balance;
  const after = Math.round((bal.before + bal.deltaNew + g.kept.reduce((s, r) => s + this.importEffect(r), 0)) * 100) / 100;
  const closing = bal.statementClosing;
  const hasClosing = closing !== undefined && closing !== null;
  const reconciled = hasClosing && Math.abs(after - closing) < 0.005;
  const toImport = g.fresh.length + g.kept.length;
  const money = n => formatCurrency(n, cur) + (acc && acc.type === 'credit' ? ' owed' : '');
  body.innerHTML = `
    <div class="card mb-2">${this.renderImportFilesPanel()}</div>
    <div class="card mb-2">
      <div class="card-title mb-2">What will be written</div>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <div class="stat-card"><div class="label">Imported</div><div class="value" style="font-size:1.2rem;color:var(--green)" id="import-count-imported">${toImport}</div><div class="text-xs text-muted">${g.fresh.length} new${g.kept.length ? ` + ${g.kept.length} kept` : ''}</div></div>
        <div class="stat-card"><div class="label">Already recorded</div><div class="value" style="font-size:1.2rem">${g.recorded.length}</div></div>
        <div class="stat-card"><div class="label">Skipped by you</div><div class="value" style="font-size:1.2rem">${g.skipped.length}</div><div class="text-xs text-muted">${g.skipped.length ? 'recorded rows get a 🔗 marker' : ''}</div></div>
        <div class="stat-card"><div class="label">Excluded</div><div class="value" style="font-size:1.2rem;color:${g.excluded.length ? 'var(--red)' : 'inherit'}">${g.excluded.length}</div></div>
      </div>
      ${S.preview.summary.uncategorized ? `<div class="text-sm text-muted mt-2">${S.preview.summary.uncategorized} row${S.preview.summary.uncategorized === 1 ? '' : 's'} will be imported as <span class="badge badge-uncategorized">Uncategorized</span> — set a category from the Transactions page whenever you like.</div>` : ''}
      ${S.saveProfile ? '<div class="text-sm text-muted mt-1">The CSV column mapping will be remembered.</div>' : ''}
    </div>

    <div class="card mb-2" id="import-balance">
      <div class="card-title mb-2">Balance of ${escapeHtml(acc ? acc.name : 'the account')}</div>
      <div class="sim-row"><span>Now</span><strong>${money(bal.before)}</strong></div>
      <div class="sim-row"><span>After import</span><strong id="import-balance-after">${money(after)}</strong></div>
      ${hasClosing ? `<div class="sim-row"><span>Statement closing balance${bal.statementClosingAsOf ? ` (${formatDate(bal.statementClosingAsOf)})` : ''}</span><strong style="color:${reconciled ? 'var(--green)' : 'var(--orange)'}">${money(closing)} ${reconciled ? '✔ reconciled' : `· differs by ${formatCurrency(Math.abs(closing - after), cur)}`}</strong></div>` : '<div class="text-xs text-muted mt-1">This file carries no closing balance.</div>'}
      <div class="mt-2 text-sm">
        <label class="flex items-center gap-1"><input type="radio" name="import-balance-mode" value="keep" ${S.balanceMode === 'keep' ? 'checked' : ''}> Keep the computed balance (${money(after)})</label>
        ${hasClosing ? `<label class="flex items-center gap-1"><input type="radio" name="import-balance-mode" value="statement" ${S.balanceMode === 'statement' ? 'checked' : ''}> Set the balance to the statement's closing balance (${money(closing)})</label>` : ''}
        <label class="flex items-center gap-1"><input type="radio" name="import-balance-mode" value="manual" ${S.balanceMode === 'manual' ? 'checked' : ''}> Enter the current balance: <input type="number" step="0.01" id="import-balance-manual" value="${escapeHtml(S.manualBalance)}" style="width:140px" ${S.balanceMode === 'manual' ? '' : 'disabled'}></label>
      </div>
      ${!reconciled && hasClosing ? '<div class="text-xs text-muted mt-2">A difference usually means the account\'s opening balance already included some of these transactions, or the statement covers a different period than the account balance date.</div>' : ''}
    </div>

    <div class="modal-actions">
      <button class="btn btn-secondary" id="import-back">← Back</button>
      <button class="btn btn-primary" id="import-commit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Importing…' : `Import ${toImport} transaction${toImport === 1 ? '' : 's'}`}</button>
    </div>
  `;
  body.querySelectorAll('input[name="import-balance-mode"]').forEach(r => r.addEventListener('change', e => {
    S.balanceMode = e.target.value;
    const manual = document.getElementById('import-balance-manual');
    manual.disabled = S.balanceMode !== 'manual';
  }));
  document.getElementById('import-balance-manual').addEventListener('input', e => { S.manualBalance = e.target.value; });
  document.getElementById('import-back').addEventListener('click', () => { S.step = 3; this.renderImportStep(); });
  document.getElementById('import-commit').addEventListener('click', () => this.importCommit());
};

App.importCommit = async function() {
  const S = this.importState;
  if (S.balanceMode === 'manual' && !Number.isFinite(parseFloat(S.manualBalance))) return showToast('Enter the current balance first', 'error');
  S.busy = true;
  this.renderImportStep();
  try {
    const body = { previewId: S.previewId, decisions: S.decisions, saveProfile: S.saveProfile, balance: { mode: S.balanceMode } };
    if (S.balanceMode === 'manual') body.balance.value = parseFloat(S.manualBalance);
    S.result = await API.importCommit(body);
    showToast(`Imported ${S.result.counts.imported} transaction${S.result.counts.imported === 1 ? '' : 's'}`);
  } catch (err) {
    showToast(err.message, 'error');
    if (err.status === 409) S.step = 3;
    if (err.status === 410) {
      const preview = await this.importRunPreview(true);
      S.step = preview ? 3 : 1;
    }
  } finally {
    S.busy = false;
  }
  this.renderImportStep();
};

App.renderImportResult = function(body) {
  const S = this.importState;
  const r = S.result;
  const acc = r.account;
  const cur = (acc && acc.currency) || 'USD';
  body.innerHTML = `
    <div class="card mb-2 import-result">
      <h2 style="margin-top:0">✅ Import complete</h2>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <div class="stat-card"><div class="label">Imported</div><div class="value" style="font-size:1.2rem;color:var(--green)" id="import-result-imported">${r.counts.imported}</div></div>
        <div class="stat-card"><div class="label">Already recorded</div><div class="value" style="font-size:1.2rem">${r.counts.recorded}</div></div>
        <div class="stat-card"><div class="label">Skipped</div><div class="value" style="font-size:1.2rem">${r.counts.skipped}</div><div class="text-xs text-muted">${r.counts.stamped ? `${r.counts.stamped} recorded row${r.counts.stamped === 1 ? '' : 's'} marked 🔗` : ''}</div></div>
        <div class="stat-card"><div class="label">Excluded</div><div class="value" style="font-size:1.2rem">${r.counts.excluded}</div></div>
      </div>
      <div class="sim-row mt-2"><span>${escapeHtml(acc ? acc.name : 'Account')} balance</span><strong>${formatCurrency(r.balance.final, cur)}${acc && acc.type === 'credit' ? ' owed' : ''}${r.balance.adjustment ? ` <span class="text-xs text-muted">(adjusted by ${formatCurrency(r.balance.adjustment, cur)} — ${escapeHtml(r.balance.mode)})</span>` : ''}</strong></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="import-another">Import another file</button>
        ${r.counts.imported ? `<a class="btn btn-primary" id="import-view" href="#transactions?batchId=${encodeURIComponent(r.batchIds[r.batchIds.length - 1])}">View imported transactions →</a>` : '<a class="btn btn-primary" href="#transactions">Transactions →</a>'}
      </div>
    </div>
  `;
  document.getElementById('import-another').addEventListener('click', () => { this.importReset({ account: S.accountId }); this.renderImportStep(); });
};
