import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareSnapshots } from '../../src/compare/engine.js';
import { comparePdfFileName, metricDelta, metricValue, money, renderComparePdf } from '../../src/compare/pdf-report.js';
import { anonymousA, anonymousSnapshot } from '../../src/seed/anonymous.js';
import { parsePdf } from '../helpers/pdf.js';

const GOLDEN = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'tests/golden/compare.snapshot.json'), 'utf-8'));
const NOW = '2026-10-25T12:00:00.000Z';

/** pdftotext when the machine has it (poppler) — an independent reader; skipped otherwise. */
function pdftotext(buf: Buffer): string | null {
  try {
    const tmp = path.join(process.cwd(), '.test-build', `pdf-${process.pid}.pdf`);
    fs.writeFileSync(tmp, buf);
    try { return execFileSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); } finally { fs.unlinkSync(tmp); }
  } catch { return null; }
}

describe('compare/pdf-report', () => {
  test('formatting helpers', () => {
    assert.equal(money(105898.58, 'USD'), '$105,899');
    assert.equal(money(-12.5, 'EUR'), '-€13');
    assert.equal(money(null, 'USD'), '—');
    assert.equal(money(1000, 'BTC').length > 0, true);
    assert.equal(metricValue('2043-05', 'month', 'USD'), 'May 2043');
    assert.equal(metricValue(0.4427, 'percent', 'USD'), '44.3%');
    assert.equal(metricValue(1, 'bool', 'USD'), 'yes');
    assert.equal(metricDelta({ delta: -83, unit: 'month' } as any, 'USD'), '−83 mo');
    assert.equal(metricDelta({ delta: 0.07, unit: 'percent' } as any, 'USD'), '+7.0 pp');
    assert.equal(comparePdfFileName('My sister!', '2026-10-25'), 'finfolio-compare-my-sister-2026-10-25.pdf');
  });

  test('fin vs penny: five pages, valid structure, the report text is in the streams', () => {
    const r = compareSnapshots({ ...GOLDEN.fin, label: 'You' }, GOLDEN.penny, { now: NOW });
    const buf = renderComparePdf({ report: r, generatedAt: NOW, whatIf: null });
    const pdf = parsePdf(buf);
    assert.equal(pdf.pages, 5);
    assert.equal(pdf.contents.length, 5);
    const all = pdf.strings.join('\n');
    assert.match(all, /How you compare/);
    assert.match(all, /You lead on 21/);
    assert.match(all, /Penny leads on 3/);
    assert.match(all, /Savings rate/);
    assert.match(all, /May 2043/);
    assert.match(all, /Penny's longest streak is 26 in a row/);
    assert.match(all, /Student loan gone/);
    assert.match(all, /Unstoppable/);
    assert.match(all, /nothing from Penny's snapshot was stored/);
    assert.match(all, /5 \/ 5/);
    assert.ok(!/What if you did a bit more/.test(all), 'no what-if box without slider values');
    assert.match(pdf.contents[2], / c\s/, 'doughnuts are Bézier paths');
    assert.match(pdf.info, /\/Title \(FinFolio \\227 You vs Penny\)/, 'em dash encoded as WinAnsi 0x97');
    assert.equal(renderComparePdf({ report: r, generatedAt: NOW, whatIf: null }).equals(buf), true, 'deterministic');
    const text = pdftotext(buf);
    if (text) {
      assert.match(text, /You lead on 21/);
      assert.match(text, /Net worth\s+\$105,899\s+\$26,645/);
      assert.match(text, /Badges\s+you 6 · Penny 5/);
    }
  });

  test('what-if box and a side without an FI date', () => {
    const a = anonymousSnapshot(anonymousA());
    const r = compareSnapshots({ ...GOLDEN.penny, label: 'You' }, a, { now: NOW });
    const base = { monthlyExpenses: 3075.6, monthlyContribution: 317.68, savingsRate: 0.3729, fiNumber: 1054491, progress: 0.0253, fiDate: '2050-04', fiAge: 57.08, yearsToFi: 23.5, cashMonths: 3.53, netWorthAtRetirement: 2461012, endRealNetWorth: 1 };
    const both = { ...base, monthlyExpenses: 2575.6, savingsRate: 0.4748, fiDate: '2045-01', fiAge: 51.83, cashMonths: 4.21, netWorthAtRetirement: 3044699 };
    const buf = renderComparePdf({ report: r, generatedAt: NOW, whatIf: { extraSaving: 300, extraInvesting: 200, result: { base, both } } });
    const pdf = parsePdf(buf);
    assert.equal(pdf.pages, 5);
    const all = pdf.strings.join('\n');
    assert.match(all, /What if you did a bit more\?/);
    assert.match(all, /save \+\$300 and invest \+\$200 a month/);
    assert.match(all, /Jan 2045/);
    assert.match(all, /not in sight/, 'Anonymous A has no FI date');
    assert.match(all, /Anonymous A leads on/);
  });

  test('a hostile label cannot break the PDF syntax', () => {
    const t = JSON.parse(JSON.stringify(GOLDEN.penny));
    t.label = 'Evil) Tj ET (x\\';
    const r = compareSnapshots({ ...GOLDEN.fin, label: 'You' }, t, { now: NOW });
    const buf = renderComparePdf({ report: r, generatedAt: NOW, whatIf: null });
    const pdf = parsePdf(buf);
    assert.equal(pdf.pages, 5);
    assert.ok(pdf.strings.some(s => s.includes('Evil) Tj ET (x\\')), 'the label survives as a literal string');
  });
});
