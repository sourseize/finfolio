/**
 * A tiny PDF reader for tests: checks the file structure (header, xref
 * offsets, trailer) and returns the decompressed content streams so text
 * operators can be asserted on.
 */
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

export interface ParsedPdf {
  objects: number;
  pages: number;
  /** Decompressed content streams, one per page in order. */
  contents: string[];
  /** Every (…) Tj string in the document, decoded from WinAnsi-ish bytes. */
  strings: string[];
  info: string;
}

export function parsePdf(buf: Buffer): ParsedPdf {
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'), 'header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'EOF marker');
  const startxref = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(text)![1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref points at the xref table');
  const count = Number(/xref\n0 (\d+)\n/.exec(text.slice(startxref))![1]);
  const entries = text.slice(startxref).split('\n').slice(2, 2 + count);
  for (let i = 1; i < count; i++) {
    const offset = Number(entries[i].slice(0, 10));
    assert.equal(text.slice(offset, offset + `${i} 0 obj`.length), `${i} 0 obj`, `xref entry ${i} points at its object`);
  }
  assert.match(text, new RegExp(`trailer\\n<< /Size ${count} /Root 1 0 R`));
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)![1]);
  const contents: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const len = Number(m[1]);
    contents.push(zlib.inflateSync(buf.subarray(start, start + len)).toString('latin1'));
  }
  const strings: string[] = [];
  for (const c of contents) {
    const tj = /\(((?:\\.|[^\\)])*)\) Tj/g;
    let t: RegExpExecArray | null;
    while ((t = tj.exec(c))) {
      strings.push(t[1].replace(/\\(\d{3})/g, (_s, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1'));
    }
  }
  const info = /<< \/Producer \(FinFolio\)[^>]*>>/.exec(text)?.[0] ?? '';
  return { objects: count - 1, pages, contents, strings, info };
}
