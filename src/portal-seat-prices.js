'use strict';

// Supplier tabAnci28102018.js: imgTab_2 loads seatMap.action; hovering
// tdSeat_<number> a fills spnTTSeatNo / spnTTSeatChg. Never select a seat
// or use the ancillary Continue control (which can submit seats for blocking).
function parseSeatPrice(text, currency) {
  if (!/^[A-Z]{3}$/.test(currency || '')) return null;
  const value = String(text || '').replace(/\u00a0/g, ' ').trim();
  if (/^free$/i.test(value)) return { amount: 0, currency };
  const match = value.match(/^(?:([A-Z]{3})\s+)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?:\s+([A-Z]{3}))?$/);
  if (!match || (match[1] && match[1] !== currency) || (match[3] && match[3] !== currency)) return null;
  const amount = Number(match[2].replace(/,/g, ''));
  return Number.isFinite(amount) && amount >= 0 ? { amount, currency } : null;
}

function summarizeSeats(seats, expected) {
  const verified = seats.filter(s => s.price !== null);
  const ordinary = verified.filter(s => !s.conditional);
  const cheapest = ordinary.slice().sort((a, b) => a.price.amount - b.price.amount || a.seat.localeCompare(b.seat))[0];
  const complete = expected > 0 && seats.length === expected && verified.length === expected;
  return {
    complete, availableSeats: expected, hoveredSeats: seats.length, pricesRead: verified.length,
    freeSeats: verified.filter(s => s.price.amount === 0).length,
    conditionalSeats: verified.filter(s => s.conditional).length,
    // An incomplete scan must never claim the cheapest seat or absence of free seats.
    cheapestOrdinarySeat: complete && cheapest ? { seat: cheapest.seat, ...cheapest.price } : null,
  };
}

function seatRequestPolicy(request) {
  const url = new URL(request.url());
  const action = url.pathname.split('/').pop().split(';')[0];
  const kind = request.resourceType?.() || 'unknown';
  const cosmetic = ['image', 'font', 'stylesheet', 'media'].includes(kind) && request.method() === 'GET';
  // Reviewed supplier onClickSeat / onClickFlexi handlers fetch catalog data.
  // The latter is also invoked while loading seat/bundle options.
  const availabilityAction = ['seatMap.action', 'anciFlexi.action', 'anciMeal.action', 'anciBaggage.action'].includes(action);
  const supplierAsset = cosmetic && url.protocol === 'https:' && (url.hostname === 'airarabia.com' || url.hostname.endsWith('.airarabia.com')) && !/\.action$/i.test(action);
  const allowed = supplierAsset || (url.origin === 'https://agents.airarabia.com'
    && (!/\.action$/i.test(action) || availabilityAction)
    && (request.method() === 'GET' || availabilityAction));
  // Block unrelated third-party telemetry, but it is not supplier price data.
  // Unknown supplier actions, scripts and document transitions remain critical.
  const critical = !allowed && !cosmetic && (url.origin === 'https://agents.airarabia.com' || ['script', 'document'].includes(kind));
  return { allowed, critical, kind: /^(?:image|font|stylesheet|media|xhr|fetch|script|document|other|unknown)$/.test(kind) ? kind : 'other',
    action: /^[A-Za-z][A-Za-z0-9_!.-]{0,70}\.action$/.test(action) ? action : null };
}

async function scanSeatPrices(frame, page, report = () => {}) {
  const safe = await frame.evaluate(() => location.origin === 'https://agents.airarabia.com'
    && typeof UI_commonSystem !== 'undefined' && UI_commonSystem.strPGMode === ''
    && typeof UI_tabAnci !== 'undefined' && !UI_tabAnci.isAnciModify && !UI_tabAnci.isRequote && !UI_tabAnci.isSegModify
    && typeof jsonPaxAdults !== 'undefined' && jsonPaxAdults.length === 1
    && jsonPaxAdults[0].displayAdultFirstName === 'TEST' && jsonPaxAdults[0].displayAdultLastName === 'QUOTE'
    && (typeof jsonPaxInfants === 'undefined' || jsonPaxInfants.length === 0)
    && !DATA_ResPro.pnrNo && !UI_tabAnci.pnr && !UI_tabAnci.seatsBlocked);
  if (!safe) throw new Error('SEAT_SCAN_SCOPE_NOT_CONFIRMED');
  let blocked = false;
  const reportedRequests = new Set();
  const guard = async route => {
    const policy = seatRequestPolicy(route.request());
    if (!policy.allowed) {
      blocked ||= policy.critical;
      const diagnostic = JSON.stringify({ kind: policy.kind, action: policy.action, critical: policy.critical });
      if (!reportedRequests.has(diagnostic) && reportedRequests.size < 20) {
        reportedRequests.add(diagnostic);
        report('PORTAL_SEAT_SCAN_REQUEST_PREVENTED_' + diagnostic);
      }
      return route.abort();
    }
    return route.continue();
  };
  await page.route('**/*', guard);
  report('PORTAL_SEAT_SCAN_STARTED');
  try {
    const available = await frame.evaluate(() => UI_tabAnci.seatMapAvailable === true);
    if (!available) {
      report('PORTAL_SEAT_MAP_UNAVAILABLE_NO_PRICE');
      return { complete: false, customerQuoteReady: false, segments: [] };
    }
    // A supplier preference dialog may precede the visible ancillary tabs.
    const preference = frame.locator('#divAnciPref:visible');
    if (await preference.count()) {
      const seats = frame.locator('#chkAnciPref_2:visible');
      if (await seats.count() !== 1) throw new Error('SEAT_PREFERENCE_NOT_CONFIRMED');
      await seats.check();
      await frame.locator('#btnAnciPrefToAnci:visible').click({ timeout: 15000 });
    }
    const tab = frame.locator('#imgTab_2:visible');
    await tab.waitFor({ state: 'visible', timeout: 15000 });
    await tab.click({ timeout: 15000 });
    // Supplier UI service code is SEAT; its ancillary type is SEAT_MAP.
    await frame.waitForFunction(() => UI_tabAnci.currAnciSrv === 'SEAT' && UI_tabAnci.selectedAnciTypeGlobal === 'SEAT_MAP' && UI_tabAnci.dataStatus.seat === true, null, { timeout: 30000 });
    const segments = await frame.evaluate(() => Array.from(document.querySelectorAll('#tbdyAnciSeg [id^="tdAnciSeg_"]')).map(el => ({
      index: Number(el.id.split('_')[1]), available: el.classList.contains('anciSeatAvail'),
    })));
    if (!segments.length || segments.length > 20 || segments.some(s => !Number.isInteger(s.index) || s.index < 0 || s.index >= 20)
      || new Set(segments.map(s => s.index)).size !== segments.length) throw new Error('SEAT_SEGMENTS_NOT_CONFIRMED');
    const results = [];
    for (const segment of segments) {
      if (!segment.available) {
        results.push({ segment: segment.index, complete: false, unavailable: true });
        continue;
      }
      await frame.locator('#tdAnciSeg_' + segment.index).click({ timeout: 15000 });
      await frame.waitForFunction(index => UI_tabAnci.currAnciSrv === 'SEAT' && UI_tabAnci.currSegRow === index, segment.index, { timeout: 15000 });
      const state = await frame.evaluate(() => {
        const seg = jsAnciSeg[UI_tabAnci.currSegRow];
        let currency = UI_tabAnci.jsonFareQuoteSummary.currency;
        if (!/^[A-Z]{3}$/.test(currency || '')) currency = DATA_ResPro.initialParams.baseCurrencyCode;
        const map = UI_tabAnci.seatRefMap[UI_tabAnci.currFltRefNo];
        const cabin = UI_tabAnci.getSelectedLogicalCabinClass(UI_tabAnci.currFltRefNo);
        const paxType = jsonPaxAdults[0].type;
        const seats = Object.values(map?.seats || {}).filter(s => s.avail === 'VAC' && s.lccCode === cabin && /^\d{1,3}[A-K]$/.test(s.seatNumber)).map(s => ({
          seat: s.seatNumber, conditional: !!String(s.seatMessage || '').trim() || s.seatType === 'EXIT'
            || !['AD','ADT'].includes(paxType)
            || (Array.isArray(s.notAllowedPassengerType) ? s.notAllowedPassengerType.includes(paxType)
              : typeof s.notAllowedPassengerType === 'string' && s.notAllowedPassengerType.split(/[,|\s]+/).includes(paxType)),
        })).filter(s => {
          const el = document.getElementById('tdSeat_' + s.seat);
          return el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
            && !!el.querySelector('a[onmouseover*="seatOnMouseOver"]');
        });
        // Count every vacant seat in the selected cabin, even if its hover target
        // is unexpectedly missing: missing DOM coverage makes the scan incomplete.
        const expected = Object.values(map?.seats || {}).filter(s => s.avail === 'VAC' && s.lccCode === cabin).length;
        return { currency: /^[A-Z]{3}$/.test(currency || '') ? currency : null,
          flight: /^[A-Z0-9]{2}\s?\d{1,4}$/.test(seg.flightNumber || '') ? seg.flightNumber : null,
          expected, seats };
      });
      if (!state.currency || state.expected > 500) throw new Error('SEAT_PRICES_SCOPE_NOT_CONFIRMED');
      const readings = [];
      for (const seat of state.seats) {
        const target = frame.locator('#tdSeat_' + seat.seat + ' a[onmouseover*="seatOnMouseOver"]');
        let price = null;
        try {
          await target.hover({ timeout: 5000 });
          await frame.waitForFunction(number => {
            const tip = document.getElementById('spnSeatInfo');
            return tip && tip.getClientRects().length && getComputedStyle(tip).visibility !== 'hidden'
              && document.getElementById('spnTTSeatNo')?.textContent.trim() === number;
          }, seat.seat, { timeout: 2000 });
          price = parseSeatPrice(await frame.locator('#spnTTSeatChg').textContent(), state.currency);
        } catch { /* Never reuse a previous seat's tooltip or infer a zero price. */ }
        readings.push({ ...seat, price });
      }
      const result = { segment: segment.index, flight: state.flight, ...summarizeSeats(readings, state.expected) };
      results.push(result);
      report('PORTAL_SEAT_SCAN_SEGMENT_' + JSON.stringify(result));
    }
    if (blocked) throw new Error('SEAT_SCAN_REQUEST_NOT_CONFIRMED');
    const result = { complete: results.length > 0 && results.every(s => s.complete), customerQuoteReady: false, segments: results };
    report(result.complete ? 'PORTAL_SEAT_SCAN_COMPLETED' : 'PORTAL_SEAT_SCAN_INCOMPLETE_NO_CUSTOMER_PRICE');
    return result;
  } finally {
    await page.unroute('**/*', guard);
  }
}

module.exports = { scanSeatPrices, parseSeatPrice, summarizeSeats, seatRequestPolicy };
