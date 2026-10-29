import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getScenarios, getStatementSource } from '../helpers/statements.js';
import { statementFor, bankify, SCENARIO_IDS, buildScenarios } from '../../src/testing/statements/index.js';
import { writeScenarios } from '../../src/testing/statements/cli.js';
import { mulberry32 } from '../../src/sim/montecarlo.js';
import { round2 } from '../../src/sim/math.js';

describe('test statement generator', () => {
  test('statements mirror the recorded transactions and balances reconcile', async () => {
    const src = await getStatementSource();
    const s = statementFor(src, 'Everyday Checking', '2026-09-01', '2026-09-30');
    const checking = src.accounts.find(a => a.name === 'Everyday Checking')!;
    const sep = src.transactions.filter(t => t.accountId === checking.id && t.date >= '2026-09-01' && t.date <= '2026-09-30');
    assert.equal(s.rows.length, sep.length);
    assert.ok(s.rows.length >= 10, 'a month of activity');
    // every recorded transaction appears once with the bank sign convention
    for (const t of sep) {
      const signed = t.type === 'income' ? t.amount : -t.amount;
      assert.ok(s.rows.some(r => r.date === t.date && r.amount === round2(signed) && r.description === t.description), `row for ${t.date} ${t.description}`);
    }
    // chronological, running balance consistent, closing = opening + sum
    for (let i = 1; i < s.rows.length; i++) assert.ok(s.rows[i].date >= s.rows[i - 1].date);
    let bal = s.openingBalance;
    for (const r of s.rows) { bal = round2(bal + r.amount); assert.equal(r.balanceAfter, bal); }
    assert.equal(s.closingBalance, bal);
    // September closing balance + October activity = today's balance
    const oct = src.transactions.filter(t => t.accountId === checking.id && t.date > '2026-09-30').reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);
    assert.equal(round2(s.closingBalance + oct), round2(checking.balance));
    assert.equal(s.account.currency, 'USD');
    assert.equal(s.account.externalId, '000123456789');
  });

  test('credit card statement uses the bank sign convention (purchases negative, closing negative = owed)', async () => {
    const src = await getStatementSource();
    const s = statementFor(src, 'Travel Rewards Card', '2026-08-01', '2026-08-31');
    const card = src.accounts.find(a => a.name === 'Travel Rewards Card')!;
    assert.ok(s.rows.filter(r => r.amount < 0).length > 5, 'purchases are negative');
    const payment = s.rows.find(r => r.amount > 0)!;
    assert.match(payment.description, /Payment received/);
    // closing balance on 31 Aug must equal -(owed at that date); today's owed = closing (neg) - later card activity
    const later = src.transactions.filter(t => t.accountId === card.id && t.date > '2026-08-31').reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);
    assert.equal(round2(-(s.closingBalance + later)), round2(card.balance));
    assert.equal(s.account.type, 'credit');
  });

  test('bankify adds only noise the normaliser strips, deterministically', () => {
    const a = bankify('Rent — 14 Harbour St', '2026-09-02', -1950, mulberry32(7));
    const b = bankify('Rent — 14 Harbour St', '2026-09-02', -1950, mulberry32(7));
    assert.equal(a, b, 'deterministic for the same seed');
    assert.match(a, /RENT - 14 HARBOUR ST/);
    const variants = new Set(Array.from({ length: 20 }, (_, i) => bankify('Fuel', '2026-09-06', -60, mulberry32(i))));
    assert.ok(variants.size > 3, 'varies with the seed');
  });

  test('all twelve scenarios build deterministically with the planted rows', async () => {
    const scenarios = await getScenarios();
    assert.deepEqual(scenarios.map(s => s.id), [...SCENARIO_IDS]);
    const again = buildScenarios(await getStatementSource());
    for (let i = 0; i < scenarios.length; i++) {
      for (let j = 0; j < scenarios[i].files.length; j++) {
        assert.equal(scenarios[i].files[j].name, again[i].files[j].name);
        assert.ok(scenarios[i].files[j].bytes.equals(again[i].files[j].bytes), `${scenarios[i].id}/${scenarios[i].files[j].name} deterministic`);
      }
    }
    const byId = Object.fromEntries(scenarios.map(s => [s.id, s]));
    const ids = (id: string) => byId[id].files[0].statement!.rows.map(r => r.id);
    assert.deepEqual(ids('S4').filter(i => i.startsWith('PLANT-')).sort(), ['PLANT-1DAY', 'PLANT-2DAY', 'PLANT-3DAY', 'PLANT-CENT', 'PLANT-REWORD']);
    assert.ok(ids('S5').some(i => i.startsWith('REPEAT-OF-')));
    assert.deepEqual(ids('S5').filter(i => i.startsWith('COFFEE')), ['COFFEE-A', 'COFFEE-B']);
    assert.deepEqual(byId.S6.files[0].statement!.rows.filter(r => r.currency === 'EUR').map(r => r.id), ['EUR-1', 'EUR-2', 'EUR-3']);
    assert.deepEqual(byId.S7.files[0].statement!.rows.filter(r => r.pending).map(r => r.id), ['PENDING-1', 'PENDING-2']);
    assert.ok(byId.S7.files[0].statement!.rows.some(r => r.id === 'FUTURE-1' && r.date > '2026-10-25'));
    assert.ok(byId.S6.files.some(f => f.statement!.account.currency === 'GBP'));
    assert.equal(byId.S11.files.every(f => f.format === 'invalid'), true);
    assert.equal(byId.S12.files[0].statement!.account.name, 'Side Hustle Checking');
    // S4 planted rows sit where the rules say
    const s4 = byId.S4.files[0].statement!;
    const base = (id: string) => s4.rows.find(r => r.id === id)!;
    const s1 = byId.S1.files[0].statement!;
    const orig = (row: typeof s4.rows[number]) => s1.rows.find(r => r.description === row.description && r.amount === row.amount)!;
    assert.equal(daysBetween(orig(base('PLANT-1DAY')).date, base('PLANT-1DAY').date), 1);
    assert.equal(daysBetween(orig(base('PLANT-2DAY')).date, base('PLANT-2DAY').date), 2);
    assert.equal(daysBetween(orig(base('PLANT-3DAY')).date, base('PLANT-3DAY').date), 3);
    assert.equal(s4.rows.length, s1.rows.length + 2, 'three rows replaced, five planted');
    for (const id of ['PLANT-1DAY', 'PLANT-2DAY', 'PLANT-3DAY']) assert.ok(!s4.rows.some(r => r.id !== id && r.description === base(id).description && r.amount === base(id).amount), `${id} replaces its original`);
    const cent = base('PLANT-CENT');
    assert.ok(s4.rows.some(r => r.id !== cent.id && r.date === cent.date && r.description === cent.description && Math.abs(r.amount - cent.amount - 0.01) < 1e-9));
  });

  test('CLI writes every scenario to disk with a README', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finfolio-gen-'));
    try {
      const scenarios = await getScenarios();
      const result = await writeScenarios(dir, scenarios);
      assert.equal(result.scenarios.length, 12);
      for (const sc of scenarios) {
        for (const f of sc.files) {
          const onDisk = await fs.readFile(path.join(dir, sc.id, f.name));
          assert.ok(onDisk.equals(f.bytes), `${sc.id}/${f.name} written byte-for-byte`);
        }
      }
      const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf-8');
      assert.match(readme, /## S4 — Near-duplicates/);
      assert.match(readme, /PLANT-1DAY/);
      // idempotent: running again replaces the tree
      await writeScenarios(dir, scenarios);
      assert.equal((await fs.readdir(dir)).length, 13);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
