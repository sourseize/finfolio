/**
 * Bytes → text. Banks export UTF-8 (with or without BOM), UTF-16 (some
 * European banks' CSV) and cp1252 (OFX 1.x). Node's TextDecoder covers all of
 * them without dependencies.
 */

export interface Decoded {
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Heuristic for BOM-less UTF-16: many NUL bytes in one parity. */
function looksUtf16(buf: Buffer): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(buf.length, 512);
  if (n < 4) return null;
  let evenNul = 0, oddNul = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) (i % 2 === 0 ? evenNul++ : oddNul++);
  if (oddNul > n / 4 && evenNul < n / 20) return 'utf-16le';
  if (evenNul > n / 4 && oddNul < n / 20) return 'utf-16be';
  return null;
}

/** 0x80–0x9F of Windows-1252 (the rest is identical to Latin-1). */
const CP1252_HIGH = '\u20ac\ufffd\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\ufffd\u017d\ufffd\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\ufffd\u017e\u0178';

/**
 * Windows-1252 decoder. Node's TextDecoder('windows-1252') is ICU-backed and on
 * some builds maps 0x80–0x9F to C1 controls instead of €, —, “ ” …, so this is
 * done by hand (it is a 256-entry table).
 */
export function decodeCp1252(buf: Buffer): string {
  let out = '';
  for (const b of buf) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return out;
}

export function decodeBytes(buf: Buffer): Decoded {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  const u16 = looksUtf16(buf);
  if (u16) return { text: new TextDecoder(u16).decode(buf), encoding: u16 };
  if (isValidUtf8(buf)) return { text: buf.toString('utf8'), encoding: 'utf-8' };
  return { text: decodeCp1252(buf), encoding: 'windows-1252' };
}
