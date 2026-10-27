import { router } from '../server/router.js';
import { db } from '../db/database.js';
import { today } from '../util/clock.js';
import type { ServerResponse } from 'node:http';
import {
  ECONOMY_PRESETS,
  effectiveBaseline,
  EVENT_CATALOG,
  DEFAULT_POLICY,
  DEFAULT_PROFILE,
  DEFAULT_ECONOMY,
  deriveBaseline,
  simulate,
  runMonteCarlo,
  compareResults,
  opportunityCost,
  goalFeasibility,
  normalizeScenario,
  normalizeProfile,
  baselineScenario,
  ageAt,
  type Profile,
  type Scenario,
  type SimulationInput,
  type SimulationResult,
} from '../sim/index.js';

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function query(req: any): URLSearchParams {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).searchParams;
}

function numParam(v: string | null | undefined, fallback: number): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Profile for a user: stored one or the defaults. */
function profileFor(userId: string): Profile & { isDefault: boolean } {
  const stored = db.getProfile(userId);
  if (!stored) return { ...DEFAULT_PROFILE, isDefault: true };
  const { userId: _u, updatedAt: _t, ...profile } = stored;
  return { ...profile, isDefault: false };
}

/** Resolve a scenario from a payload: either `{ id }` of a stored one, or an inline definition. */
function resolveScenario(userId: string, raw: any): Scenario {
  if (raw && typeof raw === 'object' && typeof raw.id === 'string' && Object.keys(raw).length === 1) {
    const stored = db.getScenario(raw.id);
    if (!stored || stored.userId !== userId) throw new HttpError(404, `Scenario ${raw.id} not found`);
    return storedToScenario(stored);
  }
  try {
    return normalizeScenario(raw);
  } catch (err: any) {
    throw new HttpError(400, err.message);
  }
}

function storedToScenario(stored: ReturnType<typeof db.getScenario> & object): Scenario {
  const { userId: _u, createdAt: _c, updatedAt: _m, ...scenario } = stored;
  return scenario;
}

/** Assemble the engine input for a user. */
function buildInput(userId: string, scenario: Scenario, lookbackMonths?: number): SimulationInput & { goals: ReturnType<typeof db.getGoals> } {
  const src = db.getSimulationSource(userId);
  const baseline = deriveBaseline(src, { asOf: today(), lookbackMonths });
  const { isDefault: _d, ...profile } = profileFor(userId);
  return { baseline, profile, scenario, goals: src.goals };
}

interface MonteCarloRequest {
  trials?: number;
  seed?: number;
}

function parseMonteCarlo(raw: unknown): MonteCarloRequest | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return {};
  if (typeof raw === 'object') {
    const o = raw as any;
    return {
      trials: typeof o.trials === 'number' ? o.trials : undefined,
      seed: typeof o.seed === 'number' ? o.seed : undefined,
    };
  }
  return null;
}

function stripMonths(result: SimulationResult): SimulationResult {
  return { ...result, months: [] };
}

/** Run a scenario for a user and build the standard response envelope. */
function runForUser(userId: string, scenario: Scenario, opts: { montecarlo: MonteCarloRequest | null; lookback?: number; includeMonths: boolean }) {
  const { goals, ...input } = buildInput(userId, scenario, opts.lookback);
  const result = simulate(input);
  const montecarlo = opts.montecarlo ? runMonteCarlo(input, opts.montecarlo) : null;
  return {
    asOf: input.baseline.asOf,
    baseline: input.baseline,
    profile: input.profile,
    scenario,
    result: opts.includeMonths ? result : stripMonths(result),
    montecarlo,
    goals: goalFeasibility(goals, result, effectiveBaseline(input.baseline, scenario).monthlyContribution),
  };
}

function handle(fn: () => void | Promise<void>, res: ServerResponse) {
  return Promise.resolve()
    .then(fn)
    .catch(err => {
      if (err instanceof HttpError) return json(res, { error: err.message }, err.status);
      throw err;
    });
}

// ── Catalog (static, public) ────────────────────────────────────────────────
router.get('/api/simulate/catalog', async (_req, res) => {
  json(res, {
    economyPresets: ECONOMY_PRESETS,
    eventTemplates: EVENT_CATALOG,
    defaultPolicy: DEFAULT_POLICY,
    defaultProfile: DEFAULT_PROFILE,
    defaultEconomy: DEFAULT_ECONOMY,
  });
}, false);

// ── Profile ─────────────────────────────────────────────────────────────────
router.get('/api/profile', async (req, res) => {
  const userId = (req as any).userId;
  const profile = profileFor(userId);
  json(res, { ...profile, age: Math.floor(ageAt(profile.birthDate, today())) });
});

router.put('/api/profile', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  if (!body || typeof body !== 'object') return json(res, { error: 'Profile body required' }, 400);
  const current = profileFor(userId);
  const { isDefault: _d, ...base } = current;
  const profile = normalizeProfile(body, base);
  const saved = db.upsertProfile(userId, profile);
  await db.persist();
  json(res, { ...profile, isDefault: false, age: Math.floor(ageAt(profile.birthDate, today())), updatedAt: saved.updatedAt });
});

// ── Scenarios CRUD ──────────────────────────────────────────────────────────
router.get('/api/scenarios', async (req, res) => {
  const userId = (req as any).userId;
  json(res, db.getScenarios(userId));
});

router.post('/api/scenarios', async (req, res, _match, body) =>
  handle(async () => {
    const userId = (req as any).userId;
    let scenario: Scenario;
    try {
      scenario = normalizeScenario(body);
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    delete scenario.id;
    const saved = db.createScenario(userId, scenario);
    await db.persist();
    json(res, saved, 201);
  }, res));

router.get('/api/scenarios/:id', async (req, res, match) => {
  const userId = (req as any).userId;
  const s = db.getScenario(match[1]);
  if (!s || s.userId !== userId) return json(res, { error: 'Not found' }, 404);
  json(res, s);
});

router.put('/api/scenarios/:id', async (req, res, match, body) =>
  handle(async () => {
    const userId = (req as any).userId;
    const existing = db.getScenario(match[1]);
    if (!existing || existing.userId !== userId) throw new HttpError(404, 'Not found');
    let scenario: Scenario;
    try {
      // Allow partial updates: merge over the stored definition, then re-validate.
      scenario = normalizeScenario({ ...storedToScenario(existing), ...(body || {}) });
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    const saved = db.updateScenario(match[1], scenario);
    await db.persist();
    json(res, saved);
  }, res));

router.delete('/api/scenarios/:id', async (req, res, match) => {
  const userId = (req as any).userId;
  const existing = db.getScenario(match[1]);
  if (!existing || existing.userId !== userId) return json(res, { error: 'Not found' }, 404);
  db.deleteScenario(match[1]);
  await db.persist();
  json(res, { success: true });
});

router.get('/api/scenarios/:id/run', async (req, res, match) =>
  handle(() => {
    const userId = (req as any).userId;
    const existing = db.getScenario(match[1]);
    if (!existing || existing.userId !== userId) throw new HttpError(404, 'Not found');
    const q = query(req);
    const mc = q.get('montecarlo');
    const montecarlo = mc && mc !== '0' && mc !== 'false'
      ? { trials: numParam(q.get('trials'), 500), seed: numParam(q.get('seed'), 42) }
      : null;
    json(res, runForUser(userId, storedToScenario(existing), {
      montecarlo,
      lookback: q.has('lookback') ? numParam(q.get('lookback'), 12) : undefined,
      includeMonths: q.get('months') !== '0',
    }));
  }, res));

// ── Simulation ──────────────────────────────────────────────────────────────
router.get('/api/simulate/baseline', async (req, res) => {
  const userId = (req as any).userId;
  const q = query(req);
  const lookback = q.has('lookback') ? numParam(q.get('lookback'), 12) : undefined;
  const src = db.getSimulationSource(userId);
  const baseline = deriveBaseline(src, { asOf: today(), lookbackMonths: lookback });
  json(res, { baseline, profile: profileFor(userId) });
});

router.post('/api/simulate', async (req, res, _match, body) =>
  handle(() => {
    const userId = (req as any).userId;
    const payload = body && typeof body === 'object' ? body : {};
    const scenario = payload.scenario !== undefined
      ? resolveScenario(userId, payload.scenario)
      : payload.scenarioId
        ? resolveScenario(userId, { id: payload.scenarioId })
        : baselineScenario();
    json(res, runForUser(userId, scenario, {
      montecarlo: parseMonteCarlo(payload.montecarlo),
      lookback: typeof payload.lookback === 'number' ? payload.lookback : undefined,
      includeMonths: payload.includeMonths !== false,
    }));
  }, res));

router.post('/api/simulate/compare', async (req, res, _match, body) =>
  handle(() => {
    const userId = (req as any).userId;
    const list = body?.scenarios;
    if (!Array.isArray(list) || list.length < 1) throw new HttpError(400, 'scenarios must be a non-empty array');
    if (list.length > 8) throw new HttpError(400, 'compare at most 8 scenarios');
    const scenarios = list.map(raw => resolveScenario(userId, raw));
    const lookback = typeof body.lookback === 'number' ? body.lookback : undefined;
    const { goals: _g, ...first } = buildInput(userId, scenarios[0], lookback);
    const results = scenarios.map(s => simulate({ ...first, scenario: s }));
    json(res, {
      asOf: first.baseline.asOf,
      baseline: first.baseline,
      profile: first.profile,
      scenarios,
      results: results.map(stripMonths),
      deltas: results.slice(1).map(r => compareResults(results[0], r)),
    });
  }, res));

router.post('/api/simulate/opportunity-cost', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  const b = body && typeof body === 'object' ? body : {};
  const years = Number(b.years);
  if (!Number.isFinite(years) || years <= 0) return json(res, { error: 'years must be a positive number' }, 400);
  const oneOff = Number(b.oneOff) || 0;
  const monthly = Number(b.monthly) || 0;
  if (oneOff <= 0 && monthly <= 0) return json(res, { error: 'oneOff or monthly must be positive' }, 400);
  const profile = profileFor(userId);
  const annualReturn = Number.isFinite(Number(b.annualReturn)) && b.annualReturn !== undefined ? Number(b.annualReturn) : DEFAULT_ECONOMY.expectedReturn;
  const inflation = Number.isFinite(Number(b.inflation)) && b.inflation !== undefined ? Number(b.inflation) : DEFAULT_ECONOMY.inflation;
  json(res, {
    input: { oneOff, monthly, years, annualReturn, inflation },
    ageAtEnd: Math.floor(ageAt(profile.birthDate, today()) + years),
    ...opportunityCost({ oneOff, monthly, years, annualReturn, inflation }),
  });
});

/** Compact forward-looking numbers for the dashboard (baseline scenario, no Monte Carlo). */
router.get('/api/simulate/outlook', async (req, res) => {
  const userId = (req as any).userId;
  const { goals: _g, ...input } = buildInput(userId, baselineScenario());
  const result = simulate(input);
  const { fire, runway } = result.summary;
  json(res, {
    asOf: input.baseline.asOf,
    hasHistory: input.baseline.monthlyIncome > 0 || input.baseline.monthlyExpenses > 0,
    monthlyIncome: input.baseline.monthlyIncome,
    monthlyExpenses: input.baseline.monthlyExpenses,
    monthlyContribution: input.baseline.monthlyContribution,
    runway,
    fire: {
      fiNumber: fire.fiNumber,
      progress: fire.progress,
      fiDate: fire.fiDate,
      fiAge: fire.fiAge,
      fiByRetirement: fire.fiByRetirement,
      coastFiMonth: fire.coastFiMonth,
      retirementAge: fire.retirementAge,
    },
    netWorthAtRetirement: result.summary.netWorthAtRetirement,
    endNetWorth: result.summary.endNetWorth,
    yearly: result.yearly.map(y => ({ year: y.year, age: y.age, netWorth: y.netWorth, realNetWorth: y.realNetWorth })),
  });
});
