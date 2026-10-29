/**
 * Preview engine: parsed statements → rows with a status, a category and the
 * duplicate/transfer evidence the user sees before anything is written.
 *
 * Dedupe rules (workbook §3, decisions D1/D9):
 *   recorded  R1  same external id already stored on a transaction of the account
 *             R2  same fingerprint (date, direction, cents, normalised description)
 *   possible  P1  same direction, cents and normalised description, 0 < |Δdate| ≤ possibleDays
 *             P2  identical row already accepted earlier in this upload without distinct ids
 * Matching is one-to-one: an existing transaction absorbs at most one row.
 * Excluded rows are never imported: currency mismatch, pending (unless asked),
 * invalid, dated after today, zero amount.
 */
import { applyTransactionToBalance, isLiabilityAccount, TRANSFER_CATEGORY, type Account, type ImportBatch, type Transaction } from '../db/database.js';
import { categorize, type CategorySource } from './categorize.js';
import type { ImportConfig } from './config.js';
import { fingerprint, normalizeDescription, sha256, toTypeAndAmount } from './normalize.js';
import type { ImportError, ImportFormat, ParsedStatement, RawRow } from './types.js';

export type RowStatus = 'new' | 'recorded' | 'possible' | 'excluded';
export type ExcludeReason = 'currency' | 'pending' | 'invalid' | 'future' | 'zero';
export type MatchRule = 'R1' | 'R2' | 'P1' | 'P2';

export interface PreviewMatch {
  rule: MatchRule;
  /** Existing transaction (R1, R2, P1). */
  txnId?: string;
  /** Earlier row of this upload (P2). */
  rowIdx?: number;
  date: string;
  type: 'income' | 'expense';
  amount: number;
  description: string;
  /** Signed: positive when the statement row is later than the match. */
  daysApart: number;
  explanation: string;
}

export interface PreviewTransfer {
  accountId: string;
  accountName: string;
  txnId: string;
  date: string;
  description: string;
  amount: number;
}

export interface PreviewRow {
  idx: number;
  file: number;
  date: string | null;
  postedDate?: string;
  type: 'income' | 'expense' | null;
  amount: number | null;
  currency?: string;
  description: string;
  rawDescription: string;
  memo?: string;
  externalId?: string;
  fingerprint?: string;
  category: string;
  categorySource: CategorySource;
  categoryConfidence: number;
  categoryVia?: string;
  status: RowStatus;
  reason?: ExcludeReason;
  match?: PreviewMatch;
  transferWith?: PreviewTransfer;
  pending?: boolean;
  errors: string[];
  raw: string;
}

export interface PreviewFile {
  index: number;
  name: string;
  size: number;
  fileHash: string;
  format?: ImportFormat;
  dialect?: string;
  encoding?: string;
  detected?: {
    currency?: string;
    accountExternalId?: string;
    accountType?: string;
    dateFrom?: string;
    dateTo?: string;
    /** Bank convention (credit card: negative = owed). */
    closingBalance?: number;
    closingBalanceAsOf?: string;
  };
  mapping?: NonNullable<ParsedStatement['csv']> & { profileApplied: boolean };
  warnings: string[];
  fileDuplicate?: { batchId: string; importedAt: string; accountName: string; rows: number };
  blocked?: { reason: 'currency'; message: string };
  error?: { code: string; message: string };
  rows: number;
}

export interface PreviewSummary {
  total: number;
  new: number;
  recorded: number;
  possible: number;
  excluded: number;
  uncategorized: number;
  transfers: number;
  byReason: Partial<Record<ExcludeReason, number>>;
  byRule: Partial<Record<MatchRule, number>>;
}

export interface PreviewBalance {
  /** Account balance now (app convention: credit = amount owed). */
  before: number;
  /** Effect on the balance of importing every `new` row. */
  deltaNew: number;
  /** Effect of keeping every `possible` row. */
  deltaPossible: number;
  /** Statement closing balance converted to the app convention, when a file carries one. */
  statementClosing?: number;
  statementClosingAsOf?: string;
}

export interface PreviewResult {
  account: { id: string; name: string; type: Account['type']; currency: string };
  files: PreviewFile[];
  rows: PreviewRow[];
  summary: PreviewSummary;
  balance: PreviewBalance;
}

export interface EngineFile {
  name: string;
  bytes: Buffer;
  parsed?: ParsedStatement;
  error?: ImportError;
  profileApplied?: boolean;
}

export interface EngineInput {
  account: Account;
  files: EngineFile[];
  /** All of the user's transactions (the engine picks the account's and uses the rest for transfers). */
  existing: Transaction[];
  accounts: Account[];
  batches: ImportBatch[];
  config: ImportConfig;
  /** YYYY-MM-DD. */
  today: string;
  includePending: boolean;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const cents = (n: number) => Math.round(Math.abs(n) * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Effect of a transaction on the account balance in the app's convention. */
export function balanceEffect(account: Pick<Account, 'type'>, type: 'income' | 'expense', amount: number): number {
  const probe = { type: account.type, balance: 0 } as Account;
  applyTransactionToBalance(probe, { type, amount }, 1);
  return probe.balance;
}

/** Statement closing balance (bank convention) → app convention. */
export function statementBalanceToApp(account: Pick<Account, 'type'>, bankBalance: number): number {
  return isLiabilityAccount(account) ? -bankBalance : bankBalance;
}

interface ExistingIndex {
  byExternalId: Map<string, Transaction>;
  byFingerprint: Map<string, Transaction[]>;
  /** type|cents|normDesc → transactions, for the 2-day rule. */
  byShape: Map<string, Transaction[]>;
}

function indexExisting(txns: Transaction[], accountId: string): ExistingIndex {
  const idx: ExistingIndex = { byExternalId: new Map(), byFingerprint: new Map(), byShape: new Map() };
  for (const t of txns) {
    if (t.accountId !== accountId) continue;
    if (t.type !== 'income' && t.type !== 'expense') continue;
    if (t.import?.externalId) idx.byExternalId.set(t.import.externalId, t);
    const norm = normalizeDescription(t.description);
    const fps = new Set<string>([fingerprint(accountId, t.date, t.type, t.amount, norm)]);
    if (t.import?.fingerprint) fps.add(t.import.fingerprint);
    for (const fp of fps) {
      const list = idx.byFingerprint.get(fp) ?? [];
      list.push(t);
      idx.byFingerprint.set(fp, list);
    }
    const shape = `${t.type}|${cents(t.amount)}|${norm}`;
    const list = idx.byShape.get(shape) ?? [];
    list.push(t);
    idx.byShape.set(shape, list);
  }
  return idx;
}

function describeMatch(rule: MatchRule, t: { date: string; type: Transaction['type']; amount: number; description: string }, rowDate: string, rowIdx?: number, txnId?: string): PreviewMatch {
  const daysApart = daysBetween(t.date, rowDate);
  const when = daysApart === 0 ? 'on the same day' : `${Math.abs(daysApart)} day${Math.abs(daysApart) === 1 ? '' : 's'} ${daysApart > 0 ? 'earlier' : 'later'}`;
  const explanation =
    rule === 'R1' ? 'Already recorded: the bank\'s transaction id is already stored on this transaction' :
    rule === 'R2' ? 'Already recorded: same date, amount and description' :
    rule === 'P1' ? `Same amount and description as a transaction recorded ${when}` :
    `Identical row appears earlier in this upload (row #${rowIdx ?? 0})`;
  return { rule, txnId, rowIdx, date: t.date, type: t.type === 'income' ? 'income' : 'expense', amount: t.amount, description: t.description, daysApart, explanation };
}

export function buildPreview(input: EngineInput): PreviewResult {
  const { account, config, today } = input;
  const accountName = new Map(input.accounts.map(a => [a.id, a.name]));
  const existingIdx = indexExisting(input.existing, account.id);
  const claimed = new Set<string>(); // existing transaction ids already matched by a row (one-to-one)

  const files: PreviewFile[] = [];
  const rows: PreviewRow[] = [];
  const parsedRefs: RawRow[] = []; // parsedRefs[row.idx] is the parser row behind each preview row

  // ── 1. Rows from every file, with exclusions ──
  input.files.forEach((f, fileIndex) => {
    const fileHash = sha256(f.bytes);
    const dup = input.batches.find(b => b.fileHash === fileHash);
    const pf: PreviewFile = { index: fileIndex, name: f.name, size: f.bytes.length, fileHash, warnings: [], rows: 0 };
    if (dup) pf.fileDuplicate = { batchId: dup.id, importedAt: dup.importedAt, accountName: accountName.get(dup.accountId) ?? 'a deleted account', rows: dup.counts.imported + dup.counts.recorded + dup.counts.skipped };
    if (f.error || !f.parsed) {
      pf.error = { code: f.error?.code ?? 'invalid', message: f.error?.message ?? 'Could not parse the file' };
      files.push(pf);
      return;
    }
    const p = f.parsed;
    pf.format = p.format;
    pf.dialect = p.dialect;
    pf.encoding = p.encoding;
    pf.warnings = [...p.warnings];
    pf.detected = {
      currency: p.currency,
      accountExternalId: p.account?.externalId,
      accountType: p.account?.type,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
      closingBalance: p.closingBalance?.amount,
      closingBalanceAsOf: p.closingBalance?.asOf,
    };
    if (p.csv) pf.mapping = { ...p.csv, profileApplied: !!f.profileApplied };
    if (p.currency && p.currency !== account.currency) {
      pf.blocked = { reason: 'currency', message: `The statement is in ${p.currency} but the account is in ${account.currency}; nothing from this file can be imported` };
    }

    for (const r of p.rows) {
      const idx = rows.length;
      const ta = r.amount === null ? null : toTypeAndAmount(r.amount);
      const description = r.description || r.memo || '(no description)';
      const row: PreviewRow = {
        idx,
        file: fileIndex,
        date: r.date,
        type: ta?.type ?? null,
        amount: ta?.amount ?? null,
        description,
        rawDescription: r.description,
        category: config.uncategorized,
        categorySource: 'none',
        categoryConfidence: 0,
        status: 'new',
        errors: [...r.errors],
        raw: r.raw,
      };
      if (r.postedDate) row.postedDate = r.postedDate;
      if (r.currency) row.currency = r.currency;
      else if (p.currency) row.currency = p.currency;
      if (r.memo) row.memo = r.memo;
      if (r.externalId) row.externalId = r.externalId;
      if (r.pending) row.pending = true;

      // exclusions, most specific first
      if (pf.blocked || (row.currency && row.currency !== account.currency)) exclude(row, 'currency', `Row is in ${row.currency}, the account is in ${account.currency}`);
      else if (r.errors.length || !r.date || ta === null) exclude(row, 'invalid', r.errors[0] ?? 'Missing date or amount');
      else if (ta.amount === 0) exclude(row, 'zero', 'Zero amount');
      else if (r.date > today) exclude(row, 'future', `Dated after today (${today})`);
      else if (r.pending && !input.includePending) exclude(row, 'pending', 'Pending — not yet booked by the bank');

      if (row.status !== 'excluded') {
        row.fingerprint = fingerprint(account.id, row.date!, row.type!, row.amount!, normalizeDescription(row.description));
      }
      rows.push(row);
      parsedRefs.push(r);
      pf.rows++;
    }
    files.push(pf);
  });

  const live = rows.filter(r => r.status !== 'excluded');

  // ── 2. R1: external ids ──
  for (const row of live) {
    if (!row.externalId) continue;
    const t = existingIdx.byExternalId.get(row.externalId);
    if (t && !claimed.has(t.id)) { claimed.add(t.id); row.status = 'recorded'; row.match = describeMatch('R1', t, row.date!, undefined, t.id); }
  }
  // ── 3. R2: fingerprints ──
  for (const row of live) {
    if (row.status !== 'new') continue;
    const t = (existingIdx.byFingerprint.get(row.fingerprint!) ?? []).find(x => !claimed.has(x.id));
    if (t) { claimed.add(t.id); row.status = 'recorded'; row.match = describeMatch('R2', t, row.date!, undefined, t.id); }
  }
  // ── 4. P1: same shape within the window (closest date first) ──
  const window = config.dedupe.possibleDays;
  for (const row of live) {
    if (row.status !== 'new') continue;
    const shape = `${row.type}|${cents(row.amount!)}|${normalizeDescription(row.description)}`;
    const candidates = (existingIdx.byShape.get(shape) ?? [])
      .filter(t => !claimed.has(t.id))
      .map(t => ({ t, d: Math.abs(daysBetween(t.date, row.date!)) }))
      .filter(x => x.d > 0 && x.d <= window)
      .sort((a, b) => a.d - b.d);
    if (candidates.length) {
      const { t } = candidates[0];
      claimed.add(t.id);
      row.status = 'possible';
      row.match = describeMatch('P1', t, row.date!, undefined, t.id);
    }
  }
  // ── 5. P2: repeats inside the upload ──
  // Every live row (including ones matched to the database) counts as an earlier occurrence;
  // a later identical row without a distinct bank id needs a decision.
  const seen = new Map<string, PreviewRow>();
  for (const row of live) {
    const key = row.fingerprint!;
    const earlier = seen.get(key);
    if (earlier && row.status === 'new') {
      const distinctIds = !!(earlier.externalId && row.externalId && earlier.externalId !== row.externalId);
      if (!distinctIds) {
        row.status = 'possible';
        row.match = describeMatch('P2', { date: earlier.date!, type: earlier.type!, amount: earlier.amount!, description: earlier.description }, row.date!, earlier.idx);
        continue;
      }
    }
    if (!earlier) seen.set(key, row);
  }

  // ── 6. Transfer pairing against other accounts ──
  const others = input.existing.filter(t => t.accountId !== account.id && (t.type === 'income' || t.type === 'expense'));
  const claimedTransfers = new Set<string>();
  for (const row of live) {
    if (row.status === 'recorded') continue;
    const opposite = row.type === 'income' ? 'expense' : 'income';
    const leg = others
      .filter(t => t.type === opposite && cents(t.amount) === cents(row.amount!) && !claimedTransfers.has(t.id))
      .map(t => ({ t, d: Math.abs(daysBetween(t.date, row.date!)) }))
      .filter(x => x.d <= config.dedupe.transferDays)
      .sort((a, b) => a.d - b.d || (b.t.category === TRANSFER_CATEGORY ? 1 : 0) - (a.t.category === TRANSFER_CATEGORY ? 1 : 0))[0];
    if (leg) {
      claimedTransfers.add(leg.t.id);
      row.transferWith = { accountId: leg.t.accountId, accountName: accountName.get(leg.t.accountId) ?? 'another account', txnId: leg.t.id, date: leg.t.date, description: leg.t.description, amount: leg.t.amount };
    }
  }

  // ── 7. Categorise everything that could be imported ──
  for (const row of live) {
    const parsedRow = parsedRefs[row.idx];
    const cat = categorize({
      type: row.type!,
      description: row.description,
      normalizedDescription: normalizeDescription(row.description),
      carriedCategory: parsedRow?.category,
      transferAccount: parsedRow?.transferAccount,
      mcc: parsedRow?.mcc,
      bankCode: parsedRow?.bankCode,
      transfer: !!row.transferWith,
    }, config);
    row.category = cat.category;
    row.categorySource = cat.source;
    row.categoryConfidence = cat.confidence;
    if (cat.via) row.categoryVia = cat.via;
  }

  // ── 8. Summary and balance ──
  const summary: PreviewSummary = { total: rows.length, new: 0, recorded: 0, possible: 0, excluded: 0, uncategorized: 0, transfers: 0, byReason: {}, byRule: {} };
  let deltaNew = 0, deltaPossible = 0;
  for (const r of rows) {
    summary[r.status]++;
    if (r.reason) summary.byReason[r.reason] = (summary.byReason[r.reason] ?? 0) + 1;
    if (r.match) summary.byRule[r.match.rule] = (summary.byRule[r.match.rule] ?? 0) + 1;
    if (r.status === 'new' || r.status === 'possible') {
      if (r.category === config.uncategorized) summary.uncategorized++;
      if (r.transferWith) summary.transfers++;
      const eff = balanceEffect(account, r.type!, r.amount!);
      if (r.status === 'new') deltaNew += eff; else deltaPossible += eff;
    }
  }
  const closingFile = [...files].reverse().find(f => f.detected?.closingBalance !== undefined && !f.blocked && !f.error);
  const balance: PreviewBalance = { before: round2(account.balance), deltaNew: round2(deltaNew), deltaPossible: round2(deltaPossible) };
  if (closingFile) {
    balance.statementClosing = round2(statementBalanceToApp(account, closingFile.detected!.closingBalance!));
    balance.statementClosingAsOf = closingFile.detected!.closingBalanceAsOf;
  }

  return {
    account: { id: account.id, name: account.name, type: account.type, currency: account.currency },
    files,
    rows,
    summary,
    balance,
  };
}

function exclude(row: PreviewRow, reason: ExcludeReason, note: string): void {
  row.status = 'excluded';
  row.reason = reason;
  if (!row.errors.includes(note)) row.errors.push(note);
}
