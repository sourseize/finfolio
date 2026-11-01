/**
 * Black-box snapshot export: signs in to a running FinFolio server over HTTP
 * exactly as the browser does and saves the comparison snapshot to a file.
 *
 *   npm run export:snapshot -- --user penny --password wise --label Penny
 *   npm run export:snapshot -- --user fin --password folio --out /tmp/fin.json --server http://localhost:3000
 *
 * Options:
 *   --server URL          default http://localhost:3000
 *   --user / --password   default fin / folio
 *   --label TEXT          how you want to appear in the other person's report (default: the username, capitalised)
 *   --out PATH            default samples/compare/<label>.finfolio-compare.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotFileName } from '../compare/snapshot.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[a.slice(2)] = true; continue; }
    out[a.slice(2)] = next;
    i++;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)): Promise<string> {
  const args = parseArgs(argv);
  const server = String(args.server ?? 'http://localhost:3000').replace(/\/$/, '');
  const user = String(args.user ?? 'fin');
  const password = String(args.password ?? 'folio');
  const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : user.charAt(0).toUpperCase() + user.slice(1);

  const login = await fetch(`${server}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password }) });
  if (!login.ok) throw new Error(`Sign-in failed (${login.status}): ${await login.text()}`);
  const { token } = await login.json() as { token: string };

  const res = await fetch(`${server}/api/compare/snapshot?label=${encodeURIComponent(label)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Export failed (${res.status}): ${await res.text()}`);
  const text = await res.text();
  const out = typeof args.out === 'string' ? args.out : path.join('samples', 'compare', snapshotFileName(label));
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, text, 'utf-8');
  const snapshot = JSON.parse(text);
  console.log(`✅ Snapshot of ${user} as "${snapshot.label}" (as of ${snapshot.asOf}, ${snapshot.currency}) written to ${out} (${text.length.toLocaleString()} bytes)`);
  return out;
}

const isDirectRun = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isDirectRun) {
  main().catch(err => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
