'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AirArabiaPortalAdapter, AIRPORTS } = require('../src/airarabia-worker');

test('keepalive adapter permits only registered search candidates; supplier must still confirm selection', () => {
  assert.deepEqual(AIRPORTS, { SHJ: 'SHJ - Sharjah', DAM: 'DAM - Damascus', ALP:'ALP - Aleppo',DXB:'DXB - Dubai',AUH:'AUH - Abu Dhabi',DWC:'DWC - Al Maktoum' });
  assert.throws(() => new AirArabiaPortalAdapter({}, {
    username: 'x', password: 'y', origin: 'BAH', destination: 'DAM',
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
      isVisible: async () => selector === '#captcha_txt' ? captcha : ['#username_txt', '#j_password', '#btnLogin'].includes(selector),
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

test('reauthenticating a reused page installs one login response diagnostic without removing other listeners', async () => {
  const page = fakePage(), events = new EventEmitter(), codes = [];
  page.on = events.on.bind(events);
  let unrelated = 0;
  events.on('response', () => unrelated++);
  const adapter = adapterFor(page, code => codes.push(code));
  for (let attempt = 0; attempt < 3; attempt++) await adapter.signIn();
  assert.equal(events.listenerCount('response'), 2);
  events.emit('response', { url: () => 'https://agents.airarabia.com/xbe/j_security_check?token=private', status: () => 302 });
  assert.equal(unrelated, 1);
  assert.deepEqual(codes.filter(code => code.startsWith('PORTAL_LOGIN_RESPONSE_HTTP_')), ['PORTAL_LOGIN_RESPONSE_HTTP_302']);
  assert.ok(!codes.join(' ').includes('private'));
});

test('login response diagnostics bind once to each replacement page and ignore foreign or malformed response URLs', () => {
  const first = fakePage(), second = fakePage(), events = [new EventEmitter(), new EventEmitter()], codes = [];
  first.on = events[0].on.bind(events[0]);second.on = events[1].on.bind(events[1]);
  const adapter = adapterFor(first, code => codes.push(code));
  adapter.observeLoginResponses();adapter.observeLoginResponses();
  adapter.page = second;adapter.observeLoginResponses();adapter.observeLoginResponses();
  assert.equal(events[0].listenerCount('response'), 1);
  assert.equal(events[1].listenerCount('response'), 1);
  for (const bus of events) {
    bus.emit('response', { url: () => 'https://foreign.example/xbe/j_security_check', status: () => 401 });
    bus.emit('response', { url: () => 'not a URL', status: () => 500 });
  }
  assert.deepEqual(codes, []);
  events[1].emit('response', { url: () => 'https://agents.airarabia.com/xbe/j_security_check', status: () => 200 });
  assert.deepEqual(codes, ['PORTAL_LOGIN_RESPONSE_HTTP_200']);
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
  let activities = 0;
  adapter.onAuthenticatedActivity = () => { activities++; };
  await adapter.searchFlightsForHeartbeat({ departureDate: '01/12/2026' });
  assert.ok(page.calls.some(([op, , url]) => op === 'goto' && url.endsWith('/private/showXBEMain.action')));
  assert.ok(codes.includes('PORTAL_HEARTBEAT_REFRESH_COMPLETED'));
  assert.ok(!page.calls.some(([op]) => op === 'click'));
  assert.equal(activities, 1);
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
      waitFor: async () => {}, isVisible: async () => pending && selector.startsWith('#userOtp'),
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
  assert.deepEqual(fills, [{ selector: '#userOtp:visible', value: '123456' }]);
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

test('visible CAPTCHA vetoes stale authenticated navigation and cannot use the OTP handoff', async () => {
  const page = fakePage({ captcha: true });
  const adapter = adapterFor(page);
  let supplied = 0;
  adapter.verificationProvider = async () => { supplied++; return '123456'; };
  assert.equal(await adapter.hasVerificationChallenge(), true);
  assert.equal(await adapter.isAuthenticated(), false);
  await assert.rejects(adapter.resumeVerification(), /MANUAL_VERIFICATION/);
  assert.equal(supplied, 0);
  assert.equal(page.calls.filter(([op]) => ['fill', 'click', 'goto'].includes(op)).length, 0);
});

test('existing OTP recovery uses one operator code without opening login or resubmitting credentials', async () => {
  const page = fakePage();
  let pending = true, supplied = 0, submitted = 0;
  const verification = {
    url: () => pending ? 'https://agents.airarabia.com/xbe/private/sendOTP.action' : 'https://agents.airarabia.com/xbe/private/verified.action',
    locator: selector => ({
      isVisible: async () => pending && selector.startsWith('#userOtp'),
      count: async () => 0,
      fill: async () => { submitted++; },
      click: async () => { pending = false; },
    }),
  };
  const navigation = page.frames();
  page.frames = () => [...navigation, verification];
  const adapter = adapterFor(page);
  adapter.verificationProvider = async () => { supplied++; return '123456'; };
  assert.equal(await adapter.hasVerificationChallenge(), true);
  await adapter.resumeVerification();
  assert.equal(supplied, 1);
  assert.equal(submitted, 1);
  assert.equal(await adapter.isAuthenticated(), true);
  assert.equal(page.calls.filter(([op]) => ['fill', 'click', 'goto'].includes(op)).length, 0);
  pending = true;
  await adapter.resumeVerification();
  assert.equal(supplied, 2);
  assert.equal(submitted, 2);
});

test('an OTP verification-result route blocks stale navigation even before its form is ready', async () => {
  const page = fakePage();
  const navigation = page.frames();
  page.frames = () => [...navigation, { url: () => 'https://agents.airarabia.com/xbe/private/verifyOTP.action' }];
  assert.equal(await adapterFor(page).isAuthenticated(), false);
});

test('protected refresh reports only bounded transient HTTP failures and never searches', async () => {
  for (const [status, transient] of [[503, true], [408, true], [429, true], [403, false], [404, false]]) {
    const page = fakePage();
    let navigations = 0;
    page.goto = async () => { navigations++; return { status: () => status }; };
    const adapter = adapterFor(page);
    let activities = 0;
    adapter.onAuthenticatedActivity = () => { activities++; };
    await assert.rejects(adapter.refreshProtectedPage(), error => error.message === 'PORTAL_SESSION_HTTP_ERROR' && error.transient === transient);
    assert.equal(navigations, 1);
    assert.equal(page.calls.filter(([op]) => op === 'click').length, 0);
    assert.equal(activities, 0);
  }
});

test('supplier-confirmed OTP resumes normal navigation and still requires authenticated controls', async () => {
  const adapter = adapterFor(fakePage());
  let pending = true, resumed = 0;
  adapter.verificationAttempted = true;
  adapter.findVerificationFrame = async () => pending ? { evaluate: async (fn, arg) => {
    if (arg.operation === 'resume') { resumed++; pending = false; return { status: 'CONFIRMED', resumed: true }; }
    return { status: 'CONFIRMED' };
  } } : null;
  adapter.isAuthenticated = async () => !pending;
  assert.equal(await adapter.waitForAuthentication(50), true);
  assert.equal(resumed, 1);
  const noNavigation = adapterFor(fakePage());
  noNavigation.verificationAttempted = true;
  noNavigation.findVerificationFrame = async () => ({ evaluate: async () => ({ status: 'CONFIRMED', resumed: false }) });
  noNavigation.isAuthenticated = async () => false;
  await assert.rejects(noNavigation.waitForAuthentication(0), /VERIFIED_NAVIGATION_PENDING/);
});

test('a remaining OTP form is not falsely classified as an explicit rejection', async () => {
  for (const [status, error] of [['UNCONFIRMED', 'VERIFICATION_NOT_CONFIRMED'], ['INVALID_CODE', 'VERIFICATION_REJECTED'], ['EXPIRED', 'VERIFICATION_EXPIRED']]) {
    const adapter = adapterFor(fakePage());
    adapter.verificationAttempted = true;
    adapter.findVerificationFrame = async () => ({ evaluate: async () => ({ status }) });
    adapter.isAuthenticated = async () => false;
    adapter.inspectSearchUI = async () => {};
    await assert.rejects(adapter.waitForAuthentication(0), new RegExp(error));
  }
});


test('reacquires an OTP frame replaced during the login transition', async () => {
  const page = fakePage();
  let scans = 0, pending = true, supplied = 0;
  const oldFrame = {
    url: () => 'https://agents.airarabia.com/xbe/private/sendOTP.action',
    locator: () => ({ isVisible: async () => { throw new Error('Frame was detached'); } }),
  };
  const liveFrame = {
    url: () => pending ? 'https://agents.airarabia.com/xbe/private/sendOTP.action' : 'https://agents.airarabia.com/xbe/private/verified.action',
    locator: selector => ({
      isVisible: async () => pending && selector.startsWith('#userOtp'),
      fill: async () => {},
      click: async () => { pending = false; },
    }),
  };
  const navigation = page.frames();
  page.frames = () => [...navigation, ++scans === 1 ? oldFrame : liveFrame];
  const adapter = adapterFor(page);
  adapter.verificationProvider = async () => { supplied++; return '123456'; };
  assert.equal(await adapter.waitForAuthentication(1000, { operatorVerification: true }), true);
  assert.equal(supplied, 1);
});


test('prefers the visible OTP input over a route-only wrapper frame', async () => {
  const page = fakePage();
  const wrapper = { url: () => 'https://agents.airarabia.com/xbe/private/sendOTP.action', locator: () => ({ isVisible: async () => false }) };
  const form = { url: () => 'https://agents.airarabia.com/xbe/private/otpForm.action', locator: () => ({ isVisible: async () => true }) };
  page.frames = () => [wrapper, form];
  assert.equal(await adapterFor(page).findVerificationFrame(), form);
});


test('reservation inspection clicks only navigation and stops at a confirmed search form', async () => {
  const page = fakePage();
  let navigationClicks = 0, surveyed = 0;
  const frame = { url: () => 'https://agents.airarabia.com/xbe/private/showSearch;jsessionid=secret-test-only', evaluate: async () => true };
  page.frames = () => [frame];
  const adapter = adapterFor(page);
  adapter.isAuthenticated = async () => true;
  adapter.reservationControl = { click: async () => { navigationClicks++; } };
  adapter.inspectSearchUI = async () => { surveyed++; };
  assert.equal(await adapter.inspectReservationSearch(), true);
  assert.equal(navigationClicks, 1); assert.equal(surveyed, 1);
  assert.equal(adapter.searchFrame, frame);
});

test('reservation inspection never accepts a foreign-origin form or missing navigation', async () => {
  const page = fakePage();
  let evaluations = 0;
  page.frames = () => [{ url: () => 'https://foreign.example/search', evaluate: async () => { evaluations++; return true; } }];
  const adapter = adapterFor(page);
  adapter.isAuthenticated = async () => true;
  adapter.inspectSearchUI = async () => {};
  assert.equal(await adapter.inspectReservationSearch({ timeoutMs: 0 }), false);
  adapter.reservationControl = { click: async () => {} };
  assert.equal(await adapter.inspectReservationSearch({ timeoutMs: 0 }), false);
  assert.equal(evaluations, 0);
});

function hiddenLoginLauncher(pages) {
  const page = fakePage();
  const locator = page.locator;
  page.url = () => 'https://agents.airarabia.com/xbe/';
  page.context = () => ({ pages: () => [page, ...pages] });
  page.locator = selector => {
    const found = locator(selector);
    return { ...found, isVisible: async () => false };
  };
  return page;
}

test('reauthentication reacquires a reused named login window when no popup event fires', async () => {
  const reused = fakePage();
  reused.evaluate = async () => 'winCC';
  const launcher = hiddenLoginLauncher([reused]);
  const events = [], adapter = adapterFor(launcher, code => events.push(code));
  await adapter.signIn();
  assert.equal(adapter.page, reused);
  assert.equal(adapter.loginTarget, reused);
  assert.equal(launcher.calls.filter(([op]) => ['fill', 'click'].includes(op)).length, 0);
  assert.deepEqual(reused.calls.filter(([op]) => op === 'fill').map(([,selector]) => selector), ['#username_txt', '#j_password']);
  assert.equal(reused.calls.filter(([op]) => op === 'click').length, 1);
  assert.ok(events.includes('PORTAL_LOGIN_FORM_REACQUIRED'));
  assert.ok(events.includes('PORTAL_AUTHENTICATED'));
});

test('reused trusted login child frame is selected while its page stays the owner', async () => {
  const owner = fakePage();
  owner.url = () => 'https://agents.airarabia.com/xbe/';
  const navigation = owner.frames();
  const fills = [];let pending = true;
  const form = {
    url: () => 'https://agents.airarabia.com/xbe/public/showLogin.action',
    locator: selector => ({
      isVisible: async () => pending && ['#username_txt', '#j_password', '#btnLogin'].includes(selector),
      fill: async () => fills.push(selector),
      click: async () => { pending = false; },
      textContent: async () => '',
    }),
  };
  owner.frames = () => [...navigation, form];
  const launcher = hiddenLoginLauncher([owner]);
  const adapter = adapterFor(launcher);
  await adapter.signIn();
  assert.equal(adapter.page, owner);
  assert.equal(adapter.loginTarget, form);
  assert.deepEqual(fills, ['#username_txt', '#j_password']);
  assert.equal(owner.calls.filter(([op]) => ['fill', 'click'].includes(op)).length, 0);
});

test('multiple visible unnamed trusted login forms are rejected before credentials are entered', async () => {
  const first = fakePage(), second = fakePage();
  const launcher = hiddenLoginLauncher([first, second]);
  await assert.rejects(adapterFor(launcher).signIn(), /PORTAL_LOGIN_FORM_SELECTOR_AMBIGUOUS/);
  for (const page of [launcher, first, second]) assert.equal(page.calls.filter(([op]) => ['fill', 'click'].includes(op)).length, 0);
});

test('reacquisition ignores a foreign window even when its frame mimics the trusted login route', async () => {
  const foreign = fakePage();
  foreign.url = () => 'https://foreign.example/';
  let inspected = 0;
  foreign.frames = () => { inspected++; return [{ url: () => 'https://agents.airarabia.com/xbe/public/showLogin.action' }]; };
  const launcher = hiddenLoginLauncher([foreign]);
  const adapter = adapterFor(launcher);
  await assert.rejects(adapter.acquireLoginForm({ timeoutMs: 0 }), /PORTAL_LOGIN_FORM_TIMEOUT/);
  // Challenge detection may check frame URLs, but no foreign form may be used.
  assert.equal(foreign.calls.filter(([op]) => ['fill', 'click'].includes(op)).length, 0);
  assert.notEqual(adapter.page, foreign);
});

test('reused popup CAPTCHA blocks all credential entry', async () => {
  const challenge = fakePage({ captcha: true });
  const launcher = hiddenLoginLauncher([challenge]);
  await assert.rejects(adapterFor(launcher).signIn(), /MANUAL_VERIFICATION/);
  assert.equal(challenge.calls.filter(([op]) => ['fill', 'click'].includes(op)).length, 0);
});

test('origin is rechecked between username, password and submit operations', async () => {
  const reused = fakePage();let route = 'https://agents.airarabia.com/xbe/public/showLogin.action';
  reused.url = () => route;
  const locator = reused.locator;
  reused.locator = selector => {
    const control = locator(selector);
    return { ...control, fill: async () => { reused.calls.push(['fill', selector]); route = 'https://foreign.example/login'; } };
  };
  const launcher = hiddenLoginLauncher([reused]);
  await assert.rejects(adapterFor(launcher).signIn(), /PORTAL_LOGIN_FORM_UNEXPECTED/);
  assert.deepEqual(reused.calls.filter(([op]) => op === 'fill').map(([,selector]) => selector), ['#username_txt']);
  assert.equal(reused.calls.filter(([op]) => op === 'click').length, 0);
});
