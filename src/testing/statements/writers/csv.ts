/**
 * CSV writers — one function per bank "dialect". Each dialect mirrors a real
 * export style so the importer's inference (delimiter, header, columns, date
 * order, number format, sign convention) is exercised end to end.
 */
import { encodeUtf16le, type Statement, type StatementRow } from '../model.js';

export type CsvDialect = 'us' | 'uk' | 'de' | 'messy' | 'ambiguous' | 'withCurrency' | 'drcr' | 'mint' | 'tsv';
export type CsvEncoding = 'utf8' | 'utf8-bom' | 'utf16le';

export interface CsvOptions {
  dialect: CsvDialect;
  encoding?: CsvEncoding;
}

export const CSV_DIALECTS: CsvDialect[] = ['us', 'uk', 'de', 'messy', 'ambiguous', 'withCurrency', 'drcr', 'mint', 'tsv'];

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: string) => d.split('-').map(Number) as [number, number, number];
const mdy = (d: string) => { const [y, m, dd] = ymd(d); return `${pad(m)}/${pad(dd)}/${y}`; };
const dmy = (d: string) => { const [y, m, dd] = ymd(d); return `${pad(dd)}/${pad(m)}/${y}`; };
const dmyDots = (d: string) => { const [y, m, dd] = ymd(d); return `${pad(dd)}.${pad(m)}.${y}`; };

/** 1234.5 → "1,234.50" */
const usNum = (n: number) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 1234.5 → "1.234,50" */
const deNum = (n: number) => Math.abs(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = (n: number) => n.toFixed(2);

/** RFC 4180 quoting: quote when the field contains the delimiter, a quote or a newline. */
function q(field: string | number | undefined, delimiter = ','): string {
  const s = field === undefined ? '' : String(field);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function lines(header: string[], rows: string[][], delimiter = ',', eol = '\n'): string {
  return [header, ...rows].map(r => r.map(f => q(f, delimiter)).join(delimiter)).join(eol) + eol;
}

function mintCategory(r: StatementRow): string {
  return r.category ?? 'Uncategorized';
}

/** Bank "type" column as UK banks print it. */
function ukType(r: StatementRow): string {
  if (r.description.toUpperCase().includes('TRANSFER')) return 'TFR';
  if (r.amount > 0) return r.description.toUpperCase().includes('SALARY') ? 'BGC' : 'CR';
  return r.checkNumber ? 'CHQ' : 'DEB';
}

export function writeCsv(statement: Statement, opts: CsvOptions): Buffer {
  const rows = statement.rows;
  let text: string;
  switch (opts.dialect) {
    case 'us':
      text = lines(
        ['Date', 'Description', 'Amount', 'Running Bal.'],
        rows.map(r => [mdy(r.date), r.description, plain(r.amount), r.balanceAfter === undefined ? '' : plain(r.balanceAfter)]),
      );
      break;

    case 'uk':
      // Newest first, as most UK banks export; unsigned Money In / Money Out columns.
      text = lines(
        ['Date', 'Type', 'Description', 'Money In', 'Money Out', 'Balance'],
        [...rows].reverse().map(r => [dmy(r.date), ukType(r), r.description, r.amount > 0 ? plain(r.amount) : '', r.amount < 0 ? plain(-r.amount) : '', r.balanceAfter === undefined ? '' : plain(r.balanceAfter)]),
      );
      break;

    case 'de':
      text = lines(
        ['Buchungstag', 'Valuta', 'Buchungstext', 'Verwendungszweck', 'Betrag', 'Währung', 'Saldo'],
        rows.map(r => [dmyDots(r.date), dmyDots(r.postedDate ?? r.date), r.amount < 0 ? 'Lastschrift' : 'Gutschrift', r.description, `${r.amount < 0 ? '-' : ''}${deNum(r.amount)}`, r.currency, r.balanceAfter === undefined ? '' : deNum(r.balanceAfter)]),
        ';',
        '\r\n',
      );
      break;

    case 'messy': {
      // Preamble, blank lines, BOM, CRLF, thousands separators, parentheses negatives,
      // an embedded newline in a quoted description, trailing blank lines.
      const body = lines(
        ['Transaction Date', 'Posted Date', 'Description', 'Amount', 'Balance'],
        rows.map((r, i) => [
          mdy(r.date),
          mdy(r.postedDate ?? r.date),
          i === 2 ? `${r.description}\nRef ${r.id}` : `${r.description},${r.memo ? ' ' + r.memo : ''}`,
          r.amount < 0 ? `(${usNum(r.amount)})` : usNum(r.amount),
          r.balanceAfter === undefined ? '' : usNum(r.balanceAfter),
        ]),
        ',',
        '\r\n',
      );
      text = `\uFEFFAccount Name: ${statement.account.name}\r\nAccount Number: ****${statement.account.externalId.slice(-4)}\r\nStatement Period: ${mdy(statement.dateFrom)} - ${mdy(statement.dateTo)}\r\n\r\n${body}\r\n\r\n`;
      break;
    }

    case 'ambiguous':
      // DD/MM/YYYY where every day ≤ 12, so the order cannot be told from the data.
      text = lines(
        ['Date', 'Description', 'Amount'],
        rows.map(r => [dmy(r.date), r.description, plain(r.amount)]),
      );
      break;

    case 'withCurrency':
      text = lines(
        ['Date', 'Description', 'Amount', 'Currency', 'Balance'],
        rows.map(r => [r.date, r.description, plain(r.amount), r.currency, r.balanceAfter === undefined ? '' : plain(r.balanceAfter)]),
      );
      break;

    case 'drcr':
      text = lines(
        ['Date', 'Narrative', 'Amount', 'Balance'],
        rows.map(r => [dmy(r.date), r.description, `${usNum(r.amount)} ${r.amount < 0 ? 'DR' : 'CR'}`, r.balanceAfter === undefined ? '' : `${usNum(r.balanceAfter)} ${r.balanceAfter < 0 ? 'DR' : 'CR'}`]),
      );
      break;

    case 'mint':
      text = lines(
        ['Date', 'Description', 'Original Description', 'Amount', 'Transaction Type', 'Category', 'Account Name', 'Labels', 'Notes'],
        rows.map(r => [mdy(r.date), r.description, r.memo ?? r.description.toUpperCase(), plain(Math.abs(r.amount)), r.amount < 0 ? 'debit' : 'credit', mintCategory(r), statement.account.name, '', '']),
      );
      break;

    case 'tsv':
      text = lines(
        ['Date', 'Reference', 'Description', 'Amount', 'Balance'],
        rows.map(r => [r.date, r.reference ?? r.id, r.description, plain(r.amount), r.balanceAfter === undefined ? '' : plain(r.balanceAfter)]),
        '\t',
      );
      break;
  }

  switch (opts.encoding ?? 'utf8') {
    case 'utf16le': return encodeUtf16le(text.replace(/^\uFEFF/, ''));
    case 'utf8-bom': return Buffer.from(text.startsWith('\uFEFF') ? text : '\uFEFF' + text, 'utf8');
    default: return Buffer.from(text, 'utf8');
  }
}

export function csvExtension(dialect: CsvDialect): string {
  return dialect === 'tsv' ? 'tsv' : 'csv';
}
