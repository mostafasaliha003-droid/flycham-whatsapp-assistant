'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { verificationFormAction } = require('../src/portal-verification-form');

function fixture({ duplicate = false, hiddenParent = false, disabled = false, foreign = false } = {}) {
  const events = [];
  let clicks = 0, value;
  class Input {}
  Object.defineProperty(Input.prototype, 'value', { set(next) { value = next; } });
  const form = {};
  const parent = { hidden: hiddenParent, parentElement: null };
  const input = Object.assign(new Input(), { tagName: 'INPUT', type: 'text', disabled, form, parentElement: parent, getClientRects: () => [1], focus() {}, dispatchEvent(event) { events.push(event.type); }, checkValidity: () => true });
  const button = { type: 'submit', form, parentElement: parent, getClientRects: () => [1], click() { clicks++; } };
  const view = {}; view.top = view;
  const context = { location: { origin: foreign ? 'https://other.example' : 'https://agents.airarabia.com' }, window: view, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } }, getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible' }), document: { querySelectorAll: selector => selector.includes('userOtp') ? (duplicate ? [input, input] : [input]) : [button] } };
  const call = options => vm.runInNewContext(`(${verificationFormAction.toString()})(options)`, { ...context, options });
  return { call, events, clicks: () => clicks, value: () => value };
}

test('operator submission uses the real form events exactly once without exposing the code', () => {
  const f = fixture();
  assert.equal(f.call({ operation: 'inspect' }).ready, true);
  assert.equal(f.clicks(), 0);
  const result = f.call({ operation: 'submit', code: '123456' });
  assert.equal(result.submitted, true);
  assert.equal(f.value(), '123456');
  assert.deepEqual(f.events, ['input', 'change']);
  assert.equal(f.clicks(), 1);
  assert.ok(!JSON.stringify(result).includes('123456'));
});

test('refuses ambiguous, hidden, disabled and foreign verification forms', () => {
  for (const config of [{ duplicate: true }, { hiddenParent: true }, { disabled: true }, { foreign: true }]) {
    const f = fixture(config);
    assert.equal(f.call({ operation: 'submit', code: '123456' }).ready, false);
    assert.equal(f.clicks(), 0);
    assert.equal(f.value(), undefined);
  }
});
