/**
 * Black-box import client: drives a running FinFolio server over HTTP exactly
 * as the browser will, and prints the preview (and optionally commits).
 *
 *   npm run import:file -- --file samples/statements/S1/everyday-checking-2026-09.us.csv --account "Everyday Checking"
 *   npm run import:file -- --file a.csv --file b.ofx --account Chk --user alice --password pw --commit --decide skip
 *
 * Options:
 *   --server URL          default http://localhost:3000
 *   --user / --password   default fin / folio
 *   --account NAME|ID     target account (required)
 *   --file PATH           one or more statement files
 *   --locale en-GB        browser locale hint for ambiguous dates
 *   --include-pending     import pending rows too
 *   --date-order DMY|MDY|YMD   CSV mapping override (file 0)
 *   --commit              write the preview
 *   --decide keep|skip    decision applied to every "possible" row (or --keep 3,4 --skip 7)
 *   --balance keep|statement|manual:VALUE
 *   --save-profile        remember the CSV mapping
 *   --json                print the raw preview/commit JSON instead of tables
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface Args { [k: string]: string | string[] | boolean | undefined }

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    if (key === 'file') { out.file = [...((out.file as string[]) ?? []), next]; }
    else out[key] = next;
    i++;
  }
  return out;
}

async function api(server: string, method: string, p: string, body?: unknown, token?: string) {
  const res = await fetch(server + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, data };
}

const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : (n < 0 ? '-' : '') + Math.abs(n).toFixed(2));
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const server = String(args.server ?? 'http://localhost:3000').replace(/\/$/, '');
  const user = String(args.user ?? 'fin');
  const password = String(args.password ?? 'folio');
  const files = (args.file as string[] | undefined) ?? [];
  if (!files.length || !args.account) {
    console.error('Usage: --file <statement> [--file …] --account <name|id> [--commit --decide keep|skip] (see header of src/testing/import-cli.ts)');
    process.exit(2);
  }

  const login = await api(server, 'POST', '/api/auth/login', { username: user, password });
  if (login.status !== 200) { console.error(`Login failed (${login.status}): ${JSON.stringify(login.data)}`); process.exit(1); }
  const token = login.data.token as string;

  const accounts = (await api(server, 'GET', '/api/accounts', undefined, token)).data as { id: string; name: string; type: string; currency: string; balance: number }[];
  const account = accounts.find(a => a.id === args.account || a.name.toLowerCase() === String(args.account).toLowerCase());
  if (!account) { console.error(`No account "${args.account}". Have: ${accounts.map(a => a.name).join(', ')}`); process.exit(1); }

  const payload: any = {
    accountId: account.id,
    localeHint: args.locale ?? 'en-GB',
    files: await Promise.all(files.map(async f => ({ name: path.basename(f), content: (await fs.readFile(f)).toString('base64') }))),
    options: { includePending: !!args['include-pending'] },
  };
  if (args['date-order']) payload.options.mapping = { dateOrder: String(args['date-order']) };

  const preview = await api(server, 'POST', '/api/import/preview', payload, token);
  if (args.json) console.log(JSON.stringify(preview.data, null, 2));
  if (preview.status !== 200) { if (!args.json) console.error(`Preview failed (${preview.status}): ${preview.data.error ?? JSON.stringify(preview.data)}`); process.exit(1); }
  const p = preview.data;

  if (!args.json) {
    console.log(`\nAccount: ${account.name} (${account.type}, ${account.currency})   balance now ${money(p.balance.before)}`);
    for (const f of p.files) {
      console.log(`File: ${f.name}  ${f.error ? `ERROR ${f.error.code}: ${f.error.message}` : `${f.format}/${f.dialect} ${f.encoding}  rows ${f.rows}`}`);
      if (f.detected) console.log(`      detected: currency=${f.detected.currency ?? '-'} account=${f.detected.accountExternalId ?? '-'} period=${f.detected.dateFrom ?? '?'}…${f.detected.dateTo ?? '?'} closing=${money(f.detected.closingBalance)}`);
      if (f.mapping) console.log(`      mapping: order=${f.mapping.mapping.dateOrder}${f.mapping.mapping.dateOrderAmbiguous ? ' (ambiguous)' : ''} numbers=${f.mapping.mapping.numberFormat} sign=${f.mapping.mapping.signConvention} columns=${JSON.stringify(f.mapping.mapping.columns)}${f.mapping.profileApplied ? ' [profile applied]' : ''}`);
      if (f.fileDuplicate) console.log(`      ⚠ this exact file was imported on ${f.fileDuplicate.importedAt.slice(0, 10)} into ${f.fileDuplicate.accountName} (${f.fileDuplicate.rows} rows)`);
      if (f.blocked) console.log(`      ⛔ ${f.blocked.message}`);
      for (const w of f.warnings) console.log(`      ⚠ ${w}`);
    }
    const s = p.summary;
    console.log(`\nSummary: total ${s.total} · new ${s.new} · already recorded ${s.recorded} · needs decision ${s.possible} · excluded ${s.excluded} · uncategorized ${s.uncategorized} · transfers ${s.transfers}`);
    console.log(`         rules ${JSON.stringify(s.byRule)} · exclusions ${JSON.stringify(s.byReason)}`);
    console.log(`Balance: before ${money(p.balance.before)} · +new ${money(p.balance.deltaNew)} · +possible(if kept) ${money(p.balance.deltaPossible)}${p.balance.statementClosing !== undefined ? ` · statement closing ${money(p.balance.statementClosing)}` : ''}\n`);
    console.log(`${pad('#', 4)} ${pad('date', 10)} ${pad('amount', 10)} ${pad('description', 34)} ${pad('category', 16)} ${pad('status', 9)} detail`);
    for (const r of p.rows) {
      const signed = r.amount === null ? null : r.type === 'expense' ? -r.amount : r.amount;
      const detail = r.status === 'excluded' ? `${r.reason}: ${r.errors[0] ?? ''}`
        : r.match ? `${r.match.rule} ↔ ${r.match.date} ${money(r.match.type === 'expense' ? -r.match.amount : r.match.amount)} ${r.match.description}${r.match.txnId ? '' : ` (row #${r.match.rowIdx})`}`
        : r.transferWith ? `transfer ↔ ${r.transferWith.accountName}: ${r.transferWith.description}` : '';
      console.log(`${pad(String(r.idx), 4)} ${pad(r.date ?? '', 10)} ${pad(money(signed), 10)} ${pad(r.description, 34)} ${pad(r.category + (r.categorySource === 'none' ? '' : ` (${r.categorySource})`), 16)} ${pad(r.status, 9)} ${detail}`);
    }
  }

  if (!args.commit) return;

  const decisions: Record<string, 'keep' | 'skip'> = {};
  const listed = (k: string) => String(args[k] ?? '').split(',').map(x => x.trim()).filter(Boolean);
  for (const i of listed('keep')) decisions[i] = 'keep';
  for (const i of listed('skip')) decisions[i] = 'skip';
  if (args.decide === 'keep' || args.decide === 'skip') for (const r of p.rows) if (r.status === 'possible' && !decisions[r.idx]) decisions[r.idx] = args.decide;

  let balance: any = { mode: 'keep' };
  if (typeof args.balance === 'string') {
    if (args.balance.startsWith('manual:')) balance = { mode: 'manual', value: Number(args.balance.slice(7)) };
    else balance = { mode: args.balance };
  }
  const commit = await api(server, 'POST', '/api/import/commit', { previewId: p.previewId, decisions, balance, saveProfile: !!args['save-profile'] }, token);
  if (args.json) console.log(JSON.stringify(commit.data, null, 2));
  else if (commit.status !== 201) console.error(`\nCommit failed (${commit.status}): ${commit.data.error ?? JSON.stringify(commit.data)}`);
  else {
    const c = commit.data;
    console.log(`\nCommitted: imported ${c.counts.imported} · already recorded ${c.counts.recorded} · skipped ${c.counts.skipped} (stamped ${c.counts.stamped}) · excluded ${c.counts.excluded}`);
    console.log(`Balance: computed ${money(c.balance.computed)} → final ${money(c.balance.final)} (${c.balance.mode}${c.balance.adjustment ? `, adjustment ${money(c.balance.adjustment)}` : ''})`);
  }
  if (commit.status !== 201) process.exit(1);
}

const isDirectRun = (() => { try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();
if (isDirectRun) main().catch(err => { console.error(err); process.exit(1); });
