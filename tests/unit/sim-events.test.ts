import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_CATALOG, createEvent, getEventTemplate, isActive, normalizeEvent, normalizeEvents } from '../../src/sim/events.js';

describe('sim/events', () => {
  test('catalog ids are unique and every template has fields', () => {
    const ids = EVENT_CATALOG.map(e => e.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of EVENT_CATALOG) assert.ok(t.fields.length > 0, t.id);
    assert.throws(() => getEventTemplate('nope'), /Unknown event template/);
  });

  test('createEvent applies template defaults then overrides', () => {
    const e = createEvent('job_loss', { startMonth: 3 });
    assert.equal(e.kind, 'income');
    assert.equal(e.startMonth, 3);
    assert.equal(e.durationMonths, 6);
    assert.equal((e as any).percent, -1);
    assert.equal(e.template, 'job_loss');
    assert.equal(e.label, 'Job loss');

    const custom = createEvent('child', { label: 'Twins', amount: 1800, id: 'kids' });
    assert.equal(custom.id, 'kids');
    assert.equal(custom.label, 'Twins');
    assert.equal((custom as any).amount, 1800);
    assert.equal(custom.durationMonths, 216);

    const a = createEvent('raise');
    const b = createEvent('raise');
    assert.notEqual(a.id, b.id, 'generated ids are unique');
  });

  test('every catalog template instantiates without error', () => {
    for (const t of EVENT_CATALOG) {
      const e = createEvent(t.id);
      assert.equal(e.kind, t.kind);
    }
  });

  test('isActive respects start and duration', () => {
    const permanent = { startMonth: 5 };
    assert.equal(isActive(permanent, 4), false);
    assert.equal(isActive(permanent, 5), true);
    assert.equal(isActive(permanent, 500), true);
    const temp = { startMonth: 5, durationMonths: 3 };
    assert.equal(isActive(temp, 7), true);
    assert.equal(isActive(temp, 8), false);
  });

  test('normalizeEvent coerces and validates', () => {
    assert.throws(() => normalizeEvent(null), /must be an object/);
    assert.throws(() => normalizeEvent({ kind: 'bogus' }), /unknown kind/);
    assert.throws(() => normalizeEvent({ kind: 'income' }), /needs percent or amount/);
    assert.throws(() => normalizeEvent({ kind: 'contribution', label: 'C' }), /needs percent or amount/);
    assert.throws(() => normalizeEvents({} as any), /must be an array/);
    assert.deepEqual(normalizeEvents(undefined), []);

    const inc = normalizeEvent({ kind: 'income', percent: -5, startMonth: -2, durationMonths: 0.4 });
    assert.equal((inc as any).percent, -1, 'percent floored at −100 %');
    assert.equal(inc.startMonth, 0);
    assert.equal(inc.durationMonths, 1);
    assert.equal(inc.id, 'event-1');

    const prop = normalizeEvent({ kind: 'property', price: 100000, downPayment: 150000, durationMonths: 5 });
    assert.equal((prop as any).downPayment, 100000, 'down payment capped at price');
    assert.equal(prop.durationMonths, undefined, 'one-shot events have no duration');
    assert.equal((prop as any).mortgageRate, 0.05);

    const oneOff = normalizeEvent({ kind: 'one_off', amount: -2000, durationMonths: 12 });
    assert.equal(oneOff.durationMonths, undefined);
    const blank = normalizeEvent({ kind: 'expense', amount: 10, durationMonths: '' });
    assert.equal(blank.durationMonths, undefined, 'empty string from a form means permanent');
  });
});
