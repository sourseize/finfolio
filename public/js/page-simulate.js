// ── SIMULATE ──
// What-if projections: life events × economic conditions → net worth, runway, FIRE.
// State lives in App.sim; every edit re-runs the scenario (debounced) against the API.

const SIM_COLORS = { scenario: '#00d4ff', baseline: '#8899bb', band: 'rgba(0,212,255,0.14)', retire: '#ffab40', fi: '#00e676', compare: ['#00d4ff', '#b388ff', '#ffd740', '#ff5252', '#00e676', '#ffab40'] };
const SIM_MC_TRIALS = 300;

App.sim = {
  catalog: null,
  profile: null,
  saved: [],
  scenario: null,     // the scenario being edited (normalised shape)
  savedId: null,      // id when it mirrors a saved scenario
  dirty: false,
  run: null,          // last /api/simulate response for the scenario
  baselineRun: null,  // cached run of the default "Baseline" scenario (for the dashed comparison line)
  showReal: false,
  showBand: true,
  runTimer: null,
  runSeq: 0,
};

App.renderSimulate = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading simulator...</div>';
  const S = this.sim;
  try {
    const [catalog, profile, saved] = await Promise.all([
      S.catalog ? Promise.resolve(S.catalog) : API.getSimCatalog(),
      API.getProfile(),
      API.getScenarios(),
    ]);
    S.catalog = catalog;
    S.profile = profile;
    S.saved = saved;
    if (!S.scenario) this.simNewScenario(false);

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1>🔮 Simulate</h1>
          <div class="text-sm text-muted">Explore life events, economic conditions and spending decisions — and see what they do to your future.</div>
        </div>
        <div class="flex items-center gap-1" style="flex-wrap:wrap">
          <select id="sim-saved-select" style="width:auto;min-width:180px"></select>
          <button class="btn btn-sm btn-secondary" id="sim-new-btn">+ New</button>
          <button class="btn btn-sm btn-primary" id="sim-save-btn">💾 Save</button>
          <button class="btn btn-sm btn-danger" id="sim-delete-btn" title="Delete saved scenario">🗑️</button>
          <button class="btn btn-sm btn-secondary" id="sim-compare-btn">⚖️ Compare</button>
        </div>
      </div>

      <div class="stats-grid" id="sim-stats"></div>

      <div class="sim-layout">
        <aside class="sim-side" id="sim-side"></aside>
        <div class="sim-main" id="sim-main">
          <div class="chart-container">
            <div class="flex items-center justify-between" style="flex-wrap:wrap;gap:8px">
              <h3 style="margin:0">📈 Net worth projection <span class="sim-running" id="sim-running">running…</span></h3>
              <div class="flex items-center gap-1">
                <div class="toggle-group" id="sim-money-toggle">
                  <button data-v="nominal" class="${S.showReal ? '' : 'active'}">Nominal</button>
                  <button data-v="real" class="${S.showReal ? 'active' : ''}">Today's money</button>
                </div>
                <div class="toggle-group" id="sim-band-toggle">
                  <button data-v="on" class="${S.showBand ? 'active' : ''}">Monte Carlo band</button>
                  <button data-v="off" class="${S.showBand ? '' : 'active'}">Hide</button>
                </div>
              </div>
            </div>
            <canvas id="sim-chart" style="margin-top:12px"></canvas>
            <div class="legend" id="sim-legend"></div>
          </div>
          <div class="grid grid-2 gap-2" id="sim-detail-cards"></div>
          <div class="card mt-2" id="sim-milestones"></div>
          <div class="grid grid-2 gap-2 mt-2">
            <div class="card" id="sim-goals"></div>
            <div class="card" id="sim-opportunity"></div>
          </div>
        </div>
      </div>
    `;

    this.simRenderSavedSelect();
    this.simRenderSide();
    this.simRenderOpportunity();

    document.getElementById('sim-saved-select').addEventListener('change', e => this.simLoadSaved(e.target.value));
    document.getElementById('sim-new-btn').addEventListener('click', () => { this.simNewScenario(true); });
    document.getElementById('sim-save-btn').addEventListener('click', () => this.simSave());
    document.getElementById('sim-delete-btn').addEventListener('click', () => this.simDelete());
    document.getElementById('sim-compare-btn').addEventListener('click', () => this.simShowCompare());
    document.getElementById('sim-money-toggle').addEventListener('click', e => {
      if (!e.target.dataset.v) return;
      S.showReal = e.target.dataset.v === 'real';
      $$('#sim-money-toggle button').forEach(b => b.classList.toggle('active', b.dataset.v === e.target.dataset.v));
      this.simRenderResults();
    });
    document.getElementById('sim-band-toggle').addEventListener('click', e => {
      if (!e.target.dataset.v) return;
      S.showBand = e.target.dataset.v === 'on';
      $$('#sim-band-toggle button').forEach(b => b.classList.toggle('active', b.dataset.v === e.target.dataset.v));
      this.simRenderResults();
    });

    if (!S.baselineRun) {
      API.simulate({ includeMonths: false }).then(r => { S.baselineRun = r; this.simRenderResults(); }).catch(() => {});
    }
    if (S.run) this.simRenderResults(); else this.simScheduleRun(0);
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

// ── Scenario state helpers ──────────────────────────────────────────────────

App.simNewScenario = function(rerender) {
  const S = this.sim;
  const econ = S.catalog.defaultEconomy;
  S.scenario = {
    name: 'New scenario',
    description: '',
    horizonYears: undefined,
    economy: { ...econ, preset: 'moderate', shocks: [...(econ.shocks || [])] },
    events: [],
    policy: { ...S.catalog.defaultPolicy },
    overrides: {},
  };
  S.savedId = null;
  S.dirty = false;
  S.run = null;
  if (rerender) {
    this.simRenderSavedSelect();
    this.simRenderSide();
    this.simScheduleRun(0);
  }
};

App.simLoadSaved = function(id) {
  const S = this.sim;
  if (!id) { this.simNewScenario(true); return; }
  const s = S.saved.find(x => x.id === id);
  if (!s) return;
  S.scenario = JSON.parse(JSON.stringify({ name: s.name, description: s.description || '', horizonYears: s.horizonYears, economy: s.economy, events: s.events, policy: s.policy, overrides: s.overrides || {} }));
  S.savedId = id;
  S.dirty = false;
  S.run = null;
  this.simRenderSavedSelect();
  this.simRenderSide();
  this.simScheduleRun(0);
};

App.simRenderSavedSelect = function() {
  const S = this.sim;
  const sel = document.getElementById('sim-saved-select');
  if (!sel) return;
  sel.innerHTML = `<option value="">Unsaved scenario</option>` +
    S.saved.map(s => `<option value="${s.id}" ${s.id === S.savedId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
  document.getElementById('sim-delete-btn').style.display = S.savedId ? '' : 'none';
  document.getElementById('sim-save-btn').textContent = S.savedId ? (S.dirty ? '💾 Save changes' : '💾 Saved') : '💾 Save';
};

App.simMarkDirty = function() {
  this.sim.dirty = true;
  this.simRenderSavedSelect();
  this.simScheduleRun();
};

App.simSave = async function() {
  const S = this.sim;
  try {
    const payload = this.simScenarioPayload();
    if (S.savedId) {
      const saved = await API.updateScenario(S.savedId, payload);
      S.saved = S.saved.map(s => (s.id === saved.id ? saved : s));
      showToast('Scenario saved');
    } else {
      const name = await App.promptDialog('Save scenario', { label: 'Scenario name', value: payload.name });
      if (name === null) return;
      payload.name = name.trim() || payload.name;
      S.scenario.name = payload.name;
      const saved = await API.createScenario(payload);
      S.saved.push(saved);
      S.savedId = saved.id;
      showToast('Scenario saved');
    }
    S.dirty = false;
    this.simRenderSavedSelect();
    this.simRenderSide();
  } catch (err) { showToast(err.message, 'error'); }
};

App.simDelete = async function() {
  const S = this.sim;
  if (!S.savedId) return;
  if (!(await App.confirmDialog(`“${S.scenario.name}” will be removed from your saved scenarios.`, { title: 'Delete this scenario?' }))) return;
  try {
    await API.deleteScenario(S.savedId);
    S.saved = S.saved.filter(s => s.id !== S.savedId);
    showToast('Scenario deleted');
    this.simNewScenario(true);
  } catch (err) { showToast(err.message, 'error'); }
};

App.simScenarioPayload = function() {
  const s = this.sim.scenario;
  const overrides = {};
  for (const k of Object.keys(s.overrides || {})) {
    if (typeof s.overrides[k] === 'number' && Number.isFinite(s.overrides[k])) overrides[k] = s.overrides[k];
  }
  return {
    name: s.name,
    description: s.description,
    horizonYears: s.horizonYears || undefined,
    economy: s.economy,
    events: s.events,
    policy: s.policy,
    overrides: Object.keys(overrides).length ? overrides : undefined,
  };
};

// ── Running ─────────────────────────────────────────────────────────────────

App.simScheduleRun = function(delay = 400) {
  const S = this.sim;
  clearTimeout(S.runTimer);
  S.runTimer = setTimeout(() => this.simRun(), delay);
};

App.simRun = async function() {
  const S = this.sim;
  const seq = ++S.runSeq;
  const indicator = document.getElementById('sim-running');
  if (indicator) indicator.classList.add('on');
  try {
    const res = await API.simulate({ scenario: this.simScenarioPayload(), montecarlo: { trials: SIM_MC_TRIALS, seed: 42 }, includeMonths: false });
    if (seq !== S.runSeq) return; // a newer run superseded this one
    const first = !S.run;
    S.run = res;
    this.simRenderResults();
    if (first) this.simRenderSide(); // fill in derived placeholders
  } catch (err) {
    if (seq === S.runSeq) showToast(err.message, 'error');
  } finally {
    if (seq === S.runSeq && indicator) indicator.classList.remove('on');
  }
};

// ── Left column: scenario builder ───────────────────────────────────────────

App.simRenderSide = function() {
  const S = this.sim;
  const s = S.scenario;
  const side = document.getElementById('sim-side');
  if (!side) return;
  const presets = S.catalog.economyPresets;
  const preset = presets.find(p => p.id === s.economy.preset);
  const pct = v => (v === undefined || v === null ? '' : Math.round(v * 10000) / 100);
  const baseline = S.run ? S.run.baseline : null;
  const ov = s.overrides || {};
  const ovField = (key, label, help) => `
    <div class="sim-row">
      <span class="k" title="${escapeHtml(help || '')}">${label}</span>
      <input type="number" step="1" data-override="${key}" value="${ov[key] !== undefined ? ov[key] : ''}" placeholder="${baseline ? Math.round(baseline[key]) : '…'}">
    </div>`;

  side.innerHTML = `
    <div class="card">
      <div class="sim-section-title">Scenario</div>
      <div class="sim-row"><span class="k">Name</span><input type="text" id="sim-name" value="${escapeHtml(s.name)}" style="width:190px"></div>
      <div class="sim-row"><span class="k">Horizon</span>
        <select id="sim-horizon">
          <option value="" ${!s.horizonYears ? 'selected' : ''}>Until age ${S.profile.planToAge}</option>
          ${[5, 10, 15, 20, 25, 30, 40].map(y => `<option value="${y}" ${s.horizonYears === y ? 'selected' : ''}>${y} years</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="card">
      <div class="flex items-center justify-between mb-1">
        <div class="sim-section-title" style="margin:0">Economy</div>
        <span class="details-toggle" id="sim-econ-toggle">adjust ▾</span>
      </div>
      <select id="sim-preset" class="w-full">
        ${presets.map(p => `<option value="${p.id}" ${p.id === s.economy.preset ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
        <option value="custom" ${!preset ? 'selected' : ''}>Custom</option>
      </select>
      <div class="help">${preset ? escapeHtml(preset.description) : 'Custom assumptions.'}</div>
      <div id="sim-econ-fields" style="display:none;margin-top:8px">
        ${[['expectedReturn', 'Return / yr'], ['volatility', 'Volatility'], ['inflation', 'Inflation'], ['wageGrowth', 'Wage growth'], ['cashYield', 'Cash yield'], ['debtRate', 'Debt APR'], ['propertyAppreciation', 'Property growth']].map(([k, label]) => `
          <div class="sim-row"><span class="k">${label}</span><div class="flex items-center gap-1"><input type="number" step="0.1" data-econ="${k}" value="${pct(s.economy[k])}"><span class="text-muted text-sm">%</span></div></div>
        `).join('')}
        <div class="sim-row"><span class="k">Market shocks</span><button class="btn btn-sm btn-secondary" id="sim-add-shock">+ Add</button></div>
        <div id="sim-shocks">
          ${(s.economy.shocks || []).map((sh, i) => `
            <div class="event-item"><span class="icon">📉</span><div class="body">
              <div class="title">${escapeHtml(sh.label)} ${Math.round(sh.drop * 100)}%</div>
              <div class="meta">${this.simMonthLabel(sh.startMonth)} · ${sh.recoveryMonths ? `recovers over ${formatMonths(sh.recoveryMonths)}` : 'permanent'}</div>
            </div><div class="actions"><button class="btn btn-sm btn-danger" data-del-shock="${i}">✕</button></div></div>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="flex items-center justify-between mb-1">
        <div class="sim-section-title" style="margin:0">Life events</div>
        <button class="btn btn-sm btn-primary" id="sim-add-event">+ Add event</button>
      </div>
      <div id="sim-events">
        ${s.events.length ? s.events.map((e, i) => this.simEventCard(e, i)).join('') : '<div class="text-muted text-sm" style="padding:8px 0">No events yet — this is your “keep doing what you’re doing” path. Add a job loss, a house, a child…</div>'}
      </div>
    </div>

    <div class="card">
      <div class="flex items-center justify-between mb-1">
        <div class="sim-section-title" style="margin:0">Starting point</div>
        <span class="chip">${baseline ? `last ${baseline.lookbackMonths} mo` : ''}</span>
      </div>
      <div class="help" style="margin-bottom:6px">Derived from your accounts and recent transactions. Type a value to assume something different.</div>
      ${ovField('monthlyIncome', 'Income / mo', 'Average take-home income')}
      ${ovField('monthlyExpenses', 'Spending / mo', 'Average spending excluding transfers and investing')}
      ${ovField('monthlyContribution', 'Investing / mo', 'Average buy trades per month')}
      ${ovField('liquid', 'Cash', 'Checking + savings + cash')}
      ${ovField('invested', 'Invested', 'Holdings + investment accounts')}
      ${ovField('debt', 'Debt', 'Credit balances owed')}
      <div class="sim-row"><span class="k">Cash buffer</span><div class="flex items-center gap-1"><input type="number" step="1" min="0" id="sim-ef" value="${s.policy.emergencyFundMonths}"><span class="text-muted text-sm">months</span></div></div>
      <div class="sim-row"><span class="k">Invest surplus above buffer</span><input type="checkbox" id="sim-sweep" ${s.policy.investSurplus ? 'checked' : ''} style="width:auto"></div>
    </div>

    <div class="card">
      <div class="flex items-center justify-between mb-1">
        <div class="sim-section-title" style="margin:0">Your profile</div>
        <button class="btn btn-sm btn-secondary" id="sim-edit-profile">✏️ Edit</button>
      </div>
      <div class="sim-row"><span class="k">Age</span><span>${S.profile.age} <span class="text-muted text-xs">(born ${formatDate(S.profile.birthDate)})</span></span></div>
      <div class="sim-row"><span class="k">Retire at</span><span>${S.profile.retirementAge}</span></div>
      <div class="sim-row"><span class="k">Safe withdrawal rate</span><span>${formatPercent(S.profile.safeWithdrawalRate, 1)}</span></div>
      <div class="sim-row"><span class="k">Plan to age</span><span>${S.profile.planToAge}</span></div>
      ${S.profile.isDefault ? '<div class="help" style="color:var(--orange)">Using default profile — set your birth date for accurate ages.</div>' : ''}
    </div>
  `;

  // Wire up
  document.getElementById('sim-name').addEventListener('input', e => { s.name = e.target.value; this.simMarkDirty(); });
  document.getElementById('sim-horizon').addEventListener('change', e => { s.horizonYears = e.target.value ? Number(e.target.value) : undefined; this.simMarkDirty(); });
  document.getElementById('sim-preset').addEventListener('change', e => {
    const id = e.target.value;
    if (id !== 'custom') {
      const p = presets.find(x => x.id === id);
      s.economy = { ...p.assumptions, preset: p.id, shocks: JSON.parse(JSON.stringify(p.assumptions.shocks || [])) };
    } else {
      s.economy = { ...s.economy, preset: undefined };
    }
    this.simMarkDirty();
    this.simRenderSide();
  });
  document.getElementById('sim-econ-toggle').addEventListener('click', e => {
    const f = document.getElementById('sim-econ-fields');
    const open = f.style.display === 'none';
    f.style.display = open ? '' : 'none';
    e.target.textContent = open ? 'adjust ▴' : 'adjust ▾';
  });
  $$('[data-econ]').forEach(inp => inp.addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    s.economy[e.target.dataset.econ] = v / 100;
    s.economy.preset = undefined;
    document.getElementById('sim-preset').value = 'custom';
    this.simMarkDirty();
  }));
  document.getElementById('sim-add-shock').addEventListener('click', () => this.simShowShockModal());
  $$('[data-del-shock]').forEach(b => b.addEventListener('click', () => {
    s.economy.shocks.splice(Number(b.dataset.delShock), 1);
    s.economy.preset = undefined;
    this.simMarkDirty();
    this.simRenderSide();
    document.getElementById('sim-econ-fields').style.display = '';
  }));
  document.getElementById('sim-add-event').addEventListener('click', () => this.simShowEventModal());
  $$('[data-edit-event]').forEach(b => b.addEventListener('click', () => this.simShowEventModal(Number(b.dataset.editEvent))));
  $$('[data-del-event]').forEach(b => b.addEventListener('click', () => {
    s.events.splice(Number(b.dataset.delEvent), 1);
    this.simMarkDirty();
    this.simRenderSide();
  }));
  $$('[data-override]').forEach(inp => inp.addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    s.overrides = s.overrides || {};
    if (Number.isFinite(v)) s.overrides[e.target.dataset.override] = v; else delete s.overrides[e.target.dataset.override];
    this.simMarkDirty();
  }));
  document.getElementById('sim-ef').addEventListener('change', e => { s.policy.emergencyFundMonths = Math.max(0, parseFloat(e.target.value) || 0); this.simMarkDirty(); });
  document.getElementById('sim-sweep').addEventListener('change', e => { s.policy.investSurplus = e.target.checked; this.simMarkDirty(); });
  document.getElementById('sim-edit-profile').addEventListener('click', () => this.simShowProfileModal());
};

App.simMonthLabel = function(startMonth) {
  const asOf = (this.sim.run && this.sim.run.asOf) || App.today;
  const [y, m] = asOf.slice(0, 7).split('-').map(Number);
  const total = y * 12 + (m - 1) + (startMonth || 0);
  const period = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  return startMonth === 0 ? 'now' : `${formatPeriod(period)} (in ${formatMonths(startMonth)})`;
};

App.simEventCard = function(e, i) {
  const tpl = this.sim.catalog.eventTemplates.find(t => t.id === e.template) || this.sim.catalog.eventTemplates.find(t => t.kind === e.kind);
  const icon = tpl ? tpl.icon : '•';
  const parts = [];
  if (e.kind === 'income') {
    if (e.percent !== undefined && e.percent !== null) parts.push(`${e.percent > 0 ? '+' : ''}${Math.round(e.percent * 100)}% income`);
    if (e.amount) parts.push(`${e.amount > 0 ? '+' : ''}${formatCurrency(e.amount)}/mo`);
  } else if (e.kind === 'expense') parts.push(`${e.amount > 0 ? '+' : ''}${formatCurrency(e.amount)}/mo spending`);
  else if (e.kind === 'one_off') parts.push(`${e.amount > 0 ? '+' : '−'}${formatCurrency(Math.abs(e.amount))} once`);
  else if (e.kind === 'property') parts.push(`${formatCurrency(e.price)} · ${formatCurrency(e.downPayment)} down · ${formatPercent(e.mortgageRate, 2)} / ${e.mortgageYears} yrs`);
  else if (e.kind === 'debt_payoff') parts.push(`pay ${formatCurrency(e.amount)} of debt`);
  else if (e.kind === 'retirement') parts.push('earned income stops');
  else if (e.kind === 'contribution') {
    if (e.percent !== undefined && e.percent !== null) parts.push(`${e.percent > 0 ? '+' : ''}${Math.round(e.percent * 100)}% investing`);
    if (e.amount) parts.push(`${e.amount > 0 ? '+' : ''}${formatCurrency(e.amount)}/mo investing`);
  }
  const when = this.simMonthLabel(e.startMonth) + (e.durationMonths ? ` · for ${formatMonths(e.durationMonths)}` : (['income', 'expense', 'contribution'].includes(e.kind) ? ' · ongoing' : ''));
  return `
    <div class="event-item">
      <span class="icon">${icon}</span>
      <div class="body">
        <div class="title">${escapeHtml(e.label)}</div>
        <div class="meta">${escapeHtml(parts.join(' · '))}</div>
        <div class="meta">${escapeHtml(when)}</div>
      </div>
      <div class="actions">
        <button class="btn btn-sm btn-secondary" data-edit-event="${i}">✏️</button>
        <button class="btn btn-sm btn-danger" data-del-event="${i}">✕</button>
      </div>
    </div>`;
};

// ── Modals ──────────────────────────────────────────────────────────────────

App.simShowEventModal = function(editIndex) {
  const S = this.sim;
  const s = S.scenario;
  const templates = S.catalog.eventTemplates;
  const existing = editIndex !== undefined ? s.events[editIndex] : null;
  let tplId = existing ? (existing.template || (templates.find(t => t.kind === existing.kind) || {}).id) : templates[0].id;

  const fieldsHtml = (tpl, values) => tpl.fields.map(f => {
    const raw = values[f.key];
    const isPct = f.type === 'percent' || f.type === 'rate';
    const val = raw === undefined || raw === null ? '' : isPct ? Math.round(raw * 10000) / 100 : raw;
    const step = f.type === 'money' ? '100' : f.type === 'rate' ? '0.05' : f.type === 'percent' ? '1' : '1';
    const suffix = isPct ? '%' : f.type === 'months' ? 'months' : f.type === 'years' ? 'years' : '';
    const hint = f.key === 'startMonth' ? `<div class="help" id="ev-start-hint"></div>` : '';
    return `
      <div class="form-group">
        <label>${escapeHtml(f.label)}</label>
        <div class="flex items-center gap-1"><input type="number" step="${step}" data-field="${f.key}" data-type="${f.type}" value="${val}" ${f.key === 'startMonth' ? 'min="0"' : ''} ${f.key === 'startMonth' || f.key === 'price' ? 'required' : ''}>${suffix ? `<span class="text-muted text-sm">${suffix}</span>` : ''}</div>
        ${hint}
      </div>`;
  }).join('');

  const formHtml = `
    <div class="form-group">
      <label>Event type</label>
      <select id="ev-template" ${existing ? 'disabled' : ''}>
        ${templates.map(t => `<option value="${t.id}" ${t.id === tplId ? 'selected' : ''}>${t.icon} ${escapeHtml(t.label)}</option>`).join('')}
      </select>
      <div class="help" id="ev-desc"></div>
    </div>
    <div class="form-group">
      <label>Label</label>
      <input type="text" id="ev-label" value="${existing ? escapeHtml(existing.label) : ''}" placeholder="e.g. Move to Lisbon">
    </div>
    <div id="ev-fields"></div>
  `;

  const renderFields = () => {
    const tpl = templates.find(t => t.id === tplId);
    const values = existing && existing.template === tpl.id ? existing : { startMonth: existing ? existing.startMonth : 0, ...tpl.defaults };
    document.getElementById('ev-desc').textContent = tpl.description;
    document.getElementById('ev-fields').innerHTML = fieldsHtml(tpl, values);
    const lbl = document.getElementById('ev-label');
    if (!existing && (!lbl.value || lbl.dataset.auto === '1')) { lbl.value = tpl.label; lbl.dataset.auto = '1'; }
    const start = document.querySelector('[data-field="startMonth"]');
    const hint = document.getElementById('ev-start-hint');
    const updateHint = () => { if (hint) hint.textContent = this.simMonthLabel(Number(start.value) || 0); };
    start.addEventListener('input', updateHint);
    updateHint();
  };

  this.showModal(existing ? 'Edit event' : 'Add life event', formHtml, async () => {
    const tpl = templates.find(t => t.id === tplId);
    const ev = { id: existing ? existing.id : `ev-${Date.now()}`, kind: tpl.kind, template: tpl.id, label: document.getElementById('ev-label').value.trim() || tpl.label, startMonth: 0 };
    for (const k of Object.keys(tpl.defaults)) ev[k] = tpl.defaults[k];
    $$('#ev-fields [data-field]').forEach(inp => {
      const key = inp.dataset.field;
      const raw = inp.value === '' ? undefined : parseFloat(inp.value);
      if (raw === undefined || !Number.isFinite(raw)) {
        if (key === 'durationMonths') ev.durationMonths = undefined;
        return;
      }
      ev[key] = inp.dataset.type === 'percent' || inp.dataset.type === 'rate' ? raw / 100 : raw;
    });
    if (ev.kind === 'property' && ev.downPayment > ev.price) throw new Error('Down payment cannot exceed the price');
    if (existing) s.events[editIndex] = ev; else s.events.push(ev);
    s.events.sort((a, b) => a.startMonth - b.startMonth);
    this.simMarkDirty();
    this.simRenderSide();
  });

  document.getElementById('ev-template').addEventListener('change', e => { tplId = e.target.value; renderFields(); });
  document.getElementById('ev-label').addEventListener('input', e => { e.target.dataset.auto = '0'; });
  renderFields();
};

App.simShowShockModal = function() {
  const s = this.sim.scenario;
  const formHtml = `
    <div class="form-group"><label>Label</label><input type="text" id="sh-label" value="Market crash"></div>
    <div class="form-row">
      <div class="form-group"><label>Starts in (months)</label><input type="number" id="sh-start" value="12" min="0"></div>
      <div class="form-group"><label>Drop (%)</label><input type="number" id="sh-drop" value="30" min="1" max="99"></div>
    </div>
    <div class="form-group"><label>Recovery (months, 0 = permanent loss)</label><input type="number" id="sh-rec" value="36" min="0"></div>
    <div class="help">The market falls by the drop, then climbs back to its pre-crash level over the recovery period.</div>
  `;
  this.showModal('Add market shock', formHtml, async () => {
    s.economy.shocks = s.economy.shocks || [];
    s.economy.shocks.push({
      id: `shock-${Date.now()}`,
      label: document.getElementById('sh-label').value || 'Market shock',
      startMonth: Math.max(0, parseInt(document.getElementById('sh-start').value) || 0),
      drop: -Math.min(0.99, Math.max(0.01, (parseFloat(document.getElementById('sh-drop').value) || 30) / 100)),
      recoveryMonths: Math.max(0, parseInt(document.getElementById('sh-rec').value) || 0),
    });
    s.economy.preset = undefined;
    this.simMarkDirty();
    this.simRenderSide();
    document.getElementById('sim-econ-fields').style.display = '';
  });
};

App.simShowProfileModal = function() {
  const p = this.sim.profile;
  const formHtml = `
    <div class="form-row">
      <div class="form-group"><label>Birth date</label><input type="date" id="pf-birth" value="${p.birthDate}" required></div>
      <div class="form-group"><label>Retirement age</label><input type="number" id="pf-retire" value="${p.retirementAge}" min="18" max="100"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Safe withdrawal rate (%)</label><input type="number" step="0.1" id="pf-swr" value="${Math.round(p.safeWithdrawalRate * 1000) / 10}"></div>
      <div class="form-group"><label>Plan to age</label><input type="number" id="pf-plan" value="${p.planToAge}" min="40" max="110"></div>
    </div>
    <div class="help">The FI number is annual spending ÷ safe withdrawal rate. 4% is the classic rule of thumb; 3–3.5% is more conservative.</div>
  `;
  this.showModal('Your profile', formHtml, async () => {
    const updated = await API.updateProfile({
      birthDate: document.getElementById('pf-birth').value,
      retirementAge: parseInt(document.getElementById('pf-retire').value),
      safeWithdrawalRate: (parseFloat(document.getElementById('pf-swr').value) || 4) / 100,
      planToAge: parseInt(document.getElementById('pf-plan').value),
    });
    this.sim.profile = updated;
    this.sim.baselineRun = null;
    showToast('Profile updated');
    this.simRenderSide();
    API.simulate({ includeMonths: false }).then(r => { this.sim.baselineRun = r; this.simRenderResults(); }).catch(() => {});
    this.simScheduleRun(0);
  });
};

// ── Right column: results ───────────────────────────────────────────────────

App.simRenderResults = function() {
  const S = this.sim;
  const run = S.run;
  if (!run || !document.getElementById('sim-stats')) return;
  const r = run.result;
  const sum = r.summary;
  const fire = sum.fire;
  const mc = run.montecarlo;
  const real = S.showReal;
  const money = v => (v === null || v === undefined ? '—' : formatCurrency(v));
  const nw = y => (real ? y.realNetWorth : y.netWorth);
  const infl = run.scenario.economy.inflation || 0;
  /** Factor converting a nominal amount at month t into today's money (1 when showing nominal). */
  const realFactor = y => (real ? 1 / Math.pow(1 + infl, y.t / 12) : 1);
  const base = S.baselineRun && S.baselineRun.result;

  // Stats
  const retireYear = r.yearly.find(y => y.t >= fire.retirementMonth) || null;
  const retireNw = sum.netWorthAtRetirement === null ? null : real && retireYear ? retireYear.realNetWorth : sum.netWorthAtRetirement;
  const endNw = real ? sum.endRealNetWorth : sum.endNetWorth;
  const deltaChip = (mine, theirs) => {
    if (!base || theirs === null || theirs === undefined || mine === null || mine === undefined) return '';
    const d = mine - theirs;
    if (Math.abs(d) < 1) return '<span class="chip">= baseline</span>';
    return `<span class="chip ${d >= 0 ? 'ok' : 'bad'}">${d >= 0 ? '+' : '−'}${formatCompact(Math.abs(d))} vs baseline</span>`;
  };
  const fiDelta = (() => {
    if (!base || base.summary.fire.fiMonth === null || fire.fiMonth === null) return '';
    const d = fire.fiMonth - base.summary.fire.fiMonth;
    if (d === 0) return '<span class="chip">= baseline</span>';
    return `<span class="chip ${d < 0 ? 'ok' : 'bad'}">${d < 0 ? formatMonths(-d) + ' earlier' : formatMonths(d) + ' later'}</span>`;
  })();
  const lastAge = r.yearly.length ? Math.floor(r.yearly[r.yearly.length - 1].age) : '';
  document.getElementById('sim-stats').innerHTML = `
    <div class="stat-card">
      <div class="label">Net worth at ${fire.retirementAge >= 0 ? `retirement (${Math.round(fire.retirementAge)})` : 'retirement'}</div>
      <div class="value" style="color:var(--accent)">${money(retireNw)}</div>
      <div class="sub">${sum.netWorthAtRetirement === null ? 'Beyond horizon' : real ? "In today's money" : 'Nominal'} ${deltaChip(retireNw, base ? (real && base.yearly.find(y => y.t >= base.summary.fire.retirementMonth) ? base.yearly.find(y => y.t >= base.summary.fire.retirementMonth).realNetWorth : base.summary.netWorthAtRetirement) : null)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Financial independence</div>
      <div class="value" style="color:${fire.fiMonth === null ? 'var(--orange)' : 'var(--green)'}">${fire.fiMonth === null ? 'Not reached' : `Age ${Math.floor(fire.fiAge)}`}</div>
      <div class="sub">${fire.fiMonth === null ? `Not within the horizon` : `${formatPeriod(fire.fiDate)} · in ${formatMonths(fire.fiMonth)}`} ${fiDelta}</div>
    </div>
    <div class="stat-card">
      <div class="label">FI progress</div>
      <div class="value" style="color:var(--purple)">${formatPercent(fire.progress)}</div>
      <div class="sub">${money(fire.investableToday)} of ${formatCompact(fire.fiNumber)} needed</div>
    </div>
    <div class="stat-card">
      <div class="label">Runway</div>
      <div class="value" style="color:${(sum.runway.cashMonths || 0) >= 6 ? 'var(--green)' : 'var(--orange)'}">${formatMonths(sum.runway.cashMonths)}</div>
      <div class="sub">cash only · ${sum.runway.simulatedMonths === null ? 'never broke' : formatMonths(sum.runway.simulatedMonths)} if income stopped today</div>
    </div>
    <div class="stat-card">
      <div class="label">Chance of success</div>
      <div class="value" style="color:${mc && mc.successProbability >= 0.9 ? 'var(--green)' : mc && mc.successProbability >= 0.7 ? 'var(--orange)' : 'var(--red)'}">${mc ? formatPercent(mc.successProbability) : '—'}</div>
      <div class="sub">${mc ? `never running out of money · ${formatPercent(mc.fiByRetirementProbability)} reach FI by ${Math.round(fire.retirementAge)}` : 'Monte Carlo off'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Net worth at ${lastAge}</div>
      <div class="value" style="color:${endNw >= 0 ? 'var(--accent)' : 'var(--red)'}">${money(endNw)}</div>
      <div class="sub">${sum.depletedMonth !== null ? `<span style="color:var(--red)">⚠ money runs out ${formatPeriod(this.simPeriodOf(sum.depletedMonth))}</span>` : real ? "In today's money" : 'Nominal'} ${deltaChip(endNw, base ? (real ? base.summary.endRealNetWorth : base.summary.endNetWorth) : null)}</div>
    </div>
  `;

  // Chart
  const labels = r.yearly.map(y => String(y.year));
  const datasets = [];
  if (mc && S.showBand && mc.netWorthBands.length === r.yearly.length) {
    datasets.push({
      label: 'band', data: [], color: SIM_COLORS.scenario,
      band: { lower: mc.netWorthBands.map((b, i) => b.p10 * realFactor(r.yearly[i])), upper: mc.netWorthBands.map((b, i) => b.p90 * realFactor(r.yearly[i])), color: SIM_COLORS.band },
    });
  }
  if (base && base.yearly.length) {
    const baseByYear = new Map(base.yearly.map(y => [y.year, y]));
    datasets.push({ label: 'Baseline', data: r.yearly.map(y => (baseByYear.has(y.year) ? nw(baseByYear.get(y.year)) : NaN)), color: SIM_COLORS.baseline, dash: [5, 4], width: 1.5 });
  }
  datasets.push({ label: run.scenario.name, data: r.yearly.map(nw), color: SIM_COLORS.scenario, width: 2.5 });
  const markers = [];
  const idxAt = t => r.yearly.findIndex(y => y.t >= t);
  if (fire.retirementMonth < sum.horizonMonths) markers.push({ index: idxAt(fire.retirementMonth), label: `Retire ${Math.round(fire.retirementAge)}`, color: SIM_COLORS.retire });
  if (fire.fiMonth !== null) markers.push({ index: idxAt(fire.fiMonth), label: 'FI', color: SIM_COLORS.fi });
  Chart.projection(document.getElementById('sim-chart'), labels, datasets, { markers, heightRatio: 0.42 });
  document.getElementById('sim-legend').innerHTML = `
    <span><span class="swatch" style="background:${SIM_COLORS.scenario}"></span>${escapeHtml(run.scenario.name)}</span>
    ${base ? `<span><span class="swatch dashed" style="color:${SIM_COLORS.baseline}"></span>Baseline (no events, moderate economy)</span>` : ''}
    ${mc && S.showBand ? `<span><span class="swatch band" style="background:${SIM_COLORS.scenario}"></span>Monte Carlo 10th–90th percentile (${mc.trials} runs)</span>` : ''}
    <span><span class="swatch dashed" style="color:${SIM_COLORS.retire}"></span>Retirement</span>
    ${fire.fiMonth !== null ? `<span><span class="swatch dashed" style="color:${SIM_COLORS.fi}"></span>FI reached</span>` : ''}
  `;

  // Detail cards: FIRE + Monte Carlo
  const coastTxt = fire.coastFiMonth === null ? 'not reached' : fire.coastFiMonth === 0 ? 'already there 🎉' : formatPeriod(this.simPeriodOf(fire.coastFiMonth));
  document.getElementById('sim-detail-cards').innerHTML = `
    <div class="card">
      <div class="card-header"><span class="card-title">🔥 FIRE milestones</span><span class="text-xs text-muted">SWR ${formatPercent(fire.safeWithdrawalRate, 1)}</span></div>
      <div class="progress-bar mb-1"><div class="progress-fill" style="width:${Math.min(100, fire.progress * 100)}%"></div></div>
      <div class="text-xs text-muted mb-2">${formatPercent(fire.progress)} of your FI number</div>
      <div class="sim-row"><span class="k">FI number <span class="text-xs">(${formatCompact(fire.annualExpensesToday)}/yr ÷ SWR)</span></span><span>${money(fire.fiNumber)}</span></div>
      <div class="sim-row"><span class="k">Full FI</span><span>${fire.fiMonth === null ? '<span class="text-muted">not within horizon</span>' : `${formatPeriod(fire.fiDate)} · age ${Math.floor(fire.fiAge)}`}</span></div>
      <div class="sim-row"><span class="k">Lean FI <span class="text-xs">(70% of spending)</span></span><span>${fire.leanFiMonth === null ? '<span class="text-muted">not within horizon</span>' : `${formatPeriod(this.simPeriodOf(fire.leanFiMonth))} · ${money(fire.leanFiNumber)}`}</span></div>
      <div class="sim-row"><span class="k">Coast FI <span class="text-xs">(stop investing, still retire at ${Math.round(fire.retirementAge)})</span></span><span>${coastTxt} · ${money(fire.coastFiNumber)}</span></div>
      <div class="sim-row"><span class="k">FI before planned retirement?</span><span class="${fire.fiByRetirement ? '' : 'text-muted'}">${fire.fiByRetirement ? '✅ Yes' : '❌ No'}</span></div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">🎲 Uncertainty</span><span class="text-xs text-muted">${mc ? `${mc.trials} Monte Carlo runs · σ ${formatPercent(run.scenario.economy.volatility)}` : ''}</span></div>
      ${mc ? `
        <div class="sim-row"><span class="k">Never run out of money</span><span>${formatPercent(mc.successProbability)}</span></div>
        <div class="sim-row"><span class="k">Reach FI by ${Math.round(fire.retirementAge)}</span><span>${formatPercent(mc.fiByRetirementProbability)}</span></div>
        <div class="sim-row"><span class="k">Net worth ever negative</span><span>${formatPercent(mc.negativeNetWorthProbability)}</span></div>
        <div class="sim-row"><span class="k">FI date (10th / median / 90th)</span><span>${mc.fiMonth ? `${formatPeriod(this.simPeriodOf(mc.fiMonth.p10))} / ${formatPeriod(this.simPeriodOf(mc.fiMonth.p50))} / ${formatPeriod(this.simPeriodOf(mc.fiMonth.p90))}` : '—'}</span></div>
        <div class="sim-row"><span class="k">Net worth at ${lastAge} (10th / median / 90th)</span><span>${real ? `${formatCompact(mc.endRealNetWorth.p10)} / ${formatCompact(mc.endRealNetWorth.p50)} / ${formatCompact(mc.endRealNetWorth.p90)}` : `${formatCompact(mc.endNetWorth.p10)} / ${formatCompact(mc.endNetWorth.p50)} / ${formatCompact(mc.endNetWorth.p90)}`}</span></div>
        <div class="help">Returns are drawn at random each month around the expected return; the shaded band on the chart shows the middle 80% of outcomes.</div>
      ` : '<div class="text-muted text-sm">Monte Carlo not run.</div>'}
    </div>
  `;

  // Milestones table (every 5 years + retirement + last)
  const rows = r.yearly.filter((y, i) => i % 5 === 4 || i === r.yearly.length - 1 || (retireYear && y.t === retireYear.t) || i === 0);
  document.getElementById('sim-milestones').innerHTML = `
    <div class="card-header"><span class="card-title">🗓️ Milestones</span><span class="text-xs text-muted">${real ? "today's money" : 'nominal'}</span></div>
    <div class="table-container">
      <table class="milestone-table">
        <thead><tr><th>Year</th><th>Age</th><th style="text-align:right">Net worth</th><th style="text-align:right">Invested</th><th style="text-align:right">Cash</th><th style="text-align:right">Property</th><th style="text-align:right">Debt</th><th style="text-align:right">Income / yr</th><th style="text-align:right">Spending / yr</th></tr></thead>
        <tbody>
          ${rows.map(y => {
            const f = realFactor(y);
            const isRet = retireYear && y.t === retireYear.t;
            return `<tr style="${isRet ? 'background:rgba(255,171,64,0.08)' : ''}">
              <td>${y.year}${isRet ? ' <span class="chip warn">retire</span>' : ''}</td><td>${Math.floor(y.age)}</td>
              <td style="text-align:right;color:${nw(y) < 0 ? 'var(--red)' : 'inherit'}">${formatCurrency(nw(y))}</td>
              <td style="text-align:right">${formatCurrency(y.invested * f)}</td>
              <td style="text-align:right">${formatCurrency(y.liquid * f)}</td>
              <td style="text-align:right">${y.property ? formatCurrency((y.property - y.mortgage) * f) : '—'}</td>
              <td style="text-align:right;color:${y.debt > 0 ? 'var(--red)' : 'inherit'}">${y.debt ? formatCurrency(y.debt * f) : '—'}</td>
              <td style="text-align:right">${formatCurrency(y.income * f)}</td>
              <td style="text-align:right">${formatCurrency(y.expenses * f)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Goals
  const goals = run.goals || [];
  const statusChip = g => ({ funded: '<span class="chip ok">funded</span>', on_track: '<span class="chip ok">on track</span>', at_risk: '<span class="chip warn">at risk</span>', unreachable: '<span class="chip bad">no surplus</span>' })[g.status] || '';
  document.getElementById('sim-goals').innerHTML = `
    <div class="card-header"><span class="card-title">🎯 Goals under this scenario</span><a href="#goals" class="text-sm">Manage →</a></div>
    ${goals.length ? goals.map(g => `
      <div style="margin-bottom:12px">
        <div class="flex justify-between text-sm mb-1"><span>${escapeHtml(g.name)} ${statusChip(g)}</span><span>${formatCurrency(g.currentAmount)} / ${formatCurrency(g.targetAmount)}</span></div>
        <div class="progress-bar"><div class="progress-fill ${g.status === 'at_risk' ? 'warning' : g.status === 'unreachable' ? 'danger' : ''}" style="width:${Math.min(100, g.targetAmount ? (g.currentAmount / g.targetAmount) * 100 : 0)}%"></div></div>
        <div class="text-xs text-muted mt-1">
          ${g.status === 'funded' ? 'Fully funded.' : g.fundedInMonths === null ? 'No monthly surplus left for this goal after higher-priority ones.' : `Funded ${formatPeriod(g.fundedBy)} at ${formatCurrency(g.allocatedMonthly)}/mo${g.deadline ? ` · deadline ${formatDate(g.deadline)}${g.requiredMonthly !== null ? ` needs ${formatCurrency(g.requiredMonthly)}/mo` : ''}` : ''}`}
        </div>
      </div>
    `).join('') : '<div class="text-muted text-sm">No goals yet. <a href="#goals">Create one →</a></div>'}
  `;
};

App.simPeriodOf = function(month) {
  const asOf = (this.sim.run && this.sim.run.asOf) || App.today;
  const [y, m] = asOf.slice(0, 7).split('-').map(Number);
  const total = y * 12 + (m - 1) + month;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

// ── Opportunity cost calculator ─────────────────────────────────────────────

App.simRenderOpportunity = function() {
  const el = document.getElementById('sim-opportunity');
  if (!el) return;
  el.innerHTML = `
    <div class="card-header"><span class="card-title">💸 What does it really cost?</span></div>
    <div class="help" style="margin-bottom:10px">The future value of a spending decision if the money were invested instead.</div>
    <div class="sim-inline">
      <div class="form-group" style="margin-bottom:8px"><label>One-off spend</label><input type="number" id="oc-oneoff" placeholder="e.g. 30000" step="100"></div>
      <div class="form-group" style="margin-bottom:8px"><label>Monthly spend</label><input type="number" id="oc-monthly" placeholder="e.g. 150" step="10" value="150"></div>
    </div>
    <div class="sim-inline">
      <div class="form-group" style="margin-bottom:8px"><label>Years invested</label><input type="number" id="oc-years" value="25" min="1" max="60"></div>
      <div class="form-group" style="margin-bottom:8px"><label>Return / yr (%)</label><input type="number" id="oc-return" value="${Math.round((this.sim.scenario.economy.expectedReturn || 0.07) * 1000) / 10}" step="0.5"></div>
    </div>
    <div id="oc-result" class="mt-1"></div>
    <canvas id="oc-chart" style="margin-top:8px"></canvas>
  `;
  const run = async () => {
    const oneOff = parseFloat(document.getElementById('oc-oneoff').value) || 0;
    const monthly = parseFloat(document.getElementById('oc-monthly').value) || 0;
    const years = parseInt(document.getElementById('oc-years').value) || 0;
    const annualReturn = (parseFloat(document.getElementById('oc-return').value) || 0) / 100;
    const out = document.getElementById('oc-result');
    if ((oneOff <= 0 && monthly <= 0) || years <= 0) { out.innerHTML = '<div class="text-muted text-sm">Enter an amount and a number of years.</div>'; return; }
    try {
      const r = await API.opportunityCost({ oneOff, monthly, years, annualReturn, inflation: this.sim.scenario.economy.inflation });
      out.innerHTML = `
        <div class="sim-row"><span class="k">You'd spend</span><span>${formatCurrency(r.totalSpent)}</span></div>
        <div class="sim-row"><span class="k">Invested instead, at age ${r.ageAtEnd}</span><span style="color:var(--green)">${formatCurrency(r.futureValue)} <span class="chip ok">${r.multiple}×</span></span></div>
        <div class="sim-row"><span class="k">In today's money</span><span>${formatCurrency(r.realFutureValue)}</span></div>
      `;
      const every = Math.max(1, Math.ceil(r.series.length / 10));
      Chart.projection(document.getElementById('oc-chart'), r.series.map(p => `${p.year}y`), [
        { label: 'Spent', data: r.series.map(p => p.spent), color: '#ff5252', dash: [4, 3], width: 1.5 },
        { label: 'Invested', data: r.series.map(p => p.value), color: '#00e676', width: 2 },
      ], { heightRatio: 0.35, xLabelEvery: every });
    } catch (err) { out.innerHTML = `<div class="text-muted text-sm">${escapeHtml(err.message)}</div>`; }
  };
  let t;
  ['oc-oneoff', 'oc-monthly', 'oc-years', 'oc-return'].forEach(id => document.getElementById(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350); }));
  run();
};

// ── Compare ─────────────────────────────────────────────────────────────────

App.simShowCompare = async function() {
  const S = this.sim;
  const choices = [{ id: '__current__', name: `${S.scenario.name}${S.savedId ? '' : ' (unsaved)'}` }, { id: '__baseline__', name: 'Baseline (no events)' }, ...S.saved.filter(s => s.id !== S.savedId).map(s => ({ id: s.id, name: s.name }))];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal wide">
      <h2>⚖️ Compare scenarios</h2>
      <div class="flex gap-2" style="flex-wrap:wrap;margin-bottom:12px" id="cmp-choices">
        ${choices.map((c, i) => `<label class="text-sm flex items-center gap-1"><input type="checkbox" value="${c.id}" ${i < 2 ? 'checked' : ''} style="width:auto"> ${escapeHtml(c.name)}</label>`).join('')}
        <button class="btn btn-sm btn-primary" id="cmp-run">Compare</button>
      </div>
      <div class="toggle-group" id="cmp-money" style="margin-bottom:8px"><button data-v="nominal" class="${S.showReal ? '' : 'active'}">Nominal</button><button data-v="real" class="${S.showReal ? 'active' : ''}">Today's money</button></div>
      <canvas id="cmp-chart"></canvas>
      <div class="legend" id="cmp-legend"></div>
      <div class="table-container mt-2" id="cmp-table"></div>
      <div class="modal-actions"><button type="button" class="btn btn-secondary" id="cmp-close">Close</button></div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('cmp-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  let last = null;
  let real = S.showReal;
  const render = () => {
    if (!last) return;
    const { results, deltas, scenarios } = last;
    const years = results[0].yearly.map(y => String(y.year));
    const datasets = results.map((r, i) => ({ label: scenarios[i].name, data: r.yearly.map(y => (real ? y.realNetWorth : y.netWorth)), color: SIM_COLORS.compare[i % SIM_COLORS.compare.length], width: i === 0 ? 2.5 : 2 }));
    Chart.projection(document.getElementById('cmp-chart'), years, datasets, { heightRatio: 0.4 });
    document.getElementById('cmp-legend').innerHTML = datasets.map(d => `<span><span class="swatch" style="background:${d.color}"></span>${escapeHtml(d.label)}</span>`).join('');
    const row = (r, i) => {
      const f = r.summary.fire;
      const d = i === 0 ? null : deltas[i - 1];
      const lastAge = r.yearly.length ? Math.floor(r.yearly[r.yearly.length - 1].age) : '';
      return `<tr>
        <td><span class="swatch" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${SIM_COLORS.compare[i % SIM_COLORS.compare.length]};margin-right:6px"></span>${escapeHtml(scenarios[i].name)}</td>
        <td style="text-align:right">${f.fiMonth === null ? '—' : `${formatPeriod(f.fiDate)} (${Math.floor(f.fiAge)})`}${d && d.fiMonthDelta !== null ? ` <span class="chip ${d.fiMonthDelta <= 0 ? 'ok' : 'bad'}">${d.fiMonthDelta <= 0 ? '−' : '+'}${formatMonths(Math.abs(d.fiMonthDelta))}</span>` : ''}</td>
        <td style="text-align:right">${r.summary.netWorthAtRetirement === null ? '—' : formatCurrency(r.summary.netWorthAtRetirement)}${d && d.netWorthAtRetirement !== null ? ` <span class="chip ${d.netWorthAtRetirement >= 0 ? 'ok' : 'bad'}">${d.netWorthAtRetirement >= 0 ? '+' : '−'}${formatCompact(Math.abs(d.netWorthAtRetirement))}</span>` : ''}</td>
        <td style="text-align:right">${formatCurrency(real ? r.summary.endRealNetWorth : r.summary.endNetWorth)}${d ? ` <span class="chip ${(real ? d.endRealNetWorth : d.endNetWorth) >= 0 ? 'ok' : 'bad'}">${(real ? d.endRealNetWorth : d.endNetWorth) >= 0 ? '+' : '−'}${formatCompact(Math.abs(real ? d.endRealNetWorth : d.endNetWorth))}</span>` : ''}</td>
        <td style="text-align:right">${r.summary.depletedMonth === null ? '<span style="color:var(--green)">never</span>' : `<span style="color:var(--red)">${formatPeriod(this.simPeriodOf(r.summary.depletedMonth))}</span>`}</td>
      </tr>`;
    };
    document.getElementById('cmp-table').innerHTML = `
      <table class="milestone-table">
        <thead><tr><th>Scenario</th><th style="text-align:right">FI reached</th><th style="text-align:right">Net worth at retirement</th><th style="text-align:right">Net worth at end</th><th style="text-align:right">Money runs out</th></tr></thead>
        <tbody>${results.map(row).join('')}</tbody>
      </table>`;
  };
  const runCompare = async () => {
    const ids = [...overlay.querySelectorAll('#cmp-choices input:checked')].map(i => i.value);
    if (!ids.length) return;
    const payload = ids.map(id => (id === '__current__' ? this.simScenarioPayload() : id === '__baseline__' ? { name: 'Baseline', economy: { preset: 'moderate' }, events: [] } : { id }));
    try {
      last = await API.compareScenarios(payload);
      render();
    } catch (err) { showToast(err.message, 'error'); }
  };
  document.getElementById('cmp-run').addEventListener('click', runCompare);
  document.getElementById('cmp-money').addEventListener('click', e => {
    if (!e.target.dataset.v) return;
    real = e.target.dataset.v === 'real';
    overlay.querySelectorAll('#cmp-money button').forEach(b => b.classList.toggle('active', b.dataset.v === e.target.dataset.v));
    render();
  });
  runCompare();
};
