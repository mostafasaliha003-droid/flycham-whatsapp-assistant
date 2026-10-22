'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { submitProbe } = require('../src/portal-search-probe');

function fixture({ wrongAirport = false, missingOneWay = false, missingOption = false } = {}) {
  const calls = [];
  const values = {};
  let optionReads = 0;
  const frame = {
    evaluate: async (fn, args) => {
      if (!args) return missingOneWay ? -1 : 0;
      if (args.pattern) { optionReads++; return missingOption ? null : args.id === 'selectedCurrency' ? 'AED' : 'observed-option'; }
      return true;
    },
    locator: selector => {
      const field = {
        fill: async value => { values[selector] = value; calls.push(['fill', selector]); },
        nth: () => field,
        check: async () => calls.push(['check', selector]),
        selectOption: async () => calls.push(['select', selector]),
        inputValue: async () => wrongAirport ? 'OTHER' : selector === '#fromAirport' ? 'SHJ' : 'DAM',
        click: async () => calls.push(['click', selector]),
        filter: () => field,
        first: () => field,
        waitFor: async () => {},
        count: async () => 1,
      };
      return field;
    },
  };
  return { frame, calls, values, optionReads: () => optionReads };
}
const config = { origin: 'SHJ', destination: 'DAM', departureDate: '11/11/2026' };

test('probe fills observed text passenger counts and clicks only the search control', async () => {
  const f = fixture();
  assert.equal((await submitProbe(f.frame, config)).submitted, true);
  assert.deepEqual([f.values['#adultCount'], f.values['#childCount'], f.values['#infantCount']], ['1', '0', '0']);
  assert.equal(f.optionReads(), 4);
  assert.ok(!f.calls.some(([action, selector]) => action === 'select' && /Count/.test(selector)));
  assert.ok(f.calls.some(([action, selector]) => action === 'click' && selector === 'input#btnSearch[type="button"]:visible'));
  assert.ok(!f.calls.some(([, selector]) => /btnBook|passenger|payment/i.test(selector)));
});

test('probe never searches if the airport, one-way control or supplier options are unconfirmed', async () => {
  for (const options of [{ wrongAirport: true }, { missingOneWay: true }, { missingOption: true }]) {
    const f = fixture(options);
    await assert.rejects(submitProbe(f.frame, config), /NOT_CONFIRMED/);
    assert.ok(!f.calls.some(([action, selector]) => action === 'click' && selector.includes('btnSearch')));
  }
});

test('probe rejects unsupported routes before interacting with the portal', async () => {
  const f = fixture();
  await assert.rejects(submitProbe(f.frame, { ...config, origin: 'OTHER' }), /UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});
