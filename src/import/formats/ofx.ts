/**
 * OFX 1.x (SGML), OFX 2.x (XML) and QFX. Bank statements (STMTRS) and credit
 * card statements (CCSTMTRS) are supported; investment statements (INVSTMTRS)
 * are rejected (out of scope for now).
 *
 * The tokenizer is deliberately tolerant: SGML leaves have no closing tag,
 * XML leaves do, and real-world files mix CRLF/LF and stray whitespace.
 */
import { parseAmount, parseDate } from '../normalize.js';
import { ImportError, type ParsedStatement, type RawRow } from '../types.js';

export interface OfxNode {
  name: string;
  value?: string;
  children: OfxNode[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Split header (OFX 1.x `KEY:VALUE` lines or XML PIs) from the body starting at `<OFX>`. */
export function splitOfx(text: string): { header: Record<string, string>; body: string } {
  const idx = text.search(/<OFX>/i);
  if (idx === -1) throw new ImportError('invalid', 'Not an OFX file (no <OFX> element)');
  const head = text.slice(0, idx);
  const header: Record<string, string> = {};
  for (const m of head.matchAll(/^([A-Z]+):(.*)$/gim)) header[m[1].toUpperCase()] = m[2].trim();
  for (const m of head.matchAll(/([A-Z]+)="([^"]*)"/g)) header[m[1].toUpperCase()] = m[2];
  return { header, body: text.slice(idx) };
}

/** Build a tree from the tag soup. Unknown closing tags are ignored. */
export function parseOfxTree(body: string): OfxNode {
  const root: OfxNode = { name: 'ROOT', children: [] };
  const stack: OfxNode[] = [root];
  const re = /<(\/?)([A-Za-z0-9_.]+)\s*>([^<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const closing = m[1] === '/';
    const name = m[2].toUpperCase();
    const text = m[3].replace(/\s+/g, ' ').trim();
    if (closing) {
      const at = stack.map(n => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at; // pop to (and including) the matching aggregate
      continue;
    }
    const parent = stack[stack.length - 1];
    if (text) {
      parent.children.push({ name, value: unescape(text), children: [] }); // leaf (SGML or XML)
    } else {
      const node: OfxNode = { name, children: [] };
      parent.children.push(node);
      stack.push(node);
    }
  }
  return root;
}

export function findAll(node: OfxNode, name: string, out: OfxNode[] = []): OfxNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
export function findFirst(node: OfxNode, name: string): OfxNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = findFirst(c, name);
    if (deep) return deep;
  }
  return undefined;
}
const leaf = (node: OfxNode | undefined, name: string): string | undefined => node?.children.find(c => c.name === name && c.value !== undefined)?.value;

function ofxDate(s: string | undefined): string | null {
  if (!s) return null;
  return parseDate(s.trim().slice(0, 8));
}

function accountType(t: string | undefined): 'checking' | 'savings' | undefined {
  if (!t) return undefined;
  const u = t.toUpperCase();
  if (u === 'SAVINGS' || u === 'MONEYMRKT') return 'savings';
  if (u === 'CHECKING' || u === 'CREDITLINE') return 'checking';
  return undefined;
}

export function parseOfx(text: string, encoding: string, filename = ''): ParsedStatement {
  const { header, body } = splitOfx(text);
  const tree = parseOfxTree(body);
  const isXml = /^\s*<\?xml/i.test(text) || header.OFXHEADER === '200';
  const intuit = !!findFirst(tree, 'INTU.BID') || /\.qfx$/i.test(filename);
  const dialect = intuit ? 'qfx' : isXml ? 'ofx2' : 'ofx1';
  const warnings: string[] = [];

  const bank = findAll(tree, 'STMTRS');
  const card = findAll(tree, 'CCSTMTRS');
  const invest = findAll(tree, 'INVSTMTRS');
  if (!bank.length && !card.length) {
    if (invest.length) throw new ImportError('investment', 'This is an investment (brokerage) statement — investment imports are not supported');
    throw new ImportError('invalid', 'No bank or credit-card statement found in the OFX file');
  }
  if (invest.length) warnings.push('Investment statement sections in this file were ignored');
  const statements = [...bank.map(n => ({ node: n, credit: false })), ...card.map(n => ({ node: n, credit: true }))];
  if (statements.length > 1) warnings.push(`The file contains ${statements.length} account statements; only the first was used`);
  const { node: stmt, credit } = statements[0];

  const curdef = leaf(stmt, 'CURDEF')?.toUpperCase();
  const acctFrom = stmt.children.find(c => c.name === (credit ? 'CCACCTFROM' : 'BANKACCTFROM'));
  const tranlist = stmt.children.find(c => c.name === 'BANKTRANLIST');
  const ledger = stmt.children.find(c => c.name === 'LEDGERBAL');

  const rows: RawRow[] = [];
  const trns = tranlist ? tranlist.children.filter(c => c.name === 'STMTTRN') : [];
  trns.forEach((t, index) => {
    const errors: string[] = [];
    const date = ofxDate(leaf(t, 'DTUSER')) ?? ofxDate(leaf(t, 'DTPOSTED'));
    const posted = ofxDate(leaf(t, 'DTPOSTED'));
    if (!date) errors.push('Missing or invalid DTPOSTED');
    const amount = parseAmount(leaf(t, 'TRNAMT'));
    if (amount === null) errors.push('Missing or invalid TRNAMT');
    const name = leaf(t, 'NAME') ?? leaf(t, 'PAYEE') ?? '';
    const memo = leaf(t, 'MEMO');
    // NAME is capped at 32 chars by the spec; when MEMO starts with NAME it is the full text.
    let description = name;
    let memoOut: string | undefined = memo;
    if (memo && name && memo.toUpperCase().startsWith(name.toUpperCase()) && memo.length > name.length) { description = memo; memoOut = undefined; }
    if (!description && memo) { description = memo; memoOut = undefined; }
    const currencyNode = t.children.find(c => c.name === 'CURRENCY' || c.name === 'ORIGCURRENCY');
    const rowCurrency = leaf(currencyNode, 'CURSYM')?.toUpperCase();
    const row: RawRow = {
      index,
      date,
      amount,
      description: description.trim(),
      externalId: leaf(t, 'FITID'),
      errors,
      raw: `${leaf(t, 'TRNTYPE') ?? ''} ${leaf(t, 'DTPOSTED') ?? ''} ${leaf(t, 'TRNAMT') ?? ''} ${name}${memo ? ' / ' + memo : ''}`.trim(),
    };
    if (posted && date && posted !== date) row.postedDate = posted;
    if (memoOut) row.memo = memoOut;
    if (rowCurrency) row.currency = rowCurrency;
    else if (curdef) row.currency = curdef;
    const check = leaf(t, 'CHECKNUM'); if (check) row.checkNumber = check;
    const ref = leaf(t, 'REFNUM'); if (ref) row.reference = ref;
    rows.push(row);
  });

  if (!/<\/OFX>/i.test(body)) warnings.push('The file ends unexpectedly (no </OFX>) — it may be truncated');
  if (!rows.length) throw new ImportError('invalid', 'The statement contains no transactions');

  const balAmt = parseAmount(leaf(ledger, 'BALAMT'));
  const dtStart = ofxDate(leaf(tranlist, 'DTSTART'));
  const dtEnd = ofxDate(leaf(tranlist, 'DTEND'));
  const dates = rows.map(r => r.date).filter((d): d is string => !!d).sort();

  return {
    format: 'ofx',
    dialect,
    encoding,
    account: {
      externalId: leaf(acctFrom, 'ACCTID'),
      bankId: leaf(acctFrom, 'BANKID'),
      type: credit ? 'credit' : accountType(leaf(acctFrom, 'ACCTTYPE')),
    },
    currency: curdef,
    dateFrom: dtStart ?? dates[0],
    dateTo: dtEnd ?? dates[dates.length - 1],
    closingBalance: balAmt === null ? undefined : { amount: balAmt, asOf: ofxDate(leaf(ledger, 'DTASOF')) ?? undefined },
    rows,
    warnings,
  };
}
