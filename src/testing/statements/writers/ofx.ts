/**
 * OFX writers: 1.x SGML (cp1252 header), 2.x XML, and QFX (OFX 1.x with the
 * Intuit extensions). Bank accounts use STMTRS, credit cards CCSTMTRS.
 */
import { encodeCp1252, type Statement, type StatementRow } from '../model.js';

export type OfxFlavour = 'ofx1' | 'ofx2' | 'qfx';
export const OFX_FLAVOURS: OfxFlavour[] = ['ofx1', 'ofx2', 'qfx'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ofxDate = (d: string, withTime: boolean) => d.replace(/-/g, '') + (withTime ? '120000.000[-5:EST]' : '');

function trnType(r: StatementRow): string {
  const d = r.description.toUpperCase();
  if (r.checkNumber) return 'CHECK';
  if (d.includes('TRANSFER')) return 'XFER';
  if (d.includes('INTEREST')) return 'INT';
  if (d.includes('FEE')) return 'FEE';
  if (d.includes('SALARY') || d.includes('PAYROLL')) return 'DIRECTDEP';
  if (d.includes('PAYMENT') && r.amount > 0) return 'PAYMENT';
  if (d.includes('ATM')) return 'ATM';
  return r.amount < 0 ? (d.includes('CARD') ? 'POS' : 'DEBIT') : 'CREDIT';
}

/** One STMTTRN. `leaf(name, value)` is flavour-specific (SGML leaves are unclosed). */
function transaction(r: StatementRow, leaf: (n: string, v: string) => string, withTime: boolean): string {
  const name = r.description.length > 32 ? r.description.slice(0, 32) : r.description;
  const memo = r.description.length > 32 ? r.description : r.memo;
  const parts = [
    leaf('TRNTYPE', trnType(r)),
    leaf('DTPOSTED', ofxDate(r.postedDate ?? r.date, withTime)),
    r.postedDate ? leaf('DTUSER', ofxDate(r.date, withTime)) : '',
    leaf('TRNAMT', r.amount.toFixed(2)),
    leaf('FITID', r.id),
    r.checkNumber ? leaf('CHECKNUM', r.checkNumber) : '',
    r.reference ? leaf('REFNUM', r.reference) : '',
    leaf('NAME', esc(name)),
    memo ? leaf('MEMO', esc(memo)) : '',
  ].filter(Boolean);
  return `<STMTTRN>\n${parts.join('\n')}\n</STMTTRN>`;
}

function body(statement: Statement, leaf: (n: string, v: string) => string, withTime: boolean, intuit: boolean): string {
  const a = statement.account;
  const isCard = a.type === 'credit';
  const rows = statement.rows.filter(r => !r.pending); // OFX has no pending concept
  const tranlist = [
    '<BANKTRANLIST>',
    leaf('DTSTART', ofxDate(statement.dateFrom, withTime)),
    leaf('DTEND', ofxDate(statement.dateTo, withTime)),
    ...rows.map(r => transaction(r, leaf, withTime)),
    '</BANKTRANLIST>',
  ].join('\n');
  const ledger = `<LEDGERBAL>\n${leaf('BALAMT', statement.closingBalance.toFixed(2))}\n${leaf('DTASOF', ofxDate(statement.dateTo, withTime))}\n</LEDGERBAL>`;
  const acctFrom = isCard
    ? `<CCACCTFROM>\n${leaf('ACCTID', a.externalId)}\n</CCACCTFROM>`
    : `<BANKACCTFROM>\n${leaf('BANKID', a.bankId ?? '000000000')}\n${leaf('ACCTID', a.externalId)}\n${leaf('ACCTTYPE', a.type === 'savings' ? 'SAVINGS' : 'CHECKING')}\n</BANKACCTFROM>`;
  const status = `<STATUS>\n${leaf('CODE', '0')}\n${leaf('SEVERITY', 'INFO')}\n</STATUS>`;
  const signon = `<SIGNONMSGSRSV1>\n<SONRS>\n${status}\n${leaf('DTSERVER', ofxDate(statement.dateTo, withTime))}\n${leaf('LANGUAGE', 'ENG')}\n<FI>\n${leaf('ORG', 'FinFolio Test Bank')}\n${leaf('FID', '9999')}\n</FI>\n${intuit ? leaf('INTU.BID', '9999') + '\n' : ''}</SONRS>\n</SIGNONMSGSRSV1>`;
  const stmt = isCard
    ? `<CREDITCARDMSGSRSV1>\n<CCSTMTTRNRS>\n${leaf('TRNUID', '1')}\n${status}\n<CCSTMTRS>\n${leaf('CURDEF', a.currency)}\n${acctFrom}\n${tranlist}\n${ledger}\n</CCSTMTRS>\n</CCSTMTTRNRS>\n</CREDITCARDMSGSRSV1>`
    : `<BANKMSGSRSV1>\n<STMTTRNRS>\n${leaf('TRNUID', '1')}\n${status}\n<STMTRS>\n${leaf('CURDEF', a.currency)}\n${acctFrom}\n${tranlist}\n${ledger}\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>`;
  return `<OFX>\n${signon}\n${stmt}\n</OFX>\n`;
}

export function writeOfx(statement: Statement, flavour: OfxFlavour): Buffer {
  if (flavour === 'ofx2') {
    const leaf = (n: string, v: string) => `<${n}>${v}</${n}>`;
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n';
    return Buffer.from(header + body(statement, leaf, false, false), 'utf8');
  }
  const leaf = (n: string, v: string) => `<${n}>${v}`;
  const header = ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '', ''].join('\r\n');
  return encodeCp1252(header + body(statement, leaf, true, flavour === 'qfx').replace(/\n/g, '\r\n'));
}

/** A minimal brokerage statement — used to check that investment files are rejected. */
export function writeOfxInvestment(): Buffer {
  const leaf = (n: string, v: string) => `<${n}>${v}`;
  const text = ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '', '',
    '<OFX>', '<SIGNONMSGSRSV1><SONRS><STATUS>', leaf('CODE', '0'), leaf('SEVERITY', 'INFO'), '</STATUS>', leaf('DTSERVER', '20261025'), leaf('LANGUAGE', 'ENG'), '</SONRS></SIGNONMSGSRSV1>',
    '<INVSTMTMSGSRSV1><INVSTMTTRNRS>', leaf('TRNUID', '1'), '<STATUS>', leaf('CODE', '0'), leaf('SEVERITY', 'INFO'), '</STATUS>',
    '<INVSTMTRS>', leaf('DTASOF', '20261025'), leaf('CURDEF', 'USD'),
    '<INVACCTFROM>', leaf('BROKERID', 'test.broker'), leaf('ACCTID', 'BRK-1'), '</INVACCTFROM>',
    '<INVTRANLIST>', leaf('DTSTART', '20260901'), leaf('DTEND', '20261025'),
    '<BUYSTOCK><INVBUY><INVTRAN>', leaf('FITID', 'B1'), leaf('DTTRADE', '20260906'), '</INVTRAN>',
    '<SECID>', leaf('UNIQUEID', '922908769'), leaf('UNIQUEIDTYPE', 'CUSIP'), '</SECID>',
    leaf('UNITS', '3'), leaf('UNITPRICE', '250.00'), leaf('TOTAL', '-750.00'), leaf('SUBACCTSEC', 'CASH'), leaf('SUBACCTFUND', 'CASH'),
    '</INVBUY>', leaf('BUYTYPE', 'BUY'), '</BUYSTOCK>',
    '</INVTRANLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>', ''].join('\r\n');
  return Buffer.from(text, 'latin1');
}
