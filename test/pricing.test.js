'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { priceAirArabiaQuote } = require('../src/pricing');

function checkedFree(passengerCount = 1, segmentIds = ['outbound']) {
  return segmentIds.flatMap(segmentId => Array.from({ length: passengerCount }, (_, index) =>
    ['seat', 'meal'].map(type => ({
      type, passengerIndex: index + 1, segmentId, available: true,
      freeOptionAvailable: true, includedInBase: true, cost: '0.00'
    }))
  ).flat());
}
function makeQuote(overrides = {}) {
  const quote = { currency: 'AED', baseTotal: '695.01', passengerCount: 1, segmentIds: ['outbound'], ...overrides };
  return { ...quote, ancillaries: overrides.ancillaries ?? checkedFree(quote.passengerCount, quote.segmentIds) };
}
function paid(type, cost, includedInBase = false) {
  return { type, cost, includedInBase, passengerIndex: 1, segmentId: 'outbound', available: true, freeOptionAvailable: false };
}

test('adds only AED 25 when a seat and meal are verified free', () => {
  const price = priceAirArabiaQuote(makeQuote(), {});
  assert.equal(price.baseTotal, '695.01');
  assert.equal(price.ticketMargin, '25.00');
  assert.equal(price.ancillaryCostAdded, '0.00');
  assert.equal(price.seatMargin, '0.00');
  assert.equal(price.mealMargin, '0.00');
  assert.equal(price.totalMargin, '25.00');
  assert.equal(price.sellingTotal, '720.01');
});

test('adds paid seat cost plus AED 10 and paid meal cost plus AED 5', () => {
  const ancillaries = [paid('seat', '20.00'), paid('meal', '15.00')];
  const price = priceAirArabiaQuote(makeQuote({ ancillaries }), {});
  assert.equal(price.ancillaryCostAdded, '35.00');
  assert.equal(price.seatMargin, '10.00');
  assert.equal(price.mealMargin, '5.00');
  assert.equal(price.totalMargin, '40.00');
  assert.equal(price.sellingTotal, '770.01');
});

test('charges only for the service with no free option', () => {
  const free = checkedFree();
  assert.equal(priceAirArabiaQuote(makeQuote({ ancillaries: [paid('seat', '20'), free[1]] }), {}).sellingTotal, '750.01');
  assert.equal(priceAirArabiaQuote(makeQuote({ ancillaries: [free[0], paid('meal', '15')] }), {}).sellingTotal, '740.01');
});

test('does not add service costs twice when included in portal total', () => {
  const price = priceAirArabiaQuote(makeQuote({ baseTotal: '730.01', ancillaries: [paid('seat', '20', true), paid('meal', '15', true)] }), {});
  assert.equal(price.ancillaryCostAdded, '0.00');
  assert.equal(price.sellingTotal, '770.01');
});

test('charges ticket margin once per passenger for the full return itinerary', () => {
  const quote = makeQuote({ baseTotal: '4170.06', passengerCount: 3, segmentIds: ['outbound', 'return'] });
  const price = priceAirArabiaQuote(quote, {});
  assert.equal(price.ticketMargin, '75.00');
  assert.equal(price.sellingTotal, '4245.06');
  quote.ancillaries[0] = { ...quote.ancillaries[0], freeOptionAvailable: false, includedInBase: false, cost: '20' };
  quote.ancillaries[7] = { ...quote.ancillaries[7], freeOptionAvailable: false, includedInBase: false, cost: '15' };
  assert.equal(priceAirArabiaQuote(quote, {}).sellingTotal, '4295.06');
});

test('refuses a final price if any service or passenger/segment check is missing', () => {
  const quote = makeQuote();
  for (const ancillaries of [undefined, [], checkedFree().slice(0, 1), [...checkedFree(), checkedFree()[0]]]) {
    assert.throws(() => priceAirArabiaQuote({ ...quote, ancillaries }, {}));
  }
  for (const segmentIds of [undefined, [], ['outbound', 'outbound']]) {
    assert.throws(() => priceAirArabiaQuote({ ...quote, segmentIds }, {}));
  }
  assert.throws(() => priceAirArabiaQuote({ ...quote, passengerCount: 2 }, {}));
});

test('rejects unchecked availability, duplicate checks and paid choices while free exists', () => {
  const quote = makeQuote();
  const invalidSeats = [
    { ...quote.ancillaries[0], available: false },
    { ...quote.ancillaries[0], available: undefined },
    { ...quote.ancillaries[0], freeOptionAvailable: undefined },
    { ...quote.ancillaries[0], includedInBase: undefined },
    { ...quote.ancillaries[0], cost: '20' },
    { ...quote.ancillaries[0], freeOptionAvailable: false },
    { ...quote.ancillaries[0], passengerIndex: 2 },
    { ...quote.ancillaries[0], segmentId: 'return' },
    { ...quote.ancillaries[0], type: 'bag' }
  ];
  for (const seat of invalidSeats) assert.throws(() => priceAirArabiaQuote({ ...quote, ancillaries: [seat, quote.ancillaries[1]] }, {}));
  assert.throws(() => priceAirArabiaQuote({ ...quote, ancillaries: [quote.ancillaries[0], quote.ancillaries[0]] }, {}));
});

test('preserves fils precision and uses provider-specific settings', () => {
  const quote = makeQuote({ baseTotal: '0.01', ancillaries: [paid('seat', '0.01'), paid('meal', '0.01')] });
  assert.equal(priceAirArabiaQuote(quote, {}).sellingTotal, '40.03');
  assert.equal(priceAirArabiaQuote(makeQuote(), { AIR_ARABIA_MARGIN_AED: '25.00', QUOTE_MARGIN_VALUE: '999' }).sellingTotal, '720.01');
  assert.equal(priceAirArabiaQuote(makeQuote(), { AIR_ARABIA_MARGIN_AED: '17.50' }).sellingTotal, '712.51');
});

test('rejects invalid base totals, currencies, passenger counts and margins', () => {
  const quote = makeQuote();
  for (const baseTotal of [0, -1, undefined, null, NaN, Infinity, '', '695.001', '695,01']) assert.throws(() => priceAirArabiaQuote({ ...quote, baseTotal }, {}));
  for (const currency of ['USD', 'aed', undefined]) assert.throws(() => priceAirArabiaQuote({ ...quote, currency }, {}));
  for (const passengerCount of [0, -1, 1.5, '2', undefined, 10]) assert.throws(() => priceAirArabiaQuote({ ...quote, passengerCount }, {}));
  for (const key of ['AIR_ARABIA_MARGIN_AED', 'AIR_ARABIA_SEAT_MARGIN_AED', 'AIR_ARABIA_MEAL_MARGIN_AED']) {
    for (const value of ['', '-25', '25.001', 'abc']) assert.throws(() => priceAirArabiaQuote(quote, { [key]: value }));
  }
});

test('rejects arithmetic overflow in base, margins or ancillary costs', () => {
  const quote = makeQuote();
  assert.throws(() => priceAirArabiaQuote({ ...quote, baseTotal: '90071992547409.92' }, {}));
  assert.throws(() => priceAirArabiaQuote(quote, { AIR_ARABIA_MARGIN_AED: '90071992547409.91' }));
  assert.throws(() => priceAirArabiaQuote({ ...quote, ancillaries: [paid('seat', '90071992547409.91'), quote.ancillaries[1]] }, {}));
});
