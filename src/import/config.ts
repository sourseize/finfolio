/**
 * Static import configuration: categorisation rules and dedupe thresholds.
 *
 * Source of truth is `config/import-categories.json` next to the application
 * (override the path with FINFOLIO_IMPORT_CONFIG). The compiled-in DEFAULT is
 * used when the file is missing (single-binary builds) and a test keeps the
 * two identical. Unknown categories or bad regexes fail fast at startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TRANSACTION_CATEGORIES, TRANSFER_CATEGORY, UNCATEGORIZED_CATEGORY } from '../db/database.js';

export interface KeywordRule {
  category: string;
  /** Which direction the rule applies to. */
  type: 'income' | 'expense' | 'any';
  /** Regular-expression fragments, matched case-insensitively against the upper-cased description. */
  patterns: string[];
}

export interface ImportConfig {
  uncategorized: string;
  dedupe: {
    /** "Possible duplicate": same amount, type and description within this many days (P1). */
    possibleDays: number;
    /** Transfer pairing: opposite leg on another account within this many days. */
    transferDays: number;
  };
  rules: KeywordRule[];
  /** Merchant category code ranges (inclusive). */
  mcc: { from: number; to: number; category: string }[];
  /** ISO 20022 sub-family codes (e.g. SALA) → category. */
  bankTransactionCodes: Record<string, string>;
  /** Category labels other tools export (Quicken, Mint, YNAB, Plaid) → our categories. */
  aliases: Record<string, string>;
}

export const DEFAULT_IMPORT_CONFIG: ImportConfig = {
  uncategorized: UNCATEGORIZED_CATEGORY,
  dedupe: { possibleDays: 2, transferDays: 3 },
  rules: [
    { category: 'Food & Dining', type: 'expense', patterns: ['TESCO', 'SAINSBURY', 'ASDA', 'MORRISONS', 'WAITROSE', 'WALMART', 'KROGER', 'SAFEWAY', 'PUBLIX', 'ALDI', 'LIDL', 'WHOLE FOODS', 'TRADER JOE', 'COSTCO', 'CARREFOUR', 'REWE', 'EDEKA', 'SUPERMARKET', 'GROCER', 'FARMERS MARKET', 'STARBUCKS', 'COSTA', 'PRET', 'MCDONALD', 'BURGER KING', 'KFC', 'SUBWAY', 'DOMINO', 'PIZZA', 'UBER EATS', 'DELIVEROO', 'JUST EAT', 'DOORDASH', 'GRUBHUB', 'RESTAURANT', 'CAFE', 'COFFEE', 'ESPRESSO', 'BAKERY', 'TAKEAWAY', 'DINER', 'BISTRO', 'LUNCH', 'DINNER', 'PASTRIES'] },
    { category: 'Transportation', type: 'expense', patterns: ['UBER(?! EATS)', 'LYFT', 'BOLT\\.EU', 'SHELL', '\\bBP\\b', 'ESSO', 'TEXACO', 'CHEVRON', 'EXXON', 'PETROL', 'FUEL', 'GAS STATION', '\\bTFL\\b', 'TRANSIT', 'AMTRAK', 'NATIONAL RAIL', 'TRAINLINE', '\\bRAIL\\b', 'METRO', 'PARKING', 'TOLL', 'CAR WASH', 'GARAGE', 'CAR REPAIR', 'MOT TEST', '\\bDVLA\\b', 'AIRLINE', 'RYANAIR', 'EASYJET', 'BRITISH AIRWAYS', 'DELTA AIR', 'UNITED AIR'] },
    { category: 'Housing', type: 'expense', patterns: ['\\bRENT\\b', 'MORTGAGE', 'LANDLORD', '\\bHOA\\b', 'LETTING', 'ESTATE AGENT', 'PROPERTY MANAGEMENT', 'APARTMENT', 'DEPOSIT TOP'] },
    { category: 'Utilities', type: 'expense', patterns: ['ELECTRIC', 'ENERGY', 'POWER CO', 'GAS BILL', 'WATER', 'THAMES WATER', 'BROADBAND', 'INTERNET', 'FIBRE', 'FIBER', 'MOBILE PLAN', 'VODAFONE', 'O2\\b', 'EE LTD', 'THREE\\.CO', 'VERIZON', 'AT&T', 'T-MOBILE', 'COMCAST', 'XFINITY', 'SPECTRUM', 'BT GROUP', 'SKY\\b', 'VIRGIN MEDIA', 'COUNCIL TAX', 'TV LICEN', 'INSURANCE', 'UTILIT'] },
    { category: 'Entertainment', type: 'expense', patterns: ['NETFLIX', 'SPOTIFY', 'DISNEY', 'HBO', 'HULU', 'PRIME VIDEO', 'APPLE TV', 'YOUTUBE', 'CINEMA', 'ODEON', 'VUE\\b', 'AMC\\b', 'THEATRE', 'THEATER', 'CONCERT', 'TICKETMASTER', 'STEAM', 'PLAYSTATION', 'XBOX', 'NINTENDO', 'STREAMING', 'BOOKS?\\b', 'KINDLE', 'AUDIBLE', 'BOARD-?GAME', 'HOLIDAY', 'HOTEL', 'AIRBNB', 'FLIGHTS'] },
    { category: 'Shopping', type: 'expense', patterns: ['AMAZON', 'AMZN', 'EBAY', 'ETSY', 'IKEA', 'TARGET', 'BEST BUY', 'APPLE\\.COM', 'APPLE STORE', 'ZARA', 'H&M', 'UNIQLO', 'PRIMARK', 'JOHN LEWIS', 'MARKS & SPENCER', 'M&S\\b', 'ARGOS', 'CURRYS', 'CLOTHING', 'ELECTRONICS', 'HOUSEHOLD', 'LAPTOP', 'SHOPPING', 'STORE\\b', 'MKTPLACE', 'OFFICE DEPOT', 'STAPLES'] },
    { category: 'Healthcare', type: 'expense', patterns: ['PHARMACY', 'CHEMIST', 'BOOTS\\b', '\\bCVS\\b', 'WALGREENS', 'RITE AID', 'DENTAL', 'DENTIST', 'CLINIC', 'HOSPITAL', 'DOCTOR', '\\bGP\\b', 'PHYSIO', 'OPTICIAN', 'SPECSAVERS', 'GYM', 'FITNESS', 'PURE GYM', 'MEDICAL', 'HEALTH'] },
    { category: 'Education', type: 'expense', patterns: ['UDEMY', 'COURSERA', 'EDX\\b', 'PLURALSIGHT', 'SKILLSHARE', 'TUITION', 'UNIVERSITY', 'COLLEGE', 'SCHOOL', 'ONLINE COURSE', 'COURSE\\b', 'TRAINING', 'TEXTBOOK', 'STUDENT LOAN'] },
    { category: 'Salary', type: 'income', patterns: ['SALARY', 'PAYROLL', 'WAGES', 'DIRECT DEP', '\\bADP\\b', 'PAYCHECK', 'PAYCHEQUE', 'BONUS', 'EMPLOYER'] },
    { category: 'Freelance', type: 'income', patterns: ['INVOICE', 'FREELANCE', 'UPWORK', 'FIVERR', 'CONSULTING', 'CONTRACT WORK', 'CLIENT PAYMENT', 'ESCROW PAYOUT', 'STRIPE PAYOUT', 'PAYPAL'] },
    { category: 'Investment', type: 'any', patterns: ['DIVIDEND', 'INTEREST', 'VANGUARD', 'FIDELITY', 'SCHWAB', 'BLACKROCK', 'ISHARES', 'BROKERAGE', 'DEGIRO', 'TRADING 212', 'INTERACTIVE BROKERS', 'ROBINHOOD', 'COINBASE', 'KRAKEN', 'BINANCE', 'HARGREAVES', '\\bISA\\b', '\\b401K\\b', '\\bIRA\\b', 'PENSION'] },
    { category: 'Gift', type: 'any', patterns: ['\\bGIFT', 'BIRTHDAY', 'CHRISTMAS', 'WEDDING', 'DONATION', 'CHARITY', 'JUSTGIVING', 'GOFUNDME'] },
    { category: 'Transfer', type: 'any', patterns: ['TRANSFER', 'XFER', '\\bTFR\\b', 'PAYMENT RECEIVED', 'THANK YOU', 'AUTOPAY', 'ONLINE PAYMENT', 'CARD PAYMENT$', 'CREDIT CARD PAYMENT', 'TO SAVINGS', 'FROM SAVINGS', 'TO CHECKING', 'FROM CHECKING', 'REVOLUT', 'MONZO', 'WISE\\b', 'ZELLE', 'VENMO', 'ATM WITHDRAWAL', 'CASH WITHDRAWAL'] },
  ],
  mcc: [
    { from: 5411, to: 5499, category: 'Food & Dining' },
    { from: 5811, to: 5814, category: 'Food & Dining' },
    { from: 4111, to: 4131, category: 'Transportation' },
    { from: 4784, to: 4789, category: 'Transportation' },
    { from: 5541, to: 5542, category: 'Transportation' },
    { from: 7511, to: 7549, category: 'Transportation' },
    { from: 3000, to: 3999, category: 'Transportation' },
    { from: 4511, to: 4511, category: 'Transportation' },
    { from: 6513, to: 6513, category: 'Housing' },
    { from: 4900, to: 4900, category: 'Utilities' },
    { from: 4812, to: 4821, category: 'Utilities' },
    { from: 4899, to: 4899, category: 'Utilities' },
    { from: 6300, to: 6300, category: 'Utilities' },
    { from: 5912, to: 5912, category: 'Healthcare' },
    { from: 8011, to: 8099, category: 'Healthcare' },
    { from: 7997, to: 7997, category: 'Healthcare' },
    { from: 8211, to: 8299, category: 'Education' },
    { from: 5942, to: 5942, category: 'Entertainment' },
    { from: 7829, to: 7841, category: 'Entertainment' },
    { from: 7911, to: 7996, category: 'Entertainment' },
    { from: 7998, to: 7999, category: 'Entertainment' },
    { from: 7011, to: 7011, category: 'Entertainment' },
    { from: 5200, to: 5399, category: 'Shopping' },
    { from: 5611, to: 5699, category: 'Shopping' },
    { from: 5712, to: 5735, category: 'Shopping' },
    { from: 5940, to: 5941, category: 'Shopping' },
    { from: 5943, to: 5999, category: 'Shopping' },
    { from: 6211, to: 6211, category: 'Investment' },
    { from: 6010, to: 6012, category: 'Transfer' },
  ],
  bankTransactionCodes: { SALA: 'Salary', PENS: 'Salary', DIVI: 'Investment', INTR: 'Investment', BOOK: 'Transfer', ICDT: 'Transfer', CWDL: 'Transfer' },
  aliases: {
    groceries: 'Food & Dining', 'food & dining': 'Food & Dining', 'food and drink': 'Food & Dining', restaurants: 'Food & Dining', dining: 'Food & Dining', 'fast food': 'Food & Dining', 'coffee shops': 'Food & Dining', food: 'Food & Dining',
    'auto & transport': 'Transportation', 'gas & fuel': 'Transportation', 'gas stations': 'Transportation', 'public transportation': 'Transportation', travel: 'Transportation', transport: 'Transportation', auto: 'Transportation', parking: 'Transportation',
    'mortgage & rent': 'Housing', rent: 'Housing', mortgage: 'Housing', home: 'Housing', 'home improvement': 'Housing',
    'bills & utilities': 'Utilities', utilities: 'Utilities', 'mobile phone': 'Utilities', internet: 'Utilities', television: 'Utilities', insurance: 'Utilities',
    entertainment: 'Entertainment', 'arts and entertainment': 'Entertainment', 'movies & dvds': 'Entertainment', music: 'Entertainment', recreation: 'Entertainment', hobbies: 'Entertainment',
    shopping: 'Shopping', shops: 'Shopping', clothing: 'Shopping', 'electronics & software': 'Shopping', 'sporting goods': 'Shopping', 'general merchandise': 'Shopping',
    'health & fitness': 'Healthcare', healthcare: 'Healthcare', 'healthcare services': 'Healthcare', medical: 'Healthcare', pharmacy: 'Healthcare', doctor: 'Healthcare', dentist: 'Healthcare', gym: 'Healthcare',
    education: 'Education', 'student loan': 'Education', tuition: 'Education', books: 'Education',
    paycheck: 'Salary', salary: 'Salary', payroll: 'Salary', wages: 'Salary', income: 'Salary', 'regular income': 'Salary',
    freelance: 'Freelance', 'business income': 'Freelance', consulting: 'Freelance',
    investments: 'Investment', investment: 'Investment', 'dividend & cap gains': 'Investment', interest: 'Investment', 'interest income': 'Investment', 'buy': 'Investment', 'deposit': 'Investment',
    gift: 'Gift', gifts: 'Gift', 'gifts & donations': 'Gift', 'gifts and novelties': 'Gift', charity: 'Gift', donations: 'Gift',
    transfer: 'Transfer', transfers: 'Transfer', 'account transfer': 'Transfer', 'credit card payment': 'Transfer', 'credit card payments': 'Transfer', 'cash & atm': 'Transfer', 'atm': 'Transfer',
    'misc expenses': 'Other', misc: 'Other', miscellaneous: 'Other', other: 'Other', fees: 'Other', 'fees & charges': 'Other', 'bank fee': 'Other', uncategorized: 'Uncategorized',
  },
};

export class ImportConfigError extends Error {}

/** Throw when the configuration is unusable; returns the compiled regexes as a side product. */
export function validateImportConfig(cfg: ImportConfig): void {
  const known = new Set(TRANSACTION_CATEGORIES);
  const check = (cat: string, where: string) => { if (!known.has(cat)) throw new ImportConfigError(`${where}: unknown category "${cat}"`); };
  check(cfg.uncategorized, 'uncategorized');
  if (!(cfg.dedupe.possibleDays >= 0) || !(cfg.dedupe.transferDays >= 0)) throw new ImportConfigError('dedupe: days must be non-negative numbers');
  for (const r of cfg.rules) {
    check(r.category, `rules[${r.category}]`);
    if (!['income', 'expense', 'any'].includes(r.type)) throw new ImportConfigError(`rules[${r.category}]: type must be income, expense or any`);
    for (const p of r.patterns) { try { new RegExp(p, 'i'); } catch { throw new ImportConfigError(`rules[${r.category}]: invalid pattern /${p}/`); } }
  }
  for (const m of cfg.mcc) { check(m.category, `mcc[${m.from}-${m.to}]`); if (m.from > m.to) throw new ImportConfigError(`mcc[${m.from}-${m.to}]: from > to`); }
  for (const [k, v] of Object.entries(cfg.bankTransactionCodes)) check(v, `bankTransactionCodes[${k}]`);
  for (const [k, v] of Object.entries(cfg.aliases)) check(v, `aliases[${k}]`);
  if (!known.has(TRANSFER_CATEGORY)) throw new ImportConfigError('Transfer category missing');
}

export function resolveImportConfigPath(): string {
  return path.resolve(process.env.FINFOLIO_IMPORT_CONFIG || path.join(process.cwd(), 'config', 'import-categories.json'));
}

let active: ImportConfig | undefined;

/** Load (once) from disk, falling back to the compiled-in default. */
export function loadImportConfig(force = false): ImportConfig {
  if (active && !force) return active;
  const file = resolveImportConfigPath();
  let cfg: ImportConfig;
  if (fs.existsSync(file)) {
    try {
      cfg = { ...DEFAULT_IMPORT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
    } catch (err: any) {
      throw new ImportConfigError(`Cannot read ${file}: ${err.message}`);
    }
  } else {
    cfg = DEFAULT_IMPORT_CONFIG;
  }
  validateImportConfig(cfg);
  active = cfg;
  return cfg;
}

/** Test hook. */
export function setImportConfig(cfg: ImportConfig | undefined): void {
  if (cfg) validateImportConfig(cfg);
  active = cfg;
}
