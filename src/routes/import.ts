/**
 * Statement import routes.
 *
 *   GET    /api/import/formats              supported formats, categories, limits (public)
 *   POST   /api/import/preview              upload files (or re-run a cached preview) → rows, summary, balance
 *   POST   /api/import/commit               write the reviewed rows, stamp skipped matches, reconcile the balance
 *   GET    /api/import/profiles             remembered CSV mappings
 *   DELETE /api/import/profiles/:id
 */
import type { ServerResponse } from 'node:http';
import { router } from '../server/router.js';
import { db, TRANSACTION_CATEGORIES, type Account, type ImportBatch, type Transaction, type TransactionImportMeta } from '../db/database.js';
import { nowIso, today } from '../util/clock.js';
import { ImportError, parseStatement, SUPPORTED_FORMATS, type CsvMappingOverrides, type ParsedStatement } from '../import/index.js';
import { loadImportConfig } from '../import/config.js';
import { balanceEffect, buildPreview, type EngineFile, type PreviewResult, type PreviewRow } from '../import/engine.js';
import { createSession, deleteSession, getSession, updateSession, PREVIEW_TTL_MS, type PreviewOptions, type PreviewSession } from '../import/session.js';

export const IMPORT_LIMITS = { maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, previewTtlMs: PREVIEW_TTL_MS };

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function userAccount(userId: string, accountId: unknown): Account | { error: string; status: number } {
  if (typeof accountId !== 'string' || !accountId) return { error: 'accountId required', status: 400 };
  const account = db.getAccount(accountId);
  if (!account || account.userId !== userId) return { error: 'Unknown account', status: 400 };
  if (account.type === 'investment') return { error: 'Statements cannot be imported into investment accounts', status: 400 };
  return account;
}

function readOptions(raw: unknown, previous?: PreviewOptions): PreviewOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const opts: PreviewOptions = { ...(previous ?? {}) };
  if (typeof o.localeHint === 'string') opts.localeHint = o.localeHint;
  if (typeof o.includePending === 'boolean') opts.includePending = o.includePending;
  if (o.mappings && typeof o.mappings === 'object') {
    opts.mappings = { ...(opts.mappings ?? {}) };
    for (const [k, v] of Object.entries(o.mappings as Record<string, unknown>)) {
      if (v && typeof v === 'object') opts.mappings[Number(k)] = v as CsvMappingOverrides;
    }
  }
  if (o.mapping && typeof o.mapping === 'object') opts.mappings = { ...(opts.mappings ?? {}), 0: o.mapping as CsvMappingOverrides };
  return opts;
}

/** Parse every file, applying an explicit mapping or a remembered profile for CSV. */
function parseFiles(userId: string, files: { name: string; bytes: Buffer }[], opts: PreviewOptions): EngineFile[] {
  return files.map((f, i) => {
    const out: EngineFile = { name: f.name, bytes: f.bytes };
    try {
      const override = opts.mappings?.[i];
      let parsed: ParsedStatement = parseStatement(f.bytes, f.name, { localeHint: opts.localeHint, mapping: override });
      if (parsed.csv && !override) {
        const profile = db.findImportProfile(userId, parsed.csv.mapping.headerSignature);
        if (profile) {
          parsed = parseStatement(f.bytes, f.name, { localeHint: opts.localeHint, mapping: { delimiter: profile.delimiter, dateOrder: profile.dateOrder, numberFormat: profile.numberFormat, columns: profile.columns } });
          out.profileApplied = true;
        }
      }
      out.parsed = parsed;
    } catch (err) {
      if (err instanceof ImportError) out.error = err;
      else out.error = new ImportError('invalid', (err as Error).message || 'Could not parse the file');
    }
    return out;
  });
}

function runPreview(userId: string, account: Account, files: { name: string; bytes: Buffer }[], opts: PreviewOptions): PreviewResult {
  return buildPreview({
    account,
    files: parseFiles(userId, files, opts),
    existing: db.getTransactions(userId),
    accounts: db.getAccounts(userId),
    batches: db.getImportBatches(userId),
    config: loadImportConfig(),
    today: today(),
    includePending: !!opts.includePending,
  });
}

function respondPreview(res: ServerResponse, session: PreviewSession) {
  json(res, {
    previewId: session.id,
    accountId: session.accountId,
    expiresAt: new Date(session.expiresAt).toISOString(),
    options: session.options,
    ...session.result,
  });
}

// ── Formats ──
router.get('/api/import/formats', async (_req, res) => {
  const cfg = loadImportConfig();
  json(res, {
    formats: SUPPORTED_FORMATS,
    categories: TRANSACTION_CATEGORIES,
    uncategorized: cfg.uncategorized,
    dedupe: cfg.dedupe,
    limits: IMPORT_LIMITS,
  });
}, false);

// ── Preview ──
router.post('/api/import/preview', async (req, res, _match, body) => {
  const userId = (req as any).userId as string;
  if (!body || typeof body !== 'object') return json(res, { error: 'Body required' }, 400);

  // Re-run on a cached upload
  if (typeof body.previewId === 'string') {
    const session = getSession(body.previewId, userId);
    if (!session) return json(res, { error: 'Preview expired — please upload the file again', code: 'expired' }, 410);
    const account = userAccount(userId, body.accountId ?? session.accountId);
    if ('error' in account) return json(res, account, account.status);
    const options = readOptions(body.options, session.options);
    const result = runPreview(userId, account, session.files, options);
    updateSession(session, { accountId: account.id, options, result });
    return respondPreview(res, session);
  }

  const account = userAccount(userId, body.accountId);
  if ('error' in account) return json(res, account, account.status);
  if (!Array.isArray(body.files) || body.files.length === 0) return json(res, { error: 'files[] required: [{ name, content (base64) }]' }, 400);
  if (body.files.length > IMPORT_LIMITS.maxFiles) return json(res, { error: `At most ${IMPORT_LIMITS.maxFiles} files per upload` }, 400);
  const files: { name: string; bytes: Buffer }[] = [];
  for (const f of body.files) {
    if (!f || typeof f.name !== 'string' || typeof f.content !== 'string') return json(res, { error: 'Each file needs a name and base64 content' }, 400);
    const bytes = Buffer.from(f.content, 'base64');
    if (bytes.length > IMPORT_LIMITS.maxFileBytes) return json(res, { error: `${f.name} is larger than ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB` }, 400);
    files.push({ name: f.name.replace(/[\\/]/g, '_').slice(0, 200), bytes });
  }
  const options = readOptions(body.options);
  if (typeof body.localeHint === 'string') options.localeHint = body.localeHint;

  const result = runPreview(userId, account, files, options);
  if (result.files.every(f => f.error)) {
    const first = result.files[0].error!;
    return json(res, { error: result.files.length === 1 ? first.message : 'None of the files could be read', code: first.code, files: result.files }, 400);
  }
  const session = createSession({ userId, accountId: account.id, files, options, result });
  respondPreview(res, session);
});

// ── Commit ──
interface CommitBody {
  previewId?: string;
  decisions?: Record<string, 'keep' | 'skip'>;
  saveProfile?: boolean;
  balance?: { mode?: 'keep' | 'statement' | 'manual'; value?: number };
}

router.post('/api/import/commit', async (req, res, _match, body: CommitBody) => {
  const userId = (req as any).userId as string;
  if (!body || typeof body.previewId !== 'string') return json(res, { error: 'previewId required' }, 400);
  const session = getSession(body.previewId, userId);
  if (!session) return json(res, { error: 'Preview expired — please upload the file again', code: 'expired' }, 410);
  const account = db.getAccount(session.accountId);
  if (!account || account.userId !== userId) return json(res, { error: 'The account no longer exists' }, 400);

  const decisions = body.decisions && typeof body.decisions === 'object' ? body.decisions : {};
  const rows = session.result.rows;
  for (const [k, v] of Object.entries(decisions)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return json(res, { error: `Unknown row ${k}` }, 400);
    if (v !== 'keep' && v !== 'skip') return json(res, { error: `Decision for row ${k} must be keep or skip` }, 400);
  }
  const undecided = rows.filter(r => r.status === 'possible' && !decisions[r.idx]).map(r => r.idx);
  if (undecided.length) return json(res, { error: `${undecided.length} possible duplicate(s) still need a Keep or Skip decision`, code: 'undecided', rows: undecided }, 409);

  const mode = body.balance?.mode ?? 'keep';
  if (!['keep', 'statement', 'manual'].includes(mode)) return json(res, { error: 'balance.mode must be keep, statement or manual' }, 400);
  if (mode === 'manual' && !Number.isFinite(Number(body.balance?.value))) return json(res, { error: 'balance.value required for manual reconciliation' }, 400);
  if (mode === 'statement' && session.result.balance.statementClosing === undefined) return json(res, { error: 'The statement carries no closing balance' }, 400);

  // ── write ──
  const stamp = nowIso();
  const config = loadImportConfig();
  const batches: ImportBatch[] = [];
  const created: Transaction[] = [];
  let stamped = 0;
  const touchedBudgets = new Set<string>();
  const touch = (category: string, date: string) => touchedBudgets.add(`${category}|${date.slice(0, 7)}`);

  session.result.files.forEach((pf, fileIndex) => {
    if (pf.error) return;
    const fileRows = rows.filter(r => r.file === fileIndex);
    const counts = { imported: 0, recorded: 0, skipped: 0, excluded: 0 };
    const batch = db.createImportBatch({
      userId,
      accountId: account.id,
      format: pf.format!,
      filename: pf.name,
      fileHash: pf.fileHash,
      dateFrom: pf.detected?.dateFrom ?? fileRows.map(r => r.date).filter(Boolean).sort()[0] ?? today(),
      dateTo: pf.detected?.dateTo ?? fileRows.map(r => r.date).filter(Boolean).sort().pop() ?? today(),
      counts,
    });
    for (const r of fileRows) {
      const decision = decisions[r.idx];
      if (r.status === 'excluded') { counts.excluded++; continue; }
      if (r.status === 'recorded') { counts.recorded++; continue; }
      if (decision === 'skip') {
        counts.skipped++;
        if (r.status === 'possible' && r.match?.txnId) stamped += stampMatched(r, r.match.txnId, pf.name, stamp) ? 1 : 0;
        continue;
      }
      const meta: TransactionImportMeta = {
        batchId: batch.id,
        source: pf.format!,
        fingerprint: r.fingerprint!,
        rawDescription: r.rawDescription,
      };
      if (r.externalId) meta.externalId = r.externalId;
      const txn = db.createTransaction({
        userId,
        accountId: account.id,
        type: r.type!,
        category: TRANSACTION_CATEGORIES.includes(r.category) ? r.category : config.uncategorized,
        amount: r.amount!,
        description: r.description,
        date: r.date!,
        tags: r.transferWith ? ['transfer'] : [],
        import: meta,
      });
      created.push(txn);
      touch(txn.category, txn.date);
      counts.imported++;
    }
    batches.push(batch);
  });

  // ── balance reconciliation ──
  const computed = Math.round(account.balance * 100) / 100;
  let target = computed;
  if (mode === 'statement') target = session.result.balance.statementClosing!;
  if (mode === 'manual') target = Math.round(Number(body.balance!.value) * 100) / 100;
  const adjustment = Math.round((target - computed) * 100) / 100;
  if (adjustment !== 0) {
    db.updateAccount(account.id, { balance: target });
    if (batches.length) batches[batches.length - 1].balanceAdjustment = adjustment;
  } else {
    db.updateAccount(account.id, { balance: computed });
  }

  // ── remembered CSV mapping ──
  let profilesSaved = 0;
  if (body.saveProfile) {
    session.result.files.forEach(pf => {
      if (!pf.mapping) return;
      const m = pf.mapping.mapping;
      db.upsertImportProfile({ userId, headerSignature: m.headerSignature, delimiter: m.delimiter, dateOrder: m.dateOrder, numberFormat: m.numberFormat, columns: m.columns });
      profilesSaved++;
    });
  }

  for (const key of touchedBudgets) {
    const [category, ym] = key.split('|');
    const d = new Date(`${ym}-01T00:00:00Z`);
    db.recalculateBudgetSpent(userId, category, d.getUTCMonth(), d.getUTCFullYear());
  }
  await db.persist();
  deleteSession(session.id);

  const totals = batches.reduce((s, b) => ({ imported: s.imported + b.counts.imported, recorded: s.recorded + b.counts.recorded, skipped: s.skipped + b.counts.skipped, excluded: s.excluded + b.counts.excluded }), { imported: 0, recorded: 0, skipped: 0, excluded: 0 });
  json(res, {
    batchIds: batches.map(b => b.id),
    counts: { ...totals, stamped, profilesSaved },
    account: db.getAccount(account.id),
    balance: { computed, final: target, adjustment, mode },
    transactions: created.map(t => t.id),
  }, 201);
});

/** "Skip: already recorded = this one" → remember the statement row on the existing transaction (D10). */
function stampMatched(row: PreviewRow, txnId: string, filename: string, stamp: string): boolean {
  const existing = db.getTransaction(txnId);
  if (!existing) return false;
  const prev = existing.import;
  existing.import = {
    batchId: prev?.batchId,
    source: prev?.source ?? (row.externalId ? 'ofx' : 'csv'),
    externalId: prev?.externalId ?? row.externalId,
    fingerprint: prev?.fingerprint ?? row.fingerprint!,
    rawDescription: prev?.rawDescription ?? row.rawDescription,
    matchedFrom: { filename, date: row.date!, amount: row.amount!, rawDescription: row.rawDescription, matchedAt: stamp },
  };
  if (existing.import.batchId === undefined) delete existing.import.batchId;
  return true;
}

// ── Profiles ──
router.get('/api/import/profiles', async (req, res) => {
  const userId = (req as any).userId as string;
  json(res, db.getImportProfiles(userId));
});

router.delete('/api/import/profiles/:id', async (req, res, match) => {
  const userId = (req as any).userId as string;
  const profile = db.getImportProfiles(userId).find(p => p.id === match[1]);
  if (!profile) return json(res, { error: 'Not found' }, 404);
  db.deleteImportProfile(profile.id);
  await db.persist();
  json(res, { success: true });
});

/** What the account would show after importing every new row plus the kept possible rows. */
export function projectedBalance(result: PreviewResult, keptPossible: number[]): number {
  const account = { type: result.account.type } as Account;
  const extra = result.rows
    .filter(r => r.status === 'possible' && keptPossible.includes(r.idx))
    .reduce((s, r) => s + balanceEffect(account, r.type!, r.amount!), 0);
  return Math.round((result.balance.before + result.balance.deltaNew + extra) * 100) / 100;
}
