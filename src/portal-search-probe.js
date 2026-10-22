'use strict';

// A bounded synthetic search only; this module has no booking/passenger actions.
async function chooseAirport(frame, inputId, hiddenId, code) {
  const field = frame.locator(`#${inputId}`);
  await field.fill(code);
  const options = frame.locator('ul.ui-autocomplete:visible li').filter({ hasText: new RegExp('\\b' + code + '\\b', 'i') });
  await options.first().waitFor({ state: 'visible', timeout: 15000 });
  if (await options.count() !== 1) throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
  await options.click();
  // The supplier's autocomplete, rather than our code, must set its hidden ID.
  const selected = await frame.locator(`#${hiddenId}`).inputValue();
  if (selected !== code) throw new Error('AIRPORT_SELECTION_NOT_CONFIRMED');
}

async function prepareSearch(frame, { origin, destination, departureDate }) {
  if (!['SHJ', 'DAM'].includes(origin) || !['SHJ', 'DAM'].includes(destination) || origin === destination) throw new Error('UNSUPPORTED_PROBE_ROUTE');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(departureDate)) throw new Error('INVALID_PROBE_DATE');
  // Use the actual visible radio label, never guess the supplier's enum value.
  const oneWay = await frame.evaluate(() => {
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
  if (!Number.isInteger(oneWay) || oneWay < 0) throw new Error('ONE_WAY_CONTROL_NOT_CONFIRMED');
  await frame.locator('input[name="searchType"][type="radio"]').nth(oneWay).check();
  await chooseAirport(frame, 'fAirport', 'fromAirport', origin);
  await chooseAirport(frame, 'tAirport', 'toAirport', destination);
  await frame.locator('#departureDate').fill(departureDate);
  await frame.locator('#adultCount').fill('1');
  await frame.locator('#childCount').fill('0');
  await frame.locator('#infantCount').fill('0');
  // Choose existing supplier options by their observed names; unknown forms stop.
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
  const validation = await frame.evaluate(({ origin, destination, departureDate }) => {
    const value = id => document.getElementById(id)?.value;
    return value('fromAirport') === origin && value('toAirport') === destination
      && value('departureDate') === departureDate && value('adultCount') === '1'
      && value('childCount') === '0' && value('infantCount') === '0'
      && value('selectedCurrency') === 'AED';
  }, { origin, destination, departureDate });
  if (validation !== true) throw new Error('SEARCH_INPUTS_NOT_CONFIRMED');
}

async function submitProbe(frame, config) {
  await prepareSearch(frame, config);
  // btnSearch was observed as a visible input/button on makeReservation.action.
  await frame.locator('input#btnSearch[type="button"]:visible').click({ timeout: 15000 });
  return { submitted: true };
}

module.exports = { chooseAirport, prepareSearch, submitProbe };
