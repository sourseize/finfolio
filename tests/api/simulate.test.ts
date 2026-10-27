import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp, TEST_TODAY } from '../helpers/server.js';

/** Seed a user with a year of simple history: 6 000 salary, 1 800 rent, 600 groceries, 1 000 invested per month. */
async function seedHistory(app: TestApp, token: string) {
  const chk = (await app.post('/api/accounts', { name: 'Checking', type: 'checking', balance: 12000 }, token)).body;
  await app.post('/api/accounts', { name: 'Savings', type: 'savings', balance: 30000 }, token);
  await app.post('/api/accounts', { name: 'Card', type: 'credit', balance: 1500 }, token);
  const inv = (await app.post('/api/investments', { symbol: 'VTI', name: 'Total Market', type: 'etf', shares: 400, avgCost: 200, currentPrice: 250 }, token)).body;
  for (let i = 1; i <= 12; i++) {
    const d = new Date(Date.UTC(2026, 9 - i, 1)); // months before Oct 2026
    const ym = d.toISOString().slice(0, 7);
    await app.post('/api/transactions', { accountId: chk.id, type: 'income', amount: 6000, category: 'Salary', date: `${ym}-01` }, token);
    await app.post('/api/transactions', { accountId: chk.id, type: 'expense', amount: 1800, category: 'Housing', date: `${ym}-02` }, token);
    await app.post('/api/transactions', { accountId: chk.id, type: 'expense', amount: 600, category: 'Food & Dining', date: `${ym}-15` }, token);
    await app.post('/api/transactions', { accountId: chk.id, type: 'expense', amount: 1000, category: 'Investment', date: `${ym}-03` }, token);
    await app.post(`/api/investments/${inv.id}/transactions`, { type: 'buy', shares: 4, pricePerShare: 250, date: `${ym}-04` }, token);
  }
  await app.post('/api/goals', { name: 'Emergency fund', targetAmount: 20000, currentAmount: 5000, priority: 'high', deadline: '2027-10-01' }, token);
  return { chk, inv };
}

describe('API: simulation', () => {
  let app: TestApp;
  let token: string;
  let userId: string;
  before(async () => {
    app = await launch();
    const reg = await app.register('fin-test', 'folio');
    token = reg.token;
    userId = reg.user.id;
    await seedHistory(app, token);
  });
  after(async () => { await app.close(); });

  test('GET /api/simulate/catalog is public and lists presets and templates', async () => {
    const res = await app.get('/api/simulate/catalog');
    assert.equal(res.status, 200);
    assert.ok(res.body.economyPresets.length >= 5);
    assert.ok(res.body.eventTemplates.some((t: any) => t.id === 'buy_home'));
    assert.equal(res.body.defaultPolicy.emergencyFundMonths, 6);
    assert.equal(res.body.defaultProfile.retirementAge, 65);
  });

  describe('profile', () => {
    test('defaults until set, then persists', async () => {
      const d = await app.get('/api/profile', token);
      assert.equal(d.status, 200);
      assert.equal(d.body.isDefault, true);
      assert.equal(d.body.retirementAge, 65);

      assert.equal((await app.put('/api/profile', undefined, token)).status, 400);

      const put = await app.put('/api/profile', { birthDate: '1986-07-10', retirementAge: 65, safeWithdrawalRate: 0.04, planToAge: 90 }, token);
      assert.equal(put.status, 200);
      assert.equal(put.body.isDefault, false);
      assert.equal(put.body.age, 40, 'age on the frozen clock');
      assert.equal(put.body.updatedAt, '2026-10-25T12:00:00.000Z');

      const partial = await app.put('/api/profile', { retirementAge: 60 }, token);
      assert.equal(partial.body.retirementAge, 60);
      assert.equal(partial.body.birthDate, '1986-07-10', 'partial update keeps other fields');

      const bad = await app.put('/api/profile', { birthDate: 'nope', retirementAge: 65 }, token);
      assert.equal(bad.body.birthDate, '1986-07-10', 'invalid date ignored');
      assert.equal((await app.get('/api/profile', token)).body.retirementAge, 65);
    });

    test('requires auth', async () => {
      assert.equal((await app.get('/api/profile')).status, 401);
    });
  });

  describe('baseline', () => {
    test('derives figures from the seeded history', async () => {
      const res = await app.get('/api/simulate/baseline', token);
      assert.equal(res.status, 200);
      const b = res.body.baseline;
      assert.equal(b.asOf, TEST_TODAY);
      // checking: 12000 + 12×(6000 − 3400) = 43200 ; savings 30000
      assert.equal(b.liquid, 73200);
      assert.equal(b.debt, 1500);
      assert.equal(b.invested, (400 + 48) * 250);
      assert.equal(b.monthlyIncome, 6000);
      assert.equal(b.monthlyExpenses, 2400);
      assert.equal(b.monthlyContribution, 1000);
      assert.equal(b.lookbackMonths, 12);
      assert.equal(res.body.profile.birthDate, '1986-07-10');
      const short = await app.get('/api/simulate/baseline?lookback=3', token);
      assert.equal(short.body.baseline.lookbackMonths, 3);
    });
  });

  describe('POST /api/simulate', () => {
    test('runs the baseline scenario when no scenario is given', async () => {
      const res = await app.post('/api/simulate', {}, token);
      assert.equal(res.status, 200);
      assert.equal(res.body.scenario.name, 'Baseline');
      assert.equal(res.body.result.months.length, 597, 'until age 90');
      assert.equal(res.body.result.yearly.length, 50);
      assert.equal(res.body.montecarlo, null);
      assert.equal(res.body.result.summary.fire.retirementMonth, 297);
      assert.equal(res.body.result.summary.runway.cashMonths, 30.5);
      assert.equal(res.body.goals.length, 1);
      assert.equal(res.body.goals[0].name, 'Emergency fund');
      assert.equal(res.body.goals[0].status, 'on_track');
    });

    test('inline scenario with events, Monte Carlo and trimmed months', async () => {
      const res = await app.post('/api/simulate', {
        scenario: {
          name: 'Sabbatical',
          horizonYears: 10,
          economy: { preset: 'pessimistic' },
          events: [{ kind: 'income', template: 'sabbatical', label: 'Year off', startMonth: 12, durationMonths: 12, percent: -1 }],
        },
        montecarlo: { trials: 50, seed: 3 },
        includeMonths: false,
      }, token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.result.months, []);
      assert.equal(res.body.result.yearly.length, 10);
      assert.equal(res.body.scenario.economy.expectedReturn, 0.04);
      assert.equal(res.body.montecarlo.trials, 50);
      assert.equal(res.body.montecarlo.seed, 3);
      assert.equal(res.body.montecarlo.netWorthBands.length, 10);
      assert.ok(res.body.montecarlo.successProbability > 0.9);
      // sabbatical year earns nothing: year-2 income should be ~0
      assert.equal(res.body.result.yearly[1].income, 0);
    });

    test('montecarlo: true uses defaults and is reproducible', async () => {
      const a = await app.post('/api/simulate', { scenario: { name: 'x', horizonYears: 3 }, montecarlo: true, includeMonths: false }, token);
      const b = await app.post('/api/simulate', { scenario: { name: 'x', horizonYears: 3 }, montecarlo: true, includeMonths: false }, token);
      assert.equal(a.body.montecarlo.trials, 500);
      assert.equal(a.body.montecarlo.seed, 42);
      assert.deepEqual(a.body.montecarlo, b.body.montecarlo);
    });

    test('validation errors are 400', async () => {
      const bad = await app.post('/api/simulate', { scenario: { name: 'bad', events: [{ kind: 'income' }] } }, token);
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /needs percent or amount/);
      const notArr = await app.post('/api/simulate', { scenario: { events: 'x' } }, token);
      assert.equal(notArr.status, 400);
      const missing = await app.post('/api/simulate', { scenarioId: 'nope' }, token);
      assert.equal(missing.status, 404);
    });
  });

  describe('scenarios CRUD + run', () => {
    let id: string;

    test('create validates and stores a normalised scenario', async () => {
      const bad = await app.post('/api/scenarios', { name: 'bad', events: [{ kind: 'wat' }] }, token);
      assert.equal(bad.status, 400);

      const res = await app.post('/api/scenarios', {
        name: 'Buy a flat',
        description: 'Flat in 2028',
        horizonYears: 30,
        economy: { preset: 'moderate', inflation: 0.03 },
        events: [{ kind: 'property', template: 'buy_home', label: 'Flat', startMonth: 15, price: 350000, downPayment: 70000, mortgageRate: 0.045, mortgageYears: 25, rentReplaced: 1800, ownershipCosts: 400 }],
      }, token);
      assert.equal(res.status, 201);
      id = res.body.id;
      assert.ok(id);
      assert.equal(res.body.userId, userId);
      assert.equal(res.body.createdAt, '2026-10-25T12:00:00.000Z');
      assert.equal(res.body.economy.inflation, 0.03);
      assert.equal(res.body.economy.expectedReturn, 0.07, 'filled from preset');
      assert.equal(res.body.policy.emergencyFundMonths, 6);
      assert.equal(res.body.events[0].id, 'event-1');
    });

    test('list / get / update / ownership', async () => {
      const list = await app.get('/api/scenarios', token);
      assert.equal(list.body.length, 1);
      const one = await app.get(`/api/scenarios/${id}`, token);
      assert.equal(one.body.name, 'Buy a flat');

      const upd = await app.put(`/api/scenarios/${id}`, { name: 'Buy a flat (2028)', horizonYears: 25 }, token);
      assert.equal(upd.status, 200);
      assert.equal(upd.body.name, 'Buy a flat (2028)');
      assert.equal(upd.body.horizonYears, 25);
      assert.equal(upd.body.events.length, 1, 'partial update keeps events');
      assert.equal(upd.body.id, id);

      const badUpd = await app.put(`/api/scenarios/${id}`, { events: 'x' }, token);
      assert.equal(badUpd.status, 400);

      const other = await app.register('intruder', 'pw');
      assert.equal((await app.get(`/api/scenarios/${id}`, other.token)).status, 404);
      assert.equal((await app.put(`/api/scenarios/${id}`, { name: 'hack' }, other.token)).status, 404);
      assert.equal((await app.del(`/api/scenarios/${id}`, other.token)).status, 404);
      assert.equal((await app.get(`/api/scenarios/${id}/run`, other.token)).status, 404);
      assert.equal((await app.get('/api/scenarios', other.token)).body.length, 0);
    });

    test('run a stored scenario with query options', async () => {
      const res = await app.get(`/api/scenarios/${id}/run?montecarlo=1&trials=40&seed=9&months=0`, token);
      assert.equal(res.status, 200);
      assert.equal(res.body.scenario.id, id);
      assert.deepEqual(res.body.result.months, []);
      assert.equal(res.body.result.yearly.length, 25);
      assert.equal(res.body.montecarlo.trials, 40);
      assert.equal(res.body.montecarlo.seed, 9);
      // the property shows up from year 2
      assert.equal(res.body.result.yearly[0].property, 0);
      assert.ok(res.body.result.yearly[1].property > 350000);
      assert.ok(res.body.result.yearly[1].mortgage > 0);

      const plain = await app.get(`/api/scenarios/${id}/run`, token);
      assert.equal(plain.body.montecarlo, null);
      assert.equal(plain.body.result.months.length, 300);

      const byId = await app.post('/api/simulate', { scenario: { id } }, token);
      assert.equal(byId.body.scenario.name, 'Buy a flat (2028)');
      const byKey = await app.post('/api/simulate', { scenarioId: id, includeMonths: false }, token);
      assert.equal(byKey.body.scenario.name, 'Buy a flat (2028)');
    });

    test('delete', async () => {
      assert.equal((await app.del(`/api/scenarios/${id}`, token)).status, 200);
      assert.equal((await app.del(`/api/scenarios/${id}`, token)).status, 404);
      assert.equal((await app.get(`/api/scenarios/${id}/run`, token)).status, 404);
    });
  });

  describe('compare', () => {
    test('deltas relative to the first scenario', async () => {
      const saved = (await app.post('/api/scenarios', { name: 'Stored', horizonYears: 5 }, token)).body;
      const res = await app.post('/api/simulate/compare', {
        scenarios: [
          { name: 'Base', horizonYears: 5 },
          { name: 'Child', horizonYears: 5, events: [{ kind: 'expense', amount: 1000, startMonth: 0 }] },
          { id: saved.id },
        ],
      }, token);
      assert.equal(res.status, 200);
      assert.equal(res.body.results.length, 3);
      assert.equal(res.body.deltas.length, 2);
      assert.deepEqual(res.body.results.map((r: any) => r.months), [[], [], []]);
      assert.equal(res.body.deltas[0].alt, 'Child');
      assert.ok(res.body.deltas[0].endNetWorth < -60000, 'five years of an extra 1 000/month costs more than 60k');
      assert.equal(res.body.deltas[1].alt, 'Stored');
      assert.equal(res.body.deltas[1].endNetWorth, 0, 'identical scenarios');
      assert.equal(res.body.deltas[0].yearly.length, 5);
    });

    test('validation', async () => {
      assert.equal((await app.post('/api/simulate/compare', {}, token)).status, 400);
      assert.equal((await app.post('/api/simulate/compare', { scenarios: [] }, token)).status, 400);
      assert.equal((await app.post('/api/simulate/compare', { scenarios: [{ id: 'missing' }] }, token)).status, 404);
      assert.equal((await app.post('/api/simulate/compare', { scenarios: Array(9).fill({ name: 'x' }) }, token)).status, 400);
    });
  });

  describe('opportunity cost', () => {
    test('computes with defaults and with explicit rates', async () => {
      const res = await app.post('/api/simulate/opportunity-cost', { monthly: 150, years: 25 }, token);
      assert.equal(res.status, 200);
      assert.equal(res.body.input.annualReturn, 0.07);
      assert.equal(res.body.totalSpent, 45000);
      assert.ok(res.body.futureValue > 110000);
      assert.equal(res.body.ageAtEnd, 65);
      assert.equal(res.body.series.length, 26);

      const flat = await app.post('/api/simulate/opportunity-cost', { oneOff: 1000, years: 10, annualReturn: 0, inflation: 0 }, token);
      assert.equal(flat.body.futureValue, 1000);
    });

    test('validation', async () => {
      assert.equal((await app.post('/api/simulate/opportunity-cost', { monthly: 100 }, token)).status, 400);
      assert.equal((await app.post('/api/simulate/opportunity-cost', { years: 5 }, token)).status, 400);
      assert.equal((await app.post('/api/simulate/opportunity-cost', { years: 5, monthly: -3 }, token)).status, 400);
    });
  });

  describe('outlook', () => {
    test('compact forward-looking numbers for the dashboard', async () => {
      const res = await app.get('/api/simulate/outlook', token);
      assert.equal(res.status, 200);
      assert.equal(res.body.hasHistory, true);
      assert.equal(res.body.monthlyExpenses, 2400);
      assert.equal(res.body.runway.cashMonths, 30.5);
      assert.equal(res.body.fire.fiNumber, 720000);
      assert.ok(res.body.fire.fiDate);
      assert.equal(res.body.fire.retirementAge, 65);
      assert.equal(res.body.yearly.length, 50);
      assert.ok(res.body.netWorthAtRetirement > 0);
    });

    test('a brand-new user gets an outlook without history', async () => {
      const fresh = await app.register('newbie', 'pw');
      const res = await app.get('/api/simulate/outlook', fresh.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.hasHistory, false);
      assert.equal(res.body.runway.cashMonths, null);
      assert.equal(res.body.fire.fiNumber, 0);
    });
  });
});
