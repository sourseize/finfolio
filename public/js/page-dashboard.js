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
          <div class="sub">Total assets minus liabilities</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Balance</div>
          <div class="value" style="color:var(--green)">${formatCurrency(data.totalBalance)}</div>
          <div class="sub">Across all accounts</div>
        </div>
        <div class="stat-card">
          <div class="label">Monthly Income</div>
          <div class="value" style="color:var(--green)">${formatCurrency(data.monthlyIncome)}</div>
          <div class="sub">This month</div>
        </div>
        <div class="stat-card">
          <div class="label">Monthly Expenses</div>
          <div class="value" style="color:var(--red)">${formatCurrency(data.monthlyExpenses)}</div>
          <div class="sub">This month</div>
        </div>
        <div class="stat-card">
          <div class="label">Investment Value</div>
          <div class="value" style="color:var(--purple)">${formatCurrency(data.investmentValue)}</div>
          <div class="sub">Current portfolio value</div>
        </div>
        <div class="stat-card">
          <div class="label">Savings Rate</div>
          <div class="value" style="color:${data.savingsRate >= 20 ? 'var(--green)' : data.savingsRate >= 10 ? 'var(--orange)' : 'var(--red)'}">${data.savingsRate}%</div>
          <div class="sub">${data.savingsRate >= 20 ? 'Great job!' : data.savingsRate >= 10 ? 'Getting there' : 'Try to save more'}</div>
        </div>
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
          <span class="badge ${t.type === 'income' ? 'badge-income' : 'badge-expense'}">
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
