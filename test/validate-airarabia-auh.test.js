'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { parseArgs, inspectSearchModelAction, safeChoices, main, readCgroupMemory, safeLoginShape, openDiagnosticRuntime } = require('../scripts/validate-airarabia-auh');

const NOW = Date.UTC(2026, 9, 26, 12);
const args = extra => ['--source-root', '/tmp/aa-validated-stage', '--date', '2026-11-11', ...(extra || [])];
const options = { now: () => NOW, realpath: value => value, readMemory: () => ({ usageBytes: 25, limitBytes: 100 }) };

test('one-off discovery requires an explicit staged source and future date', () => {
  const config = parseArgs(args(), options);
  assert.equal(config.sourceRoot, '/tmp/aa-validated-stage');
  assert.equal(config.date, '2026-11-11');
  assert.equal(config.priceRow, null);
  assert.equal(config.maxMemoryPercent, 75);
  assert.equal(parseArgs(args(['--price', '2']), options).priceRow, 2);
});

test('one-off raised memory budget is explicit and limited to integer percentages from seventy-five through eighty-five', () => {
  for (const value of ['75', '80', '85']) assert.equal(parseArgs(args(['--max-memory-percent', value]), options).maxMemoryPercent, Number(value));
  for (const value of ['74', '86', '100', '0', '-1', '84.5', '85.0', 'eighty-five', 'Infinity']) assert.throws(() => parseArgs(args(['--max-memory-percent', value]), options), value);
  assert.throws(() => parseArgs(args(['--max-memory-percent']), options));
  assert.throws(() => parseArgs(args(['--max-memory-percent', '80', '--max-memory-percent', '85']), options));
});

test('one-off source paths cannot reach the live app or escape staging through a symlink', () => {
  for (const sourceRoot of ['/app', '/', '/tmp', '/tmp2/aa-stage', '/var/tmp/aa-stage', 'relative-stage']) {
    assert.throws(() => parseArgs(['--source-root', sourceRoot, '--date', '2026-11-11'], options));
  }
  assert.throws(() => parseArgs(args(), { ...options, realpath: () => '/app' }));
  assert.throws(() => parseArgs(args(), { ...options, realpath: () => { throw Error('private missing path'); } }));
});

test('invalid, duplicate, missing or unbounded one-off arguments stop before launching', () => {
  for (const argv of [[], ['--date', '2026-11-11'], ['--source-root', '/tmp/aa-stage'], args(['--unknown', 'x']), args(['--date', '2026-11-12']), args(['--price']), args(['--price', '0']), args(['--price', '201']), args(['--price', '-1']), args(['--price', '2.5']), args(['--price', '2', '--price', '3'])]) {
    assert.throws(() => parseArgs(argv, options), JSON.stringify(argv));
  }
  for (const date of ['2026-10-25', '2026-10-26', '2026-02-30', '2026-13-11', '11/11/2026', 'private-date']) {
    assert.throws(() => parseArgs(['--source-root', '/tmp/aa-stage', '--date', date], options), date);
  }
});

test('one-off future date is relative to Dubai rather than the earlier UTC calendar day', () => {
  const nearMidnight = { ...options, now: () => Date.UTC(2026, 9, 26, 22, 30) };
  assert.throws(() => parseArgs(['--source-root', '/tmp/aa-stage', '--date', '2026-10-27'], nearMidnight));
  assert.equal(parseArgs(['--source-root', '/tmp/aa-stage', '--date', '2026-10-28'], nearMidnight).date, '2026-10-28');
});

function modelFixture({ origin = 'https://agents.airarabia.com', back = null } = {}) {
  const params = { fromAirport: 'AUH', toAirport: 'DAM', departureDate: '11/11/2026', returnDate: null, adultCount: 1, childCount: 0, infantCount: 0, selectedCurrency: 'AED', searchSystem: 'INT', customerName: 'SECRET_CUSTOMER_SENTINEL', accessToken: 'SECRET_TOKEN_SENTINEL' };
  const out = [{ segmentCodeList: ['AUH/DAM'], carrierList: ['3L'], flightNoList: ['3L504'], depatureTimeList: ['2611110920'], flightRPHList: ['SECRET_REFERENCE_SENTINEL$private$private$202611110920$private'], csOcCarrierList: [null], customerEmail: 'SECRET_ACCOUNT_SENTINEL' }];
  const response = { success: true, searchParams: params, outboundFlights: out, returnFlights: back, password: 'SECRET_PASSWORD_SENTINEL' };
  const ui = { searchStartTime: 100, searchEndTime: 200, latestResponse: response, objResSrchParams: params, strOutDate: '11/11/2026', strRetDate: '', flightInfo: [], extraPrivate: 'SECRET_EXTRA_SENTINEL' };
  const sandbox = { location: { origin }, jQuery: { active: 0 }, UI_tabSearchFlights: ui, jsonOutFlts: out, jsonRetFlts: back };
  const inspect = () => vm.runInNewContext('(' + inspectSearchModelAction.toString() + ')()', sandbox);
  return { params, out, response, ui, sandbox, inspect };
}

test('one-off model diagnostics retain only public flight evidence and never raw payloads or references', () => {
  const f = modelFixture(), before = JSON.stringify(f.sandbox), result = f.inspect(), encoded = JSON.stringify(result);
  assert.ok(encoded.includes('AUH'));assert.ok(encoded.includes('DAM'));assert.ok(encoded.includes('3L504'));
  assert.doesNotMatch(encoded, /SECRET_|private|customerName|customerEmail|accessToken|password/);
  assert.equal(JSON.stringify(f.sandbox), before);
});

test('one-off model diagnostics distinguish null and array return models without serializing their values', () => {
  const nil = JSON.stringify(modelFixture({ back: null }).inspect());
  const empty = JSON.stringify(modelFixture({ back: [] }).inspect());
  assert.notEqual(nil, empty);
  assert.doesNotMatch(nil + empty, /SECRET_|private/);
});

test('one-off model diagnostics refuse a foreign frame without exposing its data', () => {
  const f = modelFixture({ origin: 'https://foreign.example' });
  let encoded;
  try { encoded = JSON.stringify(f.inspect()); } catch (error) { encoded = String(error.message); }
  assert.doesNotMatch(encoded, /SECRET_|private|3L504|AUH|DAM/);
});

test('one-off flight choices are bounded and cannot print arbitrary source strings', () => {
  const valid = { row: 1, flight: '3L504', departure: '11 Nov 2026 09:20', arrival: '11 Nov 2026 11:50', selected: true, customer: 'SECRET_CHOICE_SENTINEL' };
  const encoded = JSON.stringify(safeChoices({ out: [valid, { ...valid, row: 2, flight: 'SECRET_FLIGHT_SENTINEL', departure: 'SECRET_TIMING_SENTINEL' }], back: [] }));
  assert.ok(encoded.includes('3L504'));
  assert.doesNotMatch(encoded, /SECRET_|customer/);
  assert.ok(encoded.length < 10000);
});

const deferred = () => { let resolve, reject;const promise = new Promise((a, b) => { resolve = a;reject = b; });return { promise, resolve, reject }; };
function runtimeFixture({ searchFailure = null, quoteGate = null, launchGate = null, doubleLaunch = false, closeFailure = false, loginDiagnostics = [] } = {}) {
  const calls = [], output = [], env = { AIR_ARABIA_AGENT_USERNAME: 'SECRET_USERNAME_SENTINEL', AIR_ARABIA_AGENT_PASSWORD: 'SECRET_LOGIN_SENTINEL', AIR_ARABIA_INSPECT_SEARCH_UI: 'true', GMAIL_OTP_ENABLED: 'true' };
  const choices = { out: [1, 2].map(row => ({ row, flight: '3L50' + row, departure: '11 Nov 2026 09:20', arrival: '11 Nov 2026 11:50', selected: row === 1 })), back: [] };
  const browser = { close: async () => { calls.push(['browser-close']);if (closeFailure) throw Error('SECRET_CLOSE_SENTINEL'); } };
  const adapter = {
    searchFrame: { evaluate: async fn => { calls.push(['model-inspect']);return vm.runInNewContext('(' + fn.toString() + ')()', modelFixture().sandbox); } },
    runCustomerQuoteVariant: async (request, choice, discovery) => {
      calls.push(['search', structuredClone(request), structuredClone(choice), discovery]);
      if (quoteGate) await quoteGate.promise;
      if (searchFailure) throw searchFailure;
      return discovery ? { choices } : { price: { currency: 'AED', sellingTotal: '643.00' }, timing: choice };
    },
  };
  const runtime = { session: { adapter, run: async task => { calls.push(['session-run']);return task(adapter); } }, close: async () => { calls.push(['runtime-close']); } };
  const load = sourceRoot => {
    calls.push(['load', sourceRoot]);
    return {
      launch: async () => { calls.push(['launch']);if (launchGate) await launchGate.promise;return browser; },
      openAirArabiaRuntime: async config => {
        calls.push(['open', config.env]);
        config.log.log('PORTAL_STAGE_BROWSER_START');config.log.log('PORTAL_SEARCH_UI_SECRET_SOURCE_SENTINEL');config.log.error('SECRET_RAW_ERROR_SENTINEL');
        for (const diagnostic of loginDiagnostics) config.log.log(diagnostic);
        await config.launch({ headless: true });
        if (doubleLaunch) await config.launch({ headless: true });
        return runtime;
      },
    };
  };
  const run = extra => main(args(extra), { ...options, env, load, write: item => output.push(item), timeoutMs: 1000, cleanupMs: 50 });
  return { calls, output, env, choices, browser, runtime, run, load };
}

test('default one-off uses one tracked browser and performs discovery only without printing env or source diagnostics', async () => {
  const f = runtimeFixture();assert.equal(await f.run(), 0);
  assert.equal(f.calls.filter(([event]) => event === 'launch').length, 1);
  const searches = f.calls.filter(([event]) => event === 'search');assert.equal(searches.length, 1);assert.equal(searches[0][3], true);assert.equal(searches[0][2], null);
  assert.deepEqual(searches[0][1], { provider: 'airarabia', origin: 'AUH', destination: 'DAM', departureDate: '2026-11-11', tripType: 'one_way', passengers: { adults: 1, children: 0, infants: 0 }, baggageRequest: { checkedWeightKg: 30, requestedByCustomer: false, source: 'default30' } });
  const environment = f.calls.find(([event]) => event === 'open')[1];assert.equal(environment.AIR_ARABIA_AGENT_PASSWORD, f.env.AIR_ARABIA_AGENT_PASSWORD);assert.equal(environment.AIR_ARABIA_KEEPALIVE_ORIGIN, 'AUH');assert.equal(environment.AIR_ARABIA_KEEPALIVE_DESTINATION, 'DAM');assert.equal(environment.AIR_ARABIA_INSPECT_SEARCH_UI, 'false');assert.equal(f.env.AIR_ARABIA_INSPECT_SEARCH_UI, 'true');
  assert.ok(f.output.some(item => item.event === 'DIAGNOSTIC_DISCOVERY_CONFIRMED'));assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_PRICE_CONFIRMED'));
  assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'runtime-close').length, 1);
  assert.doesNotMatch(JSON.stringify(f.output), /SECRET_|PASSWORD|USERNAME/);
});

test('one-off price mode requires an explicitly available discovered row and preserves the existing quote flow', async () => {
  const f = runtimeFixture();assert.equal(await f.run(['--price', '2']), 0);
  const searches = f.calls.filter(([event]) => event === 'search');assert.equal(searches.length, 2);assert.equal(searches[0][3], true);assert.equal(searches[1][3], false);
  assert.deepEqual(searches[1][2], { out: f.choices.out[1], back: null });assert.deepEqual(searches[1][1], searches[0][1]);
  assert.ok(f.output.some(item => item.event === 'DIAGNOSTIC_PRICE_CONFIRMED' && item.currency === 'AED' && item.sellingTotal === '643.00'));
  const missing = runtimeFixture();assert.equal(await missing.run(['--price', '3']), 1);assert.equal(missing.calls.filter(([event]) => event === 'search').length, 1);assert.ok(missing.output.some(item => item.reason === 'DIAGNOSTIC_PRICE_ROW_UNAVAILABLE'));
});

test('a strict search failure produces only a fixed reason and redacted model, then closes its own resources', async () => {
  const f = runtimeFixture({ searchFailure: Error('SECRET_RAW_FAILURE_SENTINEL') });assert.equal(await f.run(), 1);
  assert.ok(f.output.some(item => item.event === 'DIAGNOSTIC_UNVERIFIED' && item.reason === 'DIAGNOSTIC_FAILED'));assert.ok(f.output.some(item => item.event === 'DIAGNOSTIC_MODEL_SHAPE'));
  assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'runtime-close').length, 1);assert.doesNotMatch(JSON.stringify(f.output), /SECRET_|private/);
});

test('one-off refuses a second Chromium launch before another browser can be created', async () => {
  const f = runtimeFixture({ doubleLaunch: true });assert.equal(await f.run(), 1);assert.equal(f.calls.filter(([event]) => event === 'launch').length, 1);assert.ok(f.output.some(item => item.reason === 'DIAGNOSTIC_ONE_BROWSER_ONLY'));assert.equal(f.calls.filter(([event]) => event === 'search').length, 0);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);
});

test('one-off timeout closes its browser before draining runtime and withholds late results', async () => {
  const gate = deferred(), f = runtimeFixture({ quoteGate: gate });
  assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), timeoutMs: 5, cleanupMs: 50 }), 1);
  assert.ok(f.output.some(item => item.reason === 'DIAGNOSTIC_TIMED_OUT'));assert.ok(f.output.some(item => item.event === 'DIAGNOSTIC_CLEANUP_COMPLETED'));assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_MODEL_SHAPE'));
  assert.ok(f.calls.findIndex(([event]) => event === 'browser-close') < f.calls.findIndex(([event]) => event === 'runtime-close'));
  const count = f.output.length;gate.resolve();for (let i = 0; i < 20; i++) await Promise.resolve();assert.equal(f.output.length, count);
});

test('failed browser cleanup remains a failure and does not prevent the runtime cleanup attempt', async () => {
  const f = runtimeFixture({ closeFailure: true });assert.equal(await f.run(), 1);assert.equal(f.calls.filter(([event]) => event === 'runtime-close').length, 1);assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_FAILED');assert.doesNotMatch(JSON.stringify(f.output), /SECRET_/);
});

test('a browser returned during timeout cleanup is closed without reaching search or reporting late results', async () => {
  const gate = deferred(), f = runtimeFixture({ launchGate: gate });
  const running = main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), timeoutMs: 5, cleanupMs: 200 });
  const resolve = setTimeout(() => gate.resolve(), 15);
  try {
    assert.equal(await running, 1);assert.equal(f.calls.filter(([event]) => event === 'launch').length, 1);assert.equal(f.calls.filter(([event]) => event === 'search').length, 0);assert.ok(f.calls.some(([event]) => event === 'browser-close'));assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_COMPLETED');assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_DISCOVERY_CONFIRMED'));
  } finally { clearTimeout(resolve);gate.resolve(); }
});

test('an unresolved browser launch never produces a false cleanup-completed event', async () => {
  const gate = deferred(), f = runtimeFixture({ launchGate: gate });
  try {
    assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), timeoutMs: 5, cleanupMs: 10 }), 1);
    assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_FAILED');assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_CLEANUP_COMPLETED'));assert.equal(f.calls.filter(([event]) => event === 'search').length, 0);
    const count = f.output.length;gate.resolve();for (let i = 0; i < 30; i++) await Promise.resolve();assert.equal(f.output.length, count);assert.ok(f.calls.some(([event]) => event === 'browser-close'));
  } finally { gate.resolve(); }
});

test('invalid one-off arguments never load source or touch browser dependencies', async () => {
  let loaded = 0;const output = [];
  assert.equal(await main(['--date', '2026-11-11'], { ...options, write: value => output.push(value), load: () => { loaded++;throw Error('must not load'); } }), 1);
  assert.equal(loaded, 0);assert.ok(output.some(item => item.reason === 'DIAGNOSTIC_STAGING_REQUIRED'));assert.doesNotMatch(JSON.stringify(output), /must not load/);
});

test('memory at or above seventy-five percent prevents source loading and browser launch', async () => {
  for (const usageBytes of [75, 76, 100, 101]) {
    const f = runtimeFixture();
    assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory: () => ({ usageBytes, limitBytes: 100 }) }), 1);
    assert.equal(f.calls.length, 0);assert.ok(f.output.some(item => item.reason === 'DIAGNOSTIC_MEMORY_PRESSURE'));assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_STARTED'));
  }
});

test('unreadable or invalid memory limits prevent loading or launching rather than assuming spare RAM', async () => {
  for (const value of [null, {}, { usageBytes: -1, limitBytes: 100 }, { usageBytes: NaN, limitBytes: 100 }, { usageBytes: 1, limitBytes: 0 }, { usageBytes: 1, limitBytes: Infinity }, { usageBytes: '1', limitBytes: 100 }]) {
    const f = runtimeFixture();
    assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory: () => value }), 1);
    assert.equal(f.calls.length, 0);assert.ok(f.output.some(item => item.reason === 'DIAGNOSTIC_MEMORY_UNAVAILABLE'));
  }
  const f = runtimeFixture();assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory: () => { throw Error('SECRET_MEMORY_READER_SENTINEL'); } }), 1);assert.equal(f.calls.length, 0);assert.ok(f.output.some(item => item.reason === 'DIAGNOSTIC_MEMORY_UNAVAILABLE'));assert.doesNotMatch(JSON.stringify(f.output), /SECRET_/);
});

test('the immediate prelaunch memory recheck prevents a launch after pressure rises during source loading', async () => {
  const f = runtimeFixture();let checks = 0;
  assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory: () => ({ usageBytes: checks++ ? 75 : 25, limitBytes: 100 }) }), 1);
  assert.ok(f.calls.some(([event]) => event === 'load'));assert.equal(f.calls.filter(([event]) => event === 'launch').length, 0);assert.equal(f.calls.filter(([event]) => event === 'search').length, 0);assert.ok(f.output.some(item => item.reason === 'DIAGNOSTIC_MEMORY_PRESSURE'));
});

for (const failure of ['pressure', 'unreadable', 'invalid']) test('midrun memory ' + failure + ' closes only the owned browser and suppresses late quote results', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const gate = deferred(), f = runtimeFixture({ quoteGate: gate });let failed = false;
  const readMemory = () => { if (failed && failure === 'unreadable') throw Error('SECRET_MEMORY_READER_SENTINEL');if (failed && failure === 'invalid') return null;return { usageBytes: failed ? 75 : 25, limitBytes: 100 }; };
  try {
    const running = main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory, timeoutMs: 10000, cleanupMs: 50 });
    for (let i = 0; i < 80; i++) await Promise.resolve();assert.equal(f.calls.filter(([event]) => event === 'search').length, 1);
    failed = true;t.mock.timers.tick(1000);assert.equal(await running, 1);
    assert.ok(f.output.some(item => item.reason === (failure === 'pressure' ? 'DIAGNOSTIC_MEMORY_PRESSURE' : 'DIAGNOSTIC_MEMORY_UNAVAILABLE')));assert.equal(f.calls.filter(([event]) => event === 'launch').length, 1);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'runtime-close').length, 1);assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_COMPLETED');assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_MODEL_SHAPE'));
    const count = f.output.length;gate.resolve();for (let i = 0; i < 30; i++) await Promise.resolve();t.mock.timers.tick(10000);assert.equal(f.output.length, count);assert.doesNotMatch(JSON.stringify(f.output), /SECRET_/);
  } finally { gate.resolve();t.mock.timers.reset(); }
});

test('memory reader uses finite numeric cgroup-v2 usage and limit without consulting v1', t => {
  const reads = [];
  t.mock.method(fs, 'readFileSync', file => { reads.push(file);if (file === '/sys/fs/cgroup/memory.current') return ' 200\n';if (file === '/sys/fs/cgroup/memory.max') return '1000\n';throw Error('unexpected read'); });
  assert.deepEqual(readCgroupMemory(), { usageBytes: 200, limitBytes: 1000 });assert.deepEqual(reads, ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max']);
});

test('memory reader uses cgroup-v1 only when the v2 files are absent', t => {
  const reads = [];
  t.mock.method(fs, 'readFileSync', file => { reads.push(file);if (file === '/sys/fs/cgroup/memory.current') throw Object.assign(Error('missing'), { code: 'ENOENT' });if (file === '/sys/fs/cgroup/memory/memory.usage_in_bytes') return '100';if (file === '/sys/fs/cgroup/memory/memory.limit_in_bytes') return '1000';throw Error('unexpected read'); });
  assert.deepEqual(readCgroupMemory(), { usageBytes: 100, limitBytes: 1000 });assert.equal(reads.length, 3);
});

test('memory reader never turns inaccessible, unlimited or malformed cgroup data into spare memory', t => {
  let current = '25', limit = 'max', deny = false;
  t.mock.method(fs, 'readFileSync', file => { if (deny) throw Object.assign(Error('SECRET_PERMISSION_SENTINEL'), { code: 'EACCES' });return file.endsWith('memory.current') ? current : limit; });
  for (const [usageValue, limitValue] of [['25', 'max'], ['x', '100'], ['25', '0'], ['-1', '100'], ['25.5', '100'], ['25', '99999999999999999999999999']]) { current = usageValue;limit = limitValue;assert.throws(readCgroupMemory, /^Error: DIAGNOSTIC_MEMORY_UNAVAILABLE$/); }
  deny = true;assert.throws(readCgroupMemory, /^Error: DIAGNOSTIC_MEMORY_UNAVAILABLE$/);
});

test('an explicit eighty-five-percent budget permits an eighty-percent baseline without changing discovery scope', async () => {
  const f = runtimeFixture();
  assert.equal(await main(args(['--max-memory-percent', '85']), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory: () => ({ usageBytes: 80, limitBytes: 100 }) }), 0);
  assert.equal(f.calls.filter(([event]) => event === 'launch').length, 1);const searches = f.calls.filter(([event]) => event === 'search');assert.equal(searches.length, 1);assert.equal(searches[0][2], null);assert.equal(searches[0][3], true);
  assert.ok(f.output.some(item => item.event === 'DIAGNOSTIC_MEMORY_BUDGET_CONFIRMED' && item.usageBytes === 80 && item.limitBytes === 100 && item.thresholdPercent === 85));assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_PRICE_CONFIRMED'));
});

test('the raised one-off budget checks every quarter second and stops at its actual eighty-five-percent threshold', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const gate = deferred(), f = runtimeFixture({ quoteGate: gate });let usageBytes = 80, checks = 0;
  try {
    const running = main(args(['--max-memory-percent', '85']), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory: () => { checks++;return { usageBytes, limitBytes: 100 }; }, timeoutMs: 10000, cleanupMs: 50 });
    for (let i = 0; i < 80; i++) await Promise.resolve();assert.equal(f.calls.filter(([event]) => event === 'search').length, 1);const initialChecks = checks;
    usageBytes = 85;t.mock.timers.tick(249);for (let i = 0; i < 20; i++) await Promise.resolve();assert.equal(checks, initialChecks);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 0);
    t.mock.timers.tick(1);assert.equal(await running, 1);
    const failure = f.output.find(item => item.reason === 'DIAGNOSTIC_MEMORY_PRESSURE');assert.ok(failure);assert.equal(failure.usageBytes, 85);assert.equal(failure.limitBytes, 100);assert.equal(failure.thresholdPercent, 85);
    assert.equal(f.calls.filter(([event]) => event === 'launch').length, 1);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'runtime-close').length, 1);assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_MODEL_SHAPE'));
    const count = f.output.length;gate.resolve();for (let i = 0; i < 30; i++) await Promise.resolve();assert.equal(f.output.length, count);
  } finally { gate.resolve();t.mock.timers.reset(); }
});

test('memory pressure interrupts a pending model capture and withholds its late output', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const capture = deferred(), f = runtimeFixture({ searchFailure: Error('SEARCH_IDENTITY_UNVERIFIED') });let usageBytes = 25;
  f.runtime.session.adapter.searchFrame.evaluate = async () => { f.calls.push(['model-pending']);return capture.promise; };
  try {
    const running = main(args(), { ...options, env: f.env, load: f.load, write: item => f.output.push(item), readMemory: () => ({ usageBytes, limitBytes: 100 }), timeoutMs: 10000, cleanupMs: 50 });
    for (let i = 0; i < 80; i++) await Promise.resolve();assert.ok(f.calls.some(([event]) => event === 'model-pending'));assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 0);
    usageBytes = 75;t.mock.timers.tick(1000);assert.equal(await running, 1);
    assert.ok(f.calls.some(([event]) => event === 'browser-close'));assert.ok(f.calls.some(([event]) => event === 'runtime-close'));assert.ok(!f.output.some(item => item.event === 'DIAGNOSTIC_MODEL_SHAPE'));
    const failure = f.output.find(item => item.reason === 'DIAGNOSTIC_MEMORY_PRESSURE');assert.ok(failure);assert.equal(failure.usageBytes, 75);assert.equal(failure.limitBytes, 100);assert.equal(failure.thresholdPercent, 75);
    const count = f.output.length;capture.resolve({ SECRET_LATE_MODEL_SENTINEL: true });for (let i = 0; i < 30; i++) await Promise.resolve();assert.equal(f.output.length, count);assert.doesNotMatch(JSON.stringify(f.output), /SECRET_/);
  } finally { capture.resolve(null);t.mock.timers.reset(); }
});

const LOGIN_PREFIX = 'PORTAL_LOGIN_DIAGNOSTIC_';
const LOGIN_FIELDS = ['bodyHidden', 'loginInput', 'passwordInput', 'signOutText', 'reservationText', 'signOutNamedControl', 'reservationNamedControl', 'verification', 'accessDenied', 'invalidCredentials', 'passwordChange', 'sessionNotice'];
test('login diagnostic parser preserves only known booleans, bounded frame counts and normalized public route classes', () => {
  for (const [route, expected] of [['PRIVATE', 'PRIVATE'], ['PUBLIC', 'PUBLIC'], ['OTHER', 'OTHER'], ['LOGIN', 'PUBLIC'], ['LOGIN_HANDLER', 'PUBLIC']]) {
    const booleans = Object.fromEntries(LOGIN_FIELDS.map((field, index) => [field, index % 2 === 0]));
    const result = safeLoginShape(LOGIN_PREFIX + JSON.stringify({ route, frames: 3, ...booleans, password: 'SECRET_PASSWORD_SENTINEL', email: 'SECRET_EMAIL_SENTINEL@example.com', url: 'https://SECRET_URL_SENTINEL.invalid/?token=secret', unknownString: 'SECRET_UNKNOWN_SENTINEL' }));
    assert.equal(result.event, 'DIAGNOSTIC_LOGIN_SHAPE');assert.equal(result.route, expected);assert.equal(result.frames, 3);
    for (const field of LOGIN_FIELDS) assert.equal(result[field], booleans[field]);
    assert.deepEqual(Object.keys(result).sort(), ['event', 'route', 'frames', ...LOGIN_FIELDS].sort());
    assert.doesNotMatch(JSON.stringify(result), /SECRET_|example\.com|https:|token=|unknownString|"password"|"email"|"url"/);
  }
});

test('malformed and oversized login payloads never return raw diagnostic text', () => {
  for (const value of [null, {}, 123, 'SECRET_PLAIN_SENTINEL', LOGIN_PREFIX, LOGIN_PREFIX + '{SECRET_BROKEN_SENTINEL', LOGIN_PREFIX + JSON.stringify({ route: 'PRIVATE', frames: 2, password: 'SECRET_LARGE_SENTINEL' + 'x'.repeat(10000) })]) {
    assert.equal(safeLoginShape(value), null);
  }
});

test('login diagnostic parser does not coerce untrusted field types or copy unknown route text', () => {
  for (const frames of [-1, 101, 1.5, '2', null]) {
    const result = safeLoginShape(LOGIN_PREFIX + JSON.stringify({ route: 'PRIVATE', frames, bodyHidden: 'false', signOutNamedControl: 1, passwordInput: { value: 'SECRET_TYPED_SENTINEL' }, accessDenied: false }));
    assert.ok(result);assert.equal(result.route, 'PRIVATE');assert.equal(result.accessDenied, false);
    for (const key of ['frames', 'bodyHidden', 'signOutNamedControl', 'passwordInput']) assert.equal(Object.hasOwn(result, key), false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_|"false"/);
  }
  const result = safeLoginShape(LOGIN_PREFIX + JSON.stringify({ route: 'https://SECRET_ROUTE_SENTINEL.invalid/', frames: 2, signOutText: true }));
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|https:/);
});

test('one-off logger emits redacted login shapes and fixed recovery events without raw payload fields', async () => {
  const fixed = ['PORTAL_PARTIAL_LOGIN_RECOVERY_STARTED', 'PORTAL_PARTIAL_LOGIN_RECOVERY_CONFIRMED', 'PORTAL_PARTIAL_LOGIN_RECOVERY_NOT_CONFIRMED', 'PORTAL_LOGIN_DIAGNOSTIC_FRAME_UNAVAILABLE'];
  const f = runtimeFixture({ loginDiagnostics: [LOGIN_PREFIX + JSON.stringify({ route: 'LOGIN_HANDLER', frames: 3, signOutNamedControl: true, reservationNamedControl: false, email: 'SECRET_EMAIL_SENTINEL@example.com', password: 'SECRET_PASSWORD_SENTINEL', url: 'https://SECRET_URL_SENTINEL.invalid/' }), LOGIN_PREFIX + '{SECRET_BROKEN_SENTINEL', ...fixed] });
  assert.equal(await f.run(), 0);
  const shape = f.output.find(item => item.event === 'DIAGNOSTIC_LOGIN_SHAPE');assert.ok(shape);assert.equal(shape.route, 'PUBLIC');assert.equal(shape.frames, 3);assert.equal(shape.signOutNamedControl, true);assert.equal(shape.reservationNamedControl, false);
  for (const event of fixed) assert.ok(f.output.some(item => item.event === event));
  assert.doesNotMatch(JSON.stringify(f.output), /SECRET_|example\.com|https:|"password"|"email"|"url"/);
});

function directRuntimeFixture({ contextFailure = false, browserFailure = false } = {}) {
  const calls = [], reports = [], env = { AIR_ARABIA_AGENT_USERNAME: 'test-agent', AIR_ARABIA_AGENT_PASSWORD: 'SECRET_DIRECT_PASSWORD_SENTINEL', GMAIL_OTP_ENABLED: 'true' };let authenticated = true, config;
  const launcher = { setDefaultTimeout: value => calls.push(['timeout', value]), close: async () => { throw Error('must retain launcher'); } }, popup = { marker: 'selected-popup', close: async () => { throw Error('must retain popup'); } };
  const context = { newPage: async () => { calls.push(['context-newPage']);return launcher; }, close: async () => { calls.push(['context-close']);if (contextFailure) throw Error('SECRET_CONTEXT_CLOSE_SENTINEL'); } };
  const browser = { newContext: async () => { calls.push(['newContext']);return context; }, newPage: async () => { throw Error('implicit context forbidden'); }, close: async () => { calls.push(['browser-close']);if (browserFailure) throw Error('SECRET_BROWSER_CLOSE_SENTINEL'); } };
  class Adapter {
    constructor(page, options) { calls.push(['adapter-created']);assert.equal(page, launcher);this.page = page;config = options; }
    async signIn() { calls.push(['sign-in']);assert.equal(await config.verificationProvider({ requestedAt: 123, timeoutMs: 456 }), '123456');this.page = popup; }
    async isAuthenticated() { calls.push(['auth']);return authenticated; }
    async refreshProtectedPage() { throw Error('diagnostic must not refresh'); }
  }
  const dependencies = { AirArabiaPortalAdapter: Adapter, waitForAirArabiaCode: async options => { calls.push(['gmail-delegate', options]);return '123456'; } };
  const open = extra => openDiagnosticRuntime({ env, launch: async () => { calls.push(['launch']);return browser; }, log: { log: value => reports.push(value), error: value => reports.push(value) }, ...extra }, dependencies);
  return { open, calls, env, reports, browser, context, launcher, popup, config: () => config, dependencies, setAuthenticated: value => { authenticated = value; } };
}

test('direct diagnostic runtime uses one explicit context, retains its launcher and delegates the existing Gmail provider', async () => {
  const f = directRuntimeFixture(), runtime = await f.open();
  assert.equal(f.calls.filter(([event]) => event === 'launch').length, 1);assert.equal(f.calls.filter(([event]) => event === 'newContext').length, 1);assert.equal(f.calls.filter(([event]) => event === 'context-newPage').length, 1);assert.equal(f.calls.filter(([event]) => event === 'sign-in').length, 1);
  assert.equal(runtime.session.adapter.page, f.popup);assert.equal(f.config().username, f.env.AIR_ARABIA_AGENT_USERNAME);assert.equal(f.config().password, f.env.AIR_ARABIA_AGENT_PASSWORD);
  const delegated = f.calls.find(([event]) => event === 'gmail-delegate')[1];assert.equal(delegated.requestedAt, 123);assert.equal(delegated.timeoutMs, 456);assert.equal(delegated.env, f.env);
  assert.equal(runtime.session.timer, undefined);assert.equal(await runtime.session.run(async adapter => { assert.equal(adapter, runtime.session.adapter);return 'verified'; }), 'verified');
  await runtime.close();assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.doesNotMatch(JSON.stringify(f.reports), /SECRET_|123456/);
});

test('direct diagnostic validates missing or blank credentials before launching anything', async () => {
  for (const env of [{}, { AIR_ARABIA_AGENT_USERNAME: ' ' }, { AIR_ARABIA_AGENT_USERNAME: 'test-agent' }, { AIR_ARABIA_AGENT_USERNAME: 'test-agent', AIR_ARABIA_AGENT_PASSWORD: ' ' }]) {
    const f = directRuntimeFixture();await assert.rejects(f.open({ env }), error => /^[A-Z_]+$/.test(error.message));assert.equal(f.calls.length, 0);
  }
});

test('direct diagnostic serializes work, verifies authentication and drains work before closing its context', async () => {
  const f = directRuntimeFixture(), runtime = await f.open(), gate = deferred(), events = [];
  const first = runtime.session.run(async () => { events.push('first-start');await gate.promise;events.push('first-end');return 1; });
  const second = runtime.session.run(async () => { events.push('second-start');return 2; });
  for (let i = 0; i < 30; i++) await Promise.resolve();assert.deepEqual(events, ['first-start']);
  const closing = runtime.close();assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 0);
  gate.resolve();assert.equal(await first, 1);assert.equal(await second, 2);await closing;assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 1);
});

test('direct diagnostic cleanup attempts its context and browser even after cleanup fails and never returns a raw error', async () => {
  const f = directRuntimeFixture({ contextFailure: true, browserFailure: true }), runtime = await f.open();
  await assert.rejects(runtime.close(), error => /^[A-Z_]+$/.test(error.message) && !error.message.includes('SECRET_'));assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);
});

function integratedDirectFixture({ firstCloseFails = false, pending = false, interruptOnClose = true } = {}) {
  const f = directRuntimeFixture(), output = [], gate = deferred();let connected = true, closes = 0;
  f.browser.isConnected = () => connected;
  f.browser.close = async () => { f.calls.push(['browser-close']);closes++;connected = false;if (pending && interruptOnClose) gate.reject(Error('SECRET_INTERRUPTED_DOM_SENTINEL'));if (firstCloseFails && closes === 1) throw Error('SECRET_FAILED_BROWSER_CLOSE_SENTINEL'); };
  f.context.close = async () => { f.calls.push(['context-close']);if (!connected) throw Error('SECRET_CONTEXT_ALREADY_CLOSED_SENTINEL'); };
  f.dependencies.AirArabiaPortalAdapter.prototype.runCustomerQuoteVariant = async () => { f.calls.push(['search']);if (pending) return gate.promise;return { choices: { out: [{ row: 1, flight: '3L504', departure: '11 Nov 2026 09:20', arrival: '11 Nov 2026 11:50' }], back: [] } }; };
  const load = () => ({ launch: async () => { f.calls.push(['launch']);return f.browser; }, openAirArabiaRuntime: async config => {
    const runtime = await openDiagnosticRuntime(config, f.dependencies), close = runtime.close;
    runtime.close = async hints => { f.calls.push(['runtime-close-hints', hints]);return close(hints); };
    return runtime;
  } });
  return { ...f, output, gate, load };
}

test('main confirms its owned browser disconnected and avoids redundant IPC to the already closed context', async () => {
  const f = integratedDirectFixture();assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: value => f.output.push(value) }), 0);
  assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 0);
  assert.deepEqual(f.calls.find(([event]) => event === 'runtime-close-hints')[1], { browserAlreadyClosed: true });assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_COMPLETED');assert.doesNotMatch(JSON.stringify(f.output), /SECRET_/);
});

test('an actual owned-browser close failure remains a failure even when the browser reports disconnected', async () => {
  const f = integratedDirectFixture({ firstCloseFails: true });assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: value => f.output.push(value) }), 1);
  assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 1);assert.ok(f.calls.filter(([event]) => event === 'browser-close').length >= 2);assert.notEqual(f.calls.find(([event]) => event === 'runtime-close-hints')[1]?.browserAlreadyClosed, true);
  assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_FAILED');assert.doesNotMatch(JSON.stringify(f.output), /SECRET_/);
});

test('a cleanup hint cannot bypass context and browser cleanup when connection state is connected or unknown', async () => {
  for (const connection of ['connected', 'unknown']) {
    const f = directRuntimeFixture();if (connection === 'connected') f.browser.isConnected = () => true;
    const runtime = await f.open();let failure;
    try { await runtime.close({ browserAlreadyClosed: true }); } catch (error) { failure = error; }
    assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);
    if (connection === 'connected') assert.match(failure?.message || '', /^[A-Z_]+$/);
  }
});

test('pending direct work interrupted by the owned browser close drains before cleanup succeeds', async () => {
  const f = integratedDirectFixture({ pending: true });assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: value => f.output.push(value), timeoutMs: 5, cleanupMs: 50 }), 1);
  assert.equal(f.calls.filter(([event]) => event === 'search').length, 1);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 0);assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_COMPLETED');assert.ok(f.output.some(value => value.reason === 'DIAGNOSTIC_TIMED_OUT'));assert.doesNotMatch(JSON.stringify(f.output), /SECRET_/);
});

test('a confirmed disconnected owned browser can finish cleanup while its interrupted DOM task is still pending', async () => {
  const f = integratedDirectFixture({ pending: true, interruptOnClose: false });
  try {
    assert.equal(await main(args(), { ...options, env: f.env, load: f.load, write: value => f.output.push(value), timeoutMs: 5, cleanupMs: 50 }), 1);
    assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 0);assert.equal(f.output.at(-1).event, 'DIAGNOSTIC_CLEANUP_COMPLETED');
    assert.deepEqual(f.calls.find(([event]) => event === 'runtime-close-hints')[1], { browserAlreadyClosed: true });assert.ok(!f.output.some(value => value.event === 'DIAGNOSTIC_DISCOVERY_CONFIRMED'));
    const count = f.output.length;f.gate.resolve({ choices: { out: [], back: [] } });for (let i = 0; i < 40; i++) await Promise.resolve();assert.equal(f.output.length, count);
  } finally { f.gate.resolve({ choices: { out: [], back: [] } }); }
});

test('an unknown browser connection state cannot skip draining pending work even with a cleanup hint', async () => {
  const f = directRuntimeFixture(), runtime = await f.open(), gate = deferred();let settled = false;
  const work = runtime.session.run(async () => gate.promise);for (let i = 0; i < 20; i++) await Promise.resolve();
  const closing = runtime.close({ browserAlreadyClosed: true }).then(() => { settled = true; });
  for (let i = 0; i < 30; i++) await Promise.resolve();assert.equal(settled, false);assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 0);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 0);
  gate.resolve('drained');assert.equal(await work, 'drained');await closing;assert.equal(settled, true);assert.equal(f.calls.filter(([event]) => event === 'context-close').length, 1);assert.equal(f.calls.filter(([event]) => event === 'browser-close').length, 1);
});
