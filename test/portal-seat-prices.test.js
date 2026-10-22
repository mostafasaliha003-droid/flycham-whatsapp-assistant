'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { scanSeatPrices, parseSeatPrice, summarizeSeats, seatRequestPolicy } = require('../src/portal-seat-prices');

test('reads actual tooltip prices and rejects unknown, mismatched or malformed prices', () => {
  assert.deepEqual(parseSeatPrice('25.00 AED', 'AED'), { amount: 25, currency: 'AED' });
  assert.deepEqual(parseSeatPrice('AED 1,250.50', 'AED'), { amount: 1250.5, currency: 'AED' });
  assert.deepEqual(parseSeatPrice('Free', 'AED'), { amount: 0, currency: 'AED' });
  assert.deepEqual(parseSeatPrice('0.00 AED', 'AED'), { amount: 0, currency: 'AED' });
  for (const value of ['', 'Economy', 'USD 10', '10 AED 99', '-10', '10,50', 'NaN']) assert.equal(parseSeatPrice(value, 'AED'), null);
  assert.equal(parseSeatPrice('Free', null), null);
});

test('a partial scan cannot claim the minimum; conditional seats are separate', () => {
  const seats = [
    { seat: '1A', conditional: true, price: { amount: 0, currency: 'AED' } },
    { seat: '10A', conditional: false, price: { amount: 25, currency: 'AED' } },
    { seat: '11A', conditional: false, price: { amount: 10, currency: 'AED' } },
  ];
  assert.equal(summarizeSeats(seats, 4).cheapestOrdinarySeat, null);
  assert.equal(summarizeSeats([{ seat: '1A', price: null }], 1).complete, false);
  assert.equal(summarizeSeats([], 0).complete, false);
  assert.deepEqual(summarizeSeats(seats, 3).cheapestOrdinarySeat, { seat: '11A', amount: 10, currency: 'AED' });
});

// Execute the page-evaluation functions in a DOM contract fixture, including
// stale/missing tooltip behavior. Only navigation controls have click handlers.
function fixture({ wrongPassenger = false, failedSeat = null, extraVacant = false } = {}) {
  const calls = [], events = [];
  const segmentSeats = [
    [{ seatNumber: '1A', seatCharge: '50.00 AED' }, { seatNumber: '10B', seatCharge: 'Free' }],
    [{ seatNumber: '1A', seatCharge: '25.00 AED' }, { seatNumber: '12C', seatCharge: '10.00 AED' }],
  ];
  const elements = {};
  const visible = { getClientRects: () => [1], style: {} };
  elements.spnSeatInfo = { ...visible };
  elements.spnTTSeatNo = { textContent: '' };
  elements.spnTTSeatChg = { textContent: '' };
  const segments = [0, 1].map(index => ({ id: 'tdAnciSeg_' + index, classList: { contains: name => name === 'anciSeatAvail' } }));
  const sandbox = {
    location: { origin: 'https://agents.airarabia.com' },
    UI_commonSystem: { strPGMode: '' }, DATA_ResPro: { initialParams: { baseCurrencyCode: 'AED' } },
    jsonPaxAdults: [{ displayAdultFirstName: wrongPassenger ? 'OTHER' : 'TEST', displayAdultLastName: 'QUOTE' }], jsonPaxInfants: [],
    jsAnciSeg: [{ flightNumber: 'G9433' }, { flightNumber: 'G9434' }],
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelectorAll: () => segments, getElementById: id => elements[id] },
    UI_tabAnci: { seatMapAvailable: true, currAnciSrv: 'BAGGAGES', currSegRow: 0, dataStatus: {},
      currFltRefNo: 'segment0', seatRefMap: {}, jsonFareQuoteSummary: { currency: 'AED' }, getSelectedLogicalCabinClass: () => 'Y' },
  };
  function setSegment(index) {
    const ui = sandbox.UI_tabAnci;
    ui.currSegRow = index; ui.currFltRefNo = 'segment' + index;
    const seats = {};
    for (const seat of segmentSeats[index]) {
      seats[seat.seatNumber] = { ...seat, avail: 'VAC', lccCode: 'Y' };
      elements['tdSeat_' + seat.seatNumber] = { ...visible, querySelector: () => ({}) };
    }
    if (extraVacant) seats['99A'] = { seatNumber: '99A', avail: 'VAC', lccCode: 'Y' };
    ui.seatRefMap[ui.currFltRefNo] = { seats };
  }
  const evaluate = (fn, arg) => vm.runInNewContext('(' + fn.toString() + ')(arg)', { ...sandbox, arg });
  const page = {
    route: async (pattern, fn) => { page.guard = fn; },
    unroute: async () => { page.removed = true; },
  };
  const frame = {
    evaluate: async (fn, arg) => JSON.parse(JSON.stringify(evaluate(fn, arg))),
    waitForFunction: async (fn, arg) => { assert.equal(evaluate(fn, arg), true); },
    locator: selector => ({
      count: async () => selector.includes('divAnciPref') ? 0 : 1,
      waitFor: async () => {},
      click: async () => {
        calls.push(['click', selector]);
        if (selector === '#imgTab_2:visible') { sandbox.UI_tabAnci.currAnciSrv = 'SEAT'; sandbox.UI_tabAnci.selectedAnciTypeGlobal = 'SEAT_MAP'; sandbox.UI_tabAnci.dataStatus.seat = true; setSegment(0); }
        else if (/^#tdAnciSeg_\d+$/.test(selector)) setSegment(Number(selector.split('_').pop()));
        else assert.fail('Unexpected click: ' + selector);
      },
      hover: async () => {
        calls.push(['hover', selector]);
        const seat = selector.match(/#tdSeat_(\d+[A-K])/)[1];
        if (failedSeat === seat) throw new Error('missing tooltip');
        elements.spnTTSeatNo.textContent = seat;
        elements.spnTTSeatChg.textContent = segmentSeats[sandbox.UI_tabAnci.currSegRow].find(s => s.seatNumber === seat).seatCharge;
      },
      textContent: async () => elements.spnTTSeatChg.textContent,
    }),
  };
  return { frame, page, calls, events, report: event => events.push(event) };
}

test('hovers every seat in both legs and never clicks seats or payment/continue', async () => {
  const f = fixture();
  const result = await scanSeatPrices(f.frame, f.page, f.report);
  assert.equal(result.complete, true);
  assert.equal(result.customerQuoteReady, false);
  assert.equal(f.calls.filter(c => c[0] === 'hover').length, 4);
  assert.deepEqual(result.segments.map(s => s.cheapestOrdinarySeat.amount), [0, 10]);
  assert.equal(result.segments[0].freeSeats, 1);
  assert.ok(f.calls.filter(c => c[0] === 'click').every(c => /imgTab_2|tdAnciSeg_/.test(c[1])));
  assert.equal(f.page.removed, true);
  assert.ok(!f.events.join('').includes('TEST'));
  let aborted = false;
  await f.page.guard({ request: () => ({ url: () => 'https://agents.airarabia.com/xbe/private/blockSeat.action', method: () => 'POST' }), abort: async () => { aborted = true; }, continue: async () => assert.fail('mutation allowed') });
  assert.equal(aborted, true);
});

test('missing hover prices and missing DOM coverage cannot become a verified quote', async () => {
  for (const options of [{ failedSeat: '1A' }, { extraVacant: true }]) {
    const f = fixture(options);
    const result = await scanSeatPrices(f.frame, f.page, f.report);
    assert.equal(result.complete, false);
    assert.ok(result.segments.every(s => s.cheapestOrdinarySeat === null));
    assert.equal(f.page.removed, true);
  }
});

test('real passenger data is refused before any interaction', async () => {
  const f = fixture({ wrongPassenger: true });
  await assert.rejects(scanSeatPrices(f.frame, f.page, f.report), /SCOPE_NOT_CONFIRMED/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.page.guard, undefined);
});

test('allows supplier display assets but prevents unreviewed action requests', () => {
  const request = (url, method, kind) => ({ url: () => url, method: () => method, resourceType: () => kind });
  assert.equal(seatRequestPolicy(request('https://static.airarabia.com/images/seat.png', 'GET', 'image')).allowed, true);
  const cosmetic = seatRequestPolicy(request('https://other.example/seat.png?private=value', 'GET', 'image'));
  assert.equal(cosmetic.allowed, false); assert.equal(cosmetic.critical, false);
  const action = seatRequestPolicy(request('https://agents.airarabia.com/xbe/private/blockSeat.action?private=value', 'POST', 'xhr'));
  assert.equal(action.allowed, false); assert.equal(action.critical, true);
  assert.ok(!JSON.stringify(action).includes('private'));
  assert.equal(seatRequestPolicy(request('https://agents.airarabia.com/xbe/private/seatMap.action', 'POST', 'xhr')).allowed, true);
  assert.equal(seatRequestPolicy(request('https://other.example/code.js', 'GET', 'script')).critical, true);
});
