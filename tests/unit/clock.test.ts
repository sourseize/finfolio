import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { now, today, nowIso, setClock, isClockFrozen, getClockOverride } from '../../src/util/clock.js';

describe('clock', () => {
  afterEach(() => {
    setClock(null);
    delete process.env.FINFOLIO_NOW;
  });

  test('uses the system clock by default', () => {
    const before = Date.now();
    const t = now().getTime();
    const after = Date.now();
    assert.ok(t >= before && t <= after);
    assert.equal(isClockFrozen(), false);
  });

  test('honours FINFOLIO_NOW', () => {
    process.env.FINFOLIO_NOW = '2026-10-25';
    assert.equal(today(), '2026-10-25');
    assert.equal(nowIso(), '2026-10-25T00:00:00.000Z');
    assert.equal(isClockFrozen(), true);
  });

  test('setClock overrides FINFOLIO_NOW', () => {
    process.env.FINFOLIO_NOW = '2020-01-01';
    setClock('2026-10-25T12:00:00Z');
    assert.equal(today(), '2026-10-25');
    setClock(null);
    assert.equal(today(), '2020-01-01');
  });

  test('returns a fresh Date instance each call (no shared mutation)', () => {
    setClock('2026-10-25T12:00:00Z');
    const a = now();
    a.setFullYear(1999);
    assert.equal(now().getFullYear(), 2026);
  });

  test('getClockOverride supports save/restore', () => {
    assert.equal(getClockOverride(), null);
    setClock('2026-10-25T12:00:00Z');
    const saved = getClockOverride();
    setClock('2030-01-01');
    assert.equal(today(), '2030-01-01');
    setClock(saved);
    assert.equal(today(), '2026-10-25');
  });

  test('rejects an invalid FINFOLIO_NOW', () => {
    process.env.FINFOLIO_NOW = 'not-a-date';
    assert.throws(() => now(), /not a valid date/);
  });
});
