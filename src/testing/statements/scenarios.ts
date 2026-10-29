/**
 * Test statement scenarios S1–S12 (see docs/IMPORT_WORKBOOK.md §7).
 *
 * Statements are derived from the demo user's recorded transactions so that
 * importing them back into `fin` must be recognised as "already recorded",
 * while importing them into a fresh account yields all-new rows. Planted rows
 * (near-duplicates, repeats, foreign currency, pending …) are deterministic.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Database, type Account, type Transaction, TRANSFER_CATEGORY } from '../../db/database.js';
import { seedFin, FIN_SEED_DATE } from '../../seed/fin.js';
import { mulberry32 } from '../../sim/montecarlo.js';
import { addDays, makeRowId, round2, withRunningBalance, type Statement, type StatementAccount, type StatementRow } from './model.js';
import { writeCsv, csvExtension, type CsvDialect, type CsvEncoding } from './writers/csv.js';
import { writeOfx, writeOfxInvestment, type OfxFlavour } from './writers/ofx.js';
import { writeQif, writeQifInvestment, type QifOptions } from './writers/qif.js';
import { writeOpenBanking, writeJsonWithoutTransactions, type ObDialect } from './writers/openbanking.js';

export interface StatementSource {
  accounts: Account[];
  transactions: Transaction[];
  /** "Today" for the source data (balances are as of this date). */
  asOf: string;
}

export type ScenarioFormat = 'csv' | 'ofx' | 'qif' | 'openbanking' | 'invalid';

export interface ScenarioFile {
  /** File name inside the scenario folder. */
  name: string;
  bytes: Buffer;
  format: ScenarioFormat;
  /** Writer dialect/flavour, e.g. "us", "ofx1", "obie", "garbage". */
  dialect: string;
  /** The statement that was rendered (absent for invalid files). */
  statement?: Statement;
  /** What the importer is expected to do with this file. */
  expect: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  files: ScenarioFile[];
}

export const SCENARIO_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12'] as const;

// ── Source data ──

/** Seed the demo user into a throw-away database and return their accounts and transactions. */
export async function finStatementSource(): Promise<StatementSource> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finfolio-statements-'));
  try {
    const db = new Database();
    await db.init(dir);
    const summary = await seedFin(db, { persist: false });
    return {
      accounts: db.getAccounts(summary.userId),
      transactions: db.getTransactions(summary.userId),
      asOf: FIN_SEED_DATE,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Bank-flavoured descriptions and carried categories ──

/** How an external export would label our categories (Quicken / Mint style). */
export const CARRIED_CATEGORY_LABEL: Record<string, string> = {
  'Food & Dining': 'Groceries',
  Transportation: 'Auto & Transport',
  Housing: 'Mortgage & Rent',
  Utilities: 'Bills & Utilities',
  Entertainment: 'Entertainment',
  Shopping: 'Shopping',
  Healthcare: 'Health & Fitness',
  Education: 'Education',
  Salary: 'Paycheck',
  Freelance: 'Income',
  Investment: 'Investments',
  Gift: 'Gift',
  Transfer: 'Transfer',
  Other: 'Misc Expenses',
};

/** A plausible merchant category code per category. */
export const MCC_FOR_CATEGORY: Record<string, number> = {
  'Food & Dining': 5411,
  Transportation: 5541,
  Housing: 6513,
  Utilities: 4900,
  Entertainment: 7832,
  Shopping: 5311,
  Healthcare: 5912,
  Education: 8299,
};

const ACCOUNT_IDS: Record<string, Pick<StatementAccount, 'externalId' | 'bankId' | 'iban'>> = {
  'Everyday Checking': { externalId: '000123456789', bankId: '021000021', iban: 'GB29NWBK60161331926819' },
  'High-Yield Savings': { externalId: '000987654321', bankId: '021000021', iban: 'GB29NWBK60161331926820' },
  'Travel Rewards Card': { externalId: '4111111111111111' },
  Wallet: { externalId: 'CASH' },
  'Brokerage Cash': { externalId: 'BRK-1' },
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Turn a tidy description into what a bank prints: upper case, a card-network
 * prefix, a masked card number, a reference or an embedded date. Everything
 * added here is noise the importer's description normaliser must remove.
 */
export function bankify(description: string, date: string, amount: number, rand: () => number): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const base = description.replace(/—/g, '-').toUpperCase();
  const prefix = amount < 0 ? pick(['', 'POS ', 'CARD PAYMENT TO ', 'DEBIT CARD PURCHASE ', 'CONTACTLESS PAYMENT ']) : pick(['', 'CREDIT ', 'DEPOSIT ']);
  const [y, m, d] = date.split('-');
  const suffix = pick(['', ' XXXX5678', ' ****1234', ` REF ${Math.floor(rand() * 9e7 + 1e7)}`, ` ${d}${MONTHS[Number(m) - 1]}${y.slice(2)}`, ` ON ${d}/${m}`]);
  return `${prefix}${base}${suffix}`;
}

/** Counterpart account for a transfer leg, for QIF `[Account]`. */
function transferCounterpart(accountName: string, description: string): string | undefined {
  const d = description.toLowerCase();
  if (accountName === 'Everyday Checking') {
    if (d.includes('savings')) return 'High-Yield Savings';
    if (d.includes('credit card')) return 'Travel Rewards Card';
    if (d.includes('brokerage')) return 'Brokerage Cash';
  }
  if (accountName === 'High-Yield Savings' && d.includes('checking')) return 'Everyday Checking';
  if (accountName === 'Travel Rewards Card' && d.includes('payment')) return 'Everyday Checking';
  return undefined;
}

// ── Statement construction ──

export interface StatementOptions {
  /** Replace tidy descriptions with bank-style text (see `bankify`). */
  bankify?: boolean;
  /** Carry category labels / MCCs / bank codes in formats that support them. */
  carryCategories?: boolean;
  /** Override the statement currency (rows and account). */
  currency?: string;
  /** Keep only rows whose day of month is ≤ 12 (for the ambiguous-date dialect). */
  onlyDaysUpTo12?: boolean;
}

/** Bank-perspective effect of a recorded transaction on its account balance. */
function bankSigned(t: Transaction): number {
  return t.type === 'income' ? t.amount : -t.amount;
}

/** Balance of an account at the end of `date` (bank's point of view), given today's balance. */
function bankBalanceAt(account: Account, transactions: Transaction[], date: string): number {
  // Effects of everything after `date` are undone from today's balance.
  const later = transactions.filter(t => t.accountId === account.id && t.date > date);
  const isLiability = account.type === 'credit';
  let owedOrHeld = account.balance;
  for (const t of later) {
    // app convention: asset += income, -= expense; liability (owed) -= income, += expense
    const delta = t.type === 'income' ? t.amount : -t.amount;
    owedOrHeld -= isLiability ? -delta : delta;
  }
  return round2(isLiability ? -owedOrHeld : owedOrHeld);
}

/** Build a statement for one of the user's accounts over a period from the recorded transactions. */
export function statementFor(src: StatementSource, accountName: string, dateFrom: string, dateTo: string, opts: StatementOptions = {}): Statement {
  const account = src.accounts.find(a => a.name === accountName);
  if (!account) throw new Error(`statementFor: no account named "${accountName}"`);
  if (account.type === 'investment') throw new Error('statementFor: investment accounts are not supported');
  const rand = mulberry32(hashString(`${accountName}|${dateFrom}|${dateTo}`));
  const currency = opts.currency ?? account.currency;

  const txns = src.transactions
    .filter(t => t.accountId === account.id && t.date >= dateFrom && t.date <= dateTo)
    .filter(t => !opts.onlyDaysUpTo12 || Number(t.date.slice(8, 10)) <= 12)
    .sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description) || a.amount - b.amount);

  const rows: StatementRow[] = txns.map((t, i) => {
    const amount = round2(bankSigned(t));
    const row: StatementRow = {
      id: makeRowId(t.date, i + 1, amount),
      date: t.date,
      amount,
      currency,
      description: opts.bankify ? bankify(t.description, t.date, amount, rand) : t.description,
    };
    if (opts.carryCategories) {
      row.category = CARRIED_CATEGORY_LABEL[t.category] ?? t.category;
      if (t.type === 'expense' && MCC_FOR_CATEGORY[t.category]) row.mcc = MCC_FOR_CATEGORY[t.category];
      if (t.category === 'Salary') row.bankCode = 'PMNT/RCDT/SALA';
      if (t.category === TRANSFER_CATEGORY) row.transferAccount = transferCounterpart(accountName, t.description);
    }
    return row;
  });

  const closing = bankBalanceAt(account, src.transactions, dateTo);
  const opening = round2(closing - rows.reduce((s, r) => s + r.amount, 0));
  const ids = ACCOUNT_IDS[accountName] ?? { externalId: account.id.replace(/-/g, '').slice(0, 12) };
  return withRunningBalance({
    account: { name: account.name, type: account.type as StatementAccount['type'], currency, ...ids },
    dateFrom,
    dateTo,
    openingBalance: opening,
    closingBalance: closing,
    rows,
  });
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Insert rows and re-sort chronologically, re-deriving running balances. */
function withRows(statement: Statement, extra: StatementRow[]): Statement {
  const rows = [...statement.rows, ...extra].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return withRunningBalance({ ...statement, rows });
}

// ── File rendering helpers ──

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const period = (s: Statement) => (s.dateFrom.endsWith('-01') && s.dateTo.slice(0, 7) === s.dateFrom.slice(0, 7) && isMonthEnd(s.dateTo)) ? s.dateFrom.slice(0, 7) : `${s.dateFrom}_${s.dateTo}`;
function isMonthEnd(d: string): boolean { return addDays(d, 1).slice(8) === '01'; }
const baseName = (s: Statement) => `${slug(s.account.name)}-${period(s)}`;

function csvFile(s: Statement, dialect: CsvDialect, expect: string, encoding?: CsvEncoding): ScenarioFile {
  const enc = encoding && encoding !== 'utf8' ? `.${encoding}` : '';
  return { name: `${baseName(s)}.${dialect}${enc}.${csvExtension(dialect)}`, bytes: writeCsv(s, { dialect, encoding }), format: 'csv', dialect: encoding ? `${dialect}/${encoding}` : dialect, statement: s, expect };
}
function ofxFile(s: Statement, flavour: OfxFlavour, expect: string): ScenarioFile {
  return { name: `${baseName(s)}.${flavour}.${flavour === 'qfx' ? 'qfx' : 'ofx'}`, bytes: writeOfx(s, flavour), format: 'ofx', dialect: flavour, statement: s, expect };
}
function qifFile(s: Statement, opts: QifOptions, expect: string): ScenarioFile {
  return { name: `${baseName(s)}.${opts.dateStyle}${opts.accountHeader ? '-acct' : ''}.qif`, bytes: writeQif(s, opts), format: 'qif', dialect: `qif-${opts.dateStyle}`, statement: s, expect };
}
function obFile(s: Statement, dialect: ObDialect, expect: string): ScenarioFile {
  return { name: `${baseName(s)}.${dialect}.json`, bytes: writeOpenBanking(s, dialect), format: 'openbanking', dialect, statement: s, expect };
}

// ── Scenarios ──

const CHECKING = 'Everyday Checking';
const CARD = 'Travel Rewards Card';

export function buildScenario(id: (typeof SCENARIO_IDS)[number], src: StatementSource): Scenario {
  const sep = (opts?: StatementOptions) => statementFor(src, CHECKING, '2026-09-01', '2026-09-30', opts);
  switch (id) {
    case 'S1': {
      const s = sep();
      const e = 'Into fin/Everyday Checking: every row "already recorded" (R2) — nothing to import. Into a fresh account: every row new.';
      return scenario('S1', 'Clean statement', 'Everyday Checking, September 2026 — an exact copy of the recorded transactions.', [
        csvFile(s, 'us', e), csvFile(s, 'uk', e),
        ofxFile(s, 'ofx1', e), ofxFile(s, 'ofx2', e), ofxFile(s, 'qfx', e),
        qifFile(s, { dateStyle: 'us', accountHeader: true }, e), qifFile(s, { dateStyle: 'uk' }, e), qifFile(s, { dateStyle: 'iso' }, e),
        obFile(s, 'obie', e), obFile(s, 'berlin', e), obFile(s, 'plaid', e),
      ]);
    }
    case 'S2': {
      const s = sep({ bankify: true, carryCategories: true });
      const e = 'Same statement as S1 with bank-style descriptions (POS prefixes, masked card numbers, references, embedded dates) and carried categories/MCCs. Into fin, or into a fresh account after S1: every row "already recorded" (R1 via ids where present, R2 via normalised description otherwise). Into an empty account: all new, with the carried categories applied.';
      return scenario('S2', 'Same statement, other formats', 'September 2026 again, exported by a "different bank system": noisy descriptions and carried categories.', [
        csvFile(s, 'mint', e), csvFile(s, 'tsv', e), csvFile(s, 'withCurrency', e),
        ofxFile(s, 'ofx2', e), qifFile(s, { dateStyle: 'us' }, e),
        obFile(s, 'obie', e), obFile(s, 'berlin', e), obFile(s, 'plaid', e),
      ]);
    }
    case 'S3': {
      // The bank knows about six October transactions the user never entered by hand ("catch-up" rows).
      const base = statementFor(src, CHECKING, '2026-09-20', '2026-10-25');
      const cur = base.account.currency;
      const catchUp: StatementRow[] = [
        { id: 'CATCHUP-1', date: '2026-10-03', amount: -23.4, currency: cur, description: 'Pharmacy — cold remedies', memo: 'planted: not in fin → new (Healthcare)' },
        { id: 'CATCHUP-2', date: '2026-10-08', amount: -58.1, currency: cur, description: 'Hardware store', memo: 'planted: not in fin → new (Shopping)' },
        { id: 'CATCHUP-3', date: '2026-10-12', amount: -19.99, currency: cur, description: 'Book shop', memo: 'planted: not in fin → new (Entertainment)' },
        { id: 'CATCHUP-4', date: '2026-10-15', amount: -100, currency: cur, description: 'ATM withdrawal', memo: 'planted: not in fin → new (Transfer)' },
        { id: 'CATCHUP-5', date: '2026-10-18', amount: 42, currency: cur, description: 'Refund — online order', memo: 'planted: not in fin → new (Uncategorized: no income rule matches)' },
        { id: 'CATCHUP-6', date: '2026-10-21', amount: -6.5, currency: cur, description: 'Parking', memo: 'planted: not in fin → new (Transportation)' },
      ];
      const s = withRows(base, catchUp);
      const e = 'Into fin: 12 rows "already recorded", the 6 CATCHUP rows new (balance after import 7,684.41 = statement closing). Into a fresh account after S1: the 27 Sep card payment "already recorded", 17 new.';
      return scenario('S3', 'Overlapping window with catch-up rows', '20 Sep – 25 Oct 2026 — overlaps the September statement by ten days, as bank exports often do, and contains six October transactions that were never entered by hand (ids CATCHUP-1..6).', [
        csvFile(s, 'us', e), ofxFile(s, 'ofx1', e), obFile(s, 'obie', e),
      ]);
    }
    case 'S4': {
      const base = sep();
      const expenses = base.rows.filter(r => r.amount < 0 && Number(r.date.slice(8)) <= 20);
      if (expenses.length < 9) throw new Error('S4: not enough expense rows to plant near-duplicates');
      const [a, b, c, d, f] = [expenses[0], expenses[2], expenses[4], expenses[6], expenses[8]];
      // a, b, c are *replaced* by date-shifted copies (the bank posted them later than the user recorded them);
      // d and f stay and get a look-alike sibling.
      const planted: StatementRow[] = [
        { ...a, id: 'PLANT-1DAY', date: addDays(a.date, 1), memo: 'planted: recorded row shifted +1 day → possible (P1)' },
        { ...b, id: 'PLANT-2DAY', date: addDays(b.date, 2), memo: 'planted: recorded row shifted +2 days → possible (P1)' },
        { ...c, id: 'PLANT-3DAY', date: addDays(c.date, 3), memo: 'planted: recorded row shifted +3 days → new (outside the 2-day window)' },
        { ...d, id: 'PLANT-REWORD', description: `${d.description.toUpperCase()} WEEKLY SHOP`, memo: 'planted: same date & amount as a recorded row, different description → new' },
        { ...f, id: 'PLANT-CENT', amount: round2(f.amount - 0.01), memo: 'planted: same date & description as a recorded row, amount differs by 0.01 → new' },
      ];
      const kept = base.rows.filter(r => r !== a && r !== b && r !== c);
      const s = withRows({ ...base, rows: kept }, planted);
      const e = 'Into fin, or into a fresh account after S1: 9 rows "already recorded"; PLANT-1DAY and PLANT-2DAY need a Keep/Skip decision (P1); PLANT-3DAY, PLANT-REWORD and PLANT-CENT are new.';
      return scenario('S4', 'Near-duplicates', 'September 2026 with three rows posted 1, 2 and 3 days later than recorded, plus a reworded and a one-cent-off look-alike (ids start with PLANT-).', [
        csvFile(s, 'us', e), ofxFile(s, 'ofx1', e), qifFile(s, { dateStyle: 'uk' }, e), obFile(s, 'obie', e),
      ]);
    }
    case 'S5': {
      const base = sep();
      const k = base.rows.find(r => r.amount < 0 && Number(r.date.slice(8)) === 10) ?? base.rows[5];
      const repeat: StatementRow = { ...k, id: 'REPEAT-OF-' + k.id, memo: 'planted: verbatim repeat of ' + k.id };
      const coffeeDate = '2026-09-16';
      const coffees: StatementRow[] = [
        { id: 'COFFEE-A', date: coffeeDate, amount: -4.8, currency: base.account.currency, description: 'Coffee & pastries' },
        { id: 'COFFEE-B', date: coffeeDate, amount: -4.8, currency: base.account.currency, description: 'Espresso bar' },
      ];
      const s = withRows(base, [repeat, ...coffees]);
      return scenario('S5', 'Repeats in one file', 'September 2026 plus a verbatim repeat of one row and two same-amount coffees on one day.', [
        csvFile(s, 'us', 'Into fin (or after S1): 12 recorded; no ids in CSV, so the repeat needs a Keep/Skip decision (P2); COFFEE-A and COFFEE-B are both new (different descriptions).'),
        qifFile(s, { dateStyle: 'us' }, 'Into fin (or after S1): 12 recorded; no ids in QIF, so the repeat needs a Keep/Skip decision (P2); both coffees new.'),
        ofxFile(s, 'ofx1', 'Into fin (or after S1): 12 recorded; distinct FITIDs, so the repeat is a genuine second transaction (new); both coffees new.'),
        obFile(s, 'obie', 'Into fin (or after S1): 12 recorded; distinct TransactionIds, so the repeat is new; both coffees new.'),
      ]);
    }
    case 'S6': {
      const base = sep();
      const eur: StatementRow[] = [
        { id: 'EUR-1', date: '2026-09-12', amount: -24.5, currency: 'EUR', description: 'Café de Flore Paris', memo: 'planted: EUR row on a USD account → excluded' },
        { id: 'EUR-2', date: '2026-09-13', amount: -89, currency: 'EUR', description: 'SNCF Paris–Lyon', memo: 'planted: EUR row → excluded' },
        { id: 'EUR-3', date: '2026-09-14', amount: 120, currency: 'EUR', description: 'Hotel refund', memo: 'planted: EUR row → excluded' },
      ];
      const mixed = withRows(base, eur);
      const gbp = sep({ currency: 'GBP' });
      const e = 'Into any USD account: the three EUR rows (ids EUR-1..3) are flagged "excluded: currency" and never imported; the USD rows behave as in S1 (recorded into fin, new into an empty account).';
      return scenario('S6', 'Foreign currency', 'USD statement with three EUR rows, plus a whole statement in GBP.', [
        csvFile(mixed, 'withCurrency', e), obFile(mixed, 'obie', e), obFile(mixed, 'berlin', e),
        { ...ofxFile(gbp, 'ofx2', 'CURDEF is GBP: the whole file is blocked for a USD account.'), name: `${baseName(gbp)}.gbp.ofx2.ofx` },
        { ...obFile(gbp, 'obie', 'Every row is GBP: the whole file is blocked for a USD account.'), name: `${baseName(gbp)}.gbp.obie.json` },
      ]);
    }
    case 'S7': {
      const base = sep();
      const pending: StatementRow[] = [
        { id: 'PENDING-1', date: '2026-09-29', amount: -36.4, currency: base.account.currency, description: 'Pending card authorisation — Petrol station', pending: true },
        { id: 'PENDING-2', date: '2026-09-30', amount: -12.99, currency: base.account.currency, description: 'Pending — Streaming subscription', pending: true },
        { id: 'FUTURE-1', date: '2026-10-27', amount: -250, currency: base.account.currency, description: 'Scheduled payment — Car insurance', memo: 'planted: dated after the seed date 2026-10-25 → excluded: future' },
      ];
      const s = withRows(base, pending);
      const e = 'Into fin: 12 recorded; PENDING-1 and PENDING-2 are "excluded: pending" unless "Include pending" is ticked; FUTURE-1 (dated 27 Oct 2026, after today) is "excluded: future" and can never be imported.';
      return scenario('S7', 'Pending and future rows', 'September 2026 with two pending (not yet booked) rows and one row dated after today.', [
        obFile(s, 'obie', e), obFile(s, 'berlin', e), obFile(s, 'plaid', e),
      ]);
    }
    case 'S8': {
      const s = sep();
      const amb = sep({ onlyDaysUpTo12: true });
      return scenario('S8', 'Messy CSV dialects', 'September 2026 in awkward CSV shapes: preamble lines, BOM, CRLF, quoted newlines, thousands separators, parentheses, DR/CR, German format, UTF-16, ambiguous dates.', [
        csvFile(s, 'messy', 'Parses despite preamble, BOM, CRLF, "(12.34)" negatives, "1,234.56" and an embedded newline. All rows as in S1.'),
        csvFile(s, 'de', 'Semicolon delimiter, DD.MM.YYYY dates, "1.234,56" numbers, CRLF. All rows as in S1.'),
        csvFile(s, 'drcr', 'Unsigned amounts with DR/CR suffix. All rows as in S1.'),
        csvFile(s, 'us', 'UTF-16LE with BOM. All rows as in S1.', 'utf16le'),
        csvFile(s, 'uk', 'UTF-8 with BOM, newest-first order, Money In / Money Out columns. All rows as in S1.', 'utf8-bom'),
        csvFile(amb, 'ambiguous', 'DD/MM/YYYY where every day ≤ 12: the date order cannot be inferred — the browser locale decides (en-GB → DMY, en-US → MDY) and the mapping step lets the user override.'),
      ]);
    }
    case 'S9': {
      const chk = sep();
      const card = statementFor(src, CARD, '2026-09-01', '2026-09-30');
      return scenario('S9', 'Transfer pair', 'Checking and credit card for the same month: the card pay-off appears on both (negative on checking, positive on the card).', [
        csvFile(chk, 'us', 'Into fin: all recorded. Into a fresh checking account whose card account already holds S10: 12 new, "Credit card payment" paired with the card\'s "Payment received" → Transfer, not a duplicate.'),
        ofxFile(card, 'ofx1', 'Into fin/Travel Rewards Card: all recorded. Into a fresh credit account: 12 new; "Payment received — thank you" pairs with a checking leg when one exists → Transfer.'),
        csvFile(card, 'uk', 'Same card statement as CSV (newest-first, Money In / Money Out columns).'),
      ]);
    }
    case 'S10': {
      const s = statementFor(src, CARD, '2026-09-01', '2026-09-30');
      const e = 'Into fin/Travel Rewards Card: all recorded. Into a fresh credit account: 12 new. Purchases are negative (expenses that increase the amount owed), the payment positive (reduces it); closing balance 0.00 = nothing owed.';
      return scenario('S10', 'Credit card statement', 'Travel Rewards Card, September 2026.', [
        csvFile(s, 'us', e), ofxFile(s, 'ofx1', e), ofxFile(s, 'ofx2', e), ofxFile(s, 'qfx', e),
        qifFile(s, { dateStyle: 'us', accountHeader: true }, e), obFile(s, 'obie', e), obFile(s, 'plaid', e),
      ]);
    }
    case 'S11': {
      const rand = mulberry32(11);
      const garbage = Buffer.from(Array.from({ length: 512 }, () => Math.floor(rand() * 256)));
      const ofx1 = writeOfx(sep(), 'ofx1');
      // Cut the SGML 40 bytes into the fourth transaction so three rows survive and the fourth is incomplete.
      const cutAt = nthIndex(ofx1.toString('latin1'), '<STMTTRN>', 4) + 40;
      const invalid = (name: string, bytes: Buffer, dialect: string, expect: string): ScenarioFile => ({ name, bytes, format: 'invalid', dialect, expect });
      return scenario('S11', 'Invalid and unsupported files', 'Files the importer must reject with a specific message.', [
        invalid('garbage.csv', garbage, 'garbage', 'Rejected: not a recognised statement format.'),
        invalid('empty.csv', Buffer.alloc(0), 'empty', 'Rejected: the file is empty.'),
        invalid('truncated.ofx', ofx1.subarray(0, cutAt), 'truncated-ofx', 'Partial: the OFX is cut off inside the fourth transaction — the first three rows parse, the fourth is invalid, and the file is flagged as truncated (no closing balance).'),
        invalid('brokerage.qif', writeQifInvestment(), 'qif-invst', 'Rejected: investment (brokerage) statements are not supported.'),
        invalid('brokerage.ofx', writeOfxInvestment(), 'ofx-invst', 'Rejected: investment (brokerage) statements are not supported.'),
        invalid('no-transactions.json', writeJsonWithoutTransactions(), 'json-no-txns', 'Rejected: JSON without a transaction list.'),
        invalid('headers-only.csv', Buffer.from('Date,Description,Amount\n', 'utf8'), 'csv-no-rows', 'Rejected: no transaction rows.'),
      ]);
    }
    case 'S12': {
      const s = syntheticFreshAccount();
      const e = 'Account that does not exist in the demo data: create a USD checking account (any user, including fin) and import — all 34 rows new, 3 of them Uncategorized (ADOBE CREATIVE CLOUD).';
      return scenario('S12', 'Fresh account', 'Three months (Aug–Oct 2026) for a synthetic "Side Hustle Checking" account.', [
        csvFile(s, 'us', e), ofxFile(s, 'ofx2', e), qifFile(s, { dateStyle: 'iso' }, e), obFile(s, 'obie', e),
      ]);
    }
  }
}

function nthIndex(text: string, needle: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) { idx = text.indexOf(needle, idx + 1); if (idx === -1) return text.length; }
  return idx;
}

function scenario(id: string, title: string, description: string, files: ScenarioFile[]): Scenario {
  return { id, title, description, files };
}

export function buildScenarios(src: StatementSource): Scenario[] {
  return SCENARIO_IDS.map(id => buildScenario(id, src));
}

/** S12: a deterministic synthetic account not present in the demo data. */
export function syntheticFreshAccount(): Statement {
  const rand = mulberry32(12);
  const between = (lo: number, hi: number) => round2(lo + rand() * (hi - lo));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const rows: StatementRow[] = [];
  let seq = 0;
  const add = (date: string, amount: number, description: string, extra: Partial<StatementRow> = {}) => {
    rows.push({ id: makeRowId(date, ++seq, amount), date, amount: round2(amount), currency: 'USD', description, ...extra });
  };
  for (const ym of ['2026-08', '2026-09', '2026-10']) {
    const last = ym === '2026-10' ? 25 : 28;
    add(`${ym}-01`, 2450, 'ACME CONSULTING INVOICE PAYMENT', { bankCode: 'PMNT/RCDT/OTHR' });
    add(`${ym}-03`, -89.99, 'ADOBE CREATIVE CLOUD');
    add(`${ym}-05`, -1200, 'TRANSFER TO EVERYDAY CHECKING');
    for (const d of [6, 13, 20, 27]) if (d <= last) add(`${ym}-${String(d).padStart(2, '0')}`, -between(18, 64), pick(['STARBUCKS', 'PRET A MANGER', 'BLUE BOTTLE COFFEE']));
    if (9 <= last) add(`${ym}-09`, -between(35, 120), pick(['AMAZON MKTPLACE', 'OFFICE DEPOT', 'APPLE.COM/BILL']));
    if (15 <= last) add(`${ym}-15`, between(300, 900), 'UPWORK ESCROW PAYOUT');
    if (18 <= last) add(`${ym}-18`, -between(40, 80), 'UBER TRIP');
    if (22 <= last) add(`${ym}-22`, -14.99, 'NETFLIX.COM');
    if (28 <= last) add(`${ym}-28`, between(1.5, 4), 'INTEREST PAID');
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return withRunningBalance({
    account: { name: 'Side Hustle Checking', type: 'checking', currency: 'USD', externalId: '000555123456', bankId: '021000021' },
    dateFrom: '2026-08-01',
    dateTo: '2026-10-25',
    openingBalance: 1500,
    closingBalance: 0,
    rows,
  });
}
