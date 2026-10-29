/**
 * Static categorisation (no learning — see workbook D4).
 *
 * Resolution order, first hit wins:
 *   1. transfer pairing decided by the engine (passed in as `transfer`)
 *   2. a category carried by the file: QIF `[Account]`, a category label
 *      (through the alias table), a merchant category code, a bank code
 *   3. keyword rules on the description, filtered by income/expense
 *   4. `Uncategorized`
 */
import { TRANSACTION_CATEGORIES, TRANSFER_CATEGORY } from '../db/database.js';
import type { ImportConfig } from './config.js';

export type CategorySource = 'transfer' | 'carried' | 'mcc' | 'bankcode' | 'keyword' | 'none';

export interface CategorizeInput {
  type: 'income' | 'expense';
  description: string;
  /** Normalised description (noise removed) — also matched against. */
  normalizedDescription: string;
  carriedCategory?: string;
  transferAccount?: string;
  mcc?: number;
  bankCode?: string;
  /** True when the engine paired the row with a transfer leg on another account. */
  transfer?: boolean;
}

export interface CategorizeResult {
  category: string;
  source: CategorySource;
  /** 0 … 1 for display only. */
  confidence: number;
  /** Which alias/rule/MCC range produced the result. */
  via?: string;
}

interface Compiled {
  cfg: ImportConfig;
  rules: { category: string; type: 'income' | 'expense' | 'any'; regex: RegExp; pattern: string }[];
  known: Map<string, string>;
}

const cache = new WeakMap<ImportConfig, Compiled>();

function compile(cfg: ImportConfig): Compiled {
  let c = cache.get(cfg);
  if (c) return c;
  c = {
    cfg,
    rules: cfg.rules.flatMap(r => r.patterns.map(p => ({ category: r.category, type: r.type, regex: new RegExp(p, 'i'), pattern: p }))),
    known: new Map(TRANSACTION_CATEGORIES.map(k => [k.toLowerCase(), k])),
  };
  cache.set(cfg, c);
  return c;
}

const strip = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

/** Map a label another tool exported ("Food:Groceries", "Food and Drink > Groceries") to one of ours. */
export function resolveCarriedCategory(label: string, cfg: ImportConfig): { category: string; via: string } | undefined {
  const c = compile(cfg);
  const candidates: string[] = [];
  const full = label.trim();
  candidates.push(full);
  const parts = full.split(/\s*(?:>|:|\/|›)\s*/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) candidates.push(parts[i]);
  for (const cand of candidates) {
    const key = cand.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const alias = cfg.aliases[key];
    if (alias) return { category: alias, via: `alias "${cand}"` };
    const own = c.known.get(key);
    if (own) return { category: own, via: `label "${cand}"` };
  }
  return undefined;
}

export function categorize(input: CategorizeInput, cfg: ImportConfig): CategorizeResult {
  const c = compile(cfg);
  if (input.transfer) return { category: TRANSFER_CATEGORY, source: 'transfer', confidence: 0.95, via: 'paired with the other leg' };
  if (input.transferAccount) return { category: TRANSFER_CATEGORY, source: 'carried', confidence: 0.95, via: `[${input.transferAccount}]` };
  if (input.carriedCategory) {
    const hit = resolveCarriedCategory(input.carriedCategory, cfg);
    if (hit) return { category: hit.category, source: 'carried', confidence: 0.9, via: hit.via };
  }
  if (input.mcc !== undefined) {
    const range = cfg.mcc.find(m => input.mcc! >= m.from && input.mcc! <= m.to);
    if (range && input.type === 'expense') return { category: range.category, source: 'mcc', confidence: 0.8, via: `MCC ${input.mcc}` };
  }
  if (input.bankCode) {
    const sub = input.bankCode.split(/[-/.]/).pop()!.toUpperCase();
    const hit = cfg.bankTransactionCodes[sub];
    if (hit) return { category: hit, source: 'bankcode', confidence: 0.7, via: `bank code ${sub}` };
  }
  const raw = strip(input.description);
  const norm = input.normalizedDescription.toUpperCase();
  for (const rule of c.rules) {
    if (rule.type !== 'any' && rule.type !== input.type) continue;
    if (rule.regex.test(raw) || rule.regex.test(norm)) return { category: rule.category, source: 'keyword', confidence: 0.6, via: `/${rule.pattern}/` };
  }
  return { category: cfg.uncategorized, source: 'none', confidence: 0 };
}
