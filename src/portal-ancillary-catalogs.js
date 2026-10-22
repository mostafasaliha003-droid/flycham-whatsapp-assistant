'use strict';
const { parseSeatPrice, seatRequestPolicy } = require('./portal-seat-prices');

function foodKind(name) {
  if (/^(?:(?:no|without)\s*(?:meal|food)\b|none\b|بدون\s*(?:وجبة|طعام))/i.test(name.trim())) return 'none';
  if (/^(?:\w+\s+)?(?:water|tea|coffee|juice|cola|soft drink|ماء|شاي|قهوة|عصير)(?:\s+\d+\s*(?:ml|l))?$/i.test(name.trim())) return 'drink';
  if (/chicken|beef|fish|rice|biryani|pasta|sandwich|breakfast|omelette|vegetarian|meal|snack|salad|paratha|yogurt|egg|pie|noodles|croissant|cheese|panini|lasagna|munchkins|دجاج|لحم|سمك|أرز|رز|ساندويش|وجبة|فطور/i.test(name)) return 'food';
  return 'unconfirmed';
}

function checkedWeight(name) {
  if (/^(?:no checked baggage|no baggage|without baggage)$/i.test(name.trim())) return 0;
  if (/[2-9]\s*(?:pc|piece)/i.test(name) && !/\btotal\b/i.test(name)) return null;
  const values = [...name.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/ig)];
  return values.length === 1 && Number(values[0][1]) <= 100 ? Number(values[0][1]) : null;
}

function summarizeCatalog(snapshot, type) {
  const options = snapshot.options.map((o, index) => ({
    id: index + 1, name: o.name, price: parseSeatPrice(o.priceText, snapshot.currency), available: o.available,
    availabilityBasis: o.availabilityBasis || null,
    ...(type === 'meal' ? { foodKind: foodKind(o.name) } : { checkedWeightKg: checkedWeight(o.name), handWeightKg: null }),
  }));
  const complete = snapshot.expected > 0 && options.length === snapshot.expected && options.every(o => o.price !== null && typeof o.available === 'boolean')
    && (type !== 'baggage' || options.every(o => o.checkedWeightKg !== null));
  const candidates = options.filter(o => o.available === true && o.price && (type !== 'meal' || o.foodKind === 'food'));
  const classificationsComplete = type !== 'meal' || options.filter(o => o.available).every(o => o.foodKind !== 'unconfirmed');
  const cheapest = complete && classificationsComplete ? candidates.slice().sort((a,b) => a.price.amount - b.price.amount)[0] || null : null;
  return { complete, classificationsComplete, expectedOptions: snapshot.expected, coveredSegments: snapshot.coveredSegments,
    options, cheapest, customerQuoteReady: false };
}

async function scanAncillaryCatalogs(frame, page, report = () => {}) {
  const safe = await frame.evaluate(() => location.origin === 'https://agents.airarabia.com'
    && UI_commonSystem.strPGMode === '' && !DATA_ResPro.pnrNo && !UI_tabAnci.pnr && !UI_tabAnci.seatsBlocked
    && !UI_tabAnci.isAnciModify && !UI_tabAnci.isRequote && !UI_tabAnci.isSegModify
    && jsonPaxAdults.length === 1 && jsonPaxAdults[0].displayAdultFirstName === 'TEST'
    && jsonPaxAdults[0].displayAdultLastName === 'QUOTE' && !jsonPaxInfants.length);
  if (!safe) throw new Error('CATALOG_SCOPE_NOT_CONFIRMED');
  let blocked = false;
  const guard = async route => {
    const policy = seatRequestPolicy(route.request());
    if (policy.allowed) return route.continue();
    blocked ||= policy.critical;
    if (policy.critical) report('PORTAL_CATALOG_REQUEST_PREVENTED_' + JSON.stringify({ kind: policy.kind, action: policy.action }));
    return route.abort();
  };
  await page.route('**/*', guard);
  const results = [];
  try {
    for (const config of [{ type:'meal', tab:1, code:'MEAL' }, { type:'baggage', tab:5, code:'BAGGAGE' }]) {
      const tab = frame.locator('#imgTab_' + config.tab + ':visible');
      if (await tab.count() !== 1) {
        report('PORTAL_CATALOG_' + config.type.toUpperCase() + '_UNAVAILABLE_NO_PRICE');
        results.push({ type: config.type, complete: false });
        continue;
      }
      report('PORTAL_CATALOG_' + config.type.toUpperCase() + '_STARTED');
      await tab.click({ timeout:15000 });
      await frame.waitForFunction(c => UI_tabAnci.currAnciSrv === c.code && UI_tabAnci.dataStatus[c.type] === true, config, { timeout:30000 });
      // buildFlightSegments concatenates the service type onto cursorPointer:
      // cursorPointerMEALS / cursorPointerBAGGAGES, rather than a separate token.
      const segments = await frame.evaluate(type => Array.from(document.querySelectorAll('#tbdyAnciSeg [id^="tdAnciSeg_"]')).map(e => ({
        index:Number(e.id.split('_')[1]), enabled:e.classList.contains('cursorPointer')
          || e.classList.contains(type === 'meal' ? 'cursorPointerMEALS' : 'cursorPointerBAGGAGES'),
      })), config.type);
      if (!segments.length || segments.length > 20 || segments.some(s => !Number.isInteger(s.index) || s.index < 0 || s.index >= 20)
        || new Set(segments.map(s => s.index)).size !== segments.length) throw new Error('CATALOG_SEGMENTS_NOT_CONFIRMED');
      const catalogs = [];
      for (const segment of segments) {
        if (!segment.enabled) {
          catalogs.push({ segment:segment.index, complete:false, unavailable:true });
          report('PORTAL_CATALOG_' + config.type.toUpperCase() + '_SEGMENT_UNAVAILABLE_' + segment.index);
          continue;
        }
        await frame.locator('#tdAnciSeg_' + segment.index).click({ timeout:15000 });
        await frame.waitForFunction(({index,code}) => UI_tabAnci.currSegRow === index && UI_tabAnci.currAnciSrv === code, { index:segment.index, code:config.code }, { timeout:15000 });
        const snapshot = await frame.evaluate(type => {
          const clean = value => {
            const text = String(value || '').replace(/\s+/g,' ').trim();
            return text.length > 0 && text.length <= 100 && /^[\p{L}\p{N} .,+/&:'\[\]()_-]+$/u.test(text) ? text : null;
          };
          const isMeal = type === 'meal';
          const list = (isMeal ? jsMealList : jsBaggageList).filter(Boolean);
          const tableIds = isMeal ? ['tblAnciMealBundle','tblAnciMealAdditional'] : ['tblAnciBaggage'];
          const nameField = isMeal ? 'mealName' : 'baggageDisplayName';
          const chargeField = isMeal ? 'mealCharge' : 'baggageCharge';
          const rows = [];
          for (const id of tableIds) {
            const table = document.getElementById(id);
            if (!table || !table.getClientRects().length || getComputedStyle(table).display === 'none') continue;
            // Supplier jqGrid 3.5 has no aria-describedby on grid cells.
            // Its public colModel order is the DOM cell order (no multiselect
            // or row-number columns in these two supplier grids).
            const columns = table.p?.colModel;
            if (!Array.isArray(columns)) continue;
            const nameIndex = columns.findIndex(c => c.name === nameField);
            const priceIndex = columns.findIndex(c => c.name === chargeField);
            for (const row of table.querySelectorAll('tr.jqgrow')) {
              if (!/^\d+$/.test(row.id || '') || row.cells.length !== columns.length || nameIndex < 0) continue;
              rows.push({ table:id, rowId:Number(row.id), name:clean(row.cells[nameIndex]?.textContent),
                price:priceIndex >= 0 ? row.cells[priceIndex]?.textContent?.trim() || null : null });
            }
          }
          const index = UI_tabAnci.currSegRow;
          const segment = jsAnciSeg[index];
          let coveredSegments = [index];
          if (!isMeal) {
            const group = getBaggageONDGrpId(segment.fltRefNo);
            if (group !== null && group !== undefined && group !== '') coveredSegments = jsAnciSeg.map((s,i) => getBaggageONDGrpId(s.fltRefNo) === group ? i : -1).filter(i => i >= 0);
          }
          let currency = UI_tabAnci.jsonFareQuoteSummary.currency;
          if (!/^[A-Z]{3}$/.test(currency || '')) currency = DATA_ResPro.initialParams.baseCurrencyCode;
          const options = list.map((item,listIndex) => {
            const name = clean(item[nameField]);
            const raw = isMeal ? jsMealModel[item.mmSGI]?.meals?.[item.mmI] : jsBaggageModel[item.mmSGI]?.baggages?.[item.mmI];
            // fillGridData uses source-array index + 1, including sparse meal
            // arrays. Repeated names are different offers and must stay distinct.
            const rowId = isMeal ? item.mmI + 1 : listIndex + 1;
            const mealTable = typeof isMultiMealEnabled !== 'undefined' && isMultiMealEnabled && !raw?.optionServedFromBundle
              ? 'tblAnciMealAdditional' : 'tblAnciMealBundle';
            const expectedTable = isMeal ? mealTable : 'tblAnciBaggage';
            const matched = name ? rows.filter(r => r.table === expectedTable && r.rowId === rowId && r.name === name) : [];
            let priceText = matched.length === 1 ? matched[0].price : null;
            // Supplier hides the charge column for its explicit FOC meal mode.
            if (isMeal && UI_tabAnci.focMealEnabled === true && matched.length === 1) priceText = 'Free';
            const count = Number(isMeal ? raw?.availableMeals : raw?.availableQty);
            let available = null;
            let availabilityBasis = null;
            const rawCount = isMeal ? raw?.availableMeals : raw?.availableQty;
            if (raw && rawCount !== null && rawCount !== undefined && String(rawCount).trim() !== '' && Number.isInteger(count) && (count >= 0 || (!isMeal && count === -1))) {
              available = count > 0 || (!isMeal && count === -1);
              availabilityBasis = 'supplier-quantity';
            } else if (!isMeal && raw && !raw.inactiveSelectedBaggage && matched.length === 1 && rawCount === undefined) {
              // Supplier filters inactive baggage before displaying selectable
              // rows and imposes no quantity cap when availableQty is absent.
              available = true;
              availabilityBasis = 'displayed-active-baggage-offer';
            }
            return { name, priceText, available, availabilityBasis };
          }).filter(o => o.name !== null);
          return { currency:/^[A-Z]{3}$/.test(currency || '') ? currency : null, expected:list.length, options, coveredSegments,
            flight:/^[A-Z0-9]{2}\s?\d{1,4}$/.test(segment.flightNumber || '') ? segment.flightNumber : null };
        }, config.type);
        if (snapshot.expected > 200) throw new Error('CATALOG_LIMIT_EXCEEDED');
        const catalog = { segment:segment.index, flight:snapshot.flight, ...summarizeCatalog(snapshot, config.type) };
        catalogs.push(catalog);
        report('PORTAL_CATALOG_' + config.type.toUpperCase() + '_SEGMENT_' + JSON.stringify(catalog));
      }
      const required = await frame.evaluate(() => jsAnciSeg.length);
      const covered = new Set(catalogs.flatMap(c => c.complete ? c.coveredSegments : []));
      results.push({ type:config.type, complete:catalogs.every(c => c.complete) && covered.size === required, catalogs });
    }
    const complete = !blocked && results.every(r => r.complete);
    // This supplier total is visible at the ancillary stage only. No services
    // have been applied by this reader, no final review or payment has occurred.
    const displayed = await frame.evaluate(() => {
      const text = id => {
        const el = document.getElementById(id);
        return el && el.getClientRects().length ? el.textContent.replace(/\s+/g,' ').trim().slice(0,40) : null;
      };
      return { baseAmount:text('divAnciTotal'), baseCurrency:text('spnBaseCur'), selectedAmount:text('divAnciTotalinSelCur'), selectedCurrency:text('spnSelCur') };
    });
    const provisionalTotal = { base:parseSeatPrice(displayed?.baseAmount, displayed?.baseCurrency),
      selected:parseSeatPrice(displayed?.selectedAmount, displayed?.selectedCurrency), allChargesChecked:false, selectedServicesVerified:false };
    report('PORTAL_ANCILLARY_DISPLAYED_TOTAL_' + JSON.stringify(provisionalTotal));
    report(complete ? 'PORTAL_ANCILLARY_CATALOGS_READ' : 'PORTAL_ANCILLARY_CATALOGS_INCOMPLETE_NO_CUSTOMER_PRICE');
    return { complete, customerQuoteReady:false, results, provisionalTotal };
  } catch (error) {
    report(error?.name === 'TimeoutError' ? 'PORTAL_CATALOG_SCAN_TIMEOUT' : 'PORTAL_CATALOG_SCAN_UNCONFIRMED');
    const diagnostic = await frame.evaluate(() => ({
      service:['SEAT','MEAL','BAGGAGE','FLEXI'].includes(UI_tabAnci.currAnciSrv) ? UI_tabAnci.currAnciSrv : null,
      mealLoaded:UI_tabAnci.dataStatus.meal === true, baggageLoaded:UI_tabAnci.dataStatus.baggage === true,
      segmentControls:document.querySelectorAll('#tbdyAnciSeg [id^="tdAnciSeg_"]').length,
    })).catch(() => null);
    if (diagnostic) report('PORTAL_CATALOG_DIAGNOSTIC_' + JSON.stringify(diagnostic));
    throw error;
  } finally { await page.unroute('**/*', guard); }
}

module.exports = { scanAncillaryCatalogs, summarizeCatalog, foodKind, checkedWeight };
