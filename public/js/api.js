// ── API Client ──
const API = {
  _token: localStorage.getItem('token'),

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  login(username, password) {
    return this.request('POST', '/api/auth/login', { username, password });
  },
  register(username, password) {
    return this.request('POST', '/api/auth/register', { username, password });
  },
  getDashboard() { return this.request('GET', '/api/dashboard'); },
  getAccounts() { return this.request('GET', '/api/accounts'); },
  createAccount(data) { return this.request('POST', '/api/accounts', data); },
  updateAccount(id, data) { return this.request('PUT', `/api/accounts/${id}`, data); },
  deleteAccount(id) { return this.request('DELETE', `/api/accounts/${id}`); },
  getTransactions(filters) {
    const params = new URLSearchParams(filters || {});
    return this.request('GET', `/api/transactions?${params}`);
  },
  createTransaction(data) { return this.request('POST', '/api/transactions', data); },
  deleteTransaction(id) { return this.request('DELETE', `/api/transactions/${id}`); },
  getBudgets() { return this.request('GET', '/api/budgets'); },
  createBudget(data) { return this.request('POST', '/api/budgets', data); },
  updateBudget(id, data) { return this.request('PUT', `/api/budgets/${id}`, data); },
  deleteBudget(id) { return this.request('DELETE', `/api/budgets/${id}`); },
  getInvestments() { return this.request('GET', '/api/investments'); },
  createInvestment(data) { return this.request('POST', '/api/investments', data); },
  updateInvestment(id, data) { return this.request('PUT', `/api/investments/${id}`, data); },
  deleteInvestment(id) { return this.request('DELETE', `/api/investments/${id}`); },
  getInvestmentTransactions(id) { return this.request('GET', `/api/investments/${id}/transactions`); },
  createInvestmentTransaction(id, data) { return this.request('POST', `/api/investments/${id}/transactions`, data); },
  getGoals() { return this.request('GET', '/api/goals'); },
  createGoal(data) { return this.request('POST', '/api/goals', data); },
  updateGoal(id, data) { return this.request('PUT', `/api/goals/${id}`, data); },
  deleteGoal(id) { return this.request('DELETE', `/api/goals/${id}`); },

  // ── Simulation ──
  getMeta() { return this.request('GET', '/api/meta'); },
  getSimCatalog() { return this.request('GET', '/api/simulate/catalog'); },
  getProfile() { return this.request('GET', '/api/profile'); },
  updateProfile(data) { return this.request('PUT', '/api/profile', data); },
  getSimBaseline(lookback) { return this.request('GET', `/api/simulate/baseline${lookback ? `?lookback=${lookback}` : ''}`); },
  simulate(payload) { return this.request('POST', '/api/simulate', payload || {}); },
  compareScenarios(scenarios) { return this.request('POST', '/api/simulate/compare', { scenarios }); },
  opportunityCost(data) { return this.request('POST', '/api/simulate/opportunity-cost', data); },
  getOutlook() { return this.request('GET', '/api/simulate/outlook'); },
  getScenarios() { return this.request('GET', '/api/scenarios'); },
  createScenario(data) { return this.request('POST', '/api/scenarios', data); },
  updateScenario(id, data) { return this.request('PUT', `/api/scenarios/${id}`, data); },
  deleteScenario(id) { return this.request('DELETE', `/api/scenarios/${id}`); },

  setToken(token) {
    this._token = token;
    localStorage.setItem('token', token);
  },
  clearToken() {
    this._token = null;
    localStorage.removeItem('token');
  },
  isLoggedIn() { return !!this._token; },
};
