import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { categorize, resolveCarriedCategory } from '../../src/import/categorize.js';
import { DEFAULT_IMPORT_CONFIG, ImportConfigError, loadImportConfig, setImportConfig, validateImportConfig, resolveImportConfigPath, type ImportConfig } from '../../src/import/config.js';
import { normalizeDescription } from '../../src/import/normalize.js';
import { TRANSACTION_CATEGORIES } from '../../src/db/database.js';

const cfg = DEFAULT_IMPORT_CONFIG;
const cat = (description: string, type: 'income' | 'expense' = 'expense', extra: Partial<Parameters<typeof categorize>[0]> = {}) =>
  categorize({ type, description, normalizedDescription: normalizeDescription(description), ...extra }, cfg);

describe('import/categorize', () => {
  test('keyword rules are type-aware and report what fired', () => {
    assert.equal(cat('TESCO STORES 3412').category, 'Food & Dining');
    assert.equal(cat('UBER EATS LONDON').category, 'Food & Dining', 'Uber Eats is food, not transport');
    assert.equal(cat('UBER *TRIP HELP.UBER.COM').category, 'Transportation');
    assert.equal(cat('NETFLIX.COM').category, 'Entertainment');
    assert.equal(cat('Rent — 14 Harbour St').category, 'Housing');
    assert.equal(cat('Monthly salary — Northwind Analytics', 'income').category, 'Salary');
    assert.equal(cat('Monthly salary — Northwind Analytics', 'expense').category, 'Uncategorized', 'income-only rule does not fire on an expense');
    assert.equal(cat('Interest — high-yield savings', 'income').category, 'Investment');
    assert.equal(cat('Credit card payment').category, 'Transfer');
    assert.equal(cat('Payment received — thank you', 'income').category, 'Transfer');
    const r = cat('STARBUCKS 0042');
    assert.equal(r.source, 'keyword');
    assert.match(r.via!, /STARBUCKS/);
    assert.equal(r.confidence, 0.6);
  });

  test('unknown descriptions fall back to Uncategorized with zero confidence', () => {
    assert.deepEqual(cat('ZZQX 88213'), { category: 'Uncategorized', source: 'none', confidence: 0 });
    assert.deepEqual(cat(''), { category: 'Uncategorized', source: 'none', confidence: 0 });
  });

  test('carried categories resolve through aliases, our own names and hierarchical labels', () => {
    assert.equal(resolveCarriedCategory('Groceries', cfg)!.category, 'Food & Dining');
    assert.equal(resolveCarriedCategory('Mortgage & Rent', cfg)!.category, 'Housing');
    assert.equal(resolveCarriedCategory('Food:Groceries', cfg)!.category, 'Food & Dining', 'Quicken Parent:Child → child');
    assert.equal(resolveCarriedCategory('Food and Drink > Restaurants', cfg)!.category, 'Food & Dining');
    assert.equal(resolveCarriedCategory('FOOD_AND_DRINK', cfg)!.category, 'Food & Dining', 'Plaid personal finance category');
    assert.equal(resolveCarriedCategory('Healthcare', cfg)!.category, 'Healthcare', 'our own name passes through');
    assert.equal(resolveCarriedCategory('healthcare', cfg)!.category, 'Healthcare', 'case-insensitive');
    assert.equal(resolveCarriedCategory('Travel > Gas Stations', cfg)!.category, 'Transportation');
    assert.equal(resolveCarriedCategory('Pets:Vet', cfg), undefined);
    const r = cat('whatever', 'expense', { carriedCategory: 'Bills & Utilities' });
    assert.equal(r.category, 'Utilities');
    assert.equal(r.source, 'carried');
    assert.equal(cat('TESCO', 'expense', { carriedCategory: 'Pets:Vet' }).category, 'Food & Dining', 'unknown carried label falls through to keywords');
  });

  test('precedence: transfer pairing > [Account] > carried label > MCC > bank code > keyword', () => {
    const all = { carriedCategory: 'Groceries', mcc: 7832, bankCode: 'RCDT/SALA', transferAccount: 'Savings' } as const;
    assert.equal(cat('NETFLIX', 'expense', { ...all, transfer: true }).source, 'transfer');
    assert.equal(cat('NETFLIX', 'expense', all).category, 'Transfer');
    assert.equal(cat('NETFLIX', 'expense', { carriedCategory: 'Groceries', mcc: 7832, bankCode: 'RCDT/SALA' }).category, 'Food & Dining');
    assert.equal(cat('NETFLIX', 'expense', { mcc: 7832, bankCode: 'RCDT/SALA' }).category, 'Entertainment');
    assert.equal(cat('NETFLIX', 'expense', { mcc: 7832, bankCode: 'RCDT/SALA' }).source, 'mcc');
    assert.equal(cat('ACME', 'income', { mcc: 5411, bankCode: 'RCDT/SALA' }).category, 'Salary', 'MCC applies to expenses only; bank code decides');
    assert.equal(cat('ACME', 'income', { bankCode: 'PMNT-RCDT-SALA' }).category, 'Salary', 'last segment of any code style');
    assert.equal(cat('ACME', 'income', { bankCode: 'RCDT/OTHR' }).category, 'Uncategorized');
    assert.equal(cat('X', 'expense', { mcc: 9999 }).category, 'Uncategorized', 'MCC outside every range');
  });

  test('MCC ranges cover the common codes', () => {
    const byMcc = (m: number) => cat('X', 'expense', { mcc: m }).category;
    assert.equal(byMcc(5411), 'Food & Dining');
    assert.equal(byMcc(5812), 'Food & Dining');
    assert.equal(byMcc(5541), 'Transportation');
    assert.equal(byMcc(4111), 'Transportation');
    assert.equal(byMcc(4900), 'Utilities');
    assert.equal(byMcc(5912), 'Healthcare');
    assert.equal(byMcc(8062), 'Healthcare');
    assert.equal(byMcc(8220), 'Education');
    assert.equal(byMcc(7832), 'Entertainment');
    assert.equal(byMcc(5311), 'Shopping');
    assert.equal(byMcc(6513), 'Housing');
  });
});

describe('import/config', () => {
  afterEach(() => setImportConfig(undefined));

  test('default config is valid and only references known categories', () => {
    validateImportConfig(cfg);
    const all = [cfg.uncategorized, ...cfg.rules.map(r => r.category), ...cfg.mcc.map(m => m.category), ...Object.values(cfg.bankTransactionCodes), ...Object.values(cfg.aliases)];
    for (const c of all) assert.ok(TRANSACTION_CATEGORIES.includes(c), c);
  });

  test('config/import-categories.json is the compiled-in default (kept in sync)', () => {
    const onDisk = JSON.parse(fs.readFileSync(path.resolve('config/import-categories.json'), 'utf-8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(cfg)));
  });

  test('validation rejects unknown categories, bad regexes, bad ranges, bad types', () => {
    const bad = (patch: (c: ImportConfig) => void) => { const c: ImportConfig = JSON.parse(JSON.stringify(cfg)); patch(c); return c; };
    assert.throws(() => validateImportConfig(bad(c => { c.uncategorized = 'Nope'; })), ImportConfigError);
    assert.throws(() => validateImportConfig(bad(c => { c.rules[0].category = 'Pets'; })), /unknown category "Pets"/);
    assert.throws(() => validateImportConfig(bad(c => { c.rules[0].patterns.push('('); })), /invalid pattern/);
    assert.throws(() => validateImportConfig(bad(c => { c.rules[0].type = 'both' as any; })), /type must be/);
    assert.throws(() => validateImportConfig(bad(c => { c.mcc[0].from = 9000; })), /from > to/);
    assert.throws(() => validateImportConfig(bad(c => { c.aliases.x = 'Pets'; })), /aliases\[x\]/);
    assert.throws(() => validateImportConfig(bad(c => { c.dedupe.possibleDays = -1; })), /non-negative/);
  });

  test('loadImportConfig reads the file named by FINFOLIO_IMPORT_CONFIG, merges over defaults, fails fast on errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-cfg-'));
    const file = path.join(dir, 'cfg.json');
    const saved = process.env.FINFOLIO_IMPORT_CONFIG;
    try {
      process.env.FINFOLIO_IMPORT_CONFIG = file;
      assert.equal(resolveImportConfigPath(), file);
      // missing → compiled default
      assert.equal(loadImportConfig(true), DEFAULT_IMPORT_CONFIG);
      // partial file → merged
      fs.writeFileSync(file, JSON.stringify({ dedupe: { possibleDays: 4, transferDays: 1 }, rules: [{ category: 'Other', type: 'any', patterns: ['ZZZ'] }] }));
      const merged = loadImportConfig(true);
      assert.equal(merged.dedupe.possibleDays, 4);
      assert.equal(merged.rules.length, 1);
      assert.equal(merged.uncategorized, 'Uncategorized', 'defaults fill the rest');
      assert.equal(categorize({ type: 'expense', description: 'ZZZ', normalizedDescription: 'ZZZ' }, merged).category, 'Other');
      assert.equal(loadImportConfig(), merged, 'cached');
      // broken JSON / invalid content → error
      fs.writeFileSync(file, '{ not json');
      assert.throws(() => loadImportConfig(true), /Cannot read/);
      fs.writeFileSync(file, JSON.stringify({ uncategorized: 'Pets' }));
      assert.throws(() => loadImportConfig(true), /unknown category/);
    } finally {
      if (saved === undefined) delete process.env.FINFOLIO_IMPORT_CONFIG; else process.env.FINFOLIO_IMPORT_CONFIG = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
