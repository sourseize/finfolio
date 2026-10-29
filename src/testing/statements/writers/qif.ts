/**
 * QIF writer. Two date styles (Quicken US `M/ D'YY` and UK `DD/MM/YYYY`),
 * optional `!Account` header block, `[Account]` transfers and a category on
 * every row (the `L` field) when the statement carries one.
 */
import type { Statement, StatementRow } from '../model.js';

export type QifDateStyle = 'us' | 'uk' | 'iso';
export interface QifOptions {
  dateStyle: QifDateStyle;
  /** Emit the `!Account … ^` preamble Quicken writes when exporting an account. */
  accountHeader?: boolean;
}

export const QIF_STYLES: QifOptions[] = [
  { dateStyle: 'us', accountHeader: true },
  { dateStyle: 'uk' },
  { dateStyle: 'iso' },
];

function qifDate(d: string, style: QifDateStyle): string {
  const [y, m, dd] = d.split('-').map(Number);
  if (style === 'iso') return d;
  if (style === 'uk') return `${String(dd).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  // Quicken pads single-digit days with a space: 9/ 3'26
  return `${m}/${dd < 10 ? ' ' + dd : dd}'${String(y).slice(2)}`;
}

/** Quicken writes thousands separators in T amounts. */
const qifAmount = (n: number) => (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function record(r: StatementRow, style: QifDateStyle): string {
  const lines = [`D${qifDate(r.date, style)}`, `T${qifAmount(r.amount)}`, `C*`];
  if (r.checkNumber) lines.push(`N${r.checkNumber}`);
  lines.push(`P${r.description}`);
  if (r.memo) lines.push(`M${r.memo}`);
  if (r.transferAccount) lines.push(`L[${r.transferAccount}]`);
  else if (r.category) lines.push(`L${r.category}`);
  lines.push('^');
  return lines.join('\n');
}

export function writeQif(statement: Statement, opts: QifOptions): Buffer {
  const a = statement.account;
  const type = a.type === 'credit' ? 'CCard' : a.type === 'cash' ? 'Cash' : 'Bank';
  const out: string[] = [];
  if (opts.accountHeader) {
    out.push('!Option:AutoSwitch', '!Account', `N${a.name}`, `T${type}`, `D${a.externalId}`, '^', '!Clear:AutoSwitch', '!Account', `N${a.name}`, `T${type}`, '^');
  }
  out.push(`!Type:${type}`);
  for (const r of statement.rows.filter(r => !r.pending)) out.push(record(r, opts.dateStyle));
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}

/** Quicken investment export — used to check that it is rejected. */
export function writeQifInvestment(): Buffer {
  return Buffer.from(['!Type:Invst', "D9/ 6'26", 'NBuy', 'YVanguard Total Stock Market ETF', 'I250.00', 'Q3', 'T750.00', 'MMonthly purchase', '^', ''].join('\n'), 'utf8');
}
