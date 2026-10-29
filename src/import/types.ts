/**
 * Shared types for the statement importer (src/import).
 *
 * A parser turns file bytes into a `ParsedStatement`: a flat list of `RawRow`s
 * in the bank's sign convention (negative = money out) plus whatever the
 * format tells us about the account, currency, period and closing balance.
 * Everything downstream (dedupe, categorisation, preview) works on RawRow.
 */
import type { ImportSource } from '../db/database.js';

export type ImportFormat = ImportSource;
export type DateOrder = 'YMD' | 'DMY' | 'MDY';
export type NumberFormat = 'point' | 'comma';

export interface RawRow {
  /** 0-based position among the data rows of the file. */
  index: number;
  /** YYYY-MM-DD, or null when it could not be parsed (see `errors`). */
  date: string | null;
  /** Posting/booking date when the file distinguishes it from the transaction date. */
  postedDate?: string;
  /** Signed amount, bank convention; null when unparseable. */
  amount: number | null;
  /** Row currency when the file states one. */
  currency?: string;
  description: string;
  memo?: string;
  /** Bank-assigned unique id (OFX FITID, OB TransactionId …). */
  externalId?: string;
  /** Category label carried by the file (QIF L, CSV category column, Plaid category). */
  category?: string;
  /** Merchant category code. */
  mcc?: number;
  /** ISO 20022 code, normalised to "FAMILY/SUBFAMILY" (e.g. "RCDT/SALA"). */
  bankCode?: string;
  pending?: boolean;
  /** Running balance after the row, bank convention. */
  balance?: number;
  reference?: string;
  checkNumber?: string;
  /** QIF `[Account]` counterpart. */
  transferAccount?: string;
  /** Why `date`/`amount` are null, or other row-level problems. */
  errors: string[];
  /** The source text of the row (line, record or JSON snippet) for display. */
  raw: string;
}

export interface CsvColumns {
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  /** DR/CR or debit/credit indicator paired with an unsigned amount column. */
  indicator?: number;
  balance?: number;
  category?: number;
  currency?: number;
  reference?: number;
  memo?: number;
  postedDate?: number;
}

export interface CsvMapping {
  delimiter: string;
  /** Index (in parsed records) of the header row; -1 when the file has no header. */
  headerRow: number;
  headers: string[];
  dateOrder: DateOrder;
  /** True when the data alone could not settle DD/MM vs MM/DD (the locale hint or the user decided). */
  dateOrderAmbiguous: boolean;
  numberFormat: NumberFormat;
  columns: CsvColumns;
  signConvention: 'signed' | 'debitCredit' | 'indicator';
  /** sha256 of the normalised header row — key for remembered mappings. */
  headerSignature: string;
}

/** User/profile overrides applied on top of inference. */
export interface CsvMappingOverrides {
  delimiter?: string;
  headerRow?: number;
  dateOrder?: DateOrder;
  numberFormat?: NumberFormat;
  columns?: Partial<CsvColumns>;
  signConvention?: CsvMapping['signConvention'];
}

export interface ParsedStatement {
  format: ImportFormat;
  /** Format-specific flavour: "ofx1" | "ofx2" | "qfx" | "qif" | "obie" | "berlin" | "plaid" | "generic-json" | "csv". */
  dialect: string;
  encoding: string;
  account?: {
    externalId?: string;
    bankId?: string;
    type?: 'checking' | 'savings' | 'credit' | 'cash';
    name?: string;
  };
  /** Currency declared for the whole file (OFX CURDEF, Berlin account.currency …). */
  currency?: string;
  dateFrom?: string;
  dateTo?: string;
  closingBalance?: { amount: number; asOf?: string };
  rows: RawRow[];
  warnings: string[];
  /** Present for CSV and generic JSON: what was inferred, for the mapping step. */
  csv?: {
    mapping: CsvMapping;
    /** Up to 5 data records (strings) for the mapping preview. */
    sample: string[][];
    total: number;
    parsedOk: number;
  };
}

export interface ParseOptions {
  /** Browser locale (navigator.language) — tie-breaker for ambiguous date order. */
  localeHint?: string;
  /** CSV / generic JSON mapping overrides (from the mapping step or a remembered profile). */
  mapping?: CsvMappingOverrides;
}

export type ImportErrorCode = 'empty' | 'unsupported' | 'invalid' | 'investment';

export class ImportError extends Error {
  constructor(public code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
  }
}
