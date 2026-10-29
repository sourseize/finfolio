/**
 * Statement import — format detection and parsing entry point.
 *
 *   const parsed = parseStatement(bytes, 'statement.csv', { localeHint: 'en-GB' });
 *
 * Throws `ImportError` for empty, unsupported, invalid or investment files.
 */
import { decodeBytes } from './encoding.js';
import { parseCsv } from './formats/csv.js';
import { parseOfx } from './formats/ofx.js';
import { parseOpenBankingJson } from './formats/openbanking.js';
import { parseQif } from './formats/qif.js';
import { ImportError, type ImportFormat, type ParseOptions, type ParsedStatement } from './types.js';

export * from './types.js';
export { decodeBytes } from './encoding.js';
export { normalizeDescription, fingerprint, parseAmount, parseDate, inferDateOrder, dateOrderForLocale, toTypeAndAmount, sha256 } from './normalize.js';

export const SUPPORTED_FORMATS: { format: ImportFormat; label: string; extensions: string[] }[] = [
  { format: 'csv', label: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] },
  { format: 'ofx', label: 'OFX / QFX (Money, Quicken, most banks)', extensions: ['ofx', 'qfx'] },
  { format: 'qif', label: 'QIF (Quicken)', extensions: ['qif'] },
  { format: 'openbanking', label: 'Open Banking JSON (UK OBIE, Berlin Group, Plaid-style)', extensions: ['json'] },
];

/** Decide the format from the content first, the file extension second. */
export function detectFormat(filename: string, text: string): ImportFormat {
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 4096);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (/^OFXHEADER:/i.test(head) || /^<\?OFX/i.test(head) || /^<OFX>/i.test(head)) return 'ofx';
  if (/^<\?xml/i.test(head) && /<OFX>/i.test(head)) return 'ofx';
  if (/^<\?xml/i.test(head) && /<\?OFX/i.test(head)) return 'ofx';
  if (/^!(Type|Account|Option|Clear)\b/i.test(head)) return 'qif';
  if (head.startsWith('{') || head.startsWith('[')) return 'openbanking';
  // CSV: several lines, most of them containing a common delimiter
  const lines = head.split(/\r?\n/).filter(l => l.trim());
  const delimited = lines.filter(l => /[,;\t|]/.test(l)).length;
  if (lines.length >= 2 && delimited >= Math.max(2, Math.floor(lines.length * 0.6))) return 'csv';
  // Content was inconclusive: trust the extension
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  if (ext === 'qif') return 'qif';
  if (ext === 'json') return 'openbanking';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  throw new ImportError('unsupported', 'Unrecognised file format — supported: CSV/TSV, OFX/QFX, QIF, Open Banking JSON');
}

/** Text files should be mostly printable; random bytes are rejected early. */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 2048);
  if (!sample) return false;
  let control = 0;
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) control++;
  }
  return control / sample.length > 0.05;
}

export function parseStatement(bytes: Buffer, filename: string, opts: ParseOptions = {}): ParsedStatement {
  if (!bytes.length) throw new ImportError('empty', 'The file is empty');
  const { text, encoding } = decodeBytes(bytes);
  if (!text.trim()) throw new ImportError('empty', 'The file is empty');
  if (looksBinary(text)) throw new ImportError('unsupported', 'The file does not look like a text statement');
  const format = detectFormat(filename, text);
  switch (format) {
    case 'ofx': return parseOfx(text, encoding, filename);
    case 'qif': return parseQif(text, opts, encoding);
    case 'openbanking': return parseOpenBankingJson(text, opts, encoding);
    case 'csv': return parseCsv(text, opts, encoding);
  }
}
