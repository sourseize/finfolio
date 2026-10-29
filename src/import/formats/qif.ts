/**
 * QIF (Quicken Interchange Format). Bank, credit-card and cash lists are
 * imported; investment lists are rejected. Category/class/memorised lists
 * are skipped. Dates come in many shapes (`9/ 3'26`, `03/09/2026`, ISO) and
 * the day/month order is inferred from the whole file.
 */
import { inferDateOrder, parseAmount, parseDate } from '../normalize.js';
import { ImportError, type ParseOptions, type ParsedStatement, type RawRow } from '../types.js';

interface QifRecord {
  fields: { code: string; value: string }[];
  raw: string;
  listType: string;
}

const TXN_TYPES: Record<string, 'checking' | 'credit' | 'cash' | 'savings'> = {
  BANK: 'checking', CCARD: 'credit', CASH: 'cash', 'OTH A': 'checking', 'OTH L': 'credit',
};

function splitRecords(text: string): { records: QifRecord[]; account?: { name?: string; type?: string; description?: string }; sawInvest: boolean } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const records: QifRecord[] = [];
  let listType = '';
  let inAccountBlock = false;
  let cur: { code: string; value: string }[] = [];
  let rawLines: string[] = [];
  let account: { name?: string; type?: string; description?: string } | undefined;
  let sawInvest = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('!')) {
      const directive = line.slice(1).trim();
      const lower = directive.toLowerCase();
      if (lower.startsWith('type:')) {
        listType = directive.slice(5).trim().toUpperCase();
        inAccountBlock = false;
        if (listType === 'INVST') sawInvest = true;
      } else if (lower === 'account') {
        inAccountBlock = true;
        listType = '';
      } else if (lower.startsWith('option:') || lower.startsWith('clear:')) {
        // AutoSwitch toggles — nothing to do
      }
      cur = []; rawLines = [];
      continue;
    }
    if (line.startsWith('^')) {
      if (inAccountBlock) {
        const get = (c: string) => cur.find(f => f.code === c)?.value;
        account = { name: get('N') ?? account?.name, type: get('T') ?? account?.type, description: get('D') ?? account?.description };
      } else if (cur.length) {
        records.push({ fields: cur, raw: rawLines.join(' | '), listType });
      }
      cur = []; rawLines = [];
      continue;
    }
    cur.push({ code: line[0].toUpperCase(), value: line.slice(1).trim() });
    rawLines.push(line.trim());
  }
  if (cur.length && !inAccountBlock) records.push({ fields: cur, raw: rawLines.join(' | '), listType });
  return { records, account, sawInvest };
}

export function parseQif(text: string, opts: ParseOptions, encoding: string): ParsedStatement {
  if (!text.trim()) throw new ImportError('empty', 'The file is empty');
  const { records, account, sawInvest } = splitRecords(text);
  const txnRecords = records.filter(r => TXN_TYPES[r.listType] !== undefined);
  if (!txnRecords.length) {
    if (sawInvest) throw new ImportError('investment', 'This is a Quicken investment export — investment imports are not supported');
    throw new ImportError('invalid', 'No bank, credit-card or cash transactions found in the QIF file');
  }
  const warnings: string[] = [];
  if (sawInvest) warnings.push('Investment sections in this file were ignored');
  const listTypes = new Set(txnRecords.map(r => r.listType));
  if (listTypes.size > 1) warnings.push(`The file mixes ${[...listTypes].join(', ')} lists; all rows were included`);

  const dateStrings = txnRecords.map(r => r.fields.find(f => f.code === 'D')?.value ?? '');
  const dateInference = inferDateOrder(dateStrings, opts.localeHint);
  const dateOrder = opts.mapping?.dateOrder ?? dateInference.order;
  if (dateInference.ambiguous && !opts.mapping?.dateOrder) warnings.push(`Dates could be day/month or month/day — assuming ${dateOrder === 'DMY' ? 'day/month' : 'month/day'}`);

  const rows: RawRow[] = txnRecords.map((rec, index) => {
    const get = (c: string) => rec.fields.find(f => f.code === c)?.value;
    const errors: string[] = [];
    const date = parseDate(get('D') ?? '', dateOrder);
    if (!date) errors.push(`Unrecognised date "${get('D') ?? ''}"`);
    const amount = parseAmount(get('T') ?? get('U'));
    if (amount === null) errors.push('Missing or invalid amount (T)');
    const payee = get('P') ?? '';
    const memo = get('M');
    const category = get('L');
    const splits = rec.fields.filter(f => f.code === 'S').map((f, i) => ({ category: f.value, amount: parseAmount(rec.fields.filter(x => x.code === '$')[i]?.value ?? '') }));
    const row: RawRow = {
      index,
      date,
      amount,
      description: (payee || memo || '').replace(/\s+/g, ' ').trim(),
      errors,
      raw: rec.raw,
    };
    if (memo && memo !== row.description) row.memo = memo;
    if (category) {
      const m = category.match(/^\[(.+)\]$/);
      if (m) row.transferAccount = m[1];
      else row.category = category.split('/')[0].trim(); // strip a Quicken class after "/"
    }
    if (splits.length) {
      row.memo = [row.memo, `Split: ${splits.map(s => `${s.category}${s.amount !== null ? ' ' + s.amount.toFixed(2) : ''}`).join('; ')}`].filter(Boolean).join(' · ');
      if (!row.category && !row.transferAccount && splits.length === 1) row.category = splits[0].category;
    }
    const num = get('N'); if (num) row.checkNumber = num;
    return row;
  });

  const dates = rows.map(r => r.date).filter((d): d is string => !!d).sort();
  const firstType = TXN_TYPES[txnRecords[0].listType];
  const acctType = account?.type ? TXN_TYPES[account.type.toUpperCase()] ?? firstType : firstType;

  return {
    format: 'qif',
    dialect: 'qif',
    encoding,
    account: { name: account?.name, externalId: account?.description, type: acctType },
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    rows,
    warnings,
  };
}
