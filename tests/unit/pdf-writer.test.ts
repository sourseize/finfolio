import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { A4, PdfDocument, hex, textWidth, toWinAnsi, truncateText, wrapText } from '../../src/pdf/writer.js';
import { parsePdf } from '../helpers/pdf.js';

describe('pdf/writer', () => {
  test('WinAnsi encoding: ASCII as-is, Latin-1 and the cp1252 extras mapped, the rest becomes "?"', () => {
    assert.deepEqual([...toWinAnsi('Ab(1)')], [0x41, 0x62, 0x28, 0x31, 0x29]);
    assert.deepEqual([...toWinAnsi('é—€…')], [0xe9, 0x97, 0x80, 0x85]);
    assert.deepEqual([...toWinAnsi('−5')], [0x2d, 0x35], 'minus sign → hyphen');
    assert.deepEqual([...toWinAnsi('⚖️ 日本')], [0x3f, 0x3f, 0x20, 0x3f, 0x3f]);
  });

  test('metrics: widths, wrapping and truncation', () => {
    assert.equal(textWidth('iii', 10), 6.66);
    assert.ok(textWidth('WWW', 10) > textWidth('iii', 10));
    assert.ok(textWidth('abc', 10, true) > textWidth('abc', 10));
    assert.deepEqual(wrapText('the quick brown fox jumps', 10, 80), ['the quick brown', 'fox jumps']);
    assert.deepEqual(wrapText('the quick brown fox jumps', 10, 50), ['the quick', 'brown fox', 'jumps']);
    assert.deepEqual(wrapText('a\nb', 10, 500), ['a', 'b']);
    assert.deepEqual(wrapText('supercalifragilistic', 10, 20), ['supercalifragilistic'], 'a single long word is kept');
    assert.equal(truncateText('Short', 10, 200), 'Short');
    assert.match(truncateText('A rather long label that will not fit', 10, 60), /…$/);
    assert.ok(textWidth(truncateText('A rather long label that will not fit', 10, 60), 10) <= 60);
  });

  test('a two-page document is well-formed: header, objects, xref offsets, trailer, compressed streams', () => {
    const doc = new PdfDocument({ title: 'Test (doc)', author: 'FinFolio', createdAt: '2026-10-25T12:00:00.000Z' });
    const p1 = doc.addPage();
    p1.text('Hello — world (1)', 40, 60, { size: 14, bold: true, color: hex('#1a1a2e') });
    p1.text('right', 500, 80, { align: 'right' });
    p1.text('centre', 300, 100, { align: 'center' });
    p1.paragraph('one two three four five six seven eight nine ten', 40, 120, 100, { size: 9 });
    p1.rect(40, 200, 100, 20, { fill: hex('#00d4ff'), stroke: hex('#000000') });
    p1.line(40, 240, 300, 240, { color: hex('#ff0000'), dash: [3, 2] });
    p1.polyline([[40, 300], [80, 260], [120, 320]], { width: 2 });
    p1.circle(300, 400, 20, { fill: hex('#00e676') });
    p1.ringSlice(300, 500, 60, 30, 0, Math.PI / 2, hex('#b388ff'));
    p1.ringSlice(300, 500, 60, 30, Math.PI / 2, Math.PI * 2, hex('#ffab40'));
    const p2 = doc.addPage();
    p2.text('Page two', 40, 60);
    const buf = doc.render();
    const pdf = parsePdf(buf);
    assert.equal(pdf.pages, 2);
    assert.equal(pdf.objects, 5 + 2 * 2, 'catalog, pages, two fonts, info + (content, page) per page');
    assert.equal(pdf.contents.length, 2);
    assert.ok(pdf.strings.includes('Hello \x97 world (1)'), `strings: ${pdf.strings.join(' | ')}`);
    assert.ok(pdf.strings.includes('Page two'));
    assert.match(pdf.contents[0], /\/F2 14 Tf/);
    assert.match(pdf.contents[0], /re\s+B/);
    assert.match(pdf.contents[0], /\[3 2\] 0 d/);
    assert.match(pdf.contents[0], / c\s/, 'bezier arcs');
    assert.match(pdf.info, /\/Title \(Test \\\(doc\\\)\)/);
    assert.match(pdf.info, /\/CreationDate \(D:20261025120000Z\)/);
    assert.equal(doc.render().equals(buf), true, 'deterministic');
    assert.equal(buf.subarray(0, 9).toString('latin1'), '%PDF-1.4\n');
  });

  test('text is placed top-down: a baseline at y=100 on A4 lands at 741.89 in PDF space', () => {
    const doc = new PdfDocument();
    doc.addPage().text('x', 10, 100);
    const pdf = parsePdf(doc.render());
    assert.match(pdf.contents[0], /10 741\.89 Td/);
    assert.equal(A4.height, 841.89);
  });
});
