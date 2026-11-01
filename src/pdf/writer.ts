/**
 * A small PDF writer — no dependencies, like everything else here.
 *
 * Produces PDF 1.4 with the standard Helvetica / Helvetica-Bold fonts (no
 * embedding; text is WinAnsi-encoded, so Latin-1 plus the usual dashes and
 * quotes work, anything else becomes '?'), vector graphics (rectangles, lines,
 * polylines, circles, ring slices built from Bézier arcs) and Flate-compressed
 * content streams via node:zlib. Enough for a report with tables and charts.
 *
 * Coordinates given to `Page` are top-down in points (0,0 = top-left), which is
 * how a layout is naturally written; they are flipped to PDF's bottom-up space
 * on output. Text is positioned by its baseline.
 */
import zlib from 'node:zlib';

export const A4 = { width: 595.28, height: 841.89 } as const;

export type Rgb = [number, number, number];

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  align?: 'left' | 'right' | 'center';
  /** Truncate with an ellipsis when the text is wider than this. */
  maxWidth?: number;
}

export interface StrokeOptions {
  color?: Rgb;
  width?: number;
  dash?: number[];
}

export interface RectOptions {
  fill?: Rgb;
  stroke?: Rgb;
  lineWidth?: number;
}

// ── Font metrics (AFM widths for WinAnsi code points, /1000 em) ─────────────

const ASCII_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z { | } ~
];
const ASCII_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Unicode → WinAnsi (cp1252) for the code points above 0x7e that the encoding has. */
const WINANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
/** Widths for the high code points that appear in reports; the rest default to an average glyph. */
const HIGH_WIDTHS: Record<number, [number, number]> = {
  0x80: [556, 556], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350],
  0x96: [556, 556], 0x97: [1000, 1000], 0xa0: [278, 278], 0xb7: [278, 278], 0xd7: [584, 584], 0xe9: [556, 556],
};

/** Encode a string as WinAnsi bytes; characters outside the encoding become '?'. Also maps a few look-alikes (minus sign, narrow spaces). */
export function toWinAnsi(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0)!;
    if (cp === 0x2212) cp = 0x2d; // minus sign → hyphen
    if (cp === 0x202f || cp === 0x2009) cp = 0xa0;
    if (cp < 0x80) out.push(cp === 0x0a || cp === 0x0d || cp === 0x09 ? 0x20 : cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (WINANSI_HIGH[cp] !== undefined) out.push(WINANSI_HIGH[cp]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

/** Width of a string in points at `size`. */
export function textWidth(text: string, size: number, bold = false): number {
  const bytes = toWinAnsi(text);
  let w = 0;
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) w += (bold ? ASCII_BOLD : ASCII_REGULAR)[b - 0x20];
    else if (HIGH_WIDTHS[b]) w += HIGH_WIDTHS[b][bold ? 1 : 0];
    else w += 556;
  }
  return (w / 1000) * size;
}

/** Greedy word wrap to `maxWidth`; a single word wider than the line is kept whole. */
export function wrapText(text: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth || !line) line = candidate;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

/** Shorten with an ellipsis so the text fits `maxWidth`. */
export function truncateText(text: string, size: number, maxWidth: number, bold = false): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (c: Rgb) => `${num(c[0])} ${num(c[1])} ${num(c[2])}`;

/** Hex colour → Rgb fractions. */
export function hex(h: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function escapePdfString(bytes: Buffer): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return s;
}

export class Page {
  private ops: string[] = [];
  constructor(readonly width: number, readonly height: number) {}

  /** Flip a top-down y to PDF space. */
  private y(v: number): number { return this.height - v; }

  text(str: string, x: number, baseline: number, opts: TextOptions = {}): number {
    const size = opts.size ?? 10;
    const bold = !!opts.bold;
    let s = str;
    if (opts.maxWidth !== undefined) s = truncateText(s, size, opts.maxWidth, bold);
    const w = textWidth(s, size, bold);
    let xx = x;
    if (opts.align === 'right') xx = x - w;
    else if (opts.align === 'center') xx = x - w / 2;
    const color = opts.color ?? [0, 0, 0];
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(xx)} ${num(this.y(baseline))} Td (${escapePdfString(toWinAnsi(s))}) Tj ET`);
    return w;
  }

  /** Wrapped paragraph; returns the y after the last line. */
  paragraph(str: string, x: number, baseline: number, maxWidth: number, opts: TextOptions & { lineHeight?: number } = {}): number {
    const size = opts.size ?? 10;
    const lh = opts.lineHeight ?? size * 1.35;
    let y = baseline;
    for (const line of wrapText(str, size, maxWidth, !!opts.bold)) {
      this.text(line, x, y, opts);
      y += lh;
    }
    return y;
  }

  rect(x: number, y: number, w: number, h: number, opts: RectOptions = {}): void {
    const parts: string[] = [];
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg`);
    if (opts.stroke) parts.push(`${rgb(opts.stroke)} RG ${num(opts.lineWidth ?? 0.75)} w`);
    parts.push(`${num(x)} ${num(this.y(y + h))} ${num(w)} ${num(h)} re`);
    parts.push(opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : opts.stroke ? 'S' : 'n');
    this.ops.push(parts.join(' '));
  }

  line(x1: number, y1: number, x2: number, y2: number, opts: StrokeOptions = {}): void {
    this.polyline([[x1, y1], [x2, y2]], opts);
  }

  polyline(points: [number, number][], opts: StrokeOptions = {}): void {
    if (points.length < 2) return;
    const color = opts.color ?? [0, 0, 0];
    const dash = opts.dash && opts.dash.length ? `[${opts.dash.map(num).join(' ')}] 0 d ` : '[] 0 d ';
    const path = points.map(([x, y], i) => `${num(x)} ${num(this.y(y))} ${i === 0 ? 'm' : 'l'}`).join(' ');
    this.ops.push(`${rgb(color)} RG ${num(opts.width ?? 1)} w 1 J 1 j ${dash}${path} S [] 0 d`);
  }

  circle(cx: number, cy: number, r: number, opts: RectOptions = {}): void {
    this.ops.push(this.pathOps(this.arcSegments(cx, cy, r, 0, Math.PI * 2), opts, true));
  }

  /** A slice of a ring (doughnut chart) from angle a0 to a1 (radians, clockwise from 12 o'clock). */
  ringSlice(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number, fill: Rgb): void {
    if (a1 - a0 <= 0) return;
    const outer = this.arcSegments(cx, cy, rOuter, a0, a1);
    const inner = this.arcSegments(cx, cy, rInner, a1, a0);
    const [sx, sy] = outer.start;
    let d = `${num(sx)} ${num(this.y(sy))} m ` + outer.curves.join(' ');
    const [ix, iy] = inner.start;
    d += ` ${num(ix)} ${num(this.y(iy))} l ` + inner.curves.join(' ') + ' h';
    this.ops.push(`${rgb(fill)} rg ${d} f`);
  }

  /** Bézier segments of an arc (clockwise from 12 o'clock, in top-down coordinates). */
  private arcSegments(cx: number, cy: number, r: number, a0: number, a1: number): { start: [number, number]; curves: string[] } {
    const pt = (a: number): [number, number] => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const tangent = (a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)]; // derivative of pt wrt a (top-down y)
    const curves: string[] = [];
    const total = a1 - a0;
    const steps = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
    const step = total / steps;
    const k = (4 / 3) * Math.tan(Math.abs(step) / 4) * Math.sign(step);
    for (let i = 0; i < steps; i++) {
      const s = a0 + step * i;
      const e = s + step;
      const p0 = pt(s), p3 = pt(e);
      const t0 = tangent(s), t3 = tangent(e);
      const p1: [number, number] = [p0[0] + k * t0[0], p0[1] + k * t0[1]];
      const p2: [number, number] = [p3[0] - k * t3[0], p3[1] - k * t3[1]];
      curves.push(`${num(p1[0])} ${num(this.y(p1[1]))} ${num(p2[0])} ${num(this.y(p2[1]))} ${num(p3[0])} ${num(this.y(p3[1]))} c`);
    }
    return { start: pt(a0), curves };
  }

  private pathOps(seg: { start: [number, number]; curves: string[] }, opts: RectOptions, close: boolean): string {
    const parts: string[] = [];
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg`);
    if (opts.stroke) parts.push(`${rgb(opts.stroke)} RG ${num(opts.lineWidth ?? 0.75)} w`);
    parts.push(`${num(seg.start[0])} ${num(this.y(seg.start[1]))} m`, ...seg.curves);
    if (close) parts.push('h');
    parts.push(opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : opts.stroke ? 'S' : 'n');
    return parts.join(' ');
  }

  /** Raw content stream (uncompressed). */
  content(): Buffer {
    return Buffer.from(this.ops.join('\n'), 'latin1');
  }
}

export interface DocumentInfo {
  title?: string;
  author?: string;
  subject?: string;
  /** ISO timestamp used for CreationDate (deterministic output when given). */
  createdAt?: string;
}

export class PdfDocument {
  readonly pages: Page[] = [];
  constructor(readonly info: DocumentInfo = {}, readonly size: { width: number; height: number } = A4) {}

  addPage(): Page {
    const p = new Page(this.size.width, this.size.height);
    this.pages.push(p);
    return p;
  }

  /** Serialise the document. */
  render(): Buffer {
    const objects: Buffer[] = [];
    const add = (body: string | Buffer): number => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objects.length; };
    // 1 catalog, 2 pages, 3 regular font, 4 bold font, 5 info; then page/content pairs
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const date = this.info.createdAt ? new Date(this.info.createdAt) : new Date();
    const pdfDate = `D:${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
    const esc = (s: string) => escapePdfString(toWinAnsi(s));
    add(`<< /Producer (FinFolio) ${this.info.title ? `/Title (${esc(this.info.title)}) ` : ''}${this.info.author ? `/Author (${esc(this.info.author)}) ` : ''}${this.info.subject ? `/Subject (${esc(this.info.subject)}) ` : ''}/CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>`);
    const pageIds: number[] = [];
    for (const page of this.pages) {
      const compressed = zlib.deflateSync(page.content());
      const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), compressed, Buffer.from('\nendstream', 'latin1')]));
      const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    }
    objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1');

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets.push(offset);
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    const xrefOffset = offset;
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}
