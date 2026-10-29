import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatement, detectFormat, ImportError } from '../../src/import/index.js';
import { readCsvRecords, sniffDelimiter } from '../../src/import/formats/csv.js';
import { parseOfxTree } from '../../src/import/formats/ofx.js';

const buf = (s: string) => Buffer.from(s, 'utf8');
const fail = (fn: () => unknown): ImportError => {
  try { fn(); } catch (e) { return e as ImportError; }
  throw new Error('expected an ImportError');
};

/** Hand-written shapes the generator does not produce. */
describe('import/csv edge cases', () => {
  test('record reader: quotes, doubled quotes, embedded newlines, CRLF, trailing line', () => {
    const recs = readCsvRecords('a,"b ""quoted"", c","multi\nline"\r\n1,2,3\n', ',');
    assert.deepEqual(recs, [['a', 'b "quoted", c', 'multi\nline'], ['1', '2', '3']]);
    assert.equal(sniffDelimiter('a;b;c\n1;2;3\n'), ';');
    assert.equal(sniffDelimiter('a|b|c\n1|2|3\n'), '|');
    assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
    assert.equal(sniffDelimiter('"x, y",1\n"z, w",2\n'), ',', 'commas inside quotes do not count');
  });

  test('headerless file: roles inferred from content, balance column recognised', () => {
    const p = parseStatement(buf('03/09/2026,Coffee shop,-4.50,1000.00\n04/09/2026,Salary,2000.00,3000.00\n15/09/2026,Rent,-800.00,2200.00\n'), 'export.csv');
    assert.equal(p.csv!.mapping.headerRow, -1);
    assert.deepEqual(p.csv!.mapping.headers, ['Column 1', 'Column 2', 'Column 3', 'Column 4']);
    assert.deepEqual(p.csv!.mapping.columns, { date: 0, amount: 2, balance: 3, description: 1 });
    assert.equal(p.csv!.mapping.dateOrder, 'DMY');
    assert.deepEqual(p.rows.map(r => [r.date, r.amount, r.description, r.balance]), [['2026-09-03', -4.5, 'Coffee shop', 1000], ['2026-09-04', 2000, 'Salary', 3000], ['2026-09-15', -800, 'Rent', 2200]]);
    assert.deepEqual(p.closingBalance, { amount: 2200, asOf: '2026-09-15' });
  });

  test('pipe delimiter with quoted commas and a "Credit"/"Debit" column pair', () => {
    const p = parseStatement(buf('Date|Details|Debit|Credit\n2026-09-03|"Grocer, The"|45.20|\n2026-09-04|Refund||12.00\n'), 'x.txt');
    assert.equal(p.csv!.mapping.delimiter, '|');
    assert.equal(p.csv!.mapping.signConvention, 'debitCredit');
    assert.deepEqual(p.rows.map(r => [r.description, r.amount]), [['Grocer, The', -45.2], ['Refund', 12]]);
  });

  test('unsigned amount with a DR/CR indicator column', () => {
    const p = parseStatement(buf('Date,Narrative,Amount,DR/CR\n01/09/2026,Shop,12.00,DR\n02/09/2026,Payroll,900.00,CR\n'), 'x.csv', { localeHint: 'en-GB' });
    assert.equal(p.csv!.mapping.signConvention, 'indicator');
    assert.deepEqual(p.rows.map(r => r.amount), [-12, 900]);
  });

  test('a lone signed "Credit" column is treated as the amount', () => {
    const p = parseStatement(buf('Date,Payee,Credit\n2026-09-01,A,-5.00\n2026-09-02,B,7.00\n'), 'x.csv');
    assert.equal(p.csv!.mapping.columns.amount, 2);
    assert.equal(p.csv!.mapping.signConvention, 'signed');
    assert.deepEqual(p.rows.map(r => r.amount), [-5, 7]);
  });

  test('mapping overrides: columns, header row, sign convention, delimiter, number format', () => {
    const text = 'Ignore this line\nDate;Memo;Payee;Out;In\n01.09.2026;note;Bakery;3,50;\n02.09.2026;;Employer;;1.000,00\n';
    const auto = parseStatement(buf(text), 'x.csv');
    assert.equal(auto.csv!.mapping.headerRow, 1, 'preamble skipped');
    assert.equal(auto.csv!.mapping.numberFormat, 'comma');
    assert.deepEqual(auto.rows.map(r => [r.description, r.amount]), [['Bakery', -3.5], ['Employer', 1000]]);
    // force the memo column as description and a different sign convention
    const forced = parseStatement(buf(text), 'x.csv', { mapping: { delimiter: ';', headerRow: 1, columns: { description: 1, memo: 2, amount: 4, debit: -1, credit: -1 }, signConvention: 'signed', numberFormat: 'comma' } });
    assert.equal(forced.csv!.mapping.signConvention, 'signed');
    assert.equal(forced.rows[0].description, 'note');
    assert.equal(forced.rows[0].amount, null, 'row 1 has no value in the forced amount column');
    assert.equal(forced.rows[0].errors.length, 1);
    assert.equal(forced.rows[1].amount, 1000);
    assert.ok(forced.warnings.some(w => /1 row\(s\) could not be fully parsed/.test(w)));
  });

  test('ragged lines are skipped with a warning; empty lines ignored', () => {
    const p = parseStatement(buf('Date,Description,Amount\n\n2026-09-01,A,-1.00\nTotals,-1.00\n2026-09-02,B,-2.00\n\n'), 'x.csv');
    assert.equal(p.rows.length, 2);
    assert.ok(p.warnings.some(w => /1 line\(s\)/.test(w)));
  });

  test('transaction vs posted date and a currency column', () => {
    const p = parseStatement(buf('Transaction Date,Posted Date,Description,Amount,Currency\n2026-09-01,2026-09-03,Shop,-1.00,EUR\n2026-09-02,2026-09-02,Cafe,-2.00,EUR\n'), 'x.csv');
    assert.equal(p.rows[0].date, '2026-09-01');
    assert.equal(p.rows[0].postedDate, '2026-09-03');
    assert.equal(p.rows[1].postedDate, undefined, 'omitted when equal');
    assert.equal(p.currency, 'EUR');
    assert.equal(p.csv!.mapping.columns.currency, 4);
  });

  test('rejections: no date column, no rows', () => {
    assert.equal(fail(() => parseStatement(buf('A,B,C\nx,y,z\nq,w,e\n'), 'x.csv')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf('Date,Amount\n'), 'x.csv')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf('   \n\n'), 'x.csv')).code, 'empty');
  });
});

describe('import/ofx edge cases', () => {
  const header = 'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n';
  const wrap = (stmts: string) => `${header}<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS></SONRS></SIGNONMSGSRSV1>${stmts}</OFX>`;
  const trn = (fitid: string, amt: string, name: string, extra = '') => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>${amt}<FITID>${fitid}<NAME>${name}${extra}</STMTTRN>`;
  const stmt = (cur: string, acct: string, trns: string, bal = '<LEDGERBAL><BALAMT>100.00<DTASOF>20260930</LEDGERBAL>') =>
    `<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>${cur}<BANKACCTFROM><BANKID>1<ACCTID>${acct}<ACCTTYPE>SAVINGS</BANKACCTFROM><BANKTRANLIST><DTSTART>20260901<DTEND>20260930${trns}</BANKTRANLIST>${bal}</STMTRS></STMTTRNRS></BANKMSGSRSV1>`;

  test('entities, NAME+MEMO merging, DTUSER, per-transaction currency, savings type', () => {
    const p = parseStatement(buf(wrap(stmt('USD', 'S1',
      trn('a', '-5.00', 'Tom &amp; Jerry&#39;s', '<MEMO>Tom &amp; Jerry&#39;s Diner — full memo') +
      trn('b', '-7,50', 'Short', '<MEMO>Unrelated memo<DTUSER>20260901<CURRENCY><CURRATE>1.1<CURSYM>EUR</CURRENCY>')))), 'x.ofx');
    assert.equal(p.rows[0].description, "Tom & Jerry's Diner — full memo", 'memo that extends NAME becomes the description');
    assert.equal(p.rows[0].memo, undefined);
    assert.equal(p.rows[1].description, 'Short');
    assert.equal(p.rows[1].memo, 'Unrelated memo');
    assert.equal(p.rows[1].amount, -7.5, 'comma decimal in TRNAMT');
    assert.equal(p.rows[1].date, '2026-09-01', 'DTUSER wins as the transaction date');
    assert.equal(p.rows[1].postedDate, '2026-09-03');
    assert.equal(p.rows[1].currency, 'EUR');
    assert.equal(p.rows[0].currency, 'USD', 'CURDEF applies to rows without their own currency');
    assert.equal(p.account?.type, 'savings');
    assert.equal(p.account?.externalId, 'S1');
    assert.equal(p.dialect, 'ofx1');
    assert.deepEqual(p.warnings, []);
  });

  test('XML leaves with closing tags and a QFX marker', () => {
    const xml = '<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><SIGNONMSGSRSV1><SONRS><INTU.BID>1234</INTU.BID></SONRS></SIGNONMSGSRSV1><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>GBP</CURDEF><CCACCTFROM><ACCTID>4111</ACCTID></CCACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260903</DTPOSTED><TRNAMT>-10.00</TRNAMT><FITID>x</FITID><NAME>Shop</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-10.00</BALAMT><DTASOF>20260903</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>';
    const p = parseStatement(buf(xml), 'card.xml');
    assert.equal(p.format, 'ofx');
    assert.equal(p.dialect, 'qfx');
    assert.equal(p.account?.type, 'credit');
    assert.equal(p.currency, 'GBP');
    assert.deepEqual(p.rows.map(r => [r.externalId, r.amount, r.description]), [['x', -10, 'Shop']]);
    assert.deepEqual(p.closingBalance, { amount: -10, asOf: '2026-09-03' });
  });

  test('multiple statements → first used with a warning; missing amount → row error; no ledger balance', () => {
    const two = wrap(stmt('USD', 'A', trn('a', '-1.00', 'One')) + stmt('USD', 'B', trn('b', '-2.00', 'Two')));
    const p = parseStatement(buf(two), 'x.ofx');
    assert.equal(p.account?.externalId, 'A');
    assert.ok(p.warnings.some(w => /2 account statements/.test(w)));
    const bad = parseStatement(buf(wrap(stmt('USD', 'A', '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903<FITID>z<NAME>NoAmount</STMTTRN>', ''))), 'x.ofx');
    assert.deepEqual(bad.rows[0].errors, ['Missing or invalid TRNAMT']);
    assert.equal(bad.closingBalance, undefined);
  });

  test('rejections: no <OFX>, no statements, investment only', () => {
    assert.equal(fail(() => parseStatement(buf('OFXHEADER:100\nDATA:OFXSGML\n\nnothing here'), 'x.ofx')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf(wrap('')), 'x.ofx')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf(wrap('<INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>')), 'x.ofx')).code, 'investment');
  });

  test('tree parser tolerates stray closing tags', () => {
    const tree = parseOfxTree('<OFX><A><B>1</B></ZZZ><C>2</C></A></OFX>');
    const ofx = tree.children[0];
    assert.equal(ofx.name, 'OFX');
    assert.deepEqual(ofx.children[0].children.map(c => [c.name, c.value]), [['B', '1'], ['C', '2']]);
  });
});

describe('import/qif edge cases', () => {
  test('splits, classes, transfers, U amounts, cleared flags, ignored category list, mixed lists', () => {
    const qif = [
      '!Type:Cat', 'NFood:Groceries', 'E', '^',
      '!Type:Bank',
      "D9/ 3'26", 'U-45.50', 'C*', 'N1001', 'PSuper Market', 'MWeekly shop', 'LFood:Groceries/Holiday', '^',
      "D9/ 5'26", 'T-900.00', 'PTransfer to savings', 'L[Savings Account]', '^',
      "D9/ 7'26", 'T-60.00', 'PBig Box Store', 'SHousehold', 'ESoap', '$-20.00', 'SFood:Groceries', 'ESnacks', '$-40.00', '^',
      '!Type:CCard',
      "D9/13'26", 'T-12.00', 'PCard thing', '^',
      '',
    ].join('\n');
    const p = parseStatement(buf(qif), 'x.qif');
    assert.equal(p.rows.length, 4);
    assert.equal(p.csv, undefined);
    assert.deepEqual(p.rows[0], {
      index: 0, date: '2026-09-03', amount: -45.5, description: 'Super Market', errors: [],
      raw: "D9/ 3'26 | U-45.50 | C* | N1001 | PSuper Market | MWeekly shop | LFood:Groceries/Holiday",
      memo: 'Weekly shop', category: 'Food:Groceries', checkNumber: '1001',
    });
    assert.equal(p.rows[1].transferAccount, 'Savings Account');
    assert.equal(p.rows[1].category, undefined);
    assert.match(p.rows[2].memo!, /Split: Household -20\.00; Food:Groceries -40\.00/);
    assert.equal(p.rows[2].category, undefined, 'two splits → no single category');
    assert.equal(p.rows[3].date, '2026-09-13', 'MDY inferred from the 13th');
    assert.ok(p.warnings.some(w => /mixes BANK, CCARD/.test(w)));
    assert.equal(p.account?.type, 'checking');
  });

  test('UK day-first dates inferred; ambiguous files follow the locale; investment mixed in is ignored with a warning', () => {
    const uk = parseStatement(buf('!Type:Bank\nD25/09/2026\nT-1.00\nPA\n^\nD02/09/2026\nT-2.00\nPB\n^\n'), 'x.qif');
    assert.deepEqual(uk.rows.map(r => r.date), ['2026-09-25', '2026-09-02']);
    const amb = parseStatement(buf('!Type:Bank\nD02/09/2026\nT-2.00\nPB\n^\n'), 'x.qif', { localeHint: 'en-US' });
    assert.equal(amb.rows[0].date, '2026-02-09');
    assert.ok(amb.warnings.some(w => /month\/day/.test(w)));
    const mixed = parseStatement(buf('!Type:Invst\nD9/6\'26\nNBuy\nYVTI\nQ1\nT100\n^\n!Type:Bank\nD9/6\'26\nT-1.00\nPA\n^\n'), 'x.qif');
    assert.equal(mixed.rows.length, 1);
    assert.ok(mixed.warnings.some(w => /Investment sections/.test(w)));
  });

  test('rejections', () => {
    assert.equal(fail(() => parseStatement(buf('!Type:Invst\nD9/6\'26\nNBuy\n^\n'), 'x.qif')).code, 'investment');
    assert.equal(fail(() => parseStatement(buf('!Type:Cat\nNFood\n^\n'), 'x.qif')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf('!Type:Bank\n'), 'x.qif')).code, 'invalid');
  });
});

describe('import/openbanking edge cases', () => {
  test('generic JSON array goes through column mapping; nested objects are flattened', () => {
    const doc = { result: { items: [
      { when: '2026-09-03', what: 'Coffee', money: { value: '-4.50', ccy: 'USD' } },
      { when: '2026-09-04', what: 'Pay', money: { value: '2000', ccy: 'USD' } },
    ] } };
    const p = parseStatement(buf(JSON.stringify(doc)), 'export.json');
    assert.equal(p.format, 'openbanking');
    assert.equal(p.dialect, 'generic-json');
    assert.deepEqual(p.csv!.mapping.headers, ['when', 'what', 'money.value', 'money.ccy']);
    assert.deepEqual(p.rows.map(r => [r.date, r.description, r.amount, r.currency]), [['2026-09-03', 'Coffee', -4.5, 'USD'], ['2026-09-04', 'Pay', 2000, 'USD']]);
    assert.match(p.rows[0].raw, /"what":"Coffee"/);
  });

  test('OBIE without the Data wrapper, Berlin at top level, Plaid personal_finance_category', () => {
    const obie = parseStatement(buf(JSON.stringify({ Transaction: [{ TransactionId: 't1', Amount: { Amount: '5.00', Currency: 'GBP' }, CreditDebitIndicator: 'Debit', BookingDateTime: '2026-09-03T00:00:00Z', TransactionInformation: 'Shop' }] })), 'x.json');
    assert.deepEqual(obie.rows.map(r => [r.externalId, r.amount, r.currency]), [['t1', -5, 'GBP']]);
    const berlin = parseStatement(buf(JSON.stringify({ booked: [{ transactionId: 'b1', bookingDate: '2026-09-03', transactionAmount: { currency: 'EUR', amount: '-9.99' }, remittanceInformationUnstructuredArray: ['Part one', 'part two'], bankTransactionCode: 'PMNT-ICDT-ESCT' }] })), 'x.json');
    assert.equal(berlin.dialect, 'berlin');
    assert.equal(berlin.rows[0].description, 'Part one part two');
    assert.equal(berlin.rows[0].bankCode, 'ICDT/ESCT');
    const plaid = parseStatement(buf(JSON.stringify({ transactions: [{ transaction_id: 'p1', amount: 12.5, date: '2026-09-03', name: 'SQ *COFFEE', merchant_name: 'Coffee', personal_finance_category: { primary: 'FOOD_AND_DRINK' }, pending: false, iso_currency_code: 'USD' }] })), 'x.json');
    assert.equal(plaid.dialect, 'plaid');
    assert.deepEqual([plaid.rows[0].amount, plaid.rows[0].description, plaid.rows[0].memo, plaid.rows[0].category], [-12.5, 'Coffee', 'SQ *COFFEE', 'FOOD_AND_DRINK']);
  });

  test('OBIE row errors and rejections', () => {
    const p = parseStatement(buf(JSON.stringify({ Data: { Transaction: [{ TransactionId: 't1', Amount: { Amount: '5.00' }, BookingDateTime: '2026-09-03T00:00:00Z' }] } })), 'x.json');
    assert.deepEqual(p.rows[0].errors, ['Missing CreditDebitIndicator']);
    assert.equal(fail(() => parseStatement(buf('{not json'), 'x.json')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf('{"a":1}'), 'x.json')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf('[]'), 'x.json')).code, 'invalid');
    assert.equal(fail(() => parseStatement(buf('{"Data":{"Transaction":[]}}'), 'x.json')).code, 'invalid');
  });
});

describe('import/detectFormat', () => {
  test('content beats extension; extension breaks ties; unknown rejected', () => {
    assert.equal(detectFormat('anything.txt', 'OFXHEADER:100\nDATA:OFXSGML\n<OFX>'), 'ofx');
    assert.equal(detectFormat('x.csv', '<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX></OFX>'), 'ofx');
    assert.equal(detectFormat('x.csv', '!Type:Bank\nD1/1/26\n^'), 'qif');
    assert.equal(detectFormat('x.csv', '{"Data":{}}'), 'openbanking');
    assert.equal(detectFormat('x.json', 'a,b\n1,2\n'), 'csv', 'delimited text is CSV even with a .json extension');
    assert.equal(detectFormat('x.csv', 'Date,Amount\n2026-01-01,1\n'), 'csv');
    assert.equal(detectFormat('notes.txt', 'just one line without delimiters'), 'csv', 'txt extension falls back to CSV');
    assert.equal(fail(() => detectFormat('x.bin', 'just one line without delimiters')).code, 'unsupported');
  });
});
