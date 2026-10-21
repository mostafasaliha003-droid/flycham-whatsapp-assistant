'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AirArabiaPortalAdapter, AIRPORTS } = require('../src/airarabia-worker');

test('keepalive adapter permits only the explicitly configured verified airport codes', () => {
  assert.deepEqual(AIRPORTS, { SHJ: 'SHJ - Sharjah', DAM: 'DAM - Damascus' });
  assert.throws(() => new AirArabiaPortalAdapter({}, {
    username: 'x', password: 'y', origin: 'DXB', destination: 'DAM',
  }), /PORTAL_CONFIGURATION_UNSUPPORTED_ROUTE/);
  const adapter = new AirArabiaPortalAdapter({}, {
    username: 'x', password: 'y', origin: 'SHJ', destination: 'DAM',
  });
  assert.equal(adapter.origin, 'SHJ');
  assert.equal(adapter.destination, 'DAM');
});

const { PortalError, safeFailureCode, run } = require('../src/airarabia-worker');

function fakePage({ captcha = false, navigationError, confirmError } = {}) {
  const calls = [];
  const signOut = {
    count: async () => 1, isVisible: async () => true,
    waitFor: async options => { calls.push(['waitForSignOut', options]); if (confirmError) throw confirmError; },
  };
  return {
    calls,
    setDefaultTimeout() {},
    goto: async (url, options) => { calls.push(['goto', options]); if (navigationError) throw navigationError; return { status: () => 200 }; },
    locator: selector => ({
      waitFor: async () => {},
      fill: async () => { calls.push(['fill', selector]); },
      click: async () => { calls.push(['click', selector]); },
      isVisible: async () => selector === '#captcha_txt' && captcha,
      innerText: async () => '',
    }),
    frameLocator: () => ({ getByText: () => signOut }),
  };
}
function adapterFor(page, report) {
  return new AirArabiaPortalAdapter(page, { username: 'test-user', password: 'secret-test-only', origin: 'SHJ', destination: 'DAM', report });
}

test('login waits for the document and a visible authenticated control, not third-party page load', async () => {
  const page = fakePage();
  const codes = [];
  await adapterFor(page, code => codes.push(code)).signIn();
  assert.equal(page.calls[0][1].waitUntil, 'domcontentloaded');
  assert.ok(page.calls.some(([op]) => op === 'waitForSignOut'));
  assert.equal(codes.at(-1), 'PORTAL_AUTHENTICATED');
});

test('a visible verification challenge stops before credentials are filled or submitted', async () => {
  const page = fakePage({ captcha: true });
  await assert.rejects(adapterFor(page).signIn(), /MANUAL_VERIFICATION/);
  assert.equal(page.calls.filter(([op]) => op === 'fill' || op === 'click').length, 0);
});

test('an unconfirmed login does not declare authentication successful', async () => {
  const error = Object.assign(new Error('private page and user data'), { name: 'TimeoutError' });
  const page = fakePage({ confirmError: error });
  const codes = [];
  await assert.rejects(adapterFor(page, code => codes.push(code)).signIn(), /LOGIN_NOT_CONFIRMED/);
  assert.ok(!codes.includes('PORTAL_AUTHENTICATED'));
});

test('failure diagnostics never include raw errors, URLs or secret values', () => {
  const error = Object.assign(new Error('password=secret-test-only https://private.example/?token=private'), { name: 'TimeoutError' });
  assert.equal(safeFailureCode(error, 'OPEN_LOGIN_PAGE'), 'PORTAL_OPEN_LOGIN_PAGE_TIMEOUT');
  assert.equal(safeFailureCode(new Error('net::ERR_CONNECTION_RESET private')), 'PORTAL_SESSION_NETWORK');
  assert.equal(safeFailureCode(new PortalError('LOGIN_CONFIRM', 'MANUAL_VERIFICATION')), 'PORTAL_LOGIN_CONFIRM_MANUAL_VERIFICATION');
});

test('startup failure closes the browser and parks without repeating login or exiting', async t => {
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  Object.assign(process.env, { AIR_ARABIA_KEEPALIVE_ENABLED: 'true', AIR_ARABIA_AGENT_USERNAME: 'test-user', AIR_ARABIA_AGENT_PASSWORD: 'secret-test-only' });
  const error = Object.assign(new Error('private request failed'), { name: 'TimeoutError' });
  const page = fakePage({ navigationError: error });
  let opened = 0, closed = 0, parked = 0;
  const logs = [];
  await run({
    launch: async () => { opened++; return { newPage: async () => page, close: async () => { closed++; } }; },
    park: async () => { parked++; }, log: { log: x => logs.push(x), error: x => logs.push(x) },
  });
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(parked, 1);
  assert.equal(page.calls.filter(([op]) => op === 'goto').length, 1);
  assert.ok(logs.includes('PORTAL_OPEN_LOGIN_PAGE_TIMEOUT'));
  assert.ok(logs.includes('PORTAL_BLOCKED_OPERATOR_REVIEW_NO_AUTOMATIC_RETRY'));
  assert.ok(!logs.join(' ').includes('secret-test-only'));
});
