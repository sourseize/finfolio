/**
 * Open Banking / JSON statements. Three dialects are recognised by shape:
 *  - obie:   UK Open Banking `Data.Transaction[]` (CreditDebitIndicator, Amount.Amount, Status)
 *  - berlin: Berlin Group `transactions.booked[] / pending[]` (transactionAmount)
 *  - plaid:  aggregator `transactions[]` with `transaction_id` (positive amount = money out)
 * Anything else that is an array of flat objects goes through the CSV
 * inference (`generic-json`) so the user can map the columns.
 */
import { parseTable } from './csv.js';
import { parseAmount, parseDate } from '../normalize.js';
import { ImportError, type ParseOptions, type ParsedStatement, type RawRow } from '../types.js';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' ? parseAmount(v) : null);

function isoDate(v: unknown): string | null {
  const s = str(v);
  return s ? parseDate(s.slice(0, 10)) : null;
}

function snippet(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 240 ? s.slice(0, 237) + '…' : s;
}

// ── OBIE ──

function parseObie(txns: Json[], doc: Json, encoding: string): ParsedStatement {
  const rows: RawRow[] = txns.map((t, index) => {
    const errors: string[] = [];
    const amountObj = isObj(t.Amount) ? t.Amount : {};
    const magnitude = num(amountObj.Amount);
    const indicator = str(t.CreditDebitIndicator)?.toLowerCase();
    let amount: number | null = null;
    if (magnitude === null) errors.push('Missing Amount.Amount');
    else if (indicator !== 'credit' && indicator !== 'debit') errors.push('Missing CreditDebitIndicator');
    else amount = indicator === 'debit' ? -Math.abs(magnitude) : Math.abs(magnitude);
    const booking = isoDate(t.BookingDateTime);
    const value = isoDate(t.ValueDateTime);
    const date = value ?? booking;
    if (!date) errors.push('Missing BookingDateTime');
    const merchant = isObj(t.MerchantDetails) ? t.MerchantDetails : {};
    const description = str(t.TransactionInformation) ?? str(merchant.MerchantName) ?? str(t.TransactionReference) ?? '';
    const btc = isObj(t.BankTransactionCode) ? t.BankTransactionCode : {};
    const row: RawRow = {
      index,
      date,
      amount,
      description: description.replace(/\s+/g, ' ').trim(),
      externalId: str(t.TransactionId),
      errors,
      raw: snippet(t),
    };
    if (booking && date && booking !== date) row.postedDate = booking;
    const cur = str(amountObj.Currency)?.toUpperCase(); if (cur) row.currency = cur;
    if (str(t.Status)?.toLowerCase() === 'pending') row.pending = true;
    const mcc = str(merchant.MerchantCategoryCode); if (mcc && /^\d{4}$/.test(mcc)) row.mcc = Number(mcc);
    if (btc.Code) row.bankCode = `${str(btc.Code)}${btc.SubCode ? '/' + str(btc.SubCode) : ''}`.toUpperCase();
    const ref = str(t.TransactionReference); if (ref && ref !== row.externalId) row.reference = ref;
    const bal = isObj(t.Balance) ? t.Balance : undefined;
    if (bal && isObj(bal.Amount)) {
      const b = num(bal.Amount.Amount);
      if (b !== null) row.balance = str(bal.CreditDebitIndicator)?.toLowerCase() === 'debit' ? -Math.abs(b) : Math.abs(b);
    }
    return row;
  });
  const accountIds = new Set(txns.map(t => str(t.AccountId)).filter(Boolean));
  const warnings: string[] = [];
  if (accountIds.size > 1) warnings.push(`Rows reference ${accountIds.size} different AccountIds`);
  return finish('obie', encoding, rows, warnings, { externalId: accountIds.size === 1 ? [...accountIds][0] : undefined }, undefined, doc);
}

// ── Berlin Group ──

function parseBerlin(booked: Json[], pending: Json[], doc: Json, encoding: string): ParsedStatement {
  const account = isObj(doc.account) ? doc.account : {};
  const all = [...booked.map(t => ({ t, pending: false })), ...pending.map(t => ({ t, pending: true }))];
  const rows: RawRow[] = all.map(({ t, pending: isPending }, index) => {
    const errors: string[] = [];
    const ta = isObj(t.transactionAmount) ? t.transactionAmount : {};
    const amount = num(ta.amount);
    if (amount === null) errors.push('Missing transactionAmount.amount');
    const booking = isoDate(t.bookingDate);
    const value = isoDate(t.valueDate);
    const date = booking ?? value;
    if (!date) errors.push('Missing bookingDate');
    const counterpart = (amount !== null && amount < 0 ? str(t.creditorName) : str(t.debtorName)) ?? str(t.creditorName) ?? str(t.debtorName);
    const remittance = str(t.remittanceInformationUnstructured) ?? (Array.isArray(t.remittanceInformationUnstructuredArray) ? (t.remittanceInformationUnstructuredArray as unknown[]).map(String).join(' ') : undefined);
    const description = counterpart ?? remittance ?? '';
    const row: RawRow = {
      index,
      date,
      amount,
      description: description.replace(/\s+/g, ' ').trim(),
      externalId: str(t.transactionId) ?? str(t.entryReference),
      errors,
      raw: snippet(t),
    };
    if (remittance && remittance !== row.description) row.memo = remittance;
    const cur = str(ta.currency)?.toUpperCase(); if (cur) row.currency = cur;
    if (isPending) row.pending = true;
    const code = str(t.bankTransactionCode);
    if (code) { const parts = code.split(/[-/]/); row.bankCode = parts.slice(-2).join('/').toUpperCase(); }
    const mcc = str(t.merchantCategoryCode); if (mcc && /^\d{4}$/.test(mcc)) row.mcc = Number(mcc);
    const ref = str(t.entryReference); if (ref && ref !== row.externalId) row.reference = ref;
    return row;
  });
  return finish('berlin', encoding, rows, [], { externalId: str(account.iban) ?? str(account.resourceId) }, str(account.currency)?.toUpperCase(), doc);
}

// ── Plaid-style ──

function parsePlaid(txns: Json[], doc: Json, encoding: string): ParsedStatement {
  const accounts = Array.isArray(doc.accounts) ? (doc.accounts as unknown[]).filter(isObj) : [];
  const rows: RawRow[] = txns.map((t, index) => {
    const errors: string[] = [];
    const raw = num(t.amount);
    const amount = raw === null ? null : -raw; // Plaid: positive = money leaving the account
    if (amount === null) errors.push('Missing amount');
    const date = isoDate(t.authorized_date) ?? isoDate(t.date);
    const posted = isoDate(t.date);
    if (!date) errors.push('Missing date');
    const description = str(t.merchant_name) ?? str(t.name) ?? '';
    const row: RawRow = {
      index,
      date,
      amount,
      description: description.replace(/\s+/g, ' ').trim(),
      externalId: str(t.transaction_id),
      errors,
      raw: snippet(t),
    };
    if (posted && date && posted !== date) row.postedDate = posted;
    const name = str(t.name); if (name && name !== row.description) row.memo = name;
    const cur = str(t.iso_currency_code ?? t.unofficial_currency_code)?.toUpperCase(); if (cur) row.currency = cur;
    if (t.pending === true) row.pending = true;
    if (Array.isArray(t.category) && t.category.length) row.category = (t.category as unknown[]).map(String).join(' > ');
    else if (isObj(t.personal_finance_category) && t.personal_finance_category.primary) row.category = String(t.personal_finance_category.primary);
    return row;
  });
  const acctIds = new Set(txns.map(t => str(t.account_id)).filter(Boolean));
  const acct = accounts.find(a => acctIds.size === 1 && str(a.account_id) === [...acctIds][0]) ?? (accounts.length === 1 ? accounts[0] : undefined);
  const balances = acct && isObj(acct.balances) ? acct.balances : undefined;
  const type = acct ? (str(acct.type) === 'credit' ? 'credit' : str(acct.subtype) === 'savings' ? 'savings' : 'checking') : undefined;
  const warnings: string[] = [];
  if (acctIds.size > 1) warnings.push(`Rows reference ${acctIds.size} different account_ids`);
  const parsed = finish('plaid', encoding, rows, warnings, { externalId: acctIds.size === 1 ? [...acctIds][0] : undefined, name: acct ? str(acct.name) : undefined, type }, balances ? str(balances.iso_currency_code)?.toUpperCase() : undefined, doc);
  if (balances && typeof balances.current === 'number') {
    parsed.closingBalance = { amount: type === 'credit' ? -balances.current : balances.current, asOf: parsed.dateTo };
  }
  return parsed;
}

function finish(dialect: string, encoding: string, rows: RawRow[], warnings: string[], account: ParsedStatement['account'], currency: string | undefined, _doc: Json): ParsedStatement {
  if (!rows.length) throw new ImportError('invalid', 'The JSON contains no transactions');
  const dates = rows.map(r => r.date).filter((d): d is string => !!d).sort();
  const currencies = new Set(rows.map(r => r.currency).filter(Boolean));
  const booked = rows.filter(r => !r.pending && r.balance !== undefined && r.date);
  const last = booked.sort((a, b) => a.date!.localeCompare(b.date!) || a.index - b.index).pop();
  return {
    format: 'openbanking',
    dialect,
    encoding,
    account,
    currency: currency ?? (currencies.size === 1 ? [...currencies][0] : undefined),
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    closingBalance: last && last.balance !== undefined ? { amount: last.balance, asOf: last.date! } : undefined,
    rows,
    warnings,
  };
}

// ── Generic JSON → table ──

function findArrayOfObjects(v: unknown, depth = 0): Json[] | undefined {
  if (Array.isArray(v)) return v.length && v.every(isObj) ? (v as Json[]) : undefined;
  if (isObj(v) && depth < 3) {
    let best: Json[] | undefined;
    for (const val of Object.values(v)) {
      const found = findArrayOfObjects(val, depth + 1);
      if (found && (!best || found.length > best.length)) best = found;
    }
    return best;
  }
  return undefined;
}

function flatten(obj: Json, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = v.map(String).join(' > ');
    else out[key] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

export function parseOpenBankingJson(text: string, opts: ParseOptions, encoding: string): ParsedStatement {
  let doc: unknown;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new ImportError('invalid', 'The file is not valid JSON'); }

  if (isObj(doc)) {
    const data = isObj(doc.Data) ? doc.Data : doc;
    if (Array.isArray(data.Transaction)) return parseObie((data.Transaction as unknown[]).filter(isObj), doc, encoding);
    const txs = isObj(doc.transactions) ? doc.transactions : undefined;
    if (txs && (Array.isArray(txs.booked) || Array.isArray(txs.pending))) {
      return parseBerlin(((txs.booked as unknown[]) ?? []).filter(isObj), ((txs.pending as unknown[]) ?? []).filter(isObj), doc, encoding);
    }
    if (Array.isArray(doc.booked)) return parseBerlin((doc.booked as unknown[]).filter(isObj), ((doc.pending as unknown[]) ?? []).filter(isObj), doc, encoding);
    if (Array.isArray(doc.transactions)) {
      const list = (doc.transactions as unknown[]).filter(isObj);
      if (list.length && list.every(t => 'transaction_id' in t || ('amount' in t && 'date' in t && 'name' in t))) return parsePlaid(list, doc, encoding);
    }
  }

  const generic = findArrayOfObjects(doc);
  if (!generic || !generic.length) throw new ImportError('invalid', 'The JSON does not contain a list of transactions');
  const flat = generic.map(o => flatten(o));
  const headers = [...new Set(flat.flatMap(o => Object.keys(o)))];
  const records = [headers, ...flat.map(o => headers.map(h => o[h] ?? ''))];
  let parsed: ParsedStatement;
  try {
    parsed = parseTable(records, opts, { delimiter: ',', dialect: 'generic-json', encoding });
  } catch (err) {
    if (err instanceof ImportError) throw new ImportError('invalid', `The JSON does not contain a recognisable list of transactions (${err.message.toLowerCase()})`);
    throw err;
  }
  parsed.format = 'openbanking';
  parsed.rows.forEach((r, i) => { r.raw = snippet(generic[i]); });
  return parsed;
}
