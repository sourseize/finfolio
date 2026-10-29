/**
 * Statement model shared by the test-statement writers (src/testing/statements)
 * and the round-trip tests. It describes what a bank would export for one
 * account over one period, independent of file format.
 *
 * Sign convention (the bank's point of view, used by every real-world format):
 *   amount < 0  money left the account   (purchase, withdrawal, card spend)
 *   amount > 0  money came in            (salary, refund, card payment received)
 * This holds for credit cards too: purchases are negative, payments positive.
 *
 * Balances are also from the bank's point of view: a credit-card closing
 * balance of -420 means 420 is owed.
 */

export type StatementAccountType = 'checking' | 'savings' | 'credit' | 'cash';

export interface StatementAccount {
  /** Display name (what the user calls it in FinFolio). */
  name: string;
  type: StatementAccountType;
  /** ISO 4217 code. */
  currency: string;
  /** Account number as the bank prints it (OFX ACCTID, OBIE AccountId …). */
  externalId: string;
  /** Routing / sort code (OFX BANKID). */
  bankId?: string;
  /** IBAN for Berlin Group exports. */
  iban?: string;
}

export interface StatementRow {
  /** Bank-assigned unique id (FITID / TransactionId). Stable across formats of the same statement. */
  id: string;
  /** Transaction date, YYYY-MM-DD. */
  date: string;
  /** Posting date when it differs from `date`. */
  postedDate?: string;
  /** Signed amount, see header comment. */
  amount: number;
  currency: string;
  /** Payee / narrative as the bank prints it. */
  description: string;
  /** Secondary text (OFX MEMO, QIF M, CSV memo column). */
  memo?: string;
  /** Category label carried by the export (QIF L, Mint "Category", Plaid category). */
  category?: string;
  /** Merchant category code (Open Banking). */
  mcc?: number;
  /** ISO 20022 bank transaction code, e.g. "PMNT/RCDT/SALA". */
  bankCode?: string;
  pending?: boolean;
  /** Running balance after this row (bank's point of view). */
  balanceAfter?: number;
  reference?: string;
  checkNumber?: string;
  /** QIF `[Account]` counterpart for transfers. */
  transferAccount?: string;
}

export interface Statement {
  account: StatementAccount;
  /** Inclusive period, YYYY-MM-DD. */
  dateFrom: string;
  dateTo: string;
  openingBalance: number;
  closingBalance: number;
  /** Rows in chronological order. */
  rows: StatementRow[];
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Recompute `balanceAfter` for every row and the closing balance from the opening one. */
export function withRunningBalance(statement: Statement): Statement {
  let bal = statement.openingBalance;
  const rows = statement.rows.map(r => {
    if (!r.pending) bal = round2(bal + r.amount);
    return { ...r, balanceAfter: r.pending ? undefined : bal };
  });
  return { ...statement, rows, closingBalance: bal };
}

/** Deterministic, readable bank id for a row: date + sequence + cents. */
export function makeRowId(date: string, seq: number, amount: number): string {
  return `${date.replace(/-/g, '')}${String(seq).padStart(4, '0')}${Math.abs(Math.round(amount * 100))}`;
}

/** ISO date arithmetic without time zones. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d + days);
  return new Date(t).toISOString().slice(0, 10);
}

/** Compact cp1252 encoder sufficient for OFX 1.x files (falls back to '?' for anything else). */
export function encodeCp1252(text: string): Buffer {
  const high: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else if (high[ch] !== undefined) out.push(high[ch]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

/** UTF-16LE with BOM, as some banks export CSV. */
export function encodeUtf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}
