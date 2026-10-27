// ── GOALS ──
App.renderGoals = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading goals...</div>';
  try {
    const goals = await API.getGoals();

    container.innerHTML = `
      <div class="page-header">
        <h1>🎯 Financial Goals</h1>
        <button class="btn btn-primary" id="add-goal-btn">+ New Goal</button>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <div class="stat-card">
          <div class="label">Total Goals</div>
          <div class="value" style="font-size:1.2rem">${goals.length}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Target</div>
          <div class="value" style="font-size:1.2rem;color:var(--accent)">${formatCurrency(goals.reduce((s,g) => s+g.targetAmount,0))}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Saved</div>
          <div class="value" style="font-size:1.2rem;color:var(--green)">${formatCurrency(goals.reduce((s,g) => s+g.currentAmount,0))}</div>
        </div>
      </div>
      <div class="grid grid-2 gap-2" id="goals-list">
        ${goals.length ? goals.map(g => {
          const pct = g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0;
          const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline) - new Date()) / (1000*60*60*24)) : null;
          return `
            <div class="card">
              <div class="flex items-center justify-between mb-2">
                <span class="card-title">${escapeHtml(g.name)}</span>
                <div class="flex gap-1">
                  <button class="btn btn-sm btn-secondary edit-goal-btn" data-id="${g.id}">✏️</button>
                  <button class="btn btn-sm btn-danger delete-goal-btn" data-id="${g.id}">🗑️</button>
                </div>
              </div>
              <div class="flex justify-between text-sm mb-1">
                <span class="text-muted">${escapeHtml(g.category)} · Priority: ${g.priority}</span>
                <span style="color:var(--accent)">${pct}%</span>
              </div>
              <div class="progress-bar mb-1">
                <div class="progress-fill" style="width:${Math.min(pct,100)}%"></div>
              </div>
              <div class="flex justify-between text-sm">
                <span>${formatCurrency(g.currentAmount)} / ${formatCurrency(g.targetAmount)}</span>
                <span class="text-muted">
                  ${daysLeft !== null ? (daysLeft > 0 ? `${daysLeft} days left` : 'Past due!') : 'No deadline'}
                </span>
              </div>
              ${g.notes ? `<div class="text-xs text-muted mt-1">${escapeHtml(g.notes)}</div>` : ''}
            </div>
          `;
        }).join('') : `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">🎯</div>
            <h3>No goals yet</h3>
            <p>Set your first financial goal to stay motivated</p>
          </div>
        `}
      </div>
    `;

    document.getElementById('add-goal-btn').addEventListener('click', () => this.showGoalModal());

    $$('.edit-goal-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const goal = goals.find(g => g.id === btn.dataset.id);
        if (goal) this.showGoalModal(goal);
      });
    });

    $$('.delete-goal-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!(await App.confirmDialog('This cannot be undone.', { title: 'Delete this goal?' }))) return;
        try {
          await API.deleteGoal(btn.dataset.id);
          showToast('Goal deleted');
          this.renderGoals(container);
        } catch (err) { showToast(err.message, 'error'); }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

App.showGoalModal = function(goal) {
  const isEdit = !!goal;
  const formHtml = `
    <div class="form-group">
      <label>Goal Name</label>
      <input type="text" id="goal-name" value="${isEdit ? escapeHtml(goal.name) : ''}" placeholder="e.g. Emergency Fund" required>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Target Amount</label>
        <input type="number" step="0.01" id="goal-target" value="${isEdit ? goal.targetAmount : ''}" required>
      </div>
      <div class="form-group">
        <label>Current Amount</label>
        <input type="number" step="0.01" id="goal-current" value="${isEdit ? goal.currentAmount : 0}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Category</label>
        <select id="goal-category">
          ${['Savings','Debt','Investment','Travel','Education','Retirement','Emergency','House','Car','Other'].map(c =>
            `<option value="${c}" ${isEdit && goal.category === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Priority</label>
        <select id="goal-priority">
          <option value="low" ${isEdit && goal.priority === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${isEdit && goal.priority === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${isEdit && goal.priority === 'high' ? 'selected' : ''}>High</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Deadline</label>
      <input type="date" id="goal-deadline" value="${isEdit && goal.deadline ? goal.deadline : ''}">
    </div>
    <div class="form-group">
      <label>Notes</label>
      <textarea id="goal-notes">${isEdit ? escapeHtml(goal.notes) : ''}</textarea>
    </div>
  `;

  this.showModal(isEdit ? 'Edit Goal' : 'New Goal', formHtml, async () => {
    const data = {
      name: document.getElementById('goal-name').value,
      targetAmount: parseFloat(document.getElementById('goal-target').value),
      currentAmount: parseFloat(document.getElementById('goal-current').value) || 0,
      category: document.getElementById('goal-category').value,
      priority: document.getElementById('goal-priority').value,
      deadline: document.getElementById('goal-deadline').value,
      notes: document.getElementById('goal-notes').value,
    };
    if (isEdit) {
      await API.updateGoal(goal.id, data);
      showToast('Goal updated');
    } else {
      await API.createGoal(data);
      showToast('Goal created');
    }
    this.renderGoals(document.getElementById('page-content'));
  });
};

// ── REPORTS ──
App.renderReports = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading reports...</div>';
  try {
    const data = await API.getDashboard();
    const txns = await API.getTransactions({ limit: 1000 });
    const accounts = await API.getAccounts();
    const investments = await API.getInvestments();
    const goals = await API.getGoals();

    // Monthly income/expense trend (last 6 months)
    const months = [];
    const incomeData = [];
    const expenseData = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(App.today + 'T00:00:00');
      d.setMonth(d.getMonth() - i);
      const m = d.getMonth();
      const y = d.getFullYear();
      const monthLabel = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      months.push(monthLabel);

      const monthTxns = txns.filter(t => {
        const td = new Date(t.date);
        return td.getMonth() === m && td.getFullYear() === y;
      });
      incomeData.push(monthTxns.filter(isIncomeTxn).reduce((s, t) => s + t.amount, 0));
      expenseData.push(monthTxns.filter(isSpendingTxn).reduce((s, t) => s + Math.abs(t.amount), 0));
    }

    container.innerHTML = `
      <div class="page-header"><h1>📑 Reports</h1></div>

      <div class="chart-container">
        <h3>📈 Income vs Expenses (Last 6 months)</h3>
        <canvas id="trend-chart"></canvas>
        <div class="flex gap-2 mt-2 justify-center">
          <div class="flex items-center gap-1 text-sm"><span style="width:12px;height:3px;background:var(--green);display:inline-block"></span> Income</div>
          <div class="flex items-center gap-1 text-sm"><span style="width:12px;height:3px;background:var(--red);display:inline-block"></span> Expenses</div>
        </div>
      </div>

      <div class="grid grid-2 gap-2">
        <div class="chart-container">
          <h3>🏦 Balance by Account (assets)</h3>
          <canvas id="balance-chart"></canvas>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">📊 Summary</span>
          </div>
          <div class="flex flex-col gap-2">
            <div class="flex justify-between"><span class="text-muted">Net Worth</span><span style="color:var(--accent)">${formatCurrency(data.netWorth)}</span></div>
            <div class="flex justify-between"><span class="text-muted">Total Balance</span><span>${formatCurrency(data.totalBalance)}</span></div>
            <div class="flex justify-between"><span class="text-muted">Liabilities</span><span style="color:var(--red)">${formatCurrency(data.totalLiabilities || 0)}</span></div>
            <div class="flex justify-between"><span class="text-muted">Investment Value</span><span style="color:var(--purple)">${formatCurrency(data.investmentValue)}</span></div>
            <div class="flex justify-between"><span class="text-muted">Avg Monthly Income</span><span style="color:var(--green)">${formatCurrency(data.monthlyIncome)}</span></div>
            <div class="flex justify-between"><span class="text-muted">Avg Monthly Expenses</span><span style="color:var(--red)">${formatCurrency(data.monthlyExpenses)}</span></div>
            <div class="flex justify-between"><span class="text-muted">Savings Rate</span><span>${data.savingsRate}%</span></div>
            <div class="flex justify-between"><span class="text-muted">Active Accounts</span><span>${accounts.length}</span></div>
            <div class="flex justify-between"><span class="text-muted">Investments</span><span>${investments.length}</span></div>
            <div class="flex justify-between"><span class="text-muted">Goals</span><span>${goals.length}</span></div>
          </div>
        </div>
      </div>

      <div class="grid grid-2 gap-2 mt-2">
        <div class="card">
          <div class="card-header">
            <span class="card-title">💰 Top Expense Categories (This Month)</span>
          </div>
          <div id="report-expenses"></div>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">🎯 Goal Completion</span>
          </div>
          <div id="report-goals"></div>
        </div>
      </div>
    `;

    // Trend chart
    setTimeout(() => {
      Chart.line(document.getElementById('trend-chart'), months, [
        { label: 'Income', data: incomeData, color: '#00e676' },
        { label: 'Expenses', data: expenseData, color: '#ff5252' },
      ]);
    }, 100);

    // Balance chart
    setTimeout(() => {
      const assetAccounts = accounts.filter(a => !isLiabilityAccount(a));
      Chart.bar(
        document.getElementById('balance-chart'),
        assetAccounts.map(a => a.name),
        assetAccounts.map(a => a.balance),
      );
    }, 100);

    // Expense categories
    const expDiv = document.getElementById('report-expenses');
    if (data.topExpenseCategories.length) {
      expDiv.innerHTML = data.topExpenseCategories.map(e => `
        <div class="flex justify-between items-center" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm">${escapeHtml(e.category)}</span>
          <div class="flex items-center gap-2">
            <span class="text-sm">${formatCurrency(e.amount)}</span>
            <span class="badge badge-expense">${e.percentage}%</span>
          </div>
        </div>
      `).join('');
    } else {
      expDiv.innerHTML = '<div class="text-muted text-sm">No expenses this month</div>';
    }

    // Goals
    const goalDiv2 = document.getElementById('report-goals');
    if (data.goalProgress.length) {
      goalDiv2.innerHTML = data.goalProgress.map(g => `
        <div style="margin-bottom:12px">
          <div class="flex justify-between text-sm mb-1">
            <span>${escapeHtml(g.name)}</span>
            <span>${g.percentage}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${Math.min(g.percentage,100)}%"></div>
          </div>
        </div>
      `).join('');
    } else {
      goalDiv2.innerHTML = '<div class="text-muted text-sm">No goals set</div>';
    }
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};
