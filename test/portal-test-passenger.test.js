'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { continueWithTestPassenger } = require('../src/portal-test-passenger');

function fixture({ safe = true, profileSafe = true } = {}) {
  const calls = [];
  let scopeRead = false;
  const frame = {
    evaluate: async (fn, args) => {
      if (args?.pattern) return 'existing-supplier-option';
      if (!scopeRead) { scopeRead = true; return safe; }
      return profileSafe;
    },
    locator: selector => ({
      count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
      fill: async value => calls.push(['fill', selector, value]), press: async () => {},
      selectOption: async value => calls.push(['select', selector, value]),
      uncheck: async () => calls.push(['uncheck', selector]),
      click: async () => calls.push(['click', selector]),
    }),
    waitForFunction: async () => calls.push(['wait', 'ancillary-entry']),
  };
  return { frame, calls };
}

test('uses synthetic passenger data and only the ancillary lookup continuation', async () => {
  const f = fixture();
  await continueWithTestPassenger(f.frame);
  assert.ok(f.calls.some(([action, selector]) => action === 'uncheck' && selector.includes('chkUpdateCustProf')));
  assert.ok(f.calls.some(([action, selector, value]) => action === 'fill' && selector.includes('AdultFirstName') && value === 'TEST'));
  assert.deepEqual(f.calls.filter(([action]) => action === 'click'), [['click', 'button#btnContinue:visible']]);
  assert.ok(!f.calls.some(([, selector]) => /btnPHold|btnAnciContinue|Payment|Confirm|btnBook/.test(selector)));
});

test('refuses unknown scope or enabled profile saving before continuation', async () => {
  for (const config of [{ safe: false }, { profileSafe: false }]) {
    const f = fixture(config);
    await assert.rejects(continueWithTestPassenger(f.frame), /NOT_CONFIRMED|NOT_DISABLED/);
    assert.equal(f.calls.filter(([action]) => action === 'click').length, 0);
  }
});
