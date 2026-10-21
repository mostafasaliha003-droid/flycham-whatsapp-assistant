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

function fakePage({ captcha = false, navigationError, confirmError, popup = null } = {}) {
  const calls = [];
  const signOut = {
    count: async () => 1, isVisible: async () => !confirmError,
    first() { return this; },
    nth() { return this; },
    waitFor: async options => { calls.push(['waitForSignOut', options]); if (confirmError) throw confirmError; },
  };
  const frame = { url: () => 'https://agents.airarabia.com/xbe/private/showTop', getByText: () => signOut };
  return {
    calls,
    frames: () => [frame],
    setDefaultTimeout() {},
    waitForEvent: async () => popup,
    waitForLoadState: async () => {},
    url: () => 'https://agents.airarabia.com/xbe/public/showLogin.action',
    goto: async (url, options) => { calls.push(['goto', options, url]); if (navigationError) throw navigationError; return { status: () => 200 }; },
    locator: selector => ({
      waitFor: async () => {},
      fill: async () => { calls.push(['fill', selector]); },
      click: async () => { calls.push(['click', selector]); },
      isVisible: async () => selector === '#captcha_txt' && captcha,
      innerText: async () => 'hidden script says captcha and looked like a bot',
      textContent: async () => '',
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
  assert.equal(await adapterFor(page).isAuthenticated(), true);
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
  const adapter = adapterFor(page, code => codes.push(code));
  adapter.waitForAuthentication = () => adapter.isAuthenticated();
  await assert.rejects(adapter.signIn(), /LOGIN_NOT_CONFIRMED/);
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


test('follows the supplier login popup rather than filling the hidden launcher', async () => {
  const popup = fakePage();
  const launcher = fakePage({ popup });
  const codes = [];
  const adapter = adapterFor(launcher, code => codes.push(code));
  await adapter.signIn();
  assert.equal(adapter.page, popup);
  assert.equal(launcher.calls.filter(([op]) => op === 'fill' || op === 'click').length, 0);
  assert.equal(popup.calls.filter(([op]) => op === 'fill').length, 2);
  assert.ok(codes.includes('PORTAL_LOGIN_WINDOW_SELECTED'));
  assert.ok(codes.includes('PORTAL_AUTHENTICATED'));
});

test('refuses an unexpected popup origin before entering any credentials', async () => {
  const popup = fakePage();
  popup.url = () => 'https://untrusted.example/login';
  await assert.rejects(adapterFor(fakePage({ popup })).signIn(), /PORTAL_OPEN_LOGIN_PAGE_UNEXPECTED/);
  assert.equal(popup.calls.filter(([op]) => op === 'fill' || op === 'click').length, 0);
});


test('recognizes authentication in a legacy same-origin frame with both navigation controls', async () => {
  const page = fakePage();
  page.frameLocator = () => { throw new Error('literal iframe selector cannot match a frameset'); };
  assert.equal(await adapterFor(page).isAuthenticated(), true);
});

test('authentication rejects partial navigation and foreign-origin frames', async () => {
  const control = visible => ({ first() { return this; }, nth() { return this; }, count: async () => 1, isVisible: async () => visible });
  const page = fakePage();
  page.frames = () => [{ url: () => 'https://agents.airarabia.com/xbe/private/showTop', getByText: pattern => control(pattern.test('Sign Out')) }];
  assert.equal(await adapterFor(page).isAuthenticated(), false);
  page.frames = () => [{ url: () => 'https://other.example/xbe/private/showTop', getByText: () => control(true) }];
  assert.equal(await adapterFor(page).isAuthenticated(), false);
});


test('finds the authenticated portal when login leaves its handler in an older window', async () => {
  const handler = fakePage({ confirmError: new Error('no navigation in handler') });
  const portal = fakePage();
  handler.context = () => ({ pages: () => [handler, portal] });
  const adapter = adapterFor(handler);
  assert.equal(await adapter.isAuthenticated(), true);
  assert.equal(adapter.page, portal);
});


test('starts with the protected portal route to initialize the supplier saved request', async () => {
  const page = fakePage();
  await adapterFor(page).signIn();
  const navigation = page.calls.find(([op]) => op === 'goto');
  assert.equal(navigation[2], 'https://agents.airarabia.com/xbe/private/showXBEMain.action');
  assert.ok(!navigation[2].includes('/public/showLogin.action'));
});


test('recognizes named image controls split across header and menu frames', async () => {
  const control = visible => ({ count: async () => visible ? 1 : 0, nth() { return this; }, isVisible: async () => visible });
  const frame = label => ({
    url: () => 'https://agents.airarabia.com/xbe/private/navigation',
    getByRole: (role, { name }) => control(role === 'img' && name.test(label)),
    getByText: () => control(false),
  });
  const header = frame('SignOut'), menu = frame('Make Reservation');
  const page = fakePage();
  page.frames = () => [header, menu];
  const adapter = adapterFor(page);
  assert.equal(await adapter.isAuthenticated(), true);
  assert.equal(adapter.navigationFrame, menu);
});

test('does not combine partial navigation from unrelated login windows', async () => {
  const control = visible => ({ count: async () => visible ? 1 : 0, nth() { return this; }, isVisible: async () => visible });
  const pageWith = label => ({ url: () => 'https://agents.airarabia.com/xbe/public/showLogin.action', frames: () => [{ url: () => 'https://agents.airarabia.com/xbe/private/navigation', getByText: pattern => control(pattern.test(label)) }] });
  const first = pageWith('SignOut'), second = pageWith('Make Reservation');
  first.context = () => ({ pages: () => [first, second] });
  assert.equal(await adapterFor(first).isAuthenticated(), false);
});


test('confirms title-based navigation and can refresh an authenticated private portal', async () => {
  const control = visible => ({ count: async () => visible ? 1 : 0, nth() { return this; }, isVisible: async () => visible });
  const frame = {
    url: () => 'https://agents.airarabia.com/xbe/private/showTop',
    getByTitle: pattern => control(pattern.test('SignOut') || pattern.test('Make Reservation')),
    getByText: () => control(false),
    locator: () => ({ isVisible: async () => false }),
  };
  const page = fakePage();
  page.url = () => 'https://agents.airarabia.com/xbe/private/showXBEMain.action';
  page.frames = () => [frame];
  const adapter = adapterFor(page);
  assert.equal(await adapter.isAuthenticated(), true);
  adapter.reservationControl = null;
  adapter.isAuthenticated = async () => true;
  const codes = [];
  adapter.report = code => codes.push(code);
  await adapter.searchFlightsForHeartbeat({ departureDate: '01/12/2026' });
  assert.ok(page.calls.some(([op, , url]) => op === 'goto' && url.endsWith('/private/showXBEMain.action')));
  assert.ok(codes.includes('PORTAL_HEARTBEAT_REFRESH_COMPLETED'));
  assert.ok(!page.calls.some(([op]) => op === 'click'));
});


test('an OTP frame blocks authentication even if the portal already shows sign-out', async () => {
  const page = fakePage();
  const verification = { url: () => 'https://agents.airarabia.com/xbe/private/sendOTP.action' };
  const frames = page.frames();
  page.frames = () => [...frames, verification];
  assert.equal(await adapterFor(page).isAuthenticated(), false);
});

test('operator verification submits one supplied code and only then confirms access', async () => {
  const page = fakePage();
  let pending = true, supplied = 0, submitted = 0;
  const fills = [];
  const verification = {
    url: () => pending ? 'https://agents.airarabia.com/xbe/private/sendOTP.action' : 'https://agents.airarabia.com/xbe/private/verified.action',
    locator: selector => ({
      waitFor: async () => {}, isVisible: async () => pending && selector === '#userOtp',
      fill: async value => fills.push({ selector, value }),
      click: async () => { submitted++; pending = false; },
    }),
  };
  const frames = page.frames();
  page.frames = () => [...frames, verification];
  const codes = [];
  const adapter = new AirArabiaPortalAdapter(page, { username: 'test-user', password: 'test-only', origin: 'SHJ', destination: 'DAM', report: code => codes.push(code), verificationProvider: async () => { supplied++; return '123456'; } });
  assert.equal(await adapter.waitForAuthentication(50, { operatorVerification: true }), true);
  assert.equal(supplied, 1); assert.equal(submitted, 1);
  assert.deepEqual(fills, [{ selector: '#userOtp', value: '123456' }]);
  assert.ok(!codes.join(' ').includes('123456'));
});

test('heartbeat cannot submit a code or continue through a verification challenge', async () => {
  const page = fakePage();
  page.frames = () => [{ url: () => 'https://agents.airarabia.com/xbe/private/sendOTP.action' }];
  let supplied = 0;
  const adapter = adapterFor(page);
  adapter.verificationProvider = async () => { supplied++; return '123456'; };
  await assert.rejects(adapter.waitForAuthentication(0), /PORTAL_VERIFICATION_MANUAL_VERIFICATION/);
  assert.equal(supplied, 0);
});
