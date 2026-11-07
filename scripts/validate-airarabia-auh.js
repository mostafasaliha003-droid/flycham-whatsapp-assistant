#!/usr/bin/env node
'use strict';

// One-off operator diagnostic, never part of the running worker or server.
// Stage reviewed src/ beside this script in /tmp and make the existing
// node_modules available there. Run only after the existing AA browser has
// been confirmed closed; this script cannot inspect or control that process.
// No polling, queue claim/completion, WhatsApp send, booking or payment occurs.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function readCgroupMemory() {
  for (const [usageFile, limitFile] of [
    ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
    ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes'],
  ]) {
    let usage, limit;
    try { usage = fs.readFileSync(usageFile, 'utf8').trim();limit = fs.readFileSync(limitFile, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') continue;throw Error('DIAGNOSTIC_MEMORY_UNAVAILABLE'); }
    if (!/^\d+$/.test(usage) || !/^\d+$/.test(limit)) throw Error('DIAGNOSTIC_MEMORY_UNAVAILABLE');
    const sample = { usageBytes: Number(usage), limitBytes: Number(limit) };
    if (!Number.isSafeInteger(sample.usageBytes) || sample.usageBytes < 0 || !Number.isSafeInteger(sample.limitBytes) || sample.limitBytes <= 0) throw Error('DIAGNOSTIC_MEMORY_UNAVAILABLE');
    return sample;
  }
  throw Error('DIAGNOSTIC_MEMORY_UNAVAILABLE');
}

function parseArgs(argv, { now = Date.now, realpath = fs.realpathSync } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--source-root', '--date', '--price', '--max-memory-percent', '--origin'].includes(key) || Object.hasOwn(options, key) || typeof value !== 'string' || value.startsWith('--')) throw Error('DIAGNOSTIC_ARGUMENTS_INVALID');
    options[key] = value;
  }
  if (!options['--source-root'] || !path.isAbsolute(options['--source-root'])) throw Error('DIAGNOSTIC_STAGING_REQUIRED');
  let sourceRoot;
  try { sourceRoot = realpath(options['--source-root']); } catch { throw Error('DIAGNOSTIC_STAGING_REQUIRED'); }
  if (typeof sourceRoot !== 'string' || !sourceRoot.startsWith('/tmp/') || sourceRoot === '/tmp/' || sourceRoot.includes('\0')) throw Error('DIAGNOSTIC_STAGING_REQUIRED');
  const date = options['--date'];
  const instant = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T00:00:00Z') : null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
  if (!instant || !Number.isFinite(+instant) || instant.toISOString().slice(0, 10) !== date || date <= today) throw Error('DIAGNOSTIC_FUTURE_DATE_REQUIRED');
  const row = options['--price'];
  if (row !== undefined && (!/^[1-9]\d{0,2}$/.test(row) || Number(row) > 200)) throw Error('DIAGNOSTIC_PRICE_ROW_INVALID');
  const percent = options['--max-memory-percent'];
  if (percent !== undefined && (!/^\d{2}$/.test(percent) || Number(percent) < 75 || Number(percent) > 85)) throw Error('DIAGNOSTIC_ARGUMENTS_INVALID');
  const origin = options['--origin'] === undefined ? 'AUH' : options['--origin'];
  if (!['AUH', 'SHJ'].includes(origin)) throw Error('DIAGNOSTIC_ARGUMENTS_INVALID');
  return { sourceRoot, date, origin, priceRow: row === undefined ? null : Number(row), maxMemoryPercent: percent === undefined ? 75 : Number(percent) };
}

// Execute inside an explicitly trusted AA search frame. Never returns source
// objects, arbitrary keys/text, RPHs, session URLs, account or passenger fields.
function inspectSearchModelAction() {
  if (location.origin !== 'https://agents.airarabia.com') return { available: false, reason: 'UNTRUSTED' };
  const ui = typeof UI_tabSearchFlights === 'undefined' ? null : UI_tabSearchFlights;
  if (!ui || typeof ui !== 'object') return { available: false, reason: 'NO_SEARCH_MODEL' };
  const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const size = value => Array.isArray(value) ? Math.min(value.length, 10000) : null;
  const date = value => typeof value === 'string' && (/^\d{2}\/\d{2}\/\d{4}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) ? value : null;
  const airport = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
  const route = value => typeof value === 'string' && /^[A-Z]{3}(?:\/[A-Z]{3}){1,7}$/.test(value) ? value : null;
  const carrier = value => typeof value === 'string' && /^[A-Z0-9]{2}$/.test(value) ? value : null;
  const flight = value => typeof value === 'string' && /^[A-Z0-9]{2}[ -]?\d{1,4}$/.test(value) ? value.replace(/[ -]/g, '') : null;
  const count = value => Number.isInteger(value) && value >= 0 && value <= 9 ? value : typeof value === 'string' && /^[0-9]$/.test(value) ? Number(value) : null;
  const currency = value => ['AED', 'USD', 'EUR', 'GBP', 'SAR'].includes(value) ? value : null;
  const searchSystem = value => ['AA', 'INT', '3L', 'G9', 'XH'].includes(value) ? value : null;
  const schema = value => ({ kind: kind(value), length: typeof value === 'string' ? Math.min(value.length, 10000) : size(value) });
  const sample = (value, sanitize) => Array.isArray(value) ? value.slice(0, 8).map(item => ({ kind: kind(item), value: sanitize(item) })) : [];
  const timing = value => {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!match || +match[2] < 1 || +match[2] > 12 || +match[3] < 1 || +match[3] > 31 || +match[4] > 23 || +match[5] > 59) return null;
    return { format: 'YYMMDDHHmm', date: '20' + match[1] + '-' + match[2] + '-' + match[3], time: match[4] + ':' + match[5] };
  };
  const reference = value => {
    if (typeof value !== 'string') return { kind: kind(value) };
    const parts = value.split('$'), token = parts[3], match = typeof token === 'string' && token.match(/^(\d{4})(\d{2})(\d{2})/);
    const datePrefixes = parts.slice(0, 16).flatMap((part, index) => { const date = part.match(/^((?:20)\d{2})(\d{2})(\d{2})/);return date && +date[2] >= 1 && +date[2] <= 12 && +date[3] >= 1 && +date[3] <= 31 ? [{ part: index, date: date[1] + '-' + date[2] + '-' + date[3] }] : []; });
    return { kind: 'string', length: Math.min(value.length, 10000), delimiterParts: Math.min(parts.length, 100), datePrefix: match ? match[1] + '-' + match[2] + '-' + match[3] : null, datePrefixes };
  };
  const rows = value => ({ kind: kind(value), length: size(value), sample: Array.isArray(value) ? value.slice(0, 3).map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { kind: kind(row) };
    const fields = {};
    for (const key of ['segmentCodeList', 'flightNoList', 'carrierList', 'depatureTimeList', 'arrivalTimeList', 'flightRPHList', 'csOcCarrierList']) fields[key] = schema(row[key]);
    return { fields, routes: sample(row.segmentCodeList, route), flights: sample(row.flightNoList, flight), carriers: sample(row.carrierList, carrier), departures: sample(row.depatureTimeList, timing), references: Array.isArray(row.flightRPHList) ? row.flightRPHList.slice(0, 8).map(reference) : [] };
  }) : [] });
  const response = ui.latestResponse, params = ui.objResSrchParams;
  const out = typeof jsonOutFlts === 'undefined' ? undefined : jsonOutFlts;
  const back = typeof jsonRetFlts === 'undefined' ? undefined : jsonRetFlts;
  const parameters = {};
  const sanitizers = { fromAirport: airport, toAirport: airport, departureDate: date, returnDate: date, adultCount: count, childCount: count, infantCount: count, selectedCurrency: currency, searchSystem };
  for (const [key, sanitize] of Object.entries(sanitizers)) parameters[key] = { ...schema(params?.[key]), value: sanitize(params?.[key]) };
  return {
    available: true,
    timestamps: { start: kind(ui.searchStartTime), end: kind(ui.searchEndTime), ordered: Number.isSafeInteger(ui.searchStartTime) && Number.isSafeInteger(ui.searchEndTime) && ui.searchEndTime >= ui.searchStartTime },
    ajaxIdle: typeof jQuery !== 'undefined' && jQuery.active === 0,
    response: { kind: kind(response), successKind: kind(response?.success), success: typeof response?.success === 'boolean' ? response.success : null, paramsSame: Boolean(params && params === response?.searchParams), outSame: Array.isArray(out) && out === response?.outboundFlights, backSame: Array.isArray(back) && back === response?.returnFlights, outboundKind: kind(response?.outboundFlights), returnKind: kind(response?.returnFlights) },
    parameters, outbound: rows(out), inbound: rows(back),
    uiDates: { outbound: date(ui.strOutDate), inbound: date(ui.strRetDate), inboundKind: kind(ui.strRetDate) },
    selectedInfo: { kind: kind(ui.flightInfo), length: size(ui.flightInfo) },
  };
}

function safeChoices(choices) {
  const flight = value => typeof value === 'string' && /^(?:G9|3L)\s*\d{1,4}$/.test(value) ? value.replace(/\s/g, '') : null;
  const time = value => typeof value === 'string' && /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\d{1,2}[ ./-]*[A-Za-z]{3}[ ./-]*(?:\d{4}|\d{2})\s+\d{1,2}:\d{2}$/.test(value.trim()) ? value.trim() : null;
  const read = rows => Array.isArray(rows) ? rows.slice(0, 20).map(row => ({ row: Number.isInteger(row?.row) && row.row >= 1 && row.row <= 200 ? row.row : null, flight: flight(row?.flight), departure: time(row?.departure), arrival: time(row?.arrival) })) : [];
  return { out: read(choices?.out), back: read(choices?.back) };
}

function safeWeights(weights, { minimumKg = 0 } = {}) {
  if (!Number.isFinite(minimumKg) || minimumKg < 0 || minimumKg > 100 || !Array.isArray(weights) || !weights.length || weights.length > 16) throw Error('PRICE_NOT_VERIFIED');
  return Array.from(weights, weight => {
    const segmentsCount = Array.isArray(weight?.segments) ? weight.segments.length : null;
    if (!Number.isSafeInteger(segmentsCount) || segmentsCount < 1 || segmentsCount > 16 || !Number.isFinite(weight?.kg) || weight.kg < minimumKg || weight.kg > 100) throw Error('PRICE_NOT_VERIFIED');
    return { segmentsCount, kg: weight.kg };
  });
}

function safeLoginShape(value) {
  const prefix = 'PORTAL_LOGIN_DIAGNOSTIC_';
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 8192) return null;
  let source;try { source = JSON.parse(value.slice(prefix.length)); } catch { return null; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const shape = { event: 'DIAGNOSTIC_LOGIN_SHAPE', route: source.route === 'PRIVATE' ? 'PRIVATE' : ['PUBLIC', 'LOGIN', 'LOGIN_HANDLER'].includes(source.route) ? 'PUBLIC' : 'OTHER' };
  if (Number.isInteger(source.frames) && source.frames >= 0 && source.frames <= 100) shape.frames = source.frames;
  for (const key of ['bodyHidden', 'loginInput', 'passwordInput', 'signOutText', 'reservationText', 'signOutNamedControl', 'reservationNamedControl', 'verification', 'accessDenied', 'invalidCredentials', 'passwordChange', 'sessionNotice']) {
    if (typeof source[key] === 'boolean') shape[key] = source[key];
  }
  return shape;
}

const SIMPLE_EVENTS = new Set([
  'PORTAL_STAGE_BROWSER_START', 'PORTAL_STAGE_OPEN_LOGIN_PAGE', 'PORTAL_STAGE_LOGIN_FORM', 'PORTAL_STAGE_LOGIN_SUBMIT', 'PORTAL_STAGE_LOGIN_CONFIRM', 'PORTAL_LOGIN_WINDOW_SELECTED', 'PORTAL_LOGIN_FORM_REACQUIRED',
  'PORTAL_VERIFICATION_WAITING_FOR_OPERATOR', 'PORTAL_VERIFICATION_SUBMITTED', 'PORTAL_VERIFICATION_RESULT_UNCONFIRMED', 'PORTAL_VERIFICATION_RESULT_CONFIRMED', 'PORTAL_VERIFICATION_RESULT_EXPIRED', 'PORTAL_VERIFICATION_RESULT_INVALID_CODE', 'PORTAL_AUTHENTICATED',
  'PORTAL_STAGE_INITIAL_HEARTBEAT', 'PORTAL_HEARTBEAT_REFRESH_COMPLETED', 'PORTAL_PROTECTED_HEALTH_CONFIRMED', 'PORTAL_RESERVATION_SEARCH_OPENED', 'PORTAL_RESERVATION_SEARCH_FORM_CONFIRMED',
  'PORTAL_PARTIAL_LOGIN_RECOVERY_STARTED', 'PORTAL_PARTIAL_LOGIN_RECOVERY_CONFIRMED', 'PORTAL_PARTIAL_LOGIN_RECOVERY_NOT_CONFIRMED', 'PORTAL_LOGIN_DIAGNOSTIC_FRAME_UNAVAILABLE',
  'PORTAL_SEARCH_SUBMIT_STARTED', 'PORTAL_SEARCH_SUBMIT_COMPLETED', 'PORTAL_QUOTE_WAITING_FOR_FLIGHT_RESULTS', 'PORTAL_QUOTE_FLIGHT_RESULTS_READY', 'PORTAL_QUOTE_TIMING_FARE_CONFIRMED',
  'PORTAL_SEARCH_CARRIER_3L_EXPLICIT_SELECTED', 'PORTAL_SEARCH_CARRIER_3L_SEARCH_ALL_SELECTED', 'PORTAL_SEARCH_CARRIER_3L_EXPLICIT_RESELECTED', 'PORTAL_SEARCH_CARRIER_3L_SEARCH_ALL_RESELECTED', 'PORTAL_SEARCH_CARRIER_3L_EXPLICIT_CONFIRMED', 'PORTAL_SEARCH_CARRIER_3L_SEARCH_ALL_CONFIRMED',
  'PORTAL_SEARCH_IDENTITY_CONFIRMED', 'PORTAL_SEARCH_IDENTITY_INCOMPLETE', 'PORTAL_SEARCH_IDENTITY_RESPONSE', 'PORTAL_SEARCH_IDENTITY_PARAMETERS', 'PORTAL_SEARCH_IDENTITY_ARRAY_BINDING', 'PORTAL_SEARCH_IDENTITY_ROUTE', 'PORTAL_SEARCH_IDENTITY_DATE', 'PORTAL_SEARCH_IDENTITY_PARTY', 'PORTAL_SEARCH_IDENTITY_CURRENCY', 'PORTAL_SEARCH_IDENTITY_SEARCH_SYSTEM', 'PORTAL_SEARCH_IDENTITY_ROWS', 'PORTAL_SEARCH_IDENTITY_ROW_ROUTE', 'PORTAL_SEARCH_IDENTITY_ROW_DATE', 'PORTAL_SEARCH_IDENTITY_ROW_CARRIER', 'PORTAL_SEARCH_IDENTITY_CODESHARE', 'PORTAL_SEARCH_IDENTITY_SELECTED_REFERENCES',
]);
const FAILURES = new Set(['DIAGNOSTIC_ARGUMENTS_INVALID', 'DIAGNOSTIC_STAGING_REQUIRED', 'DIAGNOSTIC_FUTURE_DATE_REQUIRED', 'DIAGNOSTIC_PRICE_ROW_INVALID', 'DIAGNOSTIC_RUNTIME_INVALID', 'DIAGNOSTIC_ONE_BROWSER_ONLY', 'DIAGNOSTIC_TIMED_OUT', 'DIAGNOSTIC_MEMORY_PRESSURE', 'DIAGNOSTIC_MEMORY_UNAVAILABLE', 'DIAGNOSTIC_PRICE_ROW_UNAVAILABLE', 'SEARCH_IDENTITY_UNVERIFIED', 'NO_FLIGHTS_CONFIRMED', 'SEARCH_CARRIER_NOT_CONFIRMED', 'SEARCH_INPUTS_NOT_CONFIRMED', 'SEARCH_OPTION_NOT_CONFIRMED', 'AIRPORT_SELECTION_NOT_CONFIRMED', 'SEARCH_NOT_READY', 'PRICE_NOT_VERIFIED', 'TEMPORARY_BLOCK_NOT_DISABLED', 'TRIP_NOT_CONFIRMED', 'ONE_WAY_NOT_CONFIRMED']);
function failureCode(error) {
  const value = typeof error?.message === 'string' ? error.message : '';
  if (FAILURES.has(value)) return value;
  if (/^PORTAL_(?:CONFIGURATION|BROWSER_START|OPEN_LOGIN_PAGE|LOGIN_FORM|LOGIN_SUBMIT|LOGIN_CONFIRM|VERIFICATION|SESSION)_(?:TIMEOUT|NETWORK|TLS|HTTP_ERROR|MANUAL_VERIFICATION|LOGIN_NOT_CONFIRMED|MISSING_USERNAME|MISSING_PASSWORD|UNEXPECTED|VERIFICATION_TIMEOUT|VERIFICATION_REJECTED|VERIFICATION_EXPIRED|VERIFICATION_NOT_CONFIRMED|VERIFIED_NAVIGATION_PENDING|FRAME_CHANGED|SELECTOR_AMBIGUOUS|TYPE_ERROR|VERIFICATION_FORM_UNAVAILABLE|CLOSE_FAILED)$/.test(value)) return value;
  return 'DIAGNOSTIC_FAILED';
}

// The temporary diagnostic deliberately omits the production session's
// initial protected refresh and heartbeat: the quote variant refreshes before
// each actual search. Keep the launcher's explicit context alive for popups.
async function openDiagnosticRuntime({ env, launch, log }, { AirArabiaPortalAdapter, waitForAirArabiaCode }) {
  const secret = name => {
    const value = env[name];
    if (!value?.trim()) throw Error('PORTAL_CONFIGURATION_' + (name.endsWith('USERNAME') ? 'MISSING_USERNAME' : 'MISSING_PASSWORD'));
    return value;
  };
  const username = secret('AIR_ARABIA_AGENT_USERNAME'), password = secret('AIR_ARABIA_AGENT_PASSWORD');
  let browser, context, adapter, closed = false, closing, tail = Promise.resolve();
  const close = ({ browserAlreadyClosed = false } = {}) => {
    if (!closing) {
      closed = true;
      closing = (async () => {
        // Only the owner that successfully closed this exact browser may
        // supply the hint. Once disconnected, no pending DOM-loop tail can
        // act; the one-off CLI exits and suppresses its late output. Without
        // both proofs, preserve normal draining and all cleanup attempts.
        let confirmedClosed = false;
        try { confirmedClosed = browserAlreadyClosed === true && typeof browser?.isConnected === 'function' && browser.isConnected() === false; } catch {}
        if (confirmedClosed) return;
        await tail;
        let failed = false;
        try { if (context) await context.close(); } catch { failed = true; }
        try { if (browser) await browser.close();if (typeof browser?.isConnected === 'function' && browser.isConnected()) failed = true; } catch { failed = true; }
        if (failed) throw Error('PORTAL_SESSION_CLOSE_FAILED');
      })();
    }
    return closing;
  };
  try {
    log.log('PORTAL_STAGE_BROWSER_START');
    browser = await launch({ headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    adapter = new AirArabiaPortalAdapter(page, {
      username, password, origin: env.AIR_ARABIA_KEEPALIVE_ORIGIN || 'SHJ', destination: env.AIR_ARABIA_KEEPALIVE_DESTINATION || 'DAM',
      report: code => log.log(code), verificationProvider: options => waitForAirArabiaCode({ ...options, env }),
    });
    await adapter.signIn();
    if (!await adapter.isAuthenticated()) throw Error('PORTAL_SESSION_LOGIN_NOT_CONFIRMED');
    const session = { adapter, run(task) {
      if (closed) return Promise.reject(Error('PORTAL_SESSION_CLOSE_FAILED'));
      const work = tail.then(async () => {
        if (!await adapter.isAuthenticated()) throw Error('PORTAL_SESSION_LOGIN_NOT_CONFIRMED');
        const result = await task(adapter);
        if (!await adapter.isAuthenticated()) throw Error('PORTAL_SESSION_LOGIN_NOT_CONFIRMED');
        return result;
      });
      tail = work.catch(() => {});
      return work;
    } };
    return { session, browser, close };
  } catch (error) { await close();throw error; }
}

function loadRuntime(sourceRoot) {
  const worker = path.join(sourceRoot, 'src', 'airarabia-worker.js');
  if (!fs.realpathSync(worker).startsWith(sourceRoot + path.sep)) throw Error('DIAGNOSTIC_STAGING_REQUIRED');
  const stagedRequire = createRequire(worker);
  const { AirArabiaPortalAdapter } = stagedRequire(worker);
  const { waitForAirArabiaCode } = stagedRequire(path.join(sourceRoot, 'src', 'gmail-verification-provider.js'));
  if (typeof AirArabiaPortalAdapter !== 'function' || typeof waitForAirArabiaCode !== 'function') throw Error('DIAGNOSTIC_RUNTIME_INVALID');
  const { chromium } = stagedRequire('playwright');
  return { openAirArabiaRuntime: options => openDiagnosticRuntime(options, { AirArabiaPortalAdapter, waitForAirArabiaCode }), launch: options => chromium.launch(options) };
}

async function main(argv, { env = process.env, write = value => process.stdout.write(JSON.stringify(value) + '\n'), load = loadRuntime, now = Date.now, realpath = fs.realpathSync, readMemory = readCgroupMemory, timeoutMs = 12 * 60000, cleanupMs = 10000 } = {}) {
  let config, runtime, browser, launchPromise, launched = false, closing = false, timedOut = false, memoryAborted = false, memoryReason = null, memoryFailure = null, pressure = null, timer, memoryTimer, rejectMemory;
  const stopped = () => closing || timedOut || memoryAborted;
  const emit = value => { if (!closing) write(value); };
  const checkMemory = () => {
    let sample;try { sample = readMemory(); } catch { throw Error('DIAGNOSTIC_MEMORY_UNAVAILABLE'); }
    if (!sample || !Number.isSafeInteger(sample.usageBytes) || sample.usageBytes < 0 || !Number.isSafeInteger(sample.limitBytes) || sample.limitBytes <= 0) throw Error('DIAGNOSTIC_MEMORY_UNAVAILABLE');
    if (sample.usageBytes / sample.limitBytes >= config.maxMemoryPercent / 100) {
      pressure = { usageBytes: sample.usageBytes, limitBytes: sample.limitBytes, usagePercent: Number((sample.usageBytes / sample.limitBytes * 100).toFixed(2)), thresholdPercent: config.maxMemoryPercent };
      throw Error('DIAGNOSTIC_MEMORY_PRESSURE');
    }
    return sample;
  };
  const bounded = (promise, ms) => { let timeout;return Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('DIAGNOSTIC_TIMED_OUT')), ms); })]).finally(() => clearTimeout(timeout)); };
  try {
    config = parseArgs(argv, { now, realpath });
    const memory = checkMemory();
    emit({ event: 'DIAGNOSTIC_MEMORY_BUDGET_CONFIRMED', usageBytes: memory.usageBytes, limitBytes: memory.limitBytes, thresholdPercent: config.maxMemoryPercent });
    const dependencies = load(config.sourceRoot);
    const report = value => { const shape = safeLoginShape(value);if (shape) emit(shape);else if (SIMPLE_EVENTS.has(value)) emit({ event: value }); };
    const log = { log: report, error: report };
    emit({ event: 'DIAGNOSTIC_STARTED', origin: config.origin, destination: 'DAM', date: config.date, adults: 1, mode: config.priceRow === null ? 'discovery' : 'explicit_row_price', priceRow: config.priceRow });
    memoryFailure = new Promise((_, reject) => { rejectMemory = reject; });
    const operation = (async () => {
      runtime = await dependencies.openAirArabiaRuntime({
        env: { ...env, AIR_ARABIA_KEEPALIVE_ORIGIN: config.origin, AIR_ARABIA_KEEPALIVE_DESTINATION: 'DAM', AIR_ARABIA_INSPECT_SEARCH_UI: 'false' }, log,
        launch: async options => {
          if (launched || stopped()) throw Error('DIAGNOSTIC_ONE_BROWSER_ONLY');
          checkMemory();
          launched = true;
          memoryTimer = setInterval(() => {
            if (stopped()) return;
            try { checkMemory(); } catch (error) { memoryAborted = true;memoryReason = error.message;rejectMemory(error); }
          }, config.maxMemoryPercent > 75 ? 250 : 1000);
          launchPromise = Promise.resolve().then(() => dependencies.launch({ ...options, timeout: 30000 })).then(async ownedBrowser => {
            browser = ownedBrowser;
            if (stopped()) { await browser.close();throw Error(memoryAborted ? memoryReason : 'DIAGNOSTIC_TIMED_OUT'); }
            return browser;
          });
          return launchPromise;
        },
      });
      if (stopped()) return;
      const request = { provider: 'airarabia', origin: config.origin, destination: 'DAM', departureDate: config.date, tripType: 'one_way', passengers: { adults: 1, children: 0, infants: 0 }, baggageRequest: { checkedWeightKg: 30, requestedByCustomer: false, source: 'default30' } };
      const discovery = await runtime.session.run(portal => portal.runCustomerQuoteVariant(request, null, true));
      if (stopped()) return;
      emit({ event: 'DIAGNOSTIC_DISCOVERY_CONFIRMED', choices: safeChoices(discovery.choices) });
      if (config.priceRow !== null) {
        const choice = discovery.choices?.out?.find(row => row.row === config.priceRow);
        if (!choice) throw Error('DIAGNOSTIC_PRICE_ROW_UNAVAILABLE');
        const quote = await runtime.session.run(portal => portal.runCustomerQuoteVariant(request, { out: choice, back: null }, false));
        if (stopped()) return;
        if (quote.price?.currency !== 'AED' || !/^\d{1,8}\.\d{2}$/.test(quote.price.sellingTotal || '')) throw Error('PRICE_NOT_VERIFIED');
        emit({ event: 'DIAGNOSTIC_PRICE_CONFIRMED', currency: 'AED', sellingTotal: quote.price.sellingTotal, weights: safeWeights(quote.price.weights, { minimumKg: request.baggageRequest.checkedWeightKg }), timing: safeChoices({ out: [quote.timing?.out] }) });
      }
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true;reject(Error('DIAGNOSTIC_TIMED_OUT')); }, timeoutMs); });
    await Promise.race([operation, timeout, memoryFailure]);
    if (memoryAborted) throw Error(memoryReason);
    emit({ event: 'DIAGNOSTIC_COMPLETED' });
    return 0;
  } catch (error) {
    const reason = failureCode(error);
    emit({ event: 'DIAGNOSTIC_UNVERIFIED', reason, ...(reason === 'DIAGNOSTIC_MEMORY_PRESSURE' && pressure ? pressure : {}) });
    if (!timedOut && !memoryAborted && runtime?.session?.adapter?.searchFrame) {
      try {
        const capture = bounded(runtime.session.adapter.searchFrame.evaluate(inspectSearchModelAction), 4000);
        const model = await Promise.race([capture, memoryFailure]);
        if (!stopped()) emit({ event: 'DIAGNOSTIC_MODEL_SHAPE', model });
      } catch {
        if (memoryAborted) emit({ event: 'DIAGNOSTIC_UNVERIFIED', reason: memoryReason, ...(memoryReason === 'DIAGNOSTIC_MEMORY_PRESSURE' && pressure ? pressure : {}) });
        else emit({ event: 'DIAGNOSTIC_MODEL_UNAVAILABLE' });
      }
    }
    return 1;
  } finally {
    clearTimeout(timer);clearInterval(memoryTimer);closing = true;
    let cleanupFailed = false, browserAlreadyClosed = false;
    // Closing our own browser first interrupts hung DOM calls. The factory's
    // close then drains its session. This never targets the running worker.
    try { if (launchPromise && !browser) await bounded(launchPromise.catch(() => {}), cleanupMs); } catch { cleanupFailed = true; }
    try {
      if (browser) {
        await bounded(Promise.resolve().then(() => browser.close()), cleanupMs);
        browserAlreadyClosed = typeof browser.isConnected === 'function' && browser.isConnected() === false;
        if (typeof browser.isConnected === 'function' && !browserAlreadyClosed) cleanupFailed = true;
      }
    } catch { cleanupFailed = true; }
    try { if (runtime) await bounded(Promise.resolve().then(() => runtime.close({ browserAlreadyClosed })), cleanupMs); } catch { cleanupFailed = true; }
    write({ event: cleanupFailed ? 'DIAGNOSTIC_CLEANUP_FAILED' : 'DIAGNOSTIC_CLEANUP_COMPLETED' });
    if (cleanupFailed) return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), () => process.exit(1));
module.exports = { parseArgs, inspectSearchModelAction, safeChoices, safeWeights, safeLoginShape, main, failureCode, readCgroupMemory, openDiagnosticRuntime };
