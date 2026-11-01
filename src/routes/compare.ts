/**
 * Compare routes.
 *
 *   GET  /api/compare/format             what a snapshot contains / leaves out, version, limits (public)
 *   GET  /api/compare/snapshot?label=…   my snapshot, ready to download
 *   POST /api/compare                    { snapshot, label? } → the side-by-side report
 *   POST /api/compare/whatif             { extraSaving, extraInvesting } → my outlook if I saved / invested that much more a month
 *   POST /api/compare/pdf                { snapshot, label?, whatIf? } → the report as a PDF (application/pdf)
 *
 * Nothing here writes to the database: snapshots are computed on request from
 * the pure engines (see src/compare/snapshot.ts), and an imported snapshot is
 * validated, compared and forgotten — it is never stored, cached or logged.
 */
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { router } from '../server/router.js';
import { db } from '../db/database.js';
import { nowIso, today } from '../util/clock.js';
import { DEFAULT_PROFILE, baselineScenario, deriveBaseline, monthsBetween, round2, round4, simulate, type Profile, type Scenario } from '../sim/index.js';
import { buildSnapshot, normalizeLabel, snapshotFileName, type SnapshotSource } from '../compare/snapshot.js';
import { validateSnapshot } from '../compare/schema.js';
import { compareSnapshots } from '../compare/engine.js';
import { comparePdfFileName, renderComparePdf } from '../compare/pdf-report.js';
import { DEFAULT_LABEL, SNAPSHOT_EXCLUDES, SNAPSHOT_FILE_SUFFIX, SNAPSHOT_FORMAT, SNAPSHOT_INCLUDES, SNAPSHOT_LIMITS, SNAPSHOT_VERSION, type Snapshot } from '../compare/types.js';

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** The app version from package.json (read once; "0.0.0" when unavailable, e.g. in a single-file binary). */
export const APP_VERSION: string = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

/** Everything the snapshot builder needs for a user, read from the database. */
export function snapshotSourceFor(userId: string): SnapshotSource {
  const stored = db.getProfile(userId);
  let profile: SnapshotSource['profile'];
  if (stored) {
    const { userId: _u, updatedAt: _t, ...p } = stored;
    profile = p;
  }
  return {
    ...db.getSimulationSource(userId),
    budgets: db.getBudgets(userId),
    profile,
    ...db.getMotivationSource(userId),
  };
}

/** Build the user's snapshot as of the server's "today". */
export function snapshotFor(userId: string, label?: string): Snapshot {
  return buildSnapshot(snapshotSourceFor(userId), { today: today(), now: nowIso(), label, appVersion: APP_VERSION });
}

router.get('/api/compare/format', async (_req, res) => {
  json(res, {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    fileSuffix: SNAPSHOT_FILE_SUFFIX,
    defaultLabel: DEFAULT_LABEL,
    limits: SNAPSHOT_LIMITS,
    includes: SNAPSHOT_INCLUDES,
    excludes: SNAPSHOT_EXCLUDES,
  });
}, false);

router.get('/api/compare/snapshot', async (req, res) => {
  const userId = (req as any).userId;
  const q = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).searchParams;
  const snapshot = snapshotFor(userId, normalizeLabel(q.get('label')));
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${snapshotFileName(snapshot.label)}"`,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(snapshot, null, 2));
});

/**
 * Validate an imported snapshot and compare it with the user's own, built live.
 * Returns the report and the two snapshots as used (the imported one as validated).
 * Throws `{ status, error }` for a bad file or a self-comparison.
 */
export function compareFor(userId: string, body: unknown): { report: ReturnType<typeof compareSnapshots>; mine: Snapshot; theirs: Snapshot } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const raw = b.snapshot;
  if (raw === undefined || raw === null) throw { status: 400, error: 'snapshot required — the parsed contents of a .finfolio-compare.json file' };
  const v = validateSnapshot(raw);
  if (v.ok === false) throw { status: 400, error: `This file cannot be compared: ${v.errors[0]}` };
  const theirs = v.snapshot;
  if (typeof b.label === 'string' && b.label.trim()) theirs.label = normalizeLabel(b.label);
  const mine = snapshotFor(userId, 'You');
  if (mine.checksum === theirs.checksum) throw { status: 400, error: 'This is your own snapshot — import one from someone else to compare.' };
  return { report: compareSnapshots(mine, theirs, { now: nowIso() }), mine, theirs };
}

router.post('/api/compare', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  try {
    const { report, mine, theirs } = compareFor(userId, body);
    res.setHeader('Cache-Control', 'no-store');
    json(res, { report, mine, theirs });
  } catch (err: any) {
    if (err && typeof err.status === 'number') return json(res, { error: err.error }, err.status);
    throw err;
  }
});

// ── What if I saved / invested more? ────────────────────────────────────────

export interface WhatIfPoint {
  /** Monthly figures the run assumed. */
  monthlyExpenses: number;
  monthlyContribution: number;
  savingsRate: number;
  fiNumber: number;
  progress: number;
  fiDate: string | null;
  fiAge: number | null;
  yearsToFi: number | null;
  cashMonths: number | null;
  netWorthAtRetirement: number | null;
  endRealNetWorth: number;
}

/** Largest extra amount per month the sliders offer: half of current spending, rounded down to 25. */
export function whatIfMax(monthlyExpenses: number): number {
  return Math.max(0, Math.floor((monthlyExpenses * 0.5) / 25) * 25);
}

/**
 * Run my baseline with `extraSaving` less spending per month (kept as cash /
 * swept by the savings policy like any surplus) and `extraInvesting` less
 * spending that goes straight into investments (contribution up by the same
 * amount). Four runs: as-is, saving only, investing only, both.
 */
export function whatIfFor(userId: string, extraSaving: number, extraInvesting: number): { max: number; base: WhatIfPoint; saving: WhatIfPoint; investing: WhatIfPoint; both: WhatIfPoint } {
  const src = db.getSimulationSource(userId);
  const asOf = today();
  const baseline = deriveBaseline(src, { asOf });
  const stored = db.getProfile(userId);
  let profile: Profile = { ...DEFAULT_PROFILE };
  if (stored) { const { userId: _u, updatedAt: _t, ...p } = stored; profile = p; }
  const max = whatIfMax(baseline.monthlyExpenses);
  const clamp = (v: unknown) => Math.min(max, Math.max(0, Math.round((Number(v) || 0) / 25) * 25));
  const saving = clamp(extraSaving);
  const investing = clamp(extraInvesting);
  const run = (lessSpending: number, moreInvesting: number): WhatIfPoint => {
    const scenario: Scenario = baselineScenario('What if');
    if (lessSpending > 0 || moreInvesting > 0) {
      scenario.overrides = {
        monthlyExpenses: round2(Math.max(0, baseline.monthlyExpenses - lessSpending - moreInvesting)),
        monthlyContribution: round2(baseline.monthlyContribution + moreInvesting),
      };
    }
    const result = simulate({ baseline, profile, scenario });
    const expenses = scenario.overrides?.monthlyExpenses ?? baseline.monthlyExpenses;
    const contribution = scenario.overrides?.monthlyContribution ?? baseline.monthlyContribution;
    const { fire, runway } = result.summary;
    return {
      monthlyExpenses: expenses,
      monthlyContribution: contribution,
      savingsRate: baseline.monthlyIncome > 0 ? round4((baseline.monthlyIncome - expenses) / baseline.monthlyIncome) : 0,
      fiNumber: fire.fiNumber,
      progress: fire.progress,
      fiDate: fire.fiDate,
      fiAge: fire.fiAge,
      yearsToFi: fire.fiDate ? round2(Math.max(0, monthsBetween(asOf, `${fire.fiDate}-01`)) / 12) : null,
      cashMonths: runway.cashMonths,
      netWorthAtRetirement: result.summary.netWorthAtRetirement,
      endRealNetWorth: result.summary.endRealNetWorth,
    };
  };
  return { max, base: run(0, 0), saving: run(saving, 0), investing: run(0, investing), both: run(saving, investing) };
}

router.post('/api/compare/whatif', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  const b = body && typeof body === 'object' ? body : {};
  res.setHeader('Cache-Control', 'no-store');
  json(res, whatIfFor(userId, b.extraSaving, b.extraInvesting));
});

router.post('/api/compare/pdf', async (req, res, _match, body) => {
  const userId = (req as any).userId;
  try {
    const { report } = compareFor(userId, body);
    const b = body && typeof body === 'object' ? body : {};
    let whatIf: Parameters<typeof renderComparePdf>[0]['whatIf'] = null;
    if (b.whatIf && typeof b.whatIf === 'object') {
      const run = whatIfFor(userId, b.whatIf.extraSaving, b.whatIf.extraInvesting);
      const extraSaving = Math.round(run.base.monthlyExpenses - run.saving.monthlyExpenses);
      const extraInvesting = Math.round(run.investing.monthlyContribution - run.base.monthlyContribution);
      if (extraSaving > 0 || extraInvesting > 0) whatIf = { extraSaving, extraInvesting, result: { base: run.base, both: run.both } };
    }
    const pdf = renderComparePdf({ report, whatIf, generatedAt: nowIso() });
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="${comparePdfFileName(report.labels.theirs, today())}"`,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  } catch (err: any) {
    if (err && typeof err.status === 'number') return json(res, { error: err.error }, err.status);
    throw err;
  }
});
