'use strict';
const { airportSuggestionAction } = require('./airport-suggestions');

// The supplier's legacy autocomplete may store a display-form value (for
// example, "SHJ - Sharjah") instead of the bare IATA code. Accept only an
// exact IATA token for the requested airport and reject the other probe IATA.
// Never infer a code from a city name or a partial match.
function airportCodeConfirmed(value, code) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return false;
  const hasToken = token => new RegExp(`(?:^|[^A-Z])${token}(?:$|[^A-Z])`).test(normalized);
  const other = code === 'SHJ' ? 'DAM' : 'SHJ';
  return hasToken(code) && !hasToken(other);
}

// A bounded synthetic search only; this module has no booking/passenger actions.
async function chooseAirport(frame, inputId, hiddenId, code, { now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), lookupMs = 10000, report = () => {} } = {}) {
  const names = { SHJ: 'Sharjah', DAM: 'Damascus' };
  if (!names[code] || !['fAirport', 'tAirport'].includes(inputId) || hiddenId !== (inputId === 'fAirport' ? 'fromAirport' : 'toAirport')) throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
  const field = frame.locator(`#${inputId}`);
  // Key events are needed by legacy autocomplete widgets. Two bounded queries:
  // exact IATA code, then city name if the supplier does not search by code.
  for (const query of [code, names[code]]) {
    await field.fill('');
    await field.pressSequentially(query, { delay: 120 });
    const deadline = now() + lookupMs;
    let lastState;
    do {
      const state = await frame.evaluate(airportSuggestionAction, { inputId, code, operation: 'inspect' });
      if (['READY','NONE','AMBIGUOUS','INPUT_UNAVAILABLE'].includes(state?.status) && state.status !== lastState) {
        lastState = state.status;
        report(`PORTAL_AIRPORT_MENU_${state.status}`);
      }
      if (state?.status === 'AMBIGUOUS') throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
      if (state?.status === 'READY') {
        const handle = await frame.evaluateHandle(airportSuggestionAction, { inputId, code, operation: 'resolve' });
        try {
          const element = handle.asElement();
          if (!element) throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
          await element.click({ timeout: 15000 });
          report('PORTAL_AIRPORT_POINTER_CLICK_COMPLETED');
        } finally { await handle.dispose(); }
        const confirmDeadline = now() + Math.min(lookupMs, 5000);
        do {
          if (airportCodeConfirmed(await frame.locator(`#${hiddenId}`).inputValue(), code)) return;
          if (now() >= confirmDeadline) break;
          await pause(100);
        } while (now() < confirmDeadline);
        const actual = (await frame.locator(`#${hiddenId}`).inputValue()).trim();
        report(!actual ? 'PORTAL_AIRPORT_CODE_EMPTY' : /^[A-Za-z]{3}$/.test(actual) ? 'PORTAL_AIRPORT_CODE_OTHER_AIRPORT' : 'PORTAL_AIRPORT_CODE_OTHER_FORMAT');
        throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
      }
      if (state?.status && !['NONE'].includes(state.status)) throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
      if (now() >= deadline) break;
      await pause(200);
    } while (now() < deadline);
  }
  throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
}

async function prepareSearch(frame, { origin, destination, departureDate, requestedReturnDate, requestTripType, report = () => {} }) {
  if (!['SHJ', 'DAM'].includes(origin) || !['SHJ', 'DAM'].includes(destination) || origin === destination) throw new Error('UNSUPPORTED_PROBE_ROUTE');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(departureDate)) throw new Error('INVALID_PROBE_DATE');
  // Use the actual visible radio label, never guess the supplier's enum value.
  report('PORTAL_PROBE_STAGE_TRIP_MODE');
  const oneWay = requestTripType === 'round_trip' ? -1 : await frame.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name="searchType"][type="radio"]'));
    const isOneWay = text => /^one[\s\-\u2010-\u2015]*way$/i.test(text.replace(/\s+/g, ' ').trim());
    const matches = radios.map((radio, index) => {
      // Legacy pages use loose table/text labels and duplicate IDs. Read the
      // actual adjacent label, stopping at the next control; do not infer an
      // enum value from its letter or use a duplicated label-for association.
      const labels = [radio.getAttribute('aria-label') || '', radio.getAttribute('title') || ''];
      const wrapped = radio.closest('label');
      if (wrapped && wrapped.querySelectorAll('input[type="radio"]').length === 1) labels.push(wrapped.textContent || '');
      if (document.querySelectorAll('[id="' + radio.id + '"]').length === 1) labels.push(...Array.from(radio.labels || []).map(label => label.textContent || ''));
      const root = radio.form || document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      walker.currentNode = radio;
      let nearby = '';
      for (let visited = 0; visited < 40 && walker.nextNode(); visited++) {
        const node = walker.currentNode;
        if (node.nodeType === 1 && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(node.tagName)) break;
        if (node.nodeType !== 3 || node.parentElement?.closest('script,style,noscript')) continue;
        const style = getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden' || !node.parentElement.getClientRects().length) continue;
        nearby += ' ' + node.textContent;
        labels.push(nearby);
        if (nearby.length > 80) break;
      }
      return labels.some(isOneWay) && !radio.disabled ? index : -1;
    }).filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  });
  let returnDate = null;
  if (Number.isInteger(oneWay) && oneWay >= 0) {
    await frame.locator('input[name="searchType"][type="radio"]').nth(oneWay).check();
  } else {
    // Preserve the observed existing default R; never guess which enum means
    // one-way. A synthetic return search can exercise the ordinary date form.
    const defaultReturn = await frame.evaluate(({ operation }) => {
      if (operation !== 'default-return') return false;
      const checked = document.querySelectorAll('input[name="searchType"][type="radio"]:checked');
      const returns = document.querySelectorAll('[id="returnDate"]');
      if (checked.length !== 1 || checked[0].value !== 'R' || returns.length !== 1) return false;
      const field = returns[0], style = getComputedStyle(field);
      return !field.disabled && !field.readOnly && style.display !== 'none' && style.visibility !== 'hidden' && field.getClientRects().length > 0;
    }, { operation: 'default-return' });
    if (defaultReturn !== true) throw new Error('ONE_WAY_CONTROL_NOT_CONFIRMED');
    const [day, month, year] = departureDate.split('/').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + 7));
    returnDate = requestTripType==='one_way'?'':requestedReturnDate || `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
    if (requestTripType==='round_trip' && !/^\d{2}\/\d{2}\/\d{4}$/.test(requestedReturnDate || '')) throw new Error('SEARCH_INPUTS_NOT_CONFIRMED');
  }
  report('PORTAL_PROBE_STAGE_ORIGIN');
  await chooseAirport(frame, 'fAirport', 'fromAirport', origin, { report });
  report('PORTAL_PROBE_STAGE_DESTINATION');
  await chooseAirport(frame, 'tAirport', 'toAirport', destination, { report });
  report('PORTAL_PROBE_STAGE_DATES_AND_COUNTS');
  await frame.locator('#departureDate').fill(departureDate);
  if (returnDate!==null) await frame.locator('#returnDate').fill(returnDate);
  await frame.locator('#adultCount').fill('1');
  await frame.locator('#childCount').fill('0');
  await frame.locator('#infantCount').fill('0');
  // Choose existing supplier options by their observed names; unknown forms stop.
  report('PORTAL_PROBE_STAGE_SUPPLIER_OPTIONS');
  for (const [id, pattern] of [
    ['selectedCurrency', '^AED$'],
    ['classOfService', '^Economy(?:\\s*Class)?$'],
    ['selSearchOptions', '^(?:Air\\s*Arabia(?:\\s*\\(G9\\))?|G9|Search\\s*G9)$'],
    ['bookingType', '^Normal$'],
  ]) {
    const option = await frame.evaluate(({ id, pattern }) => {
      const select = document.getElementById(id);
      if (!select || select.tagName !== 'SELECT') return null;
      const regex = new RegExp(pattern, 'i');
      const matches = Array.from(select.options).filter(item => !item.disabled && (regex.test(item.textContent.trim()) || regex.test(item.value)));
      return matches.length === 1 ? matches[0].value : null;
    }, { id, pattern });
    if (option === null) throw new Error('SEARCH_OPTION_NOT_CONFIRMED');
    await frame.locator(`#${id}`).selectOption(option);
  }
  report('PORTAL_PROBE_STAGE_VALIDATE_INPUTS');
  const validation = await frame.evaluate(({ origin, destination, departureDate, returnDate }) => {
    const value = id => document.getElementById(id)?.value;
    const hasCode = (raw, code) => {
      const normalized = String(raw || '').trim().toUpperCase();
      const hasToken = token => new RegExp(`(?:^|[^A-Z])${token}(?:$|[^A-Z])`).test(normalized);
      const other = code === 'SHJ' ? 'DAM' : 'SHJ';
      return hasToken(code) && !hasToken(other);
    };
    return hasCode(value('fromAirport'), origin) && hasCode(value('toAirport'), destination)
      && value('departureDate') === departureDate && value('adultCount') === '1'
      && value('childCount') === '0' && value('infantCount') === '0'
      && value('selectedCurrency') === 'AED' && (returnDate===null || value('returnDate') === returnDate);
  }, { origin, destination, departureDate, returnDate });
  if (validation !== true) throw new Error('SEARCH_INPUTS_NOT_CONFIRMED');
  return { tripKind: returnDate ? 'return' : 'one-way' };
}

async function submitProbe(frame, config) {
  const prepared = await prepareSearch(frame, config);
  // btnSearch was observed as a visible input/button on makeReservation.action.
  config.report?.('PORTAL_SEARCH_SUBMIT_STARTED');
  await frame.locator('input#btnSearch[type="button"]:visible').click({ timeout: 15000 });
  config.report?.('PORTAL_SEARCH_SUBMIT_COMPLETED');
  return { submitted: true, tripKind: prepared.tripKind };
}

module.exports = { airportCodeConfirmed, chooseAirport, prepareSearch, submitProbe };
