import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_MAX, asciiTable, formatDelta, formatValue, main, readOptions, toAscii } from '../../src/testing/compare-cli.js';

describe('compare CLI (npm run test:compare)', () => {
  test('ASCII helpers', () => {
    assert.equal(toAscii('a — b – c − d … “e” ’f’ Émilie'), 'a - b - c - d ... "e" \'f\' Emilie');
    assert.equal(formatValue(1234.5, 'money'), '1,234.50');
    assert.equal(formatValue(-0.1234, 'percent'), '-12.3%');
    assert.equal(formatValue('2043-05', 'month'), 'May 2043');
    assert.equal(formatValue(null, 'money'), '-');
    assert.equal(formatValue(1, 'bool'), 'yes');
    assert.equal(formatDelta({ delta: 0.07, unit: 'percent' } as any), '+7.0 pp');
    assert.equal(formatDelta({ delta: -83, unit: 'month' } as any), '-83 mo');
    assert.equal(formatDelta({ delta: null, unit: 'money' } as any), '-');
    const t = asciiTable(['A', 'Bee'], [['x', '1'], ['yy', '22']], ['l', 'r']);
    assert.equal(t, ['+----+-----+', '| A  | Bee |', '+----+-----+', '| x  |   1 |', '| yy |  22 |', '+----+-----+'].join('\n'));
  });

  test('options: argv flags or the npm_config_* variables npm sets for `npm run test:compare --brief --mine fin`', () => {
    assert.deepEqual(readOptions(['--brief', '--mine', 'fin'], {}), { brief: true, spending: false, mine: 'fin' });
    assert.deepEqual(readOptions(['--mine=penny', '--spending'], {}), { brief: false, spending: true, mine: 'penny' });
    assert.deepEqual(readOptions([], { npm_config_brief: 'true', npm_config_mine: 'penny' }), { brief: true, spending: false, mine: 'penny' });
    assert.deepEqual(readOptions([], { npm_config_mine: 'true' }), { brief: false, spending: false, mine: null }, 'a bare --mine is ignored');
    assert.throws(() => readOptions(['--mine', 'bob'], {}), /--mine must be fin or penny/);
  });

  test('prints six comparisons (fin and penny vs the other three), ASCII only', async () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (s: string) => { lines.push(s); };
    let text: string;
    let full: string;
    try {
      text = await main(['--brief']);
      full = await main(['--mine', 'fin']);
    } finally { console.log = log; }
    assert.match(text, /^fin vs Penny: /m);
    assert.match(text, /^fin vs Anonymous A: /m);
    assert.match(text, /^penny vs Fin: /m);
    assert.match(text, /^penny vs Anonymous B: /m);
    assert.ok(!/[^\x20-\x7e\n]/.test(text), 'ASCII only');
    assert.ok(!/\| Group/.test(text), '--brief skips the tables');
    const briefLines = text.split('\n').filter(Boolean);
    assert.equal(briefLines.length, 6, 'one packed line per comparison');
    for (const l of briefLines) assert.ok(l.length <= BRIEF_MAX, `${l.length} chars: ${l}`);
    assert.match(briefLines[0], /^fin vs Penny: 21-3 \(1 tie, 25 scored\) \| NW 105\.9k v 26\.6k, save 44% v 37%, inv 17% v 7%, cash 9\.2 v 3\.5mo, debt 1% v 31%, FI May'43@56 v Apr'50@57, streak 10 v 26, badges 6 v 5, pts 995 v 780 \| You save/);
    assert.match(briefLines[1], /FI May'43@56 v none/);
    assert.equal((full.match(/^Score: /gm) || []).length, 3);
    assert.match(full, /\| position\s+\| Net worth/);
    assert.match(full, /^fin vs Penny /m);
    assert.match(full, /^fin vs Anonymous A /m);
    assert.match(full, /^fin vs Anonymous B /m);
    assert.ok(!/^penny vs/m.test(full), '--mine fin leaves penny\'s comparisons out');
  });
});
