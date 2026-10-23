'use strict';

// Normal UI selection only. No hidden airport field or supplier API is changed.
function airportSuggestionAction({ inputId, code, operation = 'inspect', origin = 'https://agents.airarabia.com' }) {
  if (!['https://agents.airarabia.com','https://reservations.flycham.com'].includes(origin) || location.origin !== origin) return { status: 'UNTRUSTED' };
  const airports = {
    SHJ: ['SHJ', 'SHARJAH', 'AIRPORT', 'INTERNATIONAL', 'UNITED', 'ARAB', 'EMIRATES', 'UAE'],
    ALP: ['ALP', 'ALEPPO', 'AIRPORT', 'INTERNATIONAL', 'SYRIA', 'SYRIAN', 'ARAB', 'REPUBLIC'],
    DAM: ['DAM', 'DAMASCUS', 'AIRPORT', 'INTERNATIONAL', 'SYRIA', 'SYRIAN', 'ARAB', 'REPUBLIC'],
  };
  if (!airports[code] || !['fAirport', 'tAirport'].includes(inputId)) return { status: 'INVALID' };
  const fields = document.querySelectorAll('[id="' + inputId + '"]');
  const visible = element => {
    if (!element?.getClientRects().length) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  if (fields.length !== 1 || fields[0].disabled || fields[0].readOnly || !visible(fields[0])) return { status: 'INPUT_UNAVAILABLE' };
  if (operation === 'input') return { status: 'INPUT_READY' };
  // Prefer the dropdown explicitly owned by this airport field. An unrelated
  // visible city label elsewhere on the page must not become a selection.
  const ownedIds = [...new Set(['aria-controls', 'aria-owns'].flatMap(name => (fields[0].getAttribute?.(name) || '').trim().split(/\s+/)).filter(Boolean))];
  const owned = ownedIds.map(id => Array.from(document.querySelectorAll('[id="' + id.replace(/["\\]/g, '\\$&') + '"]'))).flat();
  if (ownedIds.length && (owned.length !== ownedIds.length || new Set(owned).size !== ownedIds.length)) return { status: 'INPUT_UNAVAILABLE' };
  const matches = element => {
    const text = (element.textContent || '').trim();
    if (!text || text.length > 100 || !visible(element)) return false;
    // A layout cell containing the input can have the same text as a menu
    // item. Clicking that cell's centre does not select the supplier option.
    if (element.querySelector?.('input,select,textarea,button') || element.getAttribute?.('aria-disabled') === 'true') return false;
    const words = text.toUpperCase().replace(/[^A-Z]/g, ' ').trim().split(/\s+/);
    return words.some(word => word === code || word === airports[code][1]) && words.every(word => airports[code].includes(word));
  };
  const selector = 'li,[role="option"],a,div,span,td';
  const elements = owned.length ? owned.flatMap(root => [root, ...Array.from(root.querySelectorAll(selector))]) : Array.from(document.querySelectorAll(selector));
  const grouped = new Set(elements.filter(matches).map(element => {
    // City and IATA code may be separate spans inside one real option.
    const option = element.closest?.('[role="option"],li,a,td');
    return option && elements.includes(option) && matches(option) ? option : element;
  }));
  const candidates = Array.from(grouped).filter(element => !Array.from(element.querySelectorAll(selector)).some(child => grouped.has(child)));
  if (candidates.length !== 1) return { status: candidates.length ? 'AMBIGUOUS' : 'NONE', count: Math.min(candidates.length, 20) };
  if (operation === 'inspect') return { status: 'READY' };
  // Return the observed DOM element for a real Playwright pointer click.
  // HTMLElement.click() alone omits mouse-down/up handlers used by legacy menus.
  if (operation !== 'resolve') return { status: 'INVALID' };
  return candidates[0];
}

module.exports = { airportSuggestionAction };
