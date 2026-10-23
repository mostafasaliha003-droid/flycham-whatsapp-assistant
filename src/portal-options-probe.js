'use strict';

// The operator explicitly authorized the result-page Make Reservation step.
// Supplier code opens passenger details here; final booking/payment controls
// are intentionally absent from this bounded probe.
async function openPassengerOptions(frame, page, report = () => {}) {
  const state = await frame.evaluate(() => ({
    trusted: location.origin === 'https://agents.airarabia.com',
    newFlow: typeof UI_commonSystem !== 'undefined' && UI_commonSystem.strPGMode === '',
    temporarySeatBlock: typeof DATA_ResPro !== 'undefined' && !!DATA_ResPro.initialParams?.seatBlock,
  }));
  if (!state?.trusted || !state.newFlow) throw new Error('OPTIONS_NEW_FLOW_NOT_CONFIRMED');
  report(state.temporarySeatBlock ? 'PORTAL_OPTIONS_TEMPORARY_SEAT_BLOCK_ENABLED' : 'PORTAL_OPTIONS_TEMPORARY_SEAT_BLOCK_DISABLED');
  const button = frame.locator('button#btnBook:visible');
  if (await button.count() !== 1) throw new Error('OPTIONS_CONTROL_NOT_UNIQUE');
  const handleDialog = async dialog => {
    if (dialog.type() === 'confirm' && /^Are you sure you have selected the correct flight connections\?/i.test(dialog.message())) {
      report('PORTAL_OPTIONS_FLIGHT_CONNECTION_CONFIRM_ACCEPTED');
      await dialog.accept();
    } else {
      report('PORTAL_OPTIONS_UNEXPECTED_DIALOG_DISMISSED');
      await dialog.dismiss();
    }
  };
  page.on('dialog', handleDialog);
  try {
    await button.click({ timeout: 15000 });
    await frame.locator('#btnContinue:visible').waitFor({ state: 'visible', timeout: 30000 });
    report('PORTAL_OPTIONS_PASSENGER_FORM_VISIBLE');
    return true;
  } finally { page.removeListener('dialog', handleDialog); }
}

module.exports = { openPassengerOptions };
