'use strict';

// Normal UI selection only. No hidden airport field or supplier API is changed.
function airportSuggestionAction({ inputId, code, operation = 'inspect' }) {
  if (location.origin !== 'https://agents.airarabia.com') return { status: 'UNTRUSTED' };
  const airports = {
    SHJ: ['SHJ', 'SHARJAH', 'AIRPORT', 'INTERNATIONAL', 'UNITED', 'ARAB', 'EMIRATES', 'UAE'],
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
  const matches = element => {
    const text = (element.textContent || '').trim();
    if (!text || text.length > 100 || !visible(element)) return false;
    const words = text.toUpperCase().replace(/[^A-Z]/g, ' ').trim().split(/\s+/);
    return words.some(word => word === code || word === airports[code][1]) && words.every(word => airports[code].includes(word));
  };
  const selector = 'li,[role="option"],a,div,span,td';
  const grouped = new Set(Array.from(document.querySelectorAll(selector)).filter(matches).map(element => {
    // City and IATA code may be separate spans inside one real option.
    const option = element.closest?.('[role="option"],li,a,td');
    return option && matches(option) ? option : element;
  }));
  const candidates = Array.from(grouped).filter(element => !Array.from(element.querySelectorAll(selector)).some(child => grouped.has(child)));
  if (candidates.length !== 1) return { status: candidates.length ? 'AMBIGUOUS' : 'NONE', count: Math.min(candidates.length, 20) };
  if (operation === 'inspect') return { status: 'READY' };
  if (operation !== 'click') return { status: 'INVALID' };
  candidates[0].click();
  return { status: 'CLICKED' };
}

module.exports = { airportSuggestionAction };
