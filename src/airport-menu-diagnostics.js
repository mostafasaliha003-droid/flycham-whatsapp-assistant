'use strict';

// Read-only airport-menu diagnostics. No input values, account details,
// URLs, cookies or arbitrary DOM attributes are returned.
function inspectAirportMenu({ inputId, origin }) {
  if (origin !== 'https://reservations.flycham.com' || location.origin !== origin || !['fAirport','tAirport'].includes(inputId)) return { trusted: false };
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const input = document.querySelectorAll('[id="'+inputId+'"]');
  if (input.length !== 1 || !visible(input[0])) return { trusted: true, inputReady: false };
  const codes = ['SHJ','DXB','DWC','AUH','DAM','ALP'];
  const names = ['SHARJAH','DUBAI','MAKTOUM','DHABI','DAMASCUS','ALEPPO'];
  const nodes = Array.from(document.querySelectorAll('li,[role="option"],a,div,span,td')).filter(e => visible(e) && !e.querySelector('input,select,textarea,button'));
  const labels = nodes.map(e => (e.textContent || '').replace(/\s+/g,' ').trim().toUpperCase()).filter(t => t.length > 0 && t.length <= 120);
  const airportLabels = labels.filter(t => names.some(n => new RegExp('\\b'+n+'\\b').test(t)) || codes.some(c => new RegExp('\\b'+c+'\\b').test(t)));
  const safeLabels = [...new Set(airportLabels.filter(t => codes.some(c => new RegExp('\\b'+c+'\\b').test(t)) && names.some(n => new RegExp('\\b'+n+'\\b').test(t)) && /^[A-Z0-9 (),.\-/:]+$/.test(t) && !/[0-9]{4}|[A-Z]{25}/.test(t)))].slice(0,8);
  const features = ['TERMINAL','INTL','INTERNATIONAL','AIRPORT','JEBEL','ALI','MAKTOUM','WORLD','CENTRAL','FREE','ZONE','CITY'];
  return {
    trusted: true, inputReady: true,
    visibleOptions: Math.min(nodes.filter(e => e.matches('li,[role="option"]')).length,100),
    codes: codes.filter(c => airportLabels.some(t => new RegExp('\\b'+c+'\\b').test(t))),
    names: names.filter(n => airportLabels.some(t => new RegExp('\\b'+n+'\\b').test(t))),
    features: features.filter(n => airportLabels.some(t => new RegExp('\\b'+n+'\\b').test(t))),
    airportLabels: safeLabels,
    noMatches: labels.some(t => /^(?:NO (?:MATCHES|RESULTS|AIRPORTS)(?: FOUND)?|NOT FOUND)\.?$/.test(t)),
  };
}

async function diagnoseFlyChamAirports(adapter) {
  const origin = 'https://reservations.flycham.com';
  const frame = await adapter.openSearchForm();
  for (const [code,query] of [['DXB','Dubai'],['DWC','Maktoum'],['AUH','Abu'],['SHJ','Sharjah']]) {
    const field = frame.locator('#fAirport');
    await field.fill('');
    await field.pressSequentially(query,{delay:120});
    await adapter.page.waitForTimeout(1500);
    const state = await frame.evaluate(inspectAirportMenu,{inputId:'fAirport',origin});
    adapter.report('FLYCHAM_AIRPORT_DIAGNOSTIC_'+code+'_'+JSON.stringify(state));
  }
  await frame.locator('#fAirport').fill('');
  await frame.locator('#fAirport').press('Tab');
  await adapter.openSearchForm();
}
module.exports = { inspectAirportMenu, diagnoseFlyChamAirports };
