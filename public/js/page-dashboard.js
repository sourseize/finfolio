// ── DASHBOARD ──
App.renderDashboard = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading dashboard...</div>';
  try {
    const data = await API.getDashboard();

    container.innerHTML = `
      <div class="page-header"><h1>📊 Dashboard</h1></div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">Net Worth</div>
          <div class="value" style="color:var(--accent)">${formatCurrency(data.netWorth)}</div>
          <div class="sub">${data.totalLiabilities > 0 ? `Assets minus ${formatCurrency(data.totalLiabilities)} owed` : 'Total assets minus liabilities'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Balance</div>
          <div class="value" style="color:var(--green)">${formatCurrency(data.totalBalance)}</div>
          <div class="sub">Cash & asset accounts</div>
        </div>
        <div class="stat-card">
          <div class="label">Monthly Income</div>
          <div class="value" style="color:var(--green)">${formatCurrency(data.monthlyIncome)}</div>
          <div class="sub">This month</div>
        </div>
        <div class="stat-card">
          <div class="label">Monthly Expenses</div>
          <div class="value" style="color:var(--red)">${formatCurrency(data.monthlyExpenses)}</div>
          <div class="sub">This month (excl. transfers & investing)</div>
        </div>
        <div class="stat-card">
          <div class="label">Investment Value</div>
          <div class="value" style="color:var(--purple)">${formatCurrency(data.investmentValue)}</div>
          <div class="sub">Current portfolio value</div>
        </div>
        <div class="stat-card">
          <div class="label">Savings Rate</div>
          <div class="value" style="color:${data.savingsRate >= 20 ? 'var(--green)' : data.savingsRate >= 10 ? 'var(--orange)' : 'var(--red)'}">${data.savingsRate}%</div>
          <div class="sub">${data.savingsRate >= 20 ? 'Great job!' : data.savingsRate >= 10 ? 'Getting there' : 'Try to save more'}${data.monthlyInvested ? ` · ${formatCurrency(data.monthlyInvested)} invested` : ''}</div>
        </div>
      </div>

      <div class="grid grid-2 gap-2 mb-2" id="outlook-row">
        <div class="card outlook-card"><div class="text-muted text-sm">Loading outlook…</div></div>
        <div class="card outlook-card"><div class="text-muted text-sm">Loading outlook…</div></div>
      </div>

      <div class="grid grid-2 gap-2">
        <div class="chart-container">
          <h3>💰 Top Expense Categories</h3>
          <canvas id="doughnut-chart"></canvas>
          <div class="mt-2" id="expense-legend"></div>
        </div>
        <div class="chart-container">
          <h3>📈 Budget Health</h3>
          <div id="budget-health-list"></div>
        </div>
      </div>

      <div class="grid grid-2 gap-2 mt-2">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Recent Transactions</span>
            <a href="#transactions" class="text-sm">View all →</a>
          </div>
          <div id="recent-txns"></div>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">🎯 Goal Progress</span>
            <a href="#goals" class="text-sm">View all →</a>
          </div>
          <div id="goal-progress-list"></div>
        </div>
      </div>
    `;

    // Forward-looking outlook (runway + FIRE) — rendered independently so a failure never blocks the dashboard
    this.renderOutlook(document.getElementById('outlook-row'));

    // Doughnut chart
    const expData = data.topExpenseCategories;
    if (expData.length) {
      Chart.doughnut(
        document.getElementById('doughnut-chart'),
        expData.map(e => e.category),
        expData.map(e => e.amount),
        ['#ff5252','#ffab40','#ffd740','#b388ff','#00d4ff']
      );
      const legend = document.getElementById('expense-legend');
      const colors = ['#ff5252','#ffab40','#ffd740','#b388ff','#00d4ff'];
      legend.innerHTML = expData.map((e, i) => `
        <div class="flex items-center justify-between" style="padding:4px 0;border-bottom:1px solid var(--border)">
          <div class="flex items-center gap-1">
            <span style="width:10px;height:10px;border-radius:50%;background:${colors[i]};display:inline-block"></span>
            <span class="text-sm">${escapeHtml(e.category)}</span>
          </div>
          <span class="text-sm">${formatCurrency(e.amount)} (${e.percentage}%)</span>
        </div>
      `).join('');
    } else {
      document.getElementById('expense-legend').innerHTML = '<div class="text-muted text-sm">No expenses this month</div>';
    }

    // Budget health
    const budgetList = document.getElementById('budget-health-list');
    if (data.budgetHealth.length) {
      budgetList.innerHTML = data.budgetHealth.map(b => {
        const isOver = b.percentUsed > 100;
        const isWarning = b.percentUsed > 80;
        return `
          <div style="margin-bottom:12px">
            <div class="flex justify-between text-sm mb-1">
              <span>${escapeHtml(b.category)}</span>
              <span>${formatCurrency(b.spent)} / ${formatCurrency(b.budgeted)}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill ${isOver ? 'danger' : isWarning ? 'warning' : ''}" style="width:${Math.min(b.percentUsed,100)}%"></div>
            </div>
            <div class="text-xs text-muted mt-1">
              ${isOver ? `<span style="color:var(--red)">🔴 Over budget by ${formatCurrency(Math.abs(b.remaining))}</span>`
                      : `${formatCurrency(b.remaining)} remaining`}
            </div>
          </div>
        `;
      }).join('');
    } else {
      budgetList.innerHTML = '<div class="text-muted text-sm">No budgets set. <a href="#budgets">Create one →</a></div>';
    }

    // Recent transactions
    const txnDiv = document.getElementById('recent-txns');
    if (data.recentTransactions.length) {
      txnDiv.innerHTML = data.recentTransactions.slice(0, 5).map(t => `
        <div class="flex items-center justify-between" style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div>
            <div class="text-sm">${escapeHtml(t.description || t.category)}</div>
            <div class="text-xs text-muted">${formatDate(t.date)} · ${escapeHtml(t.category)}</div>
          </div>
          <span class="badge ${isTransferTxn(t) ? 'badge-budget' : t.type === 'income' ? 'badge-income' : 'badge-expense'}">
            ${t.type === 'income' ? '+' : '-'}${formatCurrency(t.amount)}
          </span>
        </div>
      `).join('');
    } else {
      txnDiv.innerHTML = '<div class="text-muted text-sm">No transactions yet. <a href="#transactions">Add one →</a></div>';
    }

    // Goals
    const goalDiv = document.getElementById('goal-progress-list');
    if (data.goalProgress.length) {
      goalDiv.innerHTML = data.goalProgress.map(g => `
        <div style="margin-bottom:12px">
          <div class="flex justify-between text-sm mb-1">
            <span>${escapeHtml(g.name)}</span>
            <span>${g.percentage}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${Math.min(g.percentage,100)}%"></div>
          </div>
          <div class="text-xs text-muted mt-1">${formatCurrency(g.current)} / ${formatCurrency(g.target)}</div>
        </div>
      `).join('');
    } else {
      goalDiv.innerHTML = '<div class="text-muted text-sm">No goals set. <a href="#goals">Create one →</a></div>';
    }
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

// ── Dashboard outlook cards (from the simulator's baseline scenario) ──
App.renderOutlook = async function(row) {
  if (!row) return;
  try {
    const o = await API.getOutlook();
    if (!o.hasHistory) {
      row.innerHTML = `
        <div class="card outlook-card" style="grid-column:1/-1">
          <div class="card-header"><span class="card-title">🔮 Outlook</span><a href="#simulate" class="text-sm">Open simulator →</a></div>
          <div class="text-muted text-sm">Add a few months of income and expenses and FinFolio will project your runway and financial-independence date here.</div>
        </div>`;
      return;
    }
    const cash = o.runway.cashMonths;
    const runwayColor = cash === null ? 'var(--text-primary)' : cash >= 6 ? 'var(--green)' : cash >= 3 ? 'var(--orange)' : 'var(--red)';
    const fi = o.fire;
    row.innerHTML = `
      <div class="card outlook-card">
        <div class="card-header"><span class="card-title">🛟 Runway</span><a href="#simulate" class="text-sm">Simulate →</a></div>
        <div class="big" style="color:${runwayColor}">${formatMonths(cash)}</div>
        <div class="text-sm text-muted">of spending covered by cash at ${formatCurrency(o.monthlyExpenses)}/mo</div>
        <div class="flex justify-between text-sm mt-2" style="border-top:1px solid var(--border);padding-top:8px">
          <span class="text-muted">Including investments</span><span>${formatMonths(o.runway.totalMonths)}</span>
        </div>
        <div class="flex justify-between text-sm mt-1">
          <span class="text-muted">If income stopped today</span><span>${o.runway.simulatedMonths === null ? 'never runs out' : `lasts ${formatMonths(o.runway.simulatedMonths)}`}</span>
        </div>
      </div>
      <div class="card outlook-card">
        <div class="card-header"><span class="card-title">🔥 Financial independence</span><a href="#simulate" class="text-sm">Simulate →</a></div>
        <div class="big" style="color:${fi.fiDate ? 'var(--green)' : 'var(--orange)'}">${fi.fiDate ? `${formatPeriod(fi.fiDate)} · age ${Math.floor(fi.fiAge)}` : 'Not yet in sight'}</div>
        <div class="text-sm text-muted">${fi.fiDate ? (fi.fiByRetirement ? `before your planned retirement at ${Math.round(fi.retirementAge)}` : `after your planned retirement at ${Math.round(fi.retirementAge)}`) : 'on current habits, within the plan horizon'}</div>
        <div class="progress-bar mt-2"><div class="progress-fill" style="width:${Math.min(100, fi.progress * 100)}%"></div></div>
        <div class="flex justify-between text-xs text-muted mt-1">
          <span>${formatPercent(fi.progress)} of your FI number</span><span>${formatCompact(fi.fiNumber)}</span>
        </div>
      </div>
    `;
  } catch (err) {
    row.innerHTML = `<div class="card outlook-card" style="grid-column:1/-1"><div class="text-muted text-sm">Outlook unavailable: ${escapeHtml(err.message)}</div></div>`;
  }
};

// ── Native dialogs (replace window.confirm / window.prompt) ──
App._openDialog = function(innerHtml) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = innerHtml;
  document.body.appendChild(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  return dlg;
};

/** Ask a yes/no question. Resolves true when confirmed, false when cancelled or dismissed (Esc). */
App.confirmDialog = function(message, opts = {}) {
  return new Promise(resolve => {
    const dlg = this._openDialog(`
      <h2>${escapeHtml(opts.title || 'Are you sure?')}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="dialog-cancel">${escapeHtml(opts.cancelText || 'Cancel')}</button>
        <button type="button" class="btn ${opts.danger === false ? 'btn-primary' : 'btn-danger'}" id="dialog-confirm">${escapeHtml(opts.confirmText || 'Delete')}</button>
      </div>
    `);
    let result = false;
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.querySelector('#dialog-cancel').addEventListener('click', () => dlg.close());
    dlg.querySelector('#dialog-confirm').addEventListener('click', () => { result = true; dlg.close(); });
    const btn = dlg.querySelector('#dialog-confirm');
    if (btn.focus) btn.focus();
  });
};

/** Ask for a single text value. Resolves the string, or null when cancelled. */
App.promptDialog = function(title, opts = {}) {
  return new Promise(resolve => {
    const dlg = this._openDialog(`
      <h2>${escapeHtml(title)}</h2>
      ${opts.message ? `<p>${escapeHtml(opts.message)}</p>` : ''}
      <form id="dialog-form">
        <div class="form-group">
          ${opts.label ? `<label>${escapeHtml(opts.label)}</label>` : ''}
          <input type="text" id="dialog-input" value="${escapeHtml(opts.value || '')}" placeholder="${escapeHtml(opts.placeholder || '')}" required>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="dialog-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="dialog-confirm">${escapeHtml(opts.confirmText || 'Save')}</button>
        </div>
      </form>
    `);
    let result = null;
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.querySelector('#dialog-cancel').addEventListener('click', () => dlg.close());
    dlg.querySelector('#dialog-form').addEventListener('submit', e => {
      e.preventDefault();
      result = dlg.querySelector('#dialog-input').value;
      dlg.close();
    });
    const input = dlg.querySelector('#dialog-input');
    if (input.focus) input.focus();
    if (input.select) input.select();
  });
};

// ── Modal helper ──
App.showModal = function(title, formHtml, onSubmit) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${escapeHtml(title)}</h2>
      <form id="modal-form">
        ${formHtml}
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await onSubmit();
      overlay.remove();
    } catch (err) { showToast(err.message, 'error'); }
  });
  return overlay;
};
