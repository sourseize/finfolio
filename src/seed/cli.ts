/**
 * `npm run seed` — create or reset the demo users "fin" (password "folio") and
 * "penny" (password "wise"). `--only=fin` / `--only=penny` seeds just one.
 *
 * Each seeded user's comparison snapshot is also written to samples/compare/
 * (`--snapshots DIR` to choose the folder, `--no-snapshots` to skip), together
 * with two anonymous personas that exist only as snapshots — so either demo
 * user has three people to compare with without signing in as anyone else.
 *
 * Respects FINFOLIO_DATA_DIR. Data is generated relative to the fixed seed
 * date 2026-10-25; start the server with FINFOLIO_NOW=2026-10-25 to see it
 * exactly as intended (or without it to see it against the real clock).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db } from '../db/database.js';
import { getClockOverride, setClock } from '../util/clock.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD, FIN_SEED_DATE, type SeedSummary } from './fin.js';
import { seedPenny, PENNY_USERNAME, PENNY_PASSWORD } from './penny.js';
import { snapshotFor, APP_VERSION } from '../routes/compare.js';
import { snapshotFileName } from '../compare/snapshot.js';
import { anonymousPersonas, anonymousSnapshot } from './anonymous.js';

export const DEFAULT_SNAPSHOT_DIR = path.join('samples', 'compare');

export function onlyFromArgs(argv: string[]): 'fin' | 'penny' | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = a.startsWith('--only=') ? a.slice('--only='.length) : a === '--only' ? argv[i + 1] : null;
    if (v === 'fin' || v === 'penny') return v;
    if (v) throw new Error(`--only must be fin or penny, got "${v}"`);
  }
  return null;
}

export function snapshotDirFromArgs(argv: string[]): string | null {
  if (argv.includes('--no-snapshots')) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--snapshots=')) return a.slice('--snapshots='.length);
    if (a === '--snapshots' && argv[i + 1]) return argv[i + 1];
  }
  return DEFAULT_SNAPSHOT_DIR;
}

function line(name: string, password: string, s: SeedSummary): string {
  return `   ${name} / ${password}: ${s.accounts} accounts, ${s.transactions} transactions, ${s.investments} holdings / ${s.trades} trades, ${s.budgets} budgets, ${s.goals} goals, ${s.scenarios} scenarios, ${s.habits} habits, ${s.claims} rewards claimed`;
}

/**
 * Write a user's comparison snapshot, as of the seed date, to `dir` and return the path.
 * The clock is frozen on the seed date while building so the file is deterministic.
 */
export async function writeSeedSnapshot(userId: string, label: string, dir: string): Promise<string> {
  const previousClock = getClockOverride();
  setClock(`${FIN_SEED_DATE}T09:00:00.000Z`);
  try {
    const snapshot = snapshotFor(userId, label);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, snapshotFileName(label));
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8');
    return file;
  } finally {
    setClock(previousClock);
  }
}

/** Write the anonymous personas' snapshots (as of the seed date) to `dir` and return the paths. */
export async function writeAnonymousSnapshots(dir: string): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const persona of anonymousPersonas(FIN_SEED_DATE)) {
    const snapshot = anonymousSnapshot(persona, { appVersion: APP_VERSION });
    const file = path.join(dir, snapshotFileName(persona.label));
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8');
    files.push(file);
  }
  return files;
}

async function main() {
  const argv = process.argv.slice(2);
  const only = onlyFromArgs(argv);
  const snapshotDir = snapshotDirFromArgs(argv);
  await db.init();
  const lines: string[] = [];
  const files: string[] = [];
  if (only !== 'penny') {
    const s = await seedFin(db);
    lines.push(line(FIN_USERNAME, FIN_PASSWORD, s));
    if (snapshotDir) files.push(await writeSeedSnapshot(s.userId, 'Fin', snapshotDir));
  }
  if (only !== 'fin') {
    const s = await seedPenny(db);
    lines.push(line(PENNY_USERNAME, PENNY_PASSWORD, s));
    if (snapshotDir) files.push(await writeSeedSnapshot(s.userId, 'Penny', snapshotDir));
  }
  if (snapshotDir) files.push(...await writeAnonymousSnapshots(snapshotDir));
  console.log(`
✅ Seeded demo user${lines.length > 1 ? 's' : ''} into ${db.filePath} as of ${FIN_SEED_DATE}:
${lines.join('\n')}
${files.length ? `\n   Comparison snapshots — import one on the Compare page (the two anonymous ones belong to nobody you can sign in as):\n${files.map(f => `   ${f}`).join('\n')}\n` : ''}
   npm start                         # sign in as fin / folio or penny / wise (real clock)
   npm start -- --now=${FIN_SEED_DATE}     # with the clock frozen at the seed date (any OS)
   npm start -- --now=2026-11-30     # or any other day: periods, streaks, the nudge and FI
                                     # milestones are judged on that day; re-seed between hops
`);
}

// Only run when executed directly (`node dist/seed/cli.js`), not when imported (tests reuse writeSeedSnapshot).
const isDirectRun = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isDirectRun) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
