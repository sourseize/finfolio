/**
 * `npm run test:compare` — seed fin and penny into a throw-away database, build
 * the four demo snapshots (fin, penny, Anonymous A, Anonymous B), run every
 * comparison fin and penny could make, and print the reports as plain ASCII
 * tables. A quick eyeball check of the comparison rules and the seed data —
 * no server, no browser, nothing written outside a temp folder.
 *
 * Options (after `--` when run through npm, e.g. `npm run test:compare -- --brief`;
 * the plain `npm run test:compare --brief --mine fin` form works too — npm turns
 * those into npm_config_* variables, which are read as a fallback):
 *   --mine fin|penny      only the comparisons made by that user (fin → vs penny, A, B; penny → vs fin, A, B)
 *   --brief               one packed line per comparison (at most 300 characters): score, key figures, top insight
 *   --spending            also print the spending-mix table
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../db/database.js';
import { getClockOverride, setClock } from '../util/clock.js';
import { seedFin, FIN_USERNAME, FIN_SEED_DATE } from '../seed/fin.js';
import { seedPenny, PENNY_USERNAME } from '../seed/penny.js';
import { anonymousPersonas, anonymousSnapshot } from '../seed/anonymous.js';
import { buildSnapshot, type SnapshotSource } from '../compare/snapshot.js';
import { compareSnapshots, type ComparisonReport, type MetricRow } from '../compare/engine.js';
import type { Snapshot } from '../compare/types.js';
import { periodLabel } from '../motivation/periods.js';

// ── Plain-ASCII output helpers ─────────────────────────────────────────────

/** Replace every non-ASCII character the engine may emit (em dashes, minus signs, ellipses, accents) with an ASCII stand-in. */
export function toAscii(s: string): string {
  return s
    .replace(/[\u2014\u2013\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e\n]/g, '');
}

const thousands = (n: number, digits: number) => {
  const fixed = Math.abs(n).toFixed(digits);
  const [int, frac] = fixed.split('.');
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
};

/** Format a metric value for its unit. */
export function formatValue(v: number | string | null, unit: MetricRow['unit']): string {
  if (v === null || v === undefined) return '-';
  switch (unit) {
    case 'money': return thousands(v as number, 2);
    case 'percent': return `${((v as number) * 100).toFixed(1)}%`;
    case 'months': return `${(v as number).toFixed(1)} mo`;
    case 'years': return `${(v as number).toFixed(1)} y`;
    case 'age': return (v as number).toFixed(1);
    case 'month': return periodLabel('monthly', String(v)).replace(/^(\w{3})\w* /, '$1 ');
    case 'bool': return v ? 'yes' : 'no';
    default: return thousands(v as number, 0);
  }
}

export function formatDelta(m: MetricRow): string {
  if (m.delta === null) return '-';
  const sign = m.delta > 0 ? '+' : '';
  switch (m.unit) {
    case 'money': return sign + thousands(m.delta, 2);
    case 'percent': return `${sign}${(m.delta * 100).toFixed(1)} pp`;
    case 'months': return `${sign}${m.delta.toFixed(1)} mo`;
    case 'years': return `${sign}${m.delta.toFixed(1)} y`;
    case 'age': return `${sign}${m.delta.toFixed(1)}`;
    case 'month': return `${sign}${m.delta} mo`;
    default: return sign + thousands(m.delta, 0);
  }
}

/** Render rows as an ASCII table; `align` marks right-aligned columns. */
export function asciiTable(header: string[], rows: string[][], align: ('l' | 'r')[] = []): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)));
  const line = `+${widths.map(w => '-'.repeat(w + 2)).join('+')}+`;
  const render = (r: string[]) => `|${r.map((c, i) => ` ${align[i] === 'r' ? (c ?? '').padStart(widths[i]) : (c ?? '').padEnd(widths[i])} `).join('|')}|`;
  return [line, render(header), line, ...rows.map(render), line].join('\n');
}

/** Longest line `renderBrief` produces. */
export const BRIEF_MAX = 300;

const k = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '-' : Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(digits)}k` : n.toFixed(0));
const p0 = (f: number | string | null) => (typeof f === 'number' ? `${Math.round(f * 100)}%` : '-');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2043-05" + 56.8 → "May'43@56"; no date → "none". */
const fiShort = (date: string | number | null, age: string | number | null) => (typeof date === 'string' ? `${MON[Number(date.slice(5, 7)) - 1]}'${date.slice(2, 4)}@${typeof age === 'number' ? Math.floor(age) : '?'}` : 'none');

/**
 * One line per comparison, packed: score, then the figures that matter most
 * (net worth, savings and investing rate, cash buffer, debt share, FI date@age,
 * best streak, badges, points), then the first insight, cut to BRIEF_MAX.
 */
export function renderBrief(r: ComparisonReport, mineName: string): string {
  const t = r.labels.theirs;
  const m = Object.fromEntries(r.metrics.map(x => [x.key, x]));
  const v = (key: string) => m[key];
  const parts = [
    `${mineName} vs ${t}: ${r.score.mine}-${r.score.theirs} (${r.score.ties} tie, ${r.score.scored} scored)`,
    `NW ${k(v('netWorth').mine as number)} v ${k(v('netWorth').theirs as number)}`,
    `save ${p0(v('savingsRate').mine)} v ${p0(v('savingsRate').theirs)}`,
    `inv ${p0(v('investingRate').mine)} v ${p0(v('investingRate').theirs)}`,
    `cash ${(v('cashMonths').mine as number | null)?.toFixed(1) ?? '-'} v ${(v('cashMonths').theirs as number | null)?.toFixed(1) ?? '-'}mo`,
    `debt ${p0(v('debtToAssets').mine)} v ${p0(v('debtToAssets').theirs)}`,
    `FI ${fiShort(v('fiDate').mine, v('fiAge').mine)} v ${fiShort(v('fiDate').theirs, v('fiAge').theirs)}`,
    `streak ${v('bestStreak').mine} v ${v('bestStreak').theirs}`,
    `badges ${v('badgesUnlocked').mine} v ${v('badgesUnlocked').theirs}`,
    `pts ${v('pointsEarned').mine} v ${v('pointsEarned').theirs}`,
  ];
  let line = toAscii(`${parts[0]} | ${parts.slice(1).join(', ')}`);
  const insight = r.insights[0] ? toAscii(` | ${r.insights[0].text}`) : '';
  if (insight && line.length + 8 < BRIEF_MAX) {
    line += insight.length + line.length <= BRIEF_MAX ? insight : `${insight.slice(0, BRIEF_MAX - line.length - 3)}...`;
  }
  return line.slice(0, BRIEF_MAX);
}

export function renderReport(r: ComparisonReport, mineName: string, opts: { brief?: boolean; spending?: boolean } = {}): string {
  if (opts.brief) return renderBrief(r, mineName);
  const out: string[] = [];
  const theirs = r.labels.theirs;
  out.push('='.repeat(78));
  out.push(`${mineName} vs ${theirs}   (as of ${r.asOf.mine} / ${r.asOf.theirs}, ${r.currency.mine} / ${r.currency.theirs})`);
  out.push('='.repeat(78));
  out.push(`Score: ${mineName} ${r.score.mine} - ${theirs} ${r.score.theirs}   (${r.score.ties} tie${r.score.ties === 1 ? '' : 's'}, ${r.score.scored} of ${r.metrics.length} metrics scored)`);
  for (const w of r.warnings) out.push(`Warning: ${w}`);
  {
    out.push('');
    const rows = r.metrics.map(m => [
      m.group,
      m.label,
      formatValue(m.mine, m.unit),
      formatValue(m.theirs, m.unit),
      formatDelta(m),
      m.leader === 'mine' ? mineName : m.leader === 'theirs' ? theirs : m.leader === 'tie' ? 'tie' : '-',
      m.note ?? '',
    ]);
    out.push(asciiTable(['Group', 'Metric', mineName, theirs, 'Delta', 'Leader', 'Note'], rows, ['l', 'l', 'r', 'r', 'r', 'l', 'l']));
  }
  if (opts.spending) {
    out.push('');
    out.push('Spending mix (average per month, share of spending):');
    const rows = r.spending.map(c => [
      c.category,
      c.mine ? thousands(c.mine.monthly, 2) : '-',
      c.mine ? `${(c.mine.share * 100).toFixed(1)}%` : '-',
      c.theirs ? thousands(c.theirs.monthly, 2) : '-',
      c.theirs ? `${(c.theirs.share * 100).toFixed(1)}%` : '-',
      `${c.shareDelta > 0 ? '+' : ''}${(c.shareDelta * 100).toFixed(1)} pp`,
    ]);
    out.push(asciiTable(['Category', `${mineName} / mo`, 'share', `${theirs} / mo`, 'share', 'Delta'], rows, ['l', 'r', 'r', 'r', 'r', 'r']));
  }
  out.push('');
  out.push('Insights:');
  for (const i of r.insights) out.push(`  [${i.tone === 'lead' ? '+' : i.tone === 'behind' ? '-' : '='}] ${i.text}`);
  out.push('');
  return toAscii(out.join('\n'));
}

// ── Data ───────────────────────────────────────────────────────────────────

function sourceFor(db: Database, userId: string): SnapshotSource {
  const stored = db.getProfile(userId);
  let profile: SnapshotSource['profile'];
  if (stored) {
    const { userId: _u, updatedAt: _t, ...p } = stored;
    profile = p;
  }
  return { ...db.getSimulationSource(userId), budgets: db.getBudgets(userId), profile, ...db.getMotivationSource(userId) };
}

/** Build the four demo snapshots in a throw-away data dir. */
export async function demoSnapshots(): Promise<Record<'fin' | 'penny' | 'anonymousA' | 'anonymousB', Snapshot>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finfolio-compare-cli-'));
  const previousClock = getClockOverride();
  try {
    const db = new Database();
    await db.init(dir);
    const fin = await seedFin(db, { persist: false });
    const penny = await seedPenny(db, { persist: false });
    setClock(`${FIN_SEED_DATE}T09:00:00.000Z`);
    const opts = { today: FIN_SEED_DATE, now: `${FIN_SEED_DATE}T09:00:00.000Z` };
    const [a, b] = anonymousPersonas(FIN_SEED_DATE);
    return {
      fin: buildSnapshot(sourceFor(db, fin.userId), { ...opts, label: 'Fin' }),
      penny: buildSnapshot(sourceFor(db, penny.userId), { ...opts, label: 'Penny' }),
      anonymousA: anonymousSnapshot(a),
      anonymousB: anonymousSnapshot(b),
    };
  } finally {
    setClock(previousClock);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Flags from argv, or from the npm_config_* variables npm sets for `npm run test:compare --brief --mine fin`. */
export function readOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): { brief: boolean; spending: boolean; mine: string | null } {
  const flag = (name: string) => argv.includes(`--${name}`) || env[`npm_config_${name}`] === 'true';
  const mineArg = argv.find((a, i) => argv[i - 1] === '--mine') ?? argv.find(a => a.startsWith('--mine='))?.slice('--mine='.length) ?? (typeof env.npm_config_mine === 'string' && env.npm_config_mine !== 'true' ? env.npm_config_mine : null);
  const mine = mineArg ? mineArg.toLowerCase() : null;
  if (mine && mine !== FIN_USERNAME && mine !== PENNY_USERNAME) throw new Error(`--mine must be ${FIN_USERNAME} or ${PENNY_USERNAME}`);
  return { brief: flag('brief'), spending: flag('spending'), mine };
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { brief, spending, mine: mineArg } = readOptions(argv, env);

  const snaps = await demoSnapshots();
  const others: Snapshot[] = [snaps.fin, snaps.penny, snaps.anonymousA, snaps.anonymousB];
  const now = `${FIN_SEED_DATE}T09:00:00.000Z`;
  const sections: string[] = [];
  for (const [name, mine] of [[FIN_USERNAME, snaps.fin], [PENNY_USERNAME, snaps.penny]] as [string, Snapshot][]) {
    if (mineArg && mineArg !== name) continue;
    for (const theirs of others) {
      if (theirs === mine) continue;
      const report = compareSnapshots({ ...mine, label: 'You' }, theirs, { now });
      sections.push(renderReport(report, name, { brief, spending }));
    }
  }
  const text = sections.join('\n');
  console.log(text);
  return text;
}

const isDirectRun = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isDirectRun) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
