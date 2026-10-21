'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAirArabiaQuote } = require('../src/selection');
const option = (id, cost, extra = {}) => ({ id, cost, available: true, eligible: true, includedInBase: false, ...extra });
function fixture() {
  return { currency: 'AED', baseTotal: '695.01', passengerCount: 1, segmentIds: ['out'], allChargesChecked: true, finalPortalTotal: '695.01',
    catalogs: [
      { type: 'seat', passengerIndex: 1, segmentId: 'out', allOptionsChecked: true,
        options: [option('1A', '30', { seatNumber: '1A', features: ['window'] }), option('12B', '0', { seatNumber: '12B', features: ['middle'] })] },
      { type: 'meal', passengerIndex: 1, segmentId: 'out', allOptionsChecked: true,
        options: [option('none', '0', { providesService: false }), option('sandwich', '0', { providesService: true }), option('hot', '25', { providesService: true })] },
      { type: 'baggage', passengerIndex: 1, segmentId: 'out', allOptionsChecked: true,
        options: [option('30kg', '80', { checkedWeightKg: 30, handWeightKg: 10 }), option('20kg', '0', { checkedWeightKg: 20, handWeightKg: 10 })] }
    ] };
}
test('chooses free services anywhere in complete catalogs and reports all baggage weights', () => {
  const price = buildAirArabiaQuote(fixture(), {});
  assert.equal(price.sellingTotal, '720.01');
  assert.equal(price.selectedServices.find(s => s.type === 'seat').optionId, '12B');
  assert.equal(price.selectedServices.find(s => s.type === 'meal').optionId, 'sandwich');
  assert.deepEqual(price.baggageOptions[0].options.map(o => o.checkedWeightKg), [20, 30]);
  assert.equal(price.baggageOptions[0].selectedId, '20kg');
});
test('chooses cheapest paid seat, actual food and baggage if free service is absent', () => {
  const q = fixture();
  q.catalogs[0].options[1].cost = '20';
  q.catalogs[1].options[1].cost = '15';
  q.catalogs[2].options[1].cost = '40';
  q.finalPortalTotal = '770.01';
  const p = buildAirArabiaQuote(q, {});
  assert.equal(p.selectedServices.find(s => s.type === 'seat').optionId, '12B');
  assert.equal(p.selectedServices.find(s => s.type === 'meal').optionId, 'sandwich');
  assert.equal(p.baggageCostAdded, '40.00');
  assert.equal(p.sellingTotal, '810.01');
});
test('honors requested window or exact seat only when explicitly requested, with AED 10 markup', () => {
  for (const selection of [{ features: ['window'] }, { seatNumber: '1A' }]) {
    const q = fixture();
    q.seatRequests = [{ passengerIndex: 1, segmentId: 'out', requestedByCustomer: true, ...selection }];
    q.finalPortalTotal = '725.01';
    const p = buildAirArabiaQuote(q, {});
    assert.equal(p.sellingTotal, '760.01');
    assert.equal(p.seatMargin, '10.00');
    assert.equal(p.selectedServices.find(s => s.type === 'seat').optionId, '1A');
  }
  const q = fixture();
  q.seatRequests = [{ passengerIndex: 1, segmentId: 'out', seatNumber: '99A', requestedByCustomer: true }];
  assert.throws(() => buildAirArabiaQuote(q, {}));
  q.seatRequests[0].seatNumber = '1A';
  q.seatRequests[0].requestedByCustomer = false;
  assert.throws(() => buildAirArabiaQuote(q, {}));
});
test('skips unavailable/ineligible options and never calls no-meal free food', () => {
  const q = fixture();
  q.catalogs[0].options[1].available = false;
  q.catalogs[1].options[1].eligible = false;
  q.finalPortalTotal = '750.01';
  assert.equal(buildAirArabiaQuote(q, {}).sellingTotal, '790.01');
  q.catalogs[1].options[2].available = false;
  assert.throws(() => buildAirArabiaQuote(q, {}));
});
test('blocks incomplete maps, unknown weights, uncovered segments and final hidden fees', () => {
  const mutations = [
    q => { q.catalogs[0].allOptionsChecked = false; },
    q => { delete q.catalogs[2].options[0].handWeightKg; },
    q => { q.catalogs.pop(); },
    q => { q.catalogs[2] = q.catalogs[1]; },
    q => { q.segmentIds.push('return'); },
    q => { q.finalPortalTotal = '700.01'; },
    q => { delete q.finalPortalTotal; },
    q => { q.allChargesChecked = false; }
  ];
  for (const mutate of mutations) { const q = fixture(); mutate(q); assert.throws(() => buildAirArabiaQuote(q, {})); }
});
test('allocates unique seats and handles explicit seat requests before default allocations', () => {
  const q = fixture();
  q.passengerCount = 2;
  q.baseTotal = q.finalPortalTotal = '1390.02';
  q.catalogs = q.catalogs.flatMap(c => [c, structuredClone({ ...c, passengerIndex: 2 })]);
  for (const c of q.catalogs.filter(c => c.type === 'seat')) c.options.push(option('13C', '0', { seatNumber: '13C', features: ['aisle'] }));
  q.seatRequests = [{ passengerIndex: 2, segmentId: 'out', requestedByCustomer: true, seatNumber: '12B' }];
  const p = buildAirArabiaQuote(q, {});
  const seats = p.selectedServices.filter(s => s.type === 'seat');
  assert.equal(seats.find(s => s.passengerIndex === 2).optionId, '12B');
  assert.equal(seats.find(s => s.passengerIndex === 1).optionId, '13C');
  assert.equal(p.sellingTotal, '1450.02');
});

test('a specifically requested seat carries AED 10 even when its supplier cost is zero', () => {
  const q = fixture();
  q.seatRequests = [{ passengerIndex: 1, segmentId: 'out', requestedByCustomer: true, seatNumber: '12B' }];
  assert.equal(buildAirArabiaQuote(q, {}).sellingTotal, '730.01');
});
