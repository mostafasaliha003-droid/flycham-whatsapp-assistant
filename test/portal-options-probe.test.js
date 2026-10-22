'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openPassengerOptions } = require('../src/portal-options-probe');

test('opens only the authorized result step and waits for passenger form', async () => {
  const calls = [], listeners = new Map();
  const frame = {
    evaluate: async () => ({ trusted: true, newFlow: true, temporarySeatBlock: false }),
    locator: selector => ({ count: async () => 1, click: async () => calls.push(['click', selector]), waitFor: async () => calls.push(['wait', selector]) }),
  };
  const page = { on: (event, fn) => listeners.set(event, fn), removeListener: event => listeners.delete(event) };
  assert.equal(await openPassengerOptions(frame, page), true);
  assert.deepEqual(calls, [['click', 'button#btnBook:visible'], ['wait', '#btnContinue:visible']]);
  assert.equal(listeners.size, 0);
});

test('does not enter a modification flow or ambiguous result button', async () => {
  let clicked = false;
  for (const newFlow of [false, true]) {
    const frame = { evaluate: async () => ({ trusted: true, newFlow }), locator: () => ({ count: async () => 2, click: async () => { clicked = true; } }) };
    await assert.rejects(openPassengerOptions(frame, {}), /NOT_CONFIRMED|NOT_UNIQUE/);
  }
  assert.equal(clicked, false);
});
