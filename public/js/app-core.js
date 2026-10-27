// ── App Core ──
const App = {
  currentPage: 'dashboard',
  user: null,
  /** Server's notion of "today" (YYYY-MM-DD); honours a frozen clock on the server. */
  today: new Date().toISOString().slice(0, 10),

  async init() {
    this.renderShell();
    try {
      const meta = await API.getMeta();
      if (meta && meta.today) this.today = meta.today;
    } catch { /* fall back to the browser clock */ }
    if (API.isLoggedIn()) {
      this.user = { id: 'user' };
      this.showApp();
      this.navigate(window.location.hash.slice(1) || 'dashboard');
    } else {
      this.showAuth();
    }
    window.addEventListener('hashchange', () => {
      if (API.isLoggedIn()) this.navigate(window.location.hash.slice(1) || 'dashboard');
    });
  },

  renderShell() {
    document.body.innerHTML = `
      <div id="toast-container" class="toast-container"></div>
      <div id="app"></div>
    `;
  },

  showAuth() {
    document.getElementById('app').innerHTML = `
      <div class="auth-page">
        <div class="auth-card" id="auth-card">
          <h1>Fin<span>Folio</span></h1>
          <p>Take control of your finances</p>
          <div id="auth-form"></div>
        </div>
      </div>
    `;
    this.showLoginForm();
  },

  showLoginForm() {
    document.getElementById('auth-form').innerHTML = `
      <form id="login-form">
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="login-username" placeholder="Enter username" required autocomplete="username">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="login-password" placeholder="Enter password" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary w-full">Sign In</button>
      </form>
      <div class="auth-link">
        Don't have an account? <a id="show-register">Create one</a>
      </div>
    `;
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value;
      const password = document.getElementById('login-password').value;
      try {
        const res = await API.login(username, password);
        API.setToken(res.token);
        this.user = res.user;
        showToast('Welcome back!');
        this.showApp();
        this.navigate('dashboard');
      } catch (err) { showToast(err.message, 'error'); }
    });
    document.getElementById('show-register').addEventListener('click', () => this.showRegisterForm());
  },

  showRegisterForm() {
    document.getElementById('auth-form').innerHTML = `
      <form id="register-form">
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="reg-username" placeholder="Choose a username" required autocomplete="username">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="reg-password" placeholder="Choose a password" required autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary w-full">Create Account</button>
      </form>
      <div class="auth-link">
        Already have an account? <a id="show-login">Sign in</a>
      </div>
    `;
    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('reg-username').value;
      const password = document.getElementById('reg-password').value;
      try {
        const res = await API.register(username, password);
        API.setToken(res.token);
        this.user = res.user;
        showToast('Account created! Welcome to FinFolio.');
        this.showApp();
        this.navigate('dashboard');
      } catch (err) { showToast(err.message, 'error'); }
    });
    document.getElementById('show-login').addEventListener('click', () => this.showLoginForm());
  },

  showApp() {
    document.getElementById('app').innerHTML = `
      <div class="app-layout">
        <aside class="sidebar">
          <div class="sidebar-brand">📊 Fin<span>Folio</span></div>
          <nav class="sidebar-nav">
            <div class="sidebar-link active" data-page="dashboard">📊 <span>Dashboard</span></div>
            <div class="sidebar-link" data-page="accounts">🏦 <span>Accounts</span></div>
            <div class="sidebar-link" data-page="transactions">💳 <span>Transactions</span></div>
            <div class="sidebar-link" data-page="budgets">📋 <span>Budgets</span></div>
            <div class="sidebar-link" data-page="investments">📈 <span>Investments</span></div>
            <div class="sidebar-link" data-page="goals">🎯 <span>Goals</span></div>
            <div class="sidebar-link" data-page="reports">📑 <span>Reports</span></div>
            <div class="sidebar-link" data-page="simulate">🔮 <span>Simulate</span></div>
          </nav>
          <div class="sidebar-footer">
            <div style="cursor:pointer" id="logout-btn">🚪 Sign Out</div>
          </div>
        </aside>
        <main class="main-content" id="page-content">
          <div class="text-center text-muted mt-2">Loading...</div>
        </main>
      </div>
    `;

    $$('.sidebar-link').forEach(link => {
      link.addEventListener('click', () => {
        const page = link.dataset.page;
        window.location.hash = page;
        this.navigate(page);
      });
    });

    document.getElementById('logout-btn').addEventListener('click', () => {
      API.clearToken();
      showToast('Signed out', 'info');
      this.showAuth();
    });
  },

  navigate(page) {
    this.currentPage = page;
    $$('.sidebar-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
    const content = document.getElementById('page-content');
    switch (page) {
      case 'dashboard': this.renderDashboard(content); break;
      case 'accounts': this.renderAccounts(content); break;
      case 'transactions': this.renderTransactions(content); break;
      case 'budgets': this.renderBudgets(content); break;
      case 'investments': this.renderInvestments(content); break;
      case 'goals': this.renderGoals(content); break;
      case 'reports': this.renderReports(content); break;
      case 'simulate': this.renderSimulate(content); break;
      default: content.innerHTML = '<div class="text-center text-muted mt-2">Page not found</div>';
    }
  },
};
