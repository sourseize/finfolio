import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getScenarios, getFile } from '../helpers/statements.js';
import { parseStatement, normalizeDescription, ImportError, type ParsedStatement, type RawRow } from '../../src/import/index.js';
import type { ScenarioFile, StatementRow } from '../../src/testing/statements/index.js';

/**
 * parse(write(statement)) must give back the statement, for every scenario
 * file in every format and dialect. Format capabilities differ (QIF has no
 * ids or balances, OFX has no pending rows …), so the checks are gated on
 * what each format can carry.
 */

const carriesIds = (p: ParsedStatement) => p.format === 'ofx' || p.format === 'openbanking';
const carriesPending = (p: ParsedStatement) => p.format === 'openbanking' && p.dialect !== 'generic-json';
/** Per-row running balances: CSV balance columns and OBIE `Balance`; OFX only has the ledger balance. */
const carriesRowBalance = (f: ScenarioFile, p: ParsedStatement) => (p.format === 'csv' && !['ambiguous', 'mint'].includes(f.dialect.split('/')[0])) || p.dialect === 'obie';
const carriesClosingBalance = (f: ScenarioFile, p: ParsedStatement) => carriesRowBalance(f, p) || p.format === 'ofx' || p.dialect === 'plaid';
const carriesCurrency = (f: ScenarioFile, p: ParsedStatement) => p.format === 'ofx' || p.format === 'openbanking' || ['withCurrency', 'de'].includes(f.dialect.split('/')[0]);
const carriesCategory = (f: ScenarioFile, p: ParsedStatement) => p.format === 'qif' || f.dialect === 'mint' || p.dialect === 'plaid';
const carriesMcc = (p: ParsedStatement) => p.dialect === 'obie' || p.dialect === 'berlin';

function expectedRows(f: ScenarioFile, p: ParsedStatement): StatementRow[] {
  return f.statement!.rows.filter(r => !(r.pending && !carriesPending(p)));
}

/** Pair parsed rows with statement rows by date + amount (+ id when available); returns unmatched counts. */
function pairRows(parsed: RawRow[], expected: StatementRow[], useIds: boolean): { pairs: [RawRow, StatementRow][]; unmatched: RawRow[] } {
  const pool = [...expected];
  const pairs: [RawRow, StatementRow][] = [];
  const unmatched: RawRow[] = [];
  for (const r of parsed) {
    const idx = pool.findIndex(e => (useIds ? e.id === r.externalId : true) && e.date === r.date && Math.abs(e.amount - (r.amount ?? NaN)) < 0.005);
    if (idx === -1) unmatched.push(r);
    else pairs.push([r, pool.splice(idx, 1)[0]]);
  }
  return { pairs, unmatched };
}

describe('import round trip: every generated statement parses back to itself', async () => {
  const scenarios = await getScenarios();
  for (const sc of scenarios) {
    if (sc.id === 'S11') continue; // invalid files have their own test below
    for (const f of sc.files) {
      test(`${sc.id} ${f.name}`, () => {
        const p = parseStatement(f.bytes, f.name, { localeHint: 'en-GB' });
        const expected = expectedRows(f, p);
        assert.equal(p.format, f.format, 'format detected');
        assert.equal(p.rows.length, expected.length, 'row count');
        assert.equal(p.rows.filter(r => r.errors.length).length, 0, `no row errors: ${p.rows.filter(r => r.errors.length).map(r => r.errors.join(';')).join(' | ')}`);

        const { pairs, unmatched } = pairRows(p.rows, expected, carriesIds(p));
        assert.deepEqual(unmatched.map(r => r.raw), [], 'every parsed row matches a statement row by date/amount');

        for (const [r, e] of pairs) {
          // description: equal after normalisation (the messy dialect appends memo/ref text)
          const dialect = f.dialect.split('/')[0];
          if (dialect === 'messy') assert.ok(normalizeDescription(r.description).startsWith(normalizeDescription(e.description)), `description ${r.description} ~ ${e.description}`);
          else assert.equal(normalizeDescription(r.description), normalizeDescription(e.description));
          if (carriesIds(p)) assert.equal(r.externalId, e.id);
          if (carriesPending(p)) assert.equal(!!r.pending, !!e.pending, `pending flag for ${e.id}`);
          if (carriesCurrency(f, p)) assert.equal(r.currency, e.currency, `currency for ${e.id}`);
          if (carriesRowBalance(f, p) && e.balanceAfter !== undefined) assert.ok(Math.abs((r.balance ?? NaN) - e.balanceAfter) < 0.005, `balance for ${e.id}: ${r.balance} vs ${e.balanceAfter}`);
          if (carriesCategory(f, p) && e.category && !e.transferAccount) assert.ok(r.category && r.category.length > 0, `category carried for ${e.id}`);
          if (p.format === 'qif' && e.transferAccount) assert.equal(r.transferAccount, e.transferAccount);
          if (carriesMcc(p) && e.mcc !== undefined) assert.equal(r.mcc, e.mcc);
          if (e.postedDate && p.format !== 'qif' && dialect !== 'us' && dialect !== 'uk') assert.equal(r.postedDate ?? r.date, e.postedDate);
        }

        // statement-level facts
        const st = f.statement!;
        if (p.format === 'ofx') {
          assert.equal(p.currency, st.account.currency);
          assert.equal(p.account?.externalId, st.account.externalId);
          assert.equal(p.account?.type, st.account.type === 'credit' ? 'credit' : 'checking');
          assert.equal(p.dateFrom, st.dateFrom);
          assert.equal(p.dateTo, st.dateTo);
          assert.equal(p.dialect, f.dialect);
        }
        if (p.dialect === 'obie' || p.dialect === 'plaid') assert.equal(p.account?.externalId, st.account.externalId);
        if (p.dialect === 'berlin') { assert.equal(p.account?.externalId, st.account.iban); assert.equal(p.currency, st.account.currency); }
        if (p.dialect === 'plaid') { assert.equal(p.account?.name, st.account.name); assert.equal(p.account?.type, st.account.type === 'credit' ? 'credit' : 'checking'); }
        if (p.format === 'qif' && f.name.includes('-acct')) { assert.equal(p.account?.name, st.account.name); assert.equal(p.account?.externalId, st.account.externalId); }
        if (p.format === 'qif') assert.equal(p.account?.type, st.account.type === 'credit' ? 'credit' : 'checking');
        if (carriesClosingBalance(f, p)) {
          assert.ok(p.closingBalance, 'closing balance present');
          assert.ok(Math.abs(p.closingBalance!.amount - st.closingBalance) < 0.005, `closing ${p.closingBalance!.amount} vs ${st.closingBalance}`);
        }
        const nonPending = expected.map(r => r.date).sort();
        assert.equal(p.dateFrom! <= nonPending[0], true);
        assert.equal(p.dateTo! >= nonPending[nonPending.length - 1], true);
        if (f.dialect.endsWith('utf16le')) assert.equal(p.encoding, 'utf-16le');
        if (f.dialect === 'ofx1' || f.dialect === 'qfx') assert.equal(p.encoding, 'windows-1252');
        if (p.csv) {
          const expectOrder = { us: 'MDY', messy: 'MDY', mint: 'MDY', uk: 'DMY', de: 'DMY', drcr: 'DMY', tsv: 'YMD', withCurrency: 'YMD', ambiguous: 'DMY' }[dialectOf(f)];
          assert.equal(p.csv.mapping.dateOrder, expectOrder, 'date order inferred');
          assert.equal(p.csv.mapping.dateOrderAmbiguous, dialectOf(f) === 'ambiguous');
          assert.equal(p.csv.parsedOk, p.csv.total);
          assert.ok(p.csv.sample.length > 0 && p.csv.sample.length <= 5);
          assert.equal(p.csv.mapping.numberFormat, dialectOf(f) === 'de' ? 'comma' : 'point');
          assert.equal(p.csv.mapping.signConvention, dialectOf(f) === 'uk' ? 'debitCredit' : dialectOf(f) === 'mint' ? 'indicator' : 'signed');
        }
        if (dialectOf(f) !== 'ambiguous') assert.deepEqual(p.warnings, [], 'no warnings');
      });
    }
  }

  test('ambiguous dates follow the browser locale and the explicit override', async () => {
    const f = await getFile('S8', 'ambiguous');
    const gb = parseStatement(f.bytes, f.name, { localeHint: 'en-GB' });
    const us = parseStatement(f.bytes, f.name, { localeHint: 'en-US' });
    const none = parseStatement(f.bytes, f.name, {});
    assert.equal(gb.csv!.mapping.dateOrder, 'DMY');
    assert.equal(us.csv!.mapping.dateOrder, 'MDY');
    assert.equal(none.csv!.mapping.dateOrder, 'DMY', 'no locale → day/month (most of the world)');
    assert.ok(gb.warnings.some(w => /day\/month or month\/day/.test(w)));
    // the statement was written DD/MM, so en-GB gives the true dates and en-US swaps day and month
    const truth = f.statement!.rows.map(r => r.date).sort();
    assert.deepEqual(gb.rows.map(r => r.date).sort(), truth);
    assert.notDeepEqual(us.rows.map(r => r.date).sort(), truth);
    const forced = parseStatement(f.bytes, f.name, { localeHint: 'en-US', mapping: { dateOrder: 'DMY' } });
    assert.deepEqual(forced.rows.map(r => r.date).sort(), truth);
    assert.equal(forced.csv!.mapping.dateOrderAmbiguous, false, 'an explicit choice is not ambiguous');
    assert.deepEqual(forced.warnings, []);
  });

  test('S11: invalid and unsupported files are rejected with specific codes', async () => {
    const files = (await getScenarios()).find(s => s.id === 'S11')!.files;
    const codeOf = (name: string) => {
      const f = files.find(f => f.name === name)!;
      try { return { parsed: parseStatement(f.bytes, f.name) }; } catch (e) { return { err: e as ImportError }; }
    };
    assert.equal(codeOf('garbage.csv').err?.code, 'unsupported');
    assert.equal(codeOf('empty.csv').err?.code, 'empty');
    assert.equal(codeOf('brokerage.qif').err?.code, 'investment');
    assert.match(codeOf('brokerage.qif').err!.message, /investment/i);
    assert.equal(codeOf('brokerage.ofx').err?.code, 'investment');
    assert.equal(codeOf('no-transactions.json').err?.code, 'invalid');
    assert.match(codeOf('no-transactions.json').err!.message, /list of transactions/);
    assert.equal(codeOf('headers-only.csv').err?.code, 'invalid');
    // truncated OFX: partial rows, the incomplete one flagged, file flagged
    const trunc = codeOf('truncated.ofx').parsed!;
    assert.equal(trunc.rows.length, 4);
    assert.equal(trunc.rows.slice(0, 3).every(r => r.errors.length === 0), true);
    assert.ok(trunc.rows[3].errors.length > 0, 'cut-off transaction is invalid');
    assert.ok(trunc.warnings.some(w => /truncated/.test(w)));
    assert.equal(trunc.closingBalance, undefined);
  });
});

function dialectOf(f: ScenarioFile): string {
  return f.dialect.split('/')[0];
}
