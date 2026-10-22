'use strict';

// Explicitly authorized synthetic pricing lookup. Never creates a reservation,
// customer profile, payment, ticket, or uses a stored passenger's identity.
async function continueWithTestPassenger(frame, report = () => {}) {
  const safe = await frame.evaluate(() => location.origin === 'https://agents.airarabia.com'
    && typeof UI_commonSystem !== 'undefined' && UI_commonSystem.strPGMode === ''
    && typeof jsonPaxAdtObj !== 'undefined' && jsonPaxAdtObj.paxAdults.length === 1
    && !(jsonPaxAdtObj.paxInfants || []).length);
  if (!safe) throw new Error('TEST_PASSENGER_SCOPE_NOT_CONFIRMED');
  const field = id => frame.locator('[id="' + id + '"]');
  async function fill(id, value, required = true) {
    const f = field(id);
    if (await f.count() !== 1 || !await f.isVisible()) {
      if (required) throw new Error('TEST_PASSENGER_FIELD_NOT_CONFIRMED');
      return;
    }
    await f.fill(value);
    await f.press('Tab');
  }
  async function select(id, pattern) {
    const option = await frame.evaluate(({ id, pattern }) => {
      const e = document.getElementById(id);
      if (!e || e.tagName !== 'SELECT') return null;
      const re = new RegExp(pattern, 'i');
      const matches = Array.from(e.options).filter(o => !o.disabled && (re.test(o.textContent.trim()) || re.test(o.value)));
      return matches.length === 1 ? matches[0].value : null;
    }, { id, pattern });
    if (option === null) throw new Error('TEST_PASSENGER_OPTION_NOT_CONFIRMED');
    await field(id).selectOption(option);
  }
  const profile = field('chkUpdateCustProf');
  if (await profile.count() === 1 && await profile.isVisible() && await profile.isEnabled()) await profile.uncheck();
  await select('1_displayAdultTitle', '^Mr\\.?$');
  await fill('1_displayAdultFirstName', 'TEST');
  await fill('1_displayAdultLastName', 'QUOTE');
  await select('1_displayAdultNationality', '^(?:SY|SYR|Syria|Syrian(?: Arab Republic)?)$');
  await fill('1_displayAdultDOB', '01/01/1990');
  // Exact names were observed on the supplier's passenger form.
  for (const [name, value] of [['pnrPaxCatFOIDNumber', 'TEST00001'], ['pnrPaxCatFOIDExpiry', '01/01/2036']]) {
    const f = frame.locator('[name="' + name + '"]:visible');
    if (await f.count() === 1) { await f.fill(value); await f.press('Tab'); }
  }
  await select('selTitle', '^Mr\\.?$');
  await select('selCountry', '^(?:AE|ARE|UAE|United Arab Emirates)$');
  for (const [id, value] of Object.entries({
    txtFirstName: 'TEST', txtLastName: 'QUOTE', txtStreet: 'TEST ADDRESS', txtAddress: 'QUOTE ONLY', txtCity: 'Dubai',
    txtEmail: 'quote-test@example.com', txtMobCntry: '971', txtMobArea: '54', txtMobiNo: '4757578',
  })) await fill(id, value);
  for (const id of ['txtPhoneNo','txtPhoneArea','txtFaxNo','txtFaxArea']) await fill(id, '', false);
  const profileSafe = await frame.evaluate(() => {
    const e = document.getElementById('chkUpdateCustProf');
    return !e || !e.checked;
  });
  if (!profileSafe) throw new Error('TEST_PROFILE_SAVE_NOT_DISABLED');
  report('PORTAL_TEST_PASSENGER_FIELDS_PREPARED');
  const next = frame.locator('button#btnContinue:visible');
  if (await next.count() !== 1) throw new Error('TEST_PASSENGER_CONTINUE_NOT_UNIQUE');
  await next.click({ timeout: 15000 });
  // Supplier handler performs ancillaryAvailability.action, then shows either
  // the service preference dialog or the ancillary tab. No payment continuation.
  await frame.waitForFunction(() => ['divAnciPref','btnAnciContinue'].some(id => {
    const e = document.getElementById(id);
    return e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getClientRects().length > 0;
  }), null, { timeout: 30000 });
  report('PORTAL_ANCILLARY_ENTRY_VISIBLE');
}

module.exports = { continueWithTestPassenger };
