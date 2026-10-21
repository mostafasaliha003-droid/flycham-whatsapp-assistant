'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessage, resetSessions, parseDate, parsePassengerCount } = require('../src/conversation');

test('validates calendar dates and parses passenger counts', () => {
  assert.equal(parseDate('11-11-2026'), '2026-11-11');
  assert.equal(parseDate('31-02-2026'), null);
  assert.deepEqual(parsePassengerCount('بالغين 2 وأطفال 1 أعمار 8'), { adults: 2, children: 1, infants: 0, ages: [8] });
  assert.equal(parsePassengerCount('طفل واحد'), null);
});

test('collects required details over turns and never claims a fare was checked', () => {
  resetSessions();
  const first = handleMessage('customer-1', 'من دبي إلى دمشق، 11-11-2026 ذهاب فقط');
  assert.equal(first.complete, false);
  assert.match(first.reply, /بالغين والأطفال/);
  const second = handleMessage('customer-1', '2 بالغين');
  assert.equal(second.complete, true);
  assert.match(second.reply, /طلب التسعير/);
  assert.match(second.reply, /لا يتم حجز أو إصدار تذكرة تلقائيًا/);
});

test('round trip requires a return date', () => {
  resetSessions();
  const result = handleMessage('customer-2', 'من دبي إلى دمشق، 11-11-2026 ذهاب وعودة، بالغين 1');
  assert.equal(result.complete, false);
  assert.match(result.reply, /تاريخ العودة/);
});
