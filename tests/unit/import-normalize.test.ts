import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseAmount, inferDateOrder, inferNumberFormat, normalizeDescription, fingerprint, toTypeAndAmount, dateOrderForLocale } from '../../src/import/normalize.js';
import { decodeBytes } from '../../src/import/encoding.js';
import { encodeCp1252, encodeUtf16le } from '../../src/testing/statements/model.js';

describe('import/normalize', () => {
  test('parseDate accepts the shapes banks use', () => {
    assert.equal(parseDate('2026-09-03'), '2026-09-03');
    assert.equal(parseDate('2026/09/03'), '2026-09-03');
    assert.equal(parseDate('20260903'), '2026-09-03');
    assert.equal(parseDate('2026-09-03T10:15:00+00:00'), '2026-09-03');
    assert.equal(parseDate('20260903120000.000[-5:EST]'), '2026-09-03');
    assert.equal(parseDate('03/09/2026', 'DMY'), '2026-09-03');
    assert.equal(parseDate('09/03/2026', 'MDY'), '2026-09-03');
    assert.equal(parseDate('03.09.2026', 'DMY'), '2026-09-03');
    assert.equal(parseDate('3/9/26', 'DMY'), '2026-09-03');
    assert.equal(parseDate("9/ 3'26", 'MDY'), '2026-09-03', 'Quicken padded day with apostrophe year');
    assert.equal(parseDate("12/25'2026", 'MDY'), '2026-12-25');
    assert.equal(parseDate('03 Sep 2026'), '2026-09-03');
    assert.equal(parseDate('3-Sep-26'), '2026-09-03');
    assert.equal(parseDate('03 September 2026'), '2026-09-03');
    assert.equal(parseDate('Sep 3, 2026'), '2026-09-03');
    assert.equal(parseDate('01/02/70', 'DMY'), '1970-02-01', 'two-digit years ≥ 70 are 19xx');
    assert.equal(parseDate('2026-13-45'), null);
    assert.equal(parseDate('31/02/2026', 'DMY'), null, 'impossible calendar date');
    assert.equal(parseDate('13/09/2026', 'MDY'), null, 'month 13 in MDY');
    assert.equal(parseDate('Date'), null);
    assert.equal(parseDate(''), null);
  });

  test('inferDateOrder settles on any day > 12 and falls back to the locale', () => {
    assert.deepEqual(inferDateOrder(['01/09/2026', '13/09/2026']), { order: 'DMY', ambiguous: false });
    assert.deepEqual(inferDateOrder(['09/01/2026', '09/13/2026']), { order: 'MDY', ambiguous: false });
    assert.deepEqual(inferDateOrder(['2026-09-01', '2026-09-13']), { order: 'YMD', ambiguous: false });
    assert.deepEqual(inferDateOrder(['03 Sep 2026']), { order: 'YMD', ambiguous: false }, 'textual months are never ambiguous');
    assert.deepEqual(inferDateOrder(['01/09/2026', '02/10/2026'], 'en-US'), { order: 'MDY', ambiguous: true });
    assert.deepEqual(inferDateOrder(['01/09/2026', '02/10/2026'], 'en-GB'), { order: 'DMY', ambiguous: true });
    assert.deepEqual(inferDateOrder(['01/09/2026'], 'de-DE'), { order: 'DMY', ambiguous: true });
    assert.deepEqual(inferDateOrder(['01/09/2026']), { order: 'DMY', ambiguous: true }, 'no locale → DMY');
    assert.equal(dateOrderForLocale('en-US'), 'MDY');
    assert.equal(dateOrderForLocale('fr-FR'), 'DMY');
    assert.equal(dateOrderForLocale('ja-JP'), 'YMD');
    assert.equal(dateOrderForLocale(undefined), 'YMD');
  });

  test('parseAmount handles separators, parentheses, suffixes, indicators and symbols', () => {
    assert.equal(parseAmount('1,234.56'), 1234.56);
    assert.equal(parseAmount('1.234,56'), 1234.56);
    assert.equal(parseAmount('1 234,56'), 1234.56);
    assert.equal(parseAmount("1'234.56"), 1234.56);
    assert.equal(parseAmount('(12.34)'), -12.34);
    assert.equal(parseAmount('12.34-'), -12.34);
    assert.equal(parseAmount('45.50 DR'), -45.5);
    assert.equal(parseAmount('45.50 CR'), 45.5);
    assert.equal(parseAmount('CR 45.50'), 45.5);
    assert.equal(parseAmount('$-45.50'), -45.5);
    assert.equal(parseAmount('-$45.50'), -45.5);
    assert.equal(parseAmount('€45,50'), 45.5);
    assert.equal(parseAmount('-45.50 USD'), -45.5);
    assert.equal(parseAmount('+45.50'), 45.5);
    assert.equal(parseAmount('1,234'), 1234, 'a single comma followed by three digits is a thousands separator');
    assert.equal(parseAmount('45,5'), 45.5);
    assert.equal(parseAmount('45,50', 'comma'), 45.5);
    assert.equal(parseAmount('1,234.56', 'point'), 1234.56);
    assert.equal(parseAmount('1.234,56', 'comma'), 1234.56);
    assert.equal(parseAmount(12.5), 12.5);
    assert.equal(parseAmount('abc'), null);
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount('—'), null);
    assert.equal(parseAmount(null), null);
    assert.equal(parseAmount(NaN), null);
  });

  test('inferNumberFormat picks the column-wide convention', () => {
    assert.equal(inferNumberFormat(['6.400,00', '-1.950,00', '-60,99']), 'comma');
    assert.equal(inferNumberFormat(['6,400.00', '-1,950.00', '-60.99']), 'point');
    assert.equal(inferNumberFormat(['6400.00', '-60.99']), 'point');
    assert.equal(inferNumberFormat(['6400,00', '-60,99']), 'comma');
    assert.equal(inferNumberFormat([]), 'point');
  });

  test('normalizeDescription strips bank noise and keeps the payee', () => {
    assert.equal(normalizeDescription('CARD PAYMENT TO RENT - 14 HARBOUR ST XXXX5678 03SEP26'), 'RENT 14 HARBOUR ST');
    assert.equal(normalizeDescription('Rent — 14 Harbour St'), 'RENT 14 HARBOUR ST');
    assert.equal(normalizeDescription('POS SUPERMARKET ****1234 ON 03/09'), 'SUPERMARKET');
    assert.equal(normalizeDescription('Supermarket'), 'SUPERMARKET');
    assert.equal(normalizeDescription('Café de Flore Paris REF 48201934'), 'CAFE DE FLORE PARIS');
    assert.equal(normalizeDescription('Electricity & gas'), 'ELECTRICITY AND GAS');
    assert.equal(normalizeDescription('Payment received — thank you'), 'RECEIVED THANK YOU');
    assert.equal(normalizeDescription('  multiple   spaces  '), 'MULTIPLE SPACES');
    assert.equal(normalizeDescription(''), '');
    assert.equal(normalizeDescription('Transfer to savings 2026-09-05'), 'TRANSFER SAVINGS');
    assert.notEqual(normalizeDescription('Coffee & pastries'), normalizeDescription('Espresso bar'));
  });

  test('fingerprint is stable across formats of the same row and sensitive to what matters', () => {
    const a = fingerprint('acc', '2026-09-02', 'expense', 1950, normalizeDescription('Rent — 14 Harbour St'));
    const b = fingerprint('acc', '2026-09-02', 'expense', 1950.0, normalizeDescription('CARD PAYMENT TO RENT - 14 HARBOUR ST XXXX5678'));
    assert.equal(a, b);
    assert.notEqual(a, fingerprint('acc', '2026-09-03', 'expense', 1950, normalizeDescription('Rent — 14 Harbour St')), 'date');
    assert.notEqual(a, fingerprint('acc', '2026-09-02', 'expense', 1950.01, normalizeDescription('Rent — 14 Harbour St')), 'cents');
    assert.notEqual(a, fingerprint('acc', '2026-09-02', 'income', 1950, normalizeDescription('Rent — 14 Harbour St')), 'direction');
    assert.notEqual(a, fingerprint('other', '2026-09-02', 'expense', 1950, normalizeDescription('Rent — 14 Harbour St')), 'account');
    assert.equal(a, fingerprint('acc', '2026-09-02', 'expense', -1950, normalizeDescription('Rent — 14 Harbour St')), 'sign is carried by type, not amount');
  });

  test('toTypeAndAmount maps the bank sign to FinFolio type', () => {
    assert.deepEqual(toTypeAndAmount(-45.5), { type: 'expense', amount: 45.5 });
    assert.deepEqual(toTypeAndAmount(6400), { type: 'income', amount: 6400 });
    assert.deepEqual(toTypeAndAmount(-0.004999), { type: 'expense', amount: 0 });
  });
});

describe('import/encoding', () => {
  test('BOMs, BOM-less UTF-16, UTF-8 and cp1252 are told apart', () => {
    assert.deepEqual(decodeBytes(Buffer.from('\uFEFFDate,Amount\n', 'utf8')), { text: 'Date,Amount\n', encoding: 'utf-8' });
    assert.deepEqual(decodeBytes(encodeUtf16le('Café,1\n')), { text: 'Café,1\n', encoding: 'utf-16le' });
    assert.deepEqual(decodeBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('AB', 'utf16le').swap16()])), { text: 'AB', encoding: 'utf-16be' });
    const bomless = Buffer.from('Date,Description,Amount\n01/09/2026,Coffee,-4.50\n', 'utf16le');
    assert.equal(decodeBytes(bomless).encoding, 'utf-16le');
    assert.equal(decodeBytes(bomless).text.split('\n')[1], '01/09/2026,Coffee,-4.50');
    assert.deepEqual(decodeBytes(Buffer.from('Café €5', 'utf8')), { text: 'Café €5', encoding: 'utf-8' });
    const cp = decodeBytes(encodeCp1252('Café — €5 “quoted”'));
    assert.equal(cp.encoding, 'windows-1252');
    assert.equal(cp.text, 'Café — €5 “quoted”');
    assert.equal(decodeBytes(Buffer.alloc(0)).text, '');
  });
});
