'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { priceAirArabiaQuote } = require('../src/pricing');

const quote = { currency: 'AED', baseTotal: '695.01', passengerCount: 1 };

test('adds the agreed AED 25 to the exact portal total', () => {
  assert.deepEqual(priceAirArabiaQuote(quote, {}), {
    provider: 'airarabia', currency: 'AED', passengerCount: 1,
    baseTotal: '695.01', marginPerPassenger: '25.00',
    totalMargin: '25.00', sellingTotal: '720.01'
  });
});

test('charges once per passenger on the complete itinerary total', () => {
  const family = priceAirArabiaQuote({ ...quote, baseTotal: '2085.03', passengerCount: 3 }, {});
  assert.equal(family.totalMargin, '75.00');
  assert.equal(family.sellingTotal, '2160.03');
  // A combined outbound-and-return total still gets one margin per passenger.
  assert.equal(priceAirArabiaQuote({ ...quote, baseTotal: '1390.02' }, {}).sellingTotal, '1415.02');
});

test('preserves decimal precision and allows an explicit provider-specific setting', () => {
  assert.equal(priceAirArabiaQuote({ ...quote, baseTotal: '0.01' }, {}).sellingTotal, '25.01');
  assert.equal(priceAirArabiaQuote(quote, { AIR_ARABIA_MARGIN_AED: '25.00', QUOTE_MARGIN_VALUE: '999' }).sellingTotal, '720.01');
  assert.equal(priceAirArabiaQuote(quote, { AIR_ARABIA_MARGIN_AED: '17.50' }).sellingTotal, '712.51');
});

test('rejects zero, incomplete, malformed or non-AED quotes', () => {
  for (const baseTotal of [0, -1, undefined, null, NaN, Infinity, '', '695.001', '695,01', 'AED 695.01']) {
    assert.throws(() => priceAirArabiaQuote({ ...quote, baseTotal }, {}));
  }
  for (const currency of ['USD', 'aed', undefined]) {
    assert.throws(() => priceAirArabiaQuote({ ...quote, currency }, {}));
  }
});

test('rejects invalid passenger counts and invalid margin settings', () => {
  for (const passengerCount of [0, -1, 1.5, '2', undefined, 10]) {
    assert.throws(() => priceAirArabiaQuote({ ...quote, passengerCount }, {}));
  }
  for (const margin of ['', '-25', '25.001', 'abc', 'Infinity']) {
    assert.throws(() => priceAirArabiaQuote(quote, { AIR_ARABIA_MARGIN_AED: margin }));
  }
});

test('rejects arithmetic overflow', () => {
  assert.throws(() => priceAirArabiaQuote({ ...quote, baseTotal: '90071992547409.92' }, {}));
  assert.throws(() => priceAirArabiaQuote(quote, { AIR_ARABIA_MARGIN_AED: '90071992547409.91' }));
});
