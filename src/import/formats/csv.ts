/**
 * CSV / TSV statements. There is no standard, so this module infers
 * everything — delimiter, preamble, header, column roles, date order, number
 * format and sign convention — and exposes the result as a `CsvMapping` the
 * user can correct in the mapping step (or a remembered profile can supply).
 *
 * `parseTable` is shared with the generic-JSON path of the Open Banking parser.
 */
import { inferDateOrder, inferNumberFormat, parseAmount, parseDate, sha256 } from '../normalize.js';
import { ImportError, type CsvColumns, type CsvMapping, type CsvMappingOverrides, type ParseOptions, type ParsedStatement, type RawRow } from '../types.js';

// ── Record reader ──

/** RFC 4180-tolerant reader: quoted fields, doubled quotes, embedded newlines, CRLF. */
export function readCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  return records.map(r => r.map(f => f.trim()));
}

const DELIMITERS = [',', ';', '\t', '|'];

/** Pick the delimiter whose per-line count (outside quotes) is most consistent. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 50);
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map(l => {
      let c = 0, q = false;
      for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) c++; }
      return c;
    }).filter(c => c > 0);
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => counts.filter(v => v === b).length - counts.filter(v => v === a).length)[0];
    const consistent = counts.filter(c => c === mode).length;
    const score = consistent * 10 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// ── Header / column inference ──

const looksNumeric = (s: string) => /^[-+(]?\s*[$€£¥]?\s*[\d.,' ]+\s*[)%]?\s*(DR|CR|DB)?$/i.test(s.trim()) && /\d/.test(s);
const looksDate = (s: string) => parseDate(s, 'DMY') !== null || parseDate(s, 'MDY') !== null;
const lower = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function isHeaderLike(fields: string[]): boolean {
  const nonEmpty = fields.filter(f => f !== '');
  if (nonEmpty.length < 2) return false;
  return nonEmpty.every(f => !looksNumeric(f) && !looksDate(f) && /[A-Za-z]/.test(f));
}

interface TableShape { headerRow: number; headers: string[]; data: string[][]; skipped: number }

/** Find the header (after any preamble) and the data rows of consistent width. */
function findTable(records: string[][], headerRowOverride?: number): TableShape {
  const widths = records.map(r => r.length);
  const counts = new Map<number, number>();
  for (const w of widths) if (w >= 2) counts.set(w, (counts.get(w) || 0) + 1);
  if (!counts.size) throw new ImportError('invalid', 'No delimited rows found');
  const modeWidth = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];

  let headerRow = -1;
  if (headerRowOverride !== undefined) headerRow = headerRowOverride;
  else {
    const first = records.findIndex(r => r.length === modeWidth);
    if (first !== -1 && isHeaderLike(records[first])) headerRow = first;
  }
  const start = headerRow === -1 ? records.findIndex(r => r.length === modeWidth) : headerRow + 1;
  const data: string[][] = [];
  let skipped = 0;
  for (let i = Math.max(0, start); i < records.length; i++) {
    const r = records[i];
    if (r.every(f => f === '')) continue;
    if (r.length === modeWidth) data.push(r);
    else if (r.length > modeWidth) data.push(r.slice(0, modeWidth)); // trailing junk column
    else skipped++;
  }
  const headers = headerRow === -1 ? Array.from({ length: modeWidth }, (_, i) => `Column ${i + 1}`) : records[headerRow].map((h, i) => h || `Column ${i + 1}`);
  return { headerRow, headers, data, skipped };
}

const HEADER_ROLES: { role: keyof CsvColumns; test: RegExp; priority: number }[] = [
  { role: 'postedDate', test: /^(posted|posting|booking|settlement|value)\s*date$|^valuta$|^wertstellung$|^date (posted|booked)$/, priority: 1 },
  { role: 'date', test: /date|^datum$|^buchungstag$|^fecha$|^data$/, priority: 2 },
  { role: 'indicator', test: /^(dr\/cr|cr\/dr|debit\/credit|credit\/debit|d\/c|transaction type|type|indicator|soll\/haben)$/, priority: 3 },
  { role: 'debit', test: /^(debit|debits|debit amount|money out|paid out|withdrawal|withdrawals|outflow|spent|soll|ausgang|out)$/, priority: 4 },
  { role: 'credit', test: /^(credit|credits|credit amount|money in|paid in|deposit|deposits|inflow|received|haben|eingang|in)$/, priority: 4 },
  { role: 'balance', test: /balance|^saldo$|^solde$|running/, priority: 5 },
  { role: 'amount', test: /^amount\b|^betrag$|^importe$|^montant$|^value$|^sum$|^transaction amount$|^amt$/, priority: 6 },
  { role: 'currency', test: /^currency$|^ccy$|^währung$|^waehrung$|^devise$|^iso currency/, priority: 7 },
  { role: 'category', test: /^category$|^kategorie$|^categor/, priority: 8 },
  { role: 'reference', test: /^(reference|ref|ref\.|check ?(no|number|#)|cheque (no|number)|transaction id|id)$/, priority: 9 },
  { role: 'memo', test: /^(memo|notes?|original description|additional information|extended description|buchungstext)$/, priority: 10 },
  { role: 'description', test: /description|narrative|details|payee|^name$|merchant|particulars|transaction information|verwendungszweck|^text$|^libell|^concepto$|^beschreibung$/, priority: 11 },
];

/** ISO 4217 codes a content-based currency column must consist of. */
const KNOWN_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'ZAR', 'INR', 'CNY', 'HKD', 'SGD', 'KRW', 'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'AED', 'SAR', 'ILS', 'THB', 'MYR', 'IDR', 'PHP', 'TWD', 'RUB', 'UAH', 'ISK', 'BTC', 'ETH']);

const INDICATOR_VALUES = new Set(['DR', 'CR', 'D', 'C', 'DB', 'DEBIT', 'CREDIT', 'S', 'H', 'SOLL', 'HABEN', 'WITHDRAWAL', 'DEPOSIT']);

function columnStats(data: string[][], col: number) {
  const values = data.map(r => r[col] ?? '').filter(v => v !== '');
  const n = values.length || 1;
  return {
    values,
    filled: values.length / (data.length || 1),
    dates: values.filter(looksDate).length / n,
    numeric: values.filter(looksNumeric).length / n,
    signed: values.filter(v => /^-|^\(|-$|\bDR\b/i.test(v.trim())).length / n,
    indicator: values.filter(v => INDICATOR_VALUES.has(v.trim().toUpperCase())).length / n,
    avgLen: values.reduce((s, v) => s + v.length, 0) / n,
  };
}

/** Assign roles from header names first, then verify/fill from the content. */
function inferColumns(headers: string[], data: string[][], hasHeader: boolean): { columns: CsvColumns; signConvention: CsvMapping['signConvention'] } {
  const cols: Partial<CsvColumns> = {};
  const taken = new Set<number>();
  const stats = headers.map((_, i) => columnStats(data, i));

  if (hasHeader) {
    for (const rule of HEADER_ROLES) {
      if (cols[rule.role] !== undefined) continue;
      for (let i = 0; i < headers.length; i++) {
        if (taken.has(i)) continue;
        const h = lower(headers[i]);
        if (!rule.test.test(h)) continue;
        // content sanity
        if (rule.role === 'date' || rule.role === 'postedDate') { if (stats[i].dates < 0.6) continue; }
        if (rule.role === 'amount' || rule.role === 'debit' || rule.role === 'credit' || rule.role === 'balance') { if (stats[i].numeric < 0.6 && stats[i].filled > 0) continue; }
        if (rule.role === 'indicator') { if (stats[i].indicator < 0.9) continue; }
        cols[rule.role] = i; taken.add(i); break;
      }
    }
    // "Date" matched postedDate only (e.g. just a "Posted Date" column) → use it as the date
    if (cols.date === undefined && cols.postedDate !== undefined) { cols.date = cols.postedDate; delete cols.postedDate; }
    // a header literally named "Credit" next to "Debit" is a column pair; a lone "Credit" with signed values is an amount
    if (cols.amount === undefined && cols.debit === undefined && cols.credit !== undefined) { cols.amount = cols.credit; delete cols.credit; }
  }

  // Content-based fallbacks
  if (cols.date === undefined) {
    let best = -1, bestScore = 0.6;
    stats.forEach((s, i) => { if (!taken.has(i) && s.dates > bestScore) { best = i; bestScore = s.dates; } });
    if (best === -1) throw new ImportError('invalid', 'Could not find a date column');
    cols.date = best; taken.add(best);
  }
  if (cols.amount === undefined && (cols.debit === undefined || cols.credit === undefined)) {
    const numericCols = stats.map((s, i) => ({ i, s })).filter(x => !taken.has(x.i) && x.s.numeric >= 0.9 && x.s.filled > 0);
    // balance: numeric, fully filled, rarely changes sign … pick the right-most fully filled numeric column when ≥ 2 candidates
    const signedCol = numericCols.find(x => x.s.signed > 0.05 && x.s.filled > 0.9);
    if (signedCol) { cols.amount = signedCol.i; taken.add(signedCol.i); }
    else {
      // two partially filled unsigned columns → debit / credit
      const partial = numericCols.filter(x => x.s.filled < 0.95);
      if (partial.length >= 2) {
        cols.debit = partial[0].i; cols.credit = partial[1].i; taken.add(partial[0].i); taken.add(partial[1].i);
      } else {
        const full = numericCols.filter(x => !taken.has(x.i));
        if (full.length) { cols.amount = full[0].i; taken.add(full[0].i); }
      }
    }
    if (cols.amount === undefined && cols.debit === undefined) throw new ImportError('invalid', 'Could not find an amount column');
  }
  if (cols.balance === undefined) {
    const rest = stats.map((s, i) => ({ i, s })).filter(x => !taken.has(x.i) && x.s.numeric >= 0.9 && x.s.filled > 0.9);
    if (rest.length && hasHeader === false) { cols.balance = rest[rest.length - 1].i; taken.add(cols.balance); }
  }
  if (cols.description === undefined) {
    let best = -1, bestLen = -1;
    stats.forEach((s, i) => { if (!taken.has(i) && s.numeric < 0.5 && s.dates < 0.5 && s.avgLen > bestLen) { best = i; bestLen = s.avgLen; } });
    if (best === -1) throw new ImportError('invalid', 'Could not find a description column');
    cols.description = best; taken.add(best);
  }
  if (cols.indicator === undefined && cols.amount !== undefined) {
    const ind = stats.findIndex((s, i) => !taken.has(i) && s.indicator >= 0.9 && s.filled > 0.9);
    if (ind !== -1) { cols.indicator = ind; taken.add(ind); }
  }
  if (cols.currency === undefined) {
    const cur = stats.findIndex((s, i) => !taken.has(i) && s.filled > 0.9 && s.values.every(v => KNOWN_CURRENCIES.has(v.trim().toUpperCase())));
    if (cur !== -1) { cols.currency = cur; taken.add(cur); }
  }

  let signConvention: CsvMapping['signConvention'] = 'signed';
  if (cols.amount === undefined) signConvention = 'debitCredit';
  else if (cols.indicator !== undefined && stats[cols.amount].signed < 0.05) signConvention = 'indicator';
  return { columns: cols as CsvColumns, signConvention };
}

// ── Row building ──

function buildRows(data: string[][], mapping: CsvMapping): RawRow[] {
  const c = mapping.columns;
  return data.map((r, index) => {
    const errors: string[] = [];
    const get = (i?: number) => (i === undefined ? '' : r[i] ?? '');
    const date = parseDate(get(c.date), mapping.dateOrder);
    if (!date) errors.push(`Unrecognised date "${get(c.date)}"`);
    const postedRaw = get(c.postedDate);
    const postedDate = postedRaw ? parseDate(postedRaw, mapping.dateOrder) ?? undefined : undefined;

    let amount: number | null = null;
    if (mapping.signConvention === 'debitCredit') {
      const debit = parseAmount(get(c.debit), mapping.numberFormat);
      const credit = parseAmount(get(c.credit), mapping.numberFormat);
      if (debit === null && credit === null) errors.push('No debit or credit amount');
      else amount = (credit ?? 0) - Math.abs(debit ?? 0);
      if (debit !== null && debit < 0 && credit === null) amount = debit; // some banks sign the debit column anyway
    } else {
      amount = parseAmount(get(c.amount), mapping.numberFormat);
      if (amount === null) errors.push(`Unrecognised amount "${get(c.amount)}"`);
      else if (mapping.signConvention === 'indicator') {
        const ind = get(c.indicator).trim().toUpperCase();
        const isDebit = ['DR', 'D', 'DB', 'DEBIT', 'S', 'SOLL', 'WITHDRAWAL'].includes(ind);
        amount = isDebit ? -Math.abs(amount) : Math.abs(amount);
      }
    }
    const balanceRaw = get(c.balance);
    const balance = balanceRaw ? parseAmount(balanceRaw, mapping.numberFormat) ?? undefined : undefined;
    const currency = get(c.currency).trim().toUpperCase() || undefined;
    const category = get(c.category) || undefined;
    const reference = get(c.reference) || undefined;
    const memo = get(c.memo) || undefined;
    const row: RawRow = {
      index,
      date,
      amount,
      description: get(c.description).replace(/\s+/g, ' ').trim(),
      errors,
      raw: r.join(mapping.delimiter === '\t' ? ' ⇥ ' : mapping.delimiter + ' '),
    };
    if (postedDate && postedDate !== date) row.postedDate = postedDate;
    if (balance !== undefined) row.balance = balance;
    if (currency && /^[A-Z]{3}$/.test(currency)) row.currency = currency;
    if (category) row.category = category;
    if (reference) row.reference = reference;
    if (memo && memo !== row.description) row.memo = memo;
    return row;
  });
}

// ── Entry points ──

/**
 * Infer a mapping for a table and build rows from it. Used for CSV and for
 * generic JSON arrays (objects flattened to columns).
 */
export function parseTable(records: string[][], opts: ParseOptions, meta: { delimiter: string; dialect: string; encoding: string }): ParsedStatement {
  const ov: CsvMappingOverrides = opts.mapping ?? {};
  const shape = findTable(records, ov.headerRow);
  if (!shape.data.length) throw new ImportError('invalid', 'The file has a header but no transaction rows');
  const hasHeader = shape.headerRow !== -1;

  const inferred = inferColumns(shape.headers, shape.data, hasHeader);
  const columns: CsvColumns = { ...inferred.columns, ...(ov.columns ?? {}) } as CsvColumns;
  for (const k of Object.keys(columns) as (keyof CsvColumns)[]) if (columns[k] === undefined || (columns[k] as number) < 0) delete columns[k];
  let signConvention = ov.signConvention ?? inferred.signConvention;
  if (ov.columns && !ov.signConvention) {
    signConvention = columns.amount === undefined ? 'debitCredit' : columns.indicator !== undefined ? 'indicator' : 'signed';
  }

  const dateValues = shape.data.map(r => r[columns.date] ?? '');
  const dateInference = inferDateOrder(dateValues, opts.localeHint);
  const dateOrder = ov.dateOrder ?? dateInference.order;

  const amountValues = shape.data.flatMap(r => [columns.amount, columns.debit, columns.credit, columns.balance].filter((i): i is number => i !== undefined).map(i => r[i] ?? ''));
  const numberFormat = ov.numberFormat ?? inferNumberFormat(amountValues);

  const mapping: CsvMapping = {
    delimiter: meta.delimiter,
    headerRow: shape.headerRow,
    headers: shape.headers,
    dateOrder,
    dateOrderAmbiguous: dateInference.ambiguous && !ov.dateOrder,
    numberFormat,
    columns,
    signConvention,
    headerSignature: sha256(shape.headers.map(lower).join('|')),
  };

  const rows = buildRows(shape.data, mapping);
  const parsedOk = rows.filter(r => r.errors.length === 0).length;
  const warnings: string[] = [];
  if (shape.skipped) warnings.push(`${shape.skipped} line(s) with an unexpected number of fields were skipped`);
  if (mapping.dateOrderAmbiguous) warnings.push(`Dates could be day/month or month/day — assuming ${dateOrder === 'DMY' ? 'day/month' : 'month/day'}; check the mapping`);
  if (parsedOk < rows.length) warnings.push(`${rows.length - parsedOk} row(s) could not be fully parsed`);
  if (parsedOk === 0) throw new ImportError('invalid', `No row could be parsed (${rows[0]?.errors.join('; ') || 'check the column mapping'})`);

  const dates = rows.map(r => r.date).filter((d): d is string => !!d).sort();
  const currencies = new Set(rows.map(r => r.currency).filter(Boolean));
  const last = [...rows].reverse().find(r => r.balance !== undefined && r.date);
  const first = rows.find(r => r.balance !== undefined && r.date);
  const closing = last && first ? (last.date! >= first.date! ? last : first) : last;

  return {
    format: 'csv',
    dialect: meta.dialect,
    encoding: meta.encoding,
    currency: currencies.size === 1 ? [...currencies][0] : undefined,
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    closingBalance: closing && closing.balance !== undefined ? { amount: closing.balance, asOf: closing.date! } : undefined,
    rows,
    warnings,
    csv: { mapping, sample: shape.data.slice(0, 5), total: rows.length, parsedOk },
  };
}

export function parseCsv(text: string, opts: ParseOptions, encoding: string): ParsedStatement {
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trim()) throw new ImportError('empty', 'The file is empty');
  const delimiter = opts.mapping?.delimiter ?? sniffDelimiter(clean);
  const records = readCsvRecords(clean, delimiter);
  return parseTable(records, opts, { delimiter, dialect: delimiter === '\t' ? 'tsv' : 'csv', encoding });
}
