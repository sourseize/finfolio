// ── BUDGETS ──
App.renderBudgets = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading budgets...</div>';
  try {
    const budgets = await API.getBudgets();

    container.innerHTML = `
      <div class="page-header">
        <h1>📋 Budgets</h1>
        <button class="btn btn-primary" id="add-budget-btn">+ Create Budget</button>
      </div>
      <div class="grid grid-2 gap-2" id="budgets-list">
        ${budgets.length ? budgets.map(b => {
          const pct = b.amount > 0 ? Math.round((b.spent / b.amount) * 100) : 0;
          const isOver = pct > 100;
          const isWarning = pct > 80;
          const remaining = b.amount - b.spent;
          return `
            <div class="card">
              <div class="flex items-center justify-between mb-2">
                <span class="card-title">${escapeHtml(b.category)}</span>
                <div class="flex gap-1">
                  <button class="btn btn-sm btn-secondary edit-budget-btn" data-id="${b.id}">✏️</button>
                  <button class="btn btn-sm btn-danger delete-budget-btn" data-id="${b.id}">🗑️</button>
                </div>
              </div>
              <div class="flex justify-between text-sm mb-1">
                <span class="text-muted">Budgeted</span>
                <span>${formatCurrency(b.amount)}</span>
              </div>
              <div class="flex justify-between text-sm mb-1">
                <span class="text-muted">Spent</span>
                <span style="color:${isOver ? 'var(--red)' : 'var(--text-primary)'}">${formatCurrency(b.spent)}</span>
              </div>
              <div class="flex justify-between text-sm mb-2">
                <span class="text-muted">Remaining</span>
                <span style="color:${remaining >= 0 ? 'var(--green)' : 'var(--red)'}">${formatCurrency(remaining)}</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill ${isOver ? 'danger' : isWarning ? 'warning' : ''}" style="width:${Math.min(pct, 100)}%"></div>
              </div>
              <div class="text-xs text-muted mt-1">${pct}% used · ${b.period}</div>
            </div>
          `;
        }).join('') : `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">📋</div>
            <h3>No budgets yet</h3>
            <p>Create your first budget to track spending</p>
          </div>
        `}
      </div>
    `;

    document.getElementById('add-budget-btn').addEventListener('click', () => this.showBudgetModal());

    $$('.edit-budget-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const budget = budgets.find(b => b.id === btn.dataset.id);
        if (budget) this.showBudgetModal(budget);
      });
    });

    $$('.delete-budget-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!(await App.confirmDialog('Spending history is kept; only the budget limit is removed.', { title: 'Delete this budget?' }))) return;
        try {
          await API.deleteBudget(btn.dataset.id);
          showToast('Budget deleted');
          this.renderBudgets(container);
        } catch (err) { showToast(err.message, 'error'); }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

App.showBudgetModal = function(budget) {
  const isEdit = !!budget;
  const formHtml = `
    <div class="form-row">
      <div class="form-group">
        <label>Category</label>
        <select id="budget-category">
          ${['Food & Dining','Transportation','Housing','Utilities','Entertainment','Shopping','Healthcare','Education','Other'].map(c =>
            `<option value="${c}" ${isEdit && budget.category === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Amount</label>
        <input type="number" step="0.01" id="budget-amount" value="${isEdit ? budget.amount : ''}" required>
      </div>
    </div>
    <div class="form-group">
      <label>Period</label>
      <select id="budget-period">
        <option value="monthly" ${isEdit && budget.period === 'monthly' ? 'selected' : ''}>Monthly</option>
        <option value="weekly" ${isEdit && budget.period === 'weekly' ? 'selected' : ''}>Weekly</option>
        <option value="yearly" ${isEdit && budget.period === 'yearly' ? 'selected' : ''}>Yearly</option>
      </select>
    </div>
  `;

  this.showModal(isEdit ? 'Edit Budget' : 'New Budget', formHtml, async () => {
    const data = {
      category: document.getElementById('budget-category').value,
      amount: parseFloat(document.getElementById('budget-amount').value),
      period: document.getElementById('budget-period').value,
    };
    if (isEdit) {
      await API.updateBudget(budget.id, data);
      showToast('Budget updated');
    } else {
      await API.createBudget(data);
      showToast('Budget created');
    }
    this.renderBudgets(document.getElementById('page-content'));
  });
};

// ── INVESTMENTS ──
App.renderInvestments = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading investments...</div>';
  try {
    const investments = await API.getInvestments();
    const totalValue = investments.reduce((s, i) => s + (i.currentPrice * i.shares), 0);
    const totalCost = investments.reduce((s, i) => s + (i.avgCost * i.shares), 0);
    const totalGain = totalValue - totalCost;
    const gainPct = totalCost > 0 ? Math.round((totalGain / totalCost) * 100) : 0;

    container.innerHTML = `
      <div class="page-header">
        <h1>📈 Investments</h1>
        <button class="btn btn-primary" id="add-invest-btn">+ Add Investment</button>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        <div class="stat-card">
          <div class="label">Portfolio Value</div>
          <div class="value" style="font-size:1.2rem;color:var(--accent)">${formatCurrency(totalValue)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Cost</div>
          <div class="value" style="font-size:1.2rem">${formatCurrency(totalCost)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Gain/Loss</div>
          <div class="value" style="font-size:1.2rem;color:${totalGain >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${totalGain >= 0 ? '+' : ''}${formatCurrency(totalGain)} (${gainPct >= 0 ? '+' : ''}${gainPct}%)
          </div>
        </div>
      </div>
      <div class="grid grid-3 gap-2" id="investments-list">
        ${investments.length ? investments.map(i => {
          const gain = (i.currentPrice - i.avgCost) * i.shares;
          const pct = i.avgCost > 0 ? Math.round(((i.currentPrice - i.avgCost) / i.avgCost) * 100) : 0;
          const value = i.currentPrice * i.shares;
          return `
            <div class="card invest-card" data-id="${i.id}" style="cursor:pointer">
              <div class="flex items-center justify-between mb-2">
                <span class="badge badge-invest">${i.type.replace('_',' ')}</span>
                <div class="flex gap-1">
                  <button class="btn btn-sm btn-secondary edit-invest-btn" data-id="${i.id}">✏️</button>
                  <button class="btn btn-sm btn-danger delete-invest-btn" data-id="${i.id}">🗑️</button>
                </div>
              </div>
              <div class="card-title">${escapeHtml(i.symbol)}</div>
              <div class="text-sm text-muted">${escapeHtml(i.name)}</div>
              <div class="card-value" style="font-size:1.3rem">${formatCurrency(value, i.currency)}</div>
              <div class="flex justify-between text-sm mt-1">
                <span class="text-muted">${i.shares} shares @ ${formatCurrency(i.currentPrice)}</span>
                <span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct >= 0 ? '+' : ''}${pct}%</span>
              </div>
            </div>
          `;
        }).join('') : `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">📈</div>
            <h3>No investments yet</h3>
            <p>Start building your portfolio</p>
          </div>
        `}
      </div>
    `;

    document.getElementById('add-invest-btn').addEventListener('click', () => this.showInvestmentModal());

    $$('.edit-invest-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const inv = investments.find(i => i.id === btn.dataset.id);
        if (inv) this.showInvestmentModal(inv);
      });
    });

    $$('.delete-invest-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await App.confirmDialog('Its trade history will be removed as well.', { title: 'Delete this investment?' }))) return;
        try {
          await API.deleteInvestment(btn.dataset.id);
          showToast('Investment deleted');
          this.renderInvestments(container);
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    // Click to see transactions
    $$('.invest-card').forEach(card => {
      card.addEventListener('click', function() {
        const id = this.dataset.id;
        App.showInvestmentDetail(id);
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

App.showInvestmentModal = function(investment) {
  const isEdit = !!investment;
  const formHtml = `
    <div class="form-row">
      <div class="form-group">
        <label>Symbol</label>
        <input type="text" id="inv-symbol" value="${isEdit ? escapeHtml(investment.symbol) : ''}" placeholder="e.g. AAPL" required>
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="inv-type">
          ${['stock','crypto','etf','mutual_fund','bond','real_estate','other'].map(t =>
            `<option value="${t}" ${isEdit && investment.type === t ? 'selected' : ''}>${t.replace('_',' ')}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="inv-name" value="${isEdit ? escapeHtml(investment.name) : ''}" placeholder="Company or asset name" required>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Shares</label>
        <input type="number" step="0.0001" id="inv-shares" value="${isEdit ? investment.shares : 0}">
      </div>
      <div class="form-group">
        <label>Avg Cost / Share</label>
        <input type="number" step="0.0001" id="inv-cost" value="${isEdit ? investment.avgCost : 0}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Current Price</label>
        <input type="number" step="0.0001" id="inv-price" value="${isEdit ? investment.currentPrice : 0}">
      </div>
      <div class="form-group">
        <label>Currency</label>
        <select id="inv-currency">
          ${['USD','EUR','GBP','JPY','CHF'].map(c =>
            `<option value="${c}" ${isEdit && investment.currency === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Notes</label>
      <textarea id="inv-notes">${isEdit ? escapeHtml(investment.notes) : ''}</textarea>
    </div>
  `;

  this.showModal(isEdit ? 'Edit Investment' : 'New Investment', formHtml, async () => {
    const data = {
      symbol: document.getElementById('inv-symbol').value.toUpperCase(),
      name: document.getElementById('inv-name').value,
      type: document.getElementById('inv-type').value,
      shares: parseFloat(document.getElementById('inv-shares').value) || 0,
      avgCost: parseFloat(document.getElementById('inv-cost').value) || 0,
      currentPrice: parseFloat(document.getElementById('inv-price').value) || 0,
      currency: document.getElementById('inv-currency').value,
      notes: document.getElementById('inv-notes').value,
    };
    if (isEdit) {
      await API.updateInvestment(investment.id, data);
      showToast('Investment updated');
    } else {
      await API.createInvestment(data);
      showToast('Investment added');
    }
    this.renderInvestments(document.getElementById('page-content'));
  });
};

App.showInvestmentDetail = async function(investmentId) {
  try {
    const [txns, allInvestments] = await Promise.all([
      API.getInvestmentTransactions(investmentId),
      API.getInvestments(),
    ]);
    const inv = allInvestments.find(i => i.id === investmentId);
    if (!inv) return;

    const totalInvested = txns.filter(t => t.type === 'buy').reduce((s, t) => s + t.totalAmount, 0);
    const totalSold = txns.filter(t => t.type === 'sell').reduce((s, t) => s + t.totalAmount, 0);
    const dividends = txns.filter(t => t.type === 'dividend').reduce((s, t) => s + t.totalAmount, 0);
    const currentValue = inv.shares * inv.currentPrice;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" style="max-width:700px">
        <h2>${escapeHtml(inv.symbol)} — ${escapeHtml(inv.name)}</h2>
        <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
          <div class="stat-card"><div class="label">Current Value</div><div class="value" style="font-size:1rem;color:var(--accent)">${formatCurrency(currentValue, inv.currency)}</div></div>
          <div class="stat-card"><div class="label">Total Invested</div><div class="value" style="font-size:1rem">${formatCurrency(totalInvested, inv.currency)}</div></div>
          <div class="stat-card"><div class="label">Dividends</div><div class="value" style="font-size:1rem;color:var(--green)">${formatCurrency(dividends, inv.currency)}</div></div>
        </div>
        <div class="flex justify-between mb-2">
          <h3>Transaction History</h3>
          <button class="btn btn-sm btn-primary" id="add-invest-txn-btn">+ Add Trade</button>
        </div>
        <div class="table-container" style="max-height:300px;overflow-y:auto">
          <table>
            <thead>
              <tr><th>Date</th><th>Type</th><th>Shares</th><th>Price</th><th>Total</th><th>Notes</th></tr>
            </thead>
            <tbody>
              ${txns.length ? txns.map(t => `
                <tr>
                  <td class="text-sm">${formatDate(t.date)}</td>
                  <td><span class="badge ${t.type === 'buy' ? 'badge-income' : t.type === 'dividend' ? 'badge-invest' : 'badge-expense'}">${t.type}</span></td>
                  <td class="text-sm">${t.shares}</td>
                  <td class="text-sm">${formatCurrency(t.pricePerShare, inv.currency)}</td>
                  <td class="text-sm" style="color:${t.type === 'buy' ? 'var(--red)' : 'var(--green)'}">${formatCurrency(t.totalAmount, inv.currency)}</td>
                  <td class="text-sm text-muted">${escapeHtml(t.notes || '-')}</td>
                </tr>
              `).join('') : '<tr><td colspan="6" class="text-center text-muted">No transactions yet</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="detail-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('detail-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('add-invest-txn-btn').addEventListener('click', () => {
      this.showInvestmentTransactionModal(investmentId, inv.currency);
    });
  } catch (err) { showToast(err.message, 'error'); }
};

App.showInvestmentTransactionModal = function(investmentId, currency) {
  const formHtml = `
    <div class="form-row">
      <div class="form-group">
        <label>Type</label>
        <select id="invest-txn-type">
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
          <option value="dividend">Dividend</option>
        </select>
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="invest-txn-date" value="${new Date().toISOString().slice(0,10)}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Shares</label>
        <input type="number" step="0.0001" id="invest-txn-shares" value="1" required>
      </div>
      <div class="form-group">
        <label>Price per Share (${currency})</label>
        <input type="number" step="0.0001" id="invest-txn-price" required>
      </div>
    </div>
    <div class="form-group">
      <label>Notes</label>
      <input type="text" id="invest-txn-notes" placeholder="Optional notes">
    </div>
  `;

  this.showModal('Add Trade', formHtml, async () => {
    await API.createInvestmentTransaction(investmentId, {
      type: document.getElementById('invest-txn-type').value,
      date: document.getElementById('invest-txn-date').value,
      shares: parseFloat(document.getElementById('invest-txn-shares').value),
      pricePerShare: parseFloat(document.getElementById('invest-txn-price').value),
      notes: document.getElementById('invest-txn-notes').value,
    });
    showToast('Trade recorded');
    document.querySelector('.modal-overlay.open')?.remove();
    this.showInvestmentDetail(investmentId);
  });
};
