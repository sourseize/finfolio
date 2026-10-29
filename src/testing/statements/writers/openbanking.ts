/**
 * Open Banking JSON writers for the three dialects the importer recognises:
 *  - obie:   UK Open Banking Read/Write API v3 (`Data.Transaction[]`)
 *  - berlin: Berlin Group NextGenPSD2 (`transactions.booked[] / pending[]`)
 *  - plaid:  aggregator style (`transactions[]`, positive amount = money out)
 */
import type { Statement, StatementRow } from '../model.js';

export type ObDialect = 'obie' | 'berlin' | 'plaid';
export const OB_DIALECTS: ObDialect[] = ['obie', 'berlin', 'plaid'];

const iso = (d: string, t = 'T10:15:00+00:00') => `${d}${t}`;

/** ISO 20022 domain/family/sub-family for a row, as banks derive it. */
function bankCode(r: StatementRow): { code: string; sub: string } {
  if (r.bankCode) {
    const [, fam = 'ICDT', sub = 'OTHR'] = r.bankCode.split('/');
    return { code: fam, sub };
  }
  const d = r.description.toUpperCase();
  if (d.includes('SALARY')) return { code: 'RCDT', sub: 'SALA' };
  if (d.includes('INTEREST')) return { code: 'ACMT', sub: 'INTR' };
  if (d.includes('TRANSFER')) return { code: 'ICDT', sub: 'BOOK' };
  if (r.amount < 0) return { code: 'CCRD', sub: 'POSD' };
  return { code: 'RCDT', sub: 'OTHR' };
}

function obie(statement: Statement): unknown {
  const a = statement.account;
  return {
    Data: {
      Transaction: statement.rows.map(r => {
        const bc = bankCode(r);
        const txn: Record<string, unknown> = {
          AccountId: a.externalId,
          TransactionId: r.id,
          TransactionReference: r.reference ?? r.id,
          Amount: { Amount: Math.abs(r.amount).toFixed(2), Currency: r.currency },
          CreditDebitIndicator: r.amount < 0 ? 'Debit' : 'Credit',
          Status: r.pending ? 'Pending' : 'Booked',
          BookingDateTime: iso(r.postedDate ?? r.date),
          ValueDateTime: iso(r.date),
          TransactionInformation: r.description,
          BankTransactionCode: { Code: bc.code, SubCode: bc.sub },
          ProprietaryBankTransactionCode: { Code: r.amount < 0 ? 'DEB' : 'CRE', Issuer: 'FinFolioTestBank' },
        };
        if (r.balanceAfter !== undefined) {
          txn.Balance = { Amount: { Amount: Math.abs(r.balanceAfter).toFixed(2), Currency: a.currency }, CreditDebitIndicator: r.balanceAfter < 0 ? 'Debit' : 'Credit', Type: 'InterimBooked' };
        }
        if (r.mcc !== undefined || r.amount < 0) {
          txn.MerchantDetails = { MerchantName: r.description, ...(r.mcc !== undefined ? { MerchantCategoryCode: String(r.mcc) } : {}) };
        }
        return txn;
      }),
    },
    Links: { Self: `https://api.finfolio-test-bank.example/open-banking/v3.1/aisp/accounts/${a.externalId}/transactions` },
    Meta: { TotalPages: 1, FirstAvailableDateTime: iso(statement.dateFrom), LastAvailableDateTime: iso(statement.dateTo) },
  };
}

function berlin(statement: Statement): unknown {
  const a = statement.account;
  const row = (r: StatementRow) => {
    const bc = bankCode(r);
    return {
      transactionId: r.id,
      entryReference: r.reference ?? r.id,
      endToEndId: 'NOTPROVIDED',
      bookingDate: r.date,
      valueDate: r.postedDate ?? r.date,
      transactionAmount: { currency: r.currency, amount: r.amount.toFixed(2) },
      ...(r.amount < 0 ? { creditorName: r.description } : { debtorName: r.description }),
      remittanceInformationUnstructured: r.memo ?? r.description,
      bankTransactionCode: `PMNT-${bc.code}-${bc.sub}`,
      proprietaryBankTransactionCode: r.amount < 0 ? 'LASTSCHRIFT' : 'GUTSCHRIFT',
      ...(r.mcc !== undefined ? { merchantCategoryCode: String(r.mcc) } : {}),
    };
  };
  return {
    account: { iban: a.iban ?? `DE00${a.externalId.padStart(18, '0')}`, currency: a.currency },
    transactions: {
      booked: statement.rows.filter(r => !r.pending).map(row),
      pending: statement.rows.filter(r => r.pending).map(row),
      _links: { account: { href: `/v1/accounts/${a.externalId}` } },
    },
  };
}

/** Plaid category hierarchy for the labels the scenarios carry (see CARRIED_CATEGORY_LABEL). */
const PLAID_CATEGORY: Record<string, string[]> = {
  Groceries: ['Food and Drink', 'Groceries'],
  'Auto & Transport': ['Travel', 'Gas Stations'],
  'Mortgage & Rent': ['Payment', 'Rent'],
  'Bills & Utilities': ['Service', 'Utilities'],
  Entertainment: ['Recreation', 'Arts and Entertainment'],
  Shopping: ['Shops'],
  'Health & Fitness': ['Healthcare', 'Healthcare Services'],
  Education: ['Service', 'Education'],
  Paycheck: ['Transfer', 'Payroll'],
  Income: ['Transfer', 'Deposit'],
  Investments: ['Transfer', 'Deposit'],
  Gift: ['Shops', 'Gifts and Novelties'],
  Transfer: ['Transfer', 'Account Transfer'],
  'Misc Expenses': ['Service'],
};

function plaid(statement: Statement): unknown {
  const a = statement.account;
  return {
    accounts: [{
      account_id: a.externalId,
      name: a.name,
      official_name: a.name,
      type: a.type === 'credit' ? 'credit' : 'depository',
      subtype: a.type === 'credit' ? 'credit card' : a.type,
      balances: { current: a.type === 'credit' ? -statement.closingBalance : statement.closingBalance, iso_currency_code: a.currency },
    }],
    transactions: statement.rows.map(r => ({
      transaction_id: r.id,
      account_id: a.externalId,
      amount: -r.amount, // Plaid: positive = money leaving the account
      iso_currency_code: r.currency,
      date: r.postedDate ?? r.date,
      authorized_date: r.date,
      name: r.description,
      merchant_name: r.amount < 0 ? r.description : null,
      category: r.category ? PLAID_CATEGORY[r.category] ?? [r.category] : null,
      pending: !!r.pending,
      payment_channel: r.amount < 0 ? 'in store' : 'other',
    })),
    total_transactions: statement.rows.length,
    request_id: 'finfolio-test',
  };
}

export function writeOpenBanking(statement: Statement, dialect: ObDialect): Buffer {
  const doc = dialect === 'obie' ? obie(statement) : dialect === 'berlin' ? berlin(statement) : plaid(statement);
  return Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

/** JSON that is valid but has no transactions in it — used to check rejection. */
export function writeJsonWithoutTransactions(): Buffer {
  return Buffer.from(JSON.stringify({ Data: { Account: [{ AccountId: '1', Currency: 'USD' }] }, Meta: {} }, null, 2), 'utf8');
}
