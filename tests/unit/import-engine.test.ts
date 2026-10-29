import { test, describe } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import type { Account, ImportBatch, Transaction } from '../../src/db/database.js';
import { buildPreview, balanceEffect, statementBalanceToApp, type EngineInput, type PreviewRow } from '../../src/import/engine.js';
import { DEFAULT_IMPORT_CONFIG } from '../../src/import/config.js';
import { ImportError, type ParsedStatement, type RawRow } from '../../src/import/types.js';

/**
 * Dedupe rules on hand-built inputs (workbook §3):
 *   R1 external id · R2 fingerprint · P1 same shape within 2 days · P2 in-file repeat
 *   one-to-one matching · exclusions · transfer pairing.
 */

const TODAY = '2026-10-25';
const chk: Account = { id: 'chk', userId: 'u', name: 'Checking', type: 'checking', balance: 1000, currency: 'USD', createdAt: '' };
const sav: Account = { id: 'sav', userId: 'u', name: 'Savings', type: 'savings', balance: 5000, currency: 'USD', createdAt: '' };
const card: Account = { id: 'card', userId: 'u', name: 'Card', type: 'credit', balance: 200, currency: 'USD', createdAt: '' };

let seq = 0;
function txn(accountId: string, date: string, type: 'income' | 'expense', amount: number, description: string, extra: Partial<Transaction> = {}): Transaction {
  return { id: `t${++seq}`, userId: 'u', accountId, date, type, amount, description, category: 'Other', tags: [], ...extra };
}
function raw(date: string | null, amount: number | null, description: string, extra: Partial<RawRow> = {}): RawRow {
  return { index: 0, date, amount, description, errors: [], raw: `${date} ${amount} ${description}`, ...extra };
}
function parsed(rows: RawRow[], extra: Partial<ParsedStatement> = {}): ParsedStatement {
  rows.forEach((r, i) => { r.index = i; });
  return { format: 'csv', dialect: 'csv', encoding: 'utf-8', rows, warnings: [], ...extra };
}
function run(files: (ParsedStatement | ImportError)[], existing: Transaction[], opts: Partial<EngineInput> = {}) {
  return buildPreview({
    account: chk,
    files: files.map((f, i) => (f instanceof ImportError ? { name: `f${i}`, bytes: Buffer.from(`file ${i}`), error: f } : { name: `f${i}`, bytes: Buffer.from(`file ${i}`), parsed: f })),
    existing,
    accounts: [chk, sav, card],
    batches: [],
    config: DEFAULT_IMPORT_CONFIG,
    today: TODAY,
    includePending: false,
    ...opts,
  });
}
const statuses = (rows: PreviewRow[]) => rows.map(r => `${r.status}${r.match ? ':' + r.match.rule : ''}${r.reason ? ':' + r.reason : ''}`);

describe('import/engine — dedupe rules', () => {
  test('R1: external id stored on a transaction of the account', () => {
    const existing = [txn('chk', '2026-09-02', 'expense', 1950, 'Rent paid to landlord', { import: { source: 'ofx', externalId: 'FIT-1', fingerprint: 'x', rawDescription: 'RENT' } })];
    const p = run([parsed([raw('2026-09-09', -1950, 'Completely different text', { externalId: 'FIT-1' })])], existing);
    assert.deepEqual(statuses(p.rows), ['recorded:R1']);
    assert.equal(p.rows[0].match!.txnId, existing[0].id);
    assert.match(p.rows[0].match!.explanation, /transaction id/);
  });

  test('R2: fingerprint equality against a hand-entered transaction (no import metadata)', () => {
    const existing = [txn('chk', '2026-09-02', 'expense', 1950, 'Rent — 14 Harbour St')];
    const p = run([parsed([raw('2026-09-02', -1950, 'CARD PAYMENT TO RENT - 14 HARBOUR ST XXXX5678 02SEP26')])], existing);
    assert.deepEqual(statuses(p.rows), ['recorded:R2']);
    assert.equal(p.summary.recorded, 1);
    assert.equal(p.summary.byRule.R2, 1);
  });

  test('R2 also honours a stored fingerprint when the description was edited afterwards', () => {
    const existing = [txn('chk', '2026-09-02', 'expense', 12, 'My own wording', { import: { source: 'csv', fingerprint: 'stored-fp', rawDescription: 'SHOP' } })];
    const p = run([parsed([raw('2026-09-02', -12, 'SHOP')])], existing);
    // computed fingerprint differs ("MY OWN WORDING" vs "SHOP") → new, unless the stored one matches
    assert.deepEqual(statuses(p.rows), ['new']);
    existing[0].import!.fingerprint = p.rows[0].fingerprint!;
    assert.deepEqual(statuses(run([parsed([raw('2026-09-02', -12, 'SHOP')])], existing).rows), ['recorded:R2']);
  });

  test('P1: same amount, direction and description 1 or 2 days apart; 3 days is new', () => {
    const existing = [txn('chk', '2026-09-02', 'expense', 1950, 'Rent'), txn('chk', '2026-09-10', 'expense', 49.99, 'Broadband'), txn('chk', '2026-09-20', 'expense', 72, 'Transit pass')];
    const p = run([parsed([raw('2026-09-03', -1950, 'Rent'), raw('2026-09-08', -49.99, 'Broadband'), raw('2026-09-23', -72, 'Transit pass')])], existing);
    assert.deepEqual(statuses(p.rows), ['possible:P1', 'possible:P1', 'new']);
    assert.equal(p.rows[0].match!.daysApart, 1);
    assert.equal(p.rows[1].match!.daysApart, -2);
    assert.match(p.rows[0].match!.explanation, /1 day earlier/);
    assert.match(p.rows[1].match!.explanation, /2 days later/);
    assert.equal(p.summary.possible, 2);
  });

  test('same amount on the same day with a different description is new; different direction is new', () => {
    const existing = [txn('chk', '2026-09-02', 'expense', 50, 'Lunch')];
    const p = run([parsed([raw('2026-09-02', -50, 'PRET A MANGER'), raw('2026-09-02', 50, 'Lunch')])], existing);
    assert.deepEqual(statuses(p.rows), ['new', 'new']);
  });

  test('one-to-one: two genuine coffees against one recorded coffee → one recorded, one new', () => {
    const existing = [txn('chk', '2026-09-16', 'expense', 3.2, 'Coffee')];
    const p = run([parsed([raw('2026-09-16', -3.2, 'Coffee'), raw('2026-09-16', -3.2, 'Coffee')])], existing);
    assert.deepEqual(statuses(p.rows), ['recorded:R2', 'possible:P2'], 'second identical row in the same file asks (P2) rather than silently importing');
    const distinctIds = run([parsed([raw('2026-09-16', -3.2, 'Coffee', { externalId: 'a' }), raw('2026-09-16', -3.2, 'Coffee', { externalId: 'b' })])], existing);
    assert.deepEqual(statuses(distinctIds.rows), ['recorded:R2', 'new'], 'distinct bank ids prove two transactions');
  });

  test('P1 picks the closest unclaimed candidate and never reuses a transaction', () => {
    const existing = [txn('chk', '2026-09-01', 'expense', 10, 'Bus'), txn('chk', '2026-09-04', 'expense', 10, 'Bus')];
    const p = run([parsed([raw('2026-09-03', -10, 'Bus'), raw('2026-09-02', -10, 'Bus'), raw('2026-09-06', -10, 'Bus')])], existing);
    assert.deepEqual(statuses(p.rows), ['possible:P1', 'possible:P1', 'new']);
    assert.equal(p.rows[0].match!.date, '2026-09-04', 'closest first');
    assert.equal(p.rows[1].match!.date, '2026-09-01');
  });

  test('P2: repeats inside one file and across files of the same upload', () => {
    const p = run([parsed([raw('2026-09-10', -49.99, 'Broadband')]), parsed([raw('2026-09-10', -49.99, 'Broadband'), raw('2026-09-10', -49.99, 'Broadband')])], []);
    assert.deepEqual(statuses(p.rows), ['new', 'possible:P2', 'possible:P2']);
    assert.equal(p.rows[1].match!.rowIdx, 0);
    assert.equal(p.rows[2].match!.rowIdx, 0);
    assert.match(p.rows[1].match!.explanation, /row #0/);
  });

  test('exclusions: currency (row and file), pending toggle, invalid, future, zero', () => {
    const rows = [
      raw('2026-09-12', -24.5, 'Café de Flore', { currency: 'EUR' }),
      raw('2026-09-13', -5, 'Pending thing', { pending: true }),
      raw(null, -5, 'No date', { errors: ['Unrecognised date "??"'] }),
      raw('2026-09-14', null, 'No amount', { errors: ['Unrecognised amount "x"'] }),
      raw('2026-11-01', -5, 'Future'),
      raw('2026-10-25', -5, 'Today is fine'),
      raw('2026-09-15', 0, 'Zero'),
      raw('2026-09-16', -5, 'Good row', { currency: 'USD' }),
    ];
    const p = run([parsed(rows)], []);
    assert.deepEqual(statuses(p.rows), ['excluded:currency', 'excluded:pending', 'excluded:invalid', 'excluded:invalid', 'excluded:future', 'new', 'excluded:zero', 'new']);
    assert.deepEqual(p.summary.byReason, { currency: 1, pending: 1, invalid: 2, future: 1, zero: 1 });
    assert.equal(p.summary.excluded, 6);
    assert.equal(p.summary.new, 2);
    assert.equal(p.rows[0].fingerprint, undefined, 'excluded rows get no fingerprint');

    const withPending = run([parsed(rows.map(r => ({ ...r })))], [], { includePending: true });
    assert.equal(withPending.rows[1].status, 'new');

    const gbpFile = run([parsed([raw('2026-09-16', -5, 'Good row')], { currency: 'GBP' })], []);
    assert.equal(gbpFile.files[0].blocked?.reason, 'currency');
    assert.deepEqual(statuses(gbpFile.rows), ['excluded:currency']);
    const usdFile = run([parsed([raw('2026-09-16', -5, 'Good row')], { currency: 'USD' })], []);
    assert.equal(usdFile.files[0].blocked, undefined);
    assert.equal(usdFile.rows[0].currency, 'USD', 'file currency propagates to rows');
  });

  test('excluded rows do not take part in matching', () => {
    const existing = [txn('chk', '2026-09-02', 'expense', 12, 'Shop')];
    const p = run([parsed([raw('2026-09-02', -12, 'Shop', { pending: true }), raw('2026-09-02', -12, 'Shop')])], existing);
    assert.deepEqual(statuses(p.rows), ['excluded:pending', 'recorded:R2']);
  });

  test('transfer pairing: opposite leg on another account within 3 days → Transfer, claimed once', () => {
    const existing = [txn('sav', '2026-09-05', 'income', 900, 'Transfer from checking', { category: 'Transfer' }), txn('card', '2026-09-27', 'income', 852.96, 'Payment received — thank you', { category: 'Transfer' })];
    const p = run([parsed([raw('2026-09-07', -900, 'Monthly saving'), raw('2026-09-07', -900, 'Monthly saving again'), raw('2026-09-27', -852.96, 'CARD PAYMENT'), raw('2026-09-20', -852.96, 'Too far')])], existing);
    assert.equal(p.rows[0].transferWith?.accountName, 'Savings');
    assert.equal(p.rows[0].category, 'Transfer');
    assert.equal(p.rows[0].categorySource, 'transfer');
    assert.equal(p.rows[1].transferWith, undefined, 'the savings leg pairs with one row only');
    assert.equal(p.rows[2].transferWith?.accountName, 'Card');
    assert.equal(p.rows[3].transferWith, undefined, '7 days apart is not a pair');
    assert.equal(p.summary.transfers, 2);
    assert.deepEqual(statuses(p.rows), ['new', 'new', 'new', 'new'], 'transfer legs are not duplicates');
  });

  test('categorisation runs on importable rows; carried categories beat keywords; unknown → Uncategorized', () => {
    const p = run([parsed([
      raw('2026-09-03', -45, 'TESCO STORES 1234'),
      raw('2026-09-03', -45, 'Something odd', { category: 'Groceries' }),
      raw('2026-09-03', -45, 'Something odd', { mcc: 5812 }),
      raw('2026-09-01', 2000, 'ACME PAY', { bankCode: 'RCDT/SALA' }),
      raw('2026-09-05', -900, 'To my savings', { transferAccount: 'Savings' }),
      raw('2026-09-06', -7.77, 'ZZZ UNKNOWN MERCHANT'),
      raw('2026-09-06', 7.77, 'TESCO REFUND'),
    ])], []);
    assert.deepEqual(p.rows.map(r => [r.category, r.categorySource]), [
      ['Food & Dining', 'keyword'], ['Food & Dining', 'carried'], ['Food & Dining', 'mcc'], ['Salary', 'bankcode'], ['Transfer', 'carried'], ['Uncategorized', 'none'], ['Uncategorized', 'none'],
    ]);
    assert.equal(p.rows[6].categorySource, 'none', 'expense-only keyword does not fire on income');
    assert.equal(p.summary.uncategorized, 2);
  });

  test('file-level: errors are reported per file, exact-file duplicates flagged, detected facts copied', () => {
    const batches: ImportBatch[] = [{ id: 'b1', userId: 'u', accountId: 'sav', format: 'csv', filename: 'old.csv', fileHash: require_sha('file 1'), importedAt: '2026-10-01T00:00:00Z', dateFrom: '2026-09-01', dateTo: '2026-09-30', counts: { imported: 10, recorded: 2, skipped: 0, excluded: 0 } }];
    const p = run([new ImportError('investment', 'nope'), parsed([raw('2026-09-16', -5, 'Row')], { currency: 'USD', account: { externalId: '123', type: 'checking' }, closingBalance: { amount: 6202.01, asOf: '2026-09-30' }, dateFrom: '2026-09-01', dateTo: '2026-09-30' })], [], { batches });
    assert.deepEqual(p.files[0].error, { code: 'investment', message: 'nope' });
    assert.equal(p.files[0].rows, 0);
    assert.deepEqual(p.files[1].fileDuplicate, { batchId: 'b1', importedAt: '2026-10-01T00:00:00Z', accountName: 'Savings', rows: 12 });
    assert.deepEqual(p.files[1].detected, { currency: 'USD', accountExternalId: '123', accountType: 'checking', dateFrom: '2026-09-01', dateTo: '2026-09-30', closingBalance: 6202.01, closingBalanceAsOf: '2026-09-30' });
    assert.equal(p.rows.length, 1);
    assert.equal(p.rows[0].file, 1);
  });

  test('balance: before, delta of new rows, delta of possible rows, statement closing in app convention', () => {
    const existing = [txn('chk', '2026-09-02', 'expense', 100, 'Rent')];
    const p = run([parsed([raw('2026-09-03', -100, 'Rent'), raw('2026-09-04', 250, 'Pay'), raw('2026-09-05', -50, 'Shop')], { closingBalance: { amount: 1100 } })], existing);
    assert.deepEqual(p.balance, { before: 1000, deltaNew: 200, deltaPossible: -100, statementClosing: 1100, statementClosingAsOf: undefined });

    // credit card: purchases raise the amount owed; a bank closing of -420 means 420 owed
    const cardPreview = run([parsed([raw('2026-09-03', -30, 'Shop'), raw('2026-09-27', 100, 'Payment received')], { closingBalance: { amount: -420, asOf: '2026-09-30' } })], [], { account: card });
    assert.equal(cardPreview.balance.before, 200);
    assert.equal(cardPreview.balance.deltaNew, -70);
    assert.equal(cardPreview.balance.statementClosing, 420);
    assert.equal(cardPreview.rows[0].type, 'expense');
    assert.equal(cardPreview.rows[1].type, 'income');
  });

  test('helpers: balanceEffect and statementBalanceToApp follow the liability convention', () => {
    assert.equal(balanceEffect(chk, 'income', 10), 10);
    assert.equal(balanceEffect(chk, 'expense', 10), -10);
    assert.equal(balanceEffect(card, 'income', 10), -10);
    assert.equal(balanceEffect(card, 'expense', 10), 10);
    assert.equal(statementBalanceToApp(chk, 500), 500);
    assert.equal(statementBalanceToApp(card, -500), 500);
  });
});

function require_sha(s: string): string {
  return crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');
}
