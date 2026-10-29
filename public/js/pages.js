// ── ACCOUNTS ──
App.renderAccounts = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading accounts...</div>';
  try {
    const accounts = await API.getAccounts();
    const totalAssets = accounts.filter(a => !isLiabilityAccount(a)).reduce((s, a) => s + a.balance, 0);
    const totalOwed = accounts.filter(isLiabilityAccount).reduce((s, a) => s + a.balance, 0);

    container.innerHTML = `
      <div class="page-header">
        <h1>🏦 Accounts</h1>
        <button class="btn btn-primary" id="add-account-btn">+ Add Account</button>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <div class="stat-card"><div class="label">Total Accounts</div><div class="value" style="font-size:1.2rem">${accounts.length}</div></div>
        <div class="stat-card"><div class="label">Total Assets</div><div class="value" style="font-size:1.2rem;color:var(--accent)">${formatCurrency(totalAssets)}</div></div>
        <div class="stat-card"><div class="label">Total Owed</div><div class="value" style="font-size:1.2rem;color:${totalOwed > 0 ? 'var(--red)' : 'var(--text-primary)'}">${formatCurrency(totalOwed)}</div></div>
        <div class="stat-card"><div class="label">Net</div><div class="value" style="font-size:1.2rem;color:var(--green)">${formatCurrency(totalAssets - totalOwed)}</div></div>
      </div>
      <div class="grid grid-3 gap-2" id="accounts-list">
        ${accounts.length ? accounts.map(a => `
          <div class="card" data-id="${a.id}">
            <div class="flex items-center justify-between mb-2">
              <span class="badge badge-${a.type}">${a.type.charAt(0).toUpperCase() + a.type.slice(1)}</span>
              <div class="flex gap-1">
                ${a.type !== 'investment' ? `<a class="btn btn-sm btn-secondary import-account-btn" href="#import?account=${a.id}" title="Import a bank statement into this account">⬆️</a>` : ''}
                <button class="btn btn-sm btn-secondary edit-account-btn" data-id="${a.id}">✏️</button>
                <button class="btn btn-sm btn-danger delete-account-btn" data-id="${a.id}">🗑️</button>
              </div>
            </div>
            <div class="card-title">${escapeHtml(a.name)}</div>
            <div class="card-value ${describeAccountBalance(a).cls}">${describeAccountBalance(a).text}</div>
            <div class="text-xs text-muted mt-1">${a.currency}${describeAccountBalance(a).note ? ' · ' + describeAccountBalance(a).note : ''}</div>
          </div>
        `).join('') : `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">🏦</div>
            <h3>No accounts yet</h3>
            <p>Create your first account to start tracking</p>
          </div>
        `}
      </div>
    `;

    document.getElementById('add-account-btn').addEventListener('click', () => this.showAccountModal());

    $$('.edit-account-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const account = accounts.find(a => a.id === btn.dataset.id);
        if (account) this.showAccountModal(account);
      });
    });

    $$('.delete-account-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await App.confirmDialog('This will also remove all of its transactions.', { title: 'Delete this account?' }))) return;
        try {
          await API.deleteAccount(btn.dataset.id);
          showToast('Account deleted');
          this.renderAccounts(container);
        } catch (err) { showToast(err.message, 'error'); }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

App.showAccountModal = function(account) {
  const isEdit = !!account;
  const formHtml = `
    <div class="form-group">
      <label>Account Name</label>
      <input type="text" id="acc-name" value="${isEdit ? escapeHtml(account.name) : ''}" required>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Type</label>
        <select id="acc-type">
          ${['checking','savings','investment','credit','cash'].map(t =>
            `<option value="${t}" ${isEdit && account.type === t ? 'selected' : ''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Currency</label>
        <select id="acc-currency">
          ${['USD','EUR','GBP','JPY','CHF','BTC','ETH'].map(c =>
            `<option value="${c}" ${isEdit && account.currency === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label id="acc-balance-label">Balance</label>
      <input type="number" step="0.01" id="acc-balance" value="${isEdit ? account.balance : 0}">
      <div class="text-xs text-muted mt-1" id="acc-balance-hint"></div>
    </div>
  `;

  this.showModal(isEdit ? 'Edit Account' : 'New Account', formHtml, async () => {
    const data = {
      name: document.getElementById('acc-name').value,
      type: document.getElementById('acc-type').value,
      currency: document.getElementById('acc-currency').value,
      balance: parseFloat(document.getElementById('acc-balance').value) || 0,
    };
    if (isEdit) {
      await API.updateAccount(account.id, data);
      showToast('Account updated');
    } else {
      await API.createAccount(data);
      showToast('Account created');
    }
    this.renderAccounts(document.getElementById('page-content'));
  });

  // Credit accounts store the amount owed as a positive number.
  const typeSel = document.getElementById('acc-type');
  const syncBalanceLabel = () => {
    const credit = typeSel.value === 'credit';
    document.getElementById('acc-balance-label').textContent = credit ? 'Amount Owed' : 'Balance';
    document.getElementById('acc-balance-hint').textContent = credit
      ? 'Enter what you currently owe as a positive number. Purchases increase it, payments reduce it.'
      : '';
  };
  typeSel.addEventListener('change', syncBalanceLabel);
  syncBalanceLabel();
};

// ── TRANSACTIONS ──

/** One table row; shared by the initial render and the filtered reload. */
App.renderTransactionRow = function(t, accountMap) {
  const account = accountMap[t.accountId];
  const matched = t.import && t.import.matchedFrom;
  const matchedNote = matched
    ? `Matched to a statement row you skipped as already recorded: ${matched.date} · ${formatCurrency(matched.amount)} · ${matched.rawDescription} (${matched.filename})`
    : '';
  const uncategorized = t.category === UNCATEGORIZED_CATEGORY;
  return `
    <tr data-id="${t.id}">
      <td class="text-sm">${formatDate(t.date)}</td>
      <td class="text-sm">${account ? escapeHtml(account.name) : 'Unknown'}</td>
      <td><span class="badge ${uncategorized ? 'badge-uncategorized' : isTransferTxn(t) ? 'badge-budget' : 'badge-' + t.type}">${escapeHtml(t.category)}</span></td>
      <td class="text-sm">${escapeHtml(t.description || '-')}${matched ? ` <span class="txn-matched" title="${escapeHtml(matchedNote)}" aria-label="Matched statement row">🔗</span>` : ''}</td>
      <td style="text-align:right;color:${isTransferTxn(t) ? 'var(--text-secondary)' : t.type === 'income' ? 'var(--green)' : 'var(--red)'}">
        ${t.type === 'income' ? '+' : '-'}${formatCurrency(t.amount)}
      </td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm btn-secondary edit-txn-btn" data-id="${t.id}" title="Edit">✏️</button>
        <button class="btn btn-sm btn-danger delete-txn-btn" data-id="${t.id}" title="Delete">🗑️</button>
      </td>
    </tr>
  `;
};

/** Wire the edit/delete buttons of the rows currently in the table. */
App.bindTransactionRowActions = function(txns, accounts, onChange) {
  $$('.edit-txn-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const txn = txns.find(t => t.id === btn.dataset.id);
      if (txn) this.showTransactionModal(accounts, txn, onChange);
    });
  });
  $$('.delete-txn-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await App.confirmDialog('The account balance will be adjusted accordingly.', { title: 'Delete this transaction?' }))) return;
      try {
        await API.deleteTransaction(btn.dataset.id);
        showToast('Transaction deleted');
        onChange();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });
};

App.renderTransactions = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading transactions...</div>';
  try {
    const batchId = (this.pageParams || {}).batchId;
    const [txns, accounts] = await Promise.all([
      API.getTransactions(batchId ? { batchId, limit: 500 } : { limit: 50 }),
      API.getAccounts(),
    ]);

    const accountMap = {};
    accounts.forEach(a => accountMap[a.id] = a);

    const categories = [...new Set(txns.map(t => t.category))];

    container.innerHTML = `
      <div class="page-header">
        <h1>💳 Transactions</h1>
        <div class="flex gap-1">
          <a class="btn btn-secondary" id="import-txn-btn" href="#import">⬆️ Import statement</a>
          <button class="btn btn-primary" id="add-txn-btn">+ Add Transaction</button>
        </div>
      </div>
      ${batchId ? `<div class="card mb-2 import-batch-note">Showing the ${txns.length} transaction${txns.length === 1 ? '' : 's'} written by your latest import${txns[0] && txns[0].import ? ` (${escapeHtml(txns[0].import.source.toUpperCase())} statement)` : ''}. <a href="#transactions">Show all transactions</a></div>` : ''}

      <div class="card mb-2">
        <form id="txn-filter-form" class="flex items-center gap-2" style="flex-wrap:wrap">
          <select id="filter-account" style="width:auto;min-width:140px">
            <option value="">All Accounts</option>
            ${accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
          </select>
          <select id="filter-category" style="width:auto;min-width:140px">
            <option value="">All Categories</option>
            ${categories.map(c => `<option value="${c}">${escapeHtml(c)}</option>`).join('')}
          </select>
          <input type="date" id="filter-from" style="width:auto">
          <input type="date" id="filter-to" style="width:auto">
          <button type="submit" class="btn btn-sm btn-secondary">Filter</button>
        </form>
      </div>

      <div class="card">
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Account</th>
                <th>Category</th>
                <th>Description</th>
                <th style="text-align:right">Amount</th>
                <th style="text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody id="txn-table-body">
              ${txns.length ? txns.map(t => this.renderTransactionRow(t, accountMap)).join('') : `
                <tr><td colspan="6" class="text-center text-muted">No transactions found</td></tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('add-txn-btn').addEventListener('click', () => this.showTransactionModal(accounts));

    // Filter
    document.getElementById('txn-filter-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const filters = {};
      const acct = document.getElementById('filter-account').value;
      if (acct) filters.accountId = acct;
      const cat = document.getElementById('filter-category').value;
      if (cat) filters.category = cat;
      const from = document.getElementById('filter-from').value;
      if (from) filters.from = from;
      const to = document.getElementById('filter-to').value;
      if (to) filters.to = to;
      filters.limit = '50';
      this.loadFilteredTransactions(container, filters, accounts, accountMap);
    });

    this.bindTransactionRowActions(txns, accounts, () => this.renderTransactions(container));
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

App.loadFilteredTransactions = async function(container, filters, accounts, accountMap) {
  try {
    const txns = await API.getTransactions(filters);
    const tbody = document.getElementById('txn-table-body');
    if (!tbody) return;
    tbody.innerHTML = txns.length
      ? txns.map(t => this.renderTransactionRow(t, accountMap)).join('')
      : '<tr><td colspan="6" class="text-center text-muted">No transactions found</td></tr>';
    this.bindTransactionRowActions(txns, accounts, () => this.loadFilteredTransactions(container, filters, accounts, accountMap));
  } catch (err) { showToast(err.message, 'error'); }
};

/**
 * Create (no `txn`) or edit (`txn` given) a transaction.
 * `onSaved` runs after a successful save; defaults to re-rendering the page.
 */
App.showTransactionModal = function(accounts, txn, onSaved) {
  const isEdit = !!txn;
  const selected = (value, current) => value === current ? 'selected' : '';
  const formHtml = `
    <div class="form-group">
      <label>Account</label>
      <select id="txn-account" required>
        <option value="">Select account...</option>
        ${accounts.map(a => `<option value="${a.id}" ${isEdit ? selected(a.id, txn.accountId) : ''}>${escapeHtml(a.name)} (${isLiabilityAccount(a) && a.balance > 0 ? 'owes ' : ''}${describeAccountBalance(a).text})</option>`).join('')}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Type</label>
        <select id="txn-type">
          <option value="expense" ${isEdit ? selected('expense', txn.type) : ''}>Expense</option>
          <option value="income" ${isEdit ? selected('income', txn.type) : ''}>Income</option>
        </select>
      </div>
      <div class="form-group">
        <label>Amount</label>
        <input type="number" step="0.01" min="0.01" id="txn-amount" value="${isEdit ? txn.amount : ''}" required>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Category</label>
        <select id="txn-category">
          ${TRANSACTION_CATEGORIES.map(c => `<option value="${c}" ${isEdit ? selected(c, txn.category) : ''}>${c}</option>`).join('')}
        </select>
        <div class="help">“Transfer” = between your own accounts (not income or spending). “Investment” as an expense = money invested. “Uncategorized” is where imported rows land until you pick a category.</div>
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="txn-date" value="${isEdit ? txn.date : new Date().toISOString().slice(0,10)}">
      </div>
    </div>
    <div class="form-group">
      <label>Description</label>
      <input type="text" id="txn-desc" placeholder="Optional description" value="${isEdit ? escapeHtml(txn.description || '') : ''}">
    </div>
    ${isEdit && txn.import ? `<div class="text-xs text-muted">Imported from a ${escapeHtml(txn.import.source.toUpperCase())} statement${txn.import.rawDescription ? ` · bank text: “${escapeHtml(txn.import.rawDescription)}”` : ''}</div>` : ''}
  `;

  this.showModal(isEdit ? 'Edit Transaction' : 'New Transaction', formHtml, async () => {
    const data = {
      accountId: document.getElementById('txn-account').value,
      type: document.getElementById('txn-type').value,
      amount: parseFloat(document.getElementById('txn-amount').value),
      category: document.getElementById('txn-category').value,
      date: document.getElementById('txn-date').value,
      description: document.getElementById('txn-desc').value,
    };
    if (isEdit) {
      await API.updateTransaction(txn.id, data);
      showToast('Transaction updated');
    } else {
      await API.createTransaction(data);
      showToast('Transaction added');
    }
    if (onSaved) onSaved(); else this.renderTransactions(document.getElementById('page-content'));
  });
};
