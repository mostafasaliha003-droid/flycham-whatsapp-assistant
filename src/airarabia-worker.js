'use strict';

const { chromium } = require('playwright');
const { PortalSession, HEARTBEAT_IDLE_MS, HEARTBEAT_CHECK_MS } = require('./portal-session');

const LOGIN_URL = 'https://agents.airarabia.com/xbe/public/showLogin.action';
const AIRPORTS = {
  SHJ: 'SHJ - Sharjah',
  DAM: 'DAM - Damascus',
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

class AirArabiaPortalAdapter {
  constructor(page, { username, password, origin, destination }) {
    if (!AIRPORTS[origin] || !AIRPORTS[destination] || origin === destination) {
      throw new Error('Unsupported keepalive route configuration');
    }
    this.page = page;
    this.username = username;
    this.password = password;
    this.origin = origin;
    this.destination = destination;
  }

  async isAuthenticated() {
    try {
      const top = this.page.frameLocator('iframe[src="showTop"]');
      const signOut = top.getByText('SignOut', { exact: true });
      return await signOut.count() > 0 && await signOut.isVisible();
    } catch {
      return false;
    }
  }

  async signIn() {
    await this.page.goto(LOGIN_URL);
    await this.page.locator('#username_txt').waitFor({ state: 'visible', timeout: 20000 });
    await this.page.locator('#username_txt').fill(this.username);
    await this.page.locator('#j_password').fill(this.password);
    await this.page.locator('#btnLogin').click();

    try {
      await this.page.locator('iframe[src="showTop"]').waitFor({ state: 'attached', timeout: 30000 });
      if (await this.isAuthenticated()) return;
    } catch {}

    const visibleText = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (/captcha|verify|verification|one[- ]time|otp|security code/i.test(visibleText)) {
      throw new Error('Portal requires manual verification');
    }
    throw new Error('Portal login could not be verified');
  }

  async selectAirport(frame, selector, code) {
    const field = frame.locator(selector);
    await field.fill(code);
    await field.press('ArrowDown');
    await frame.getByText(AIRPORTS[code], { exact: true }).click({ timeout: 10000 });
  }

  async searchFlightsForHeartbeat({ departureDate }) {
    if (!await this.isAuthenticated()) throw new Error('Portal session expired before heartbeat search');

    const top = this.page.frameLocator('iframe[src="showTop"]');
    await top.getByText('Make Reservation', { exact: true }).click();
    const search = this.page.frameLocator('iframe#mainFrame');
    await search.locator('#btnSearch').waitFor({ state: 'visible', timeout: 15000 });
    await this.selectAirport(search, '#fAirport', this.origin);
    await this.selectAirport(search, '#tAirport', this.destination);
    await search.locator('#departureDate').fill(departureDate);
    await search.locator('#returnDate').fill('');
    await search.locator('#adultCount').selectOption('1');
    await search.locator('#childCount').selectOption('0');
    await search.locator('#infantCount').selectOption('0');
    await search.locator('#classOfService').selectOption('EconomyClass');
    await search.locator('#selectedCurrency').selectOption({ label: 'AED' });
    await search.locator('#selSearchOptions').selectOption('SearchG9');
    await search.locator('#bookingType').selectOption('NORMAL');

    // This is the search-only button. Never click a result's #btnBook control.
    await search.locator('#btnSearch').click();
    await search.locator('#btnBook').first().waitFor({ state: 'visible', timeout: 45000 });
    if (!await this.isAuthenticated()) throw new Error('Session was not retained after heartbeat search');
  }
}

async function run() {
  if (process.env.AIR_ARABIA_KEEPALIVE_ENABLED !== 'true') {
    throw new Error('Keepalive is disabled; set AIR_ARABIA_KEEPALIVE_ENABLED=true only after approved setup');
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let session;
  const shutdown = async () => {
    if (session) await session.stop().catch(() => {});
    await browser.close().catch(() => {});
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const adapter = new AirArabiaPortalAdapter(page, {
      username: requiredEnv('AIR_ARABIA_AGENT_USERNAME'),
      password: requiredEnv('AIR_ARABIA_AGENT_PASSWORD'),
      origin: process.env.AIR_ARABIA_KEEPALIVE_ORIGIN || 'SHJ',
      destination: process.env.AIR_ARABIA_KEEPALIVE_DESTINATION || 'DAM',
    });
    await adapter.signIn();
    session = new PortalSession(adapter, {
      idleMs: HEARTBEAT_IDLE_MS,
      checkMs: HEARTBEAT_CHECK_MS,
    });

    let errorReported = false;
    session.start(code => {
      if (!errorReported) {
        errorReported = true;
        // Do not log page contents, credentials, customer data, or supplier URLs.
        console.error(code);
      }
    });
    console.log('Air Arabia keepalive worker started; idle search interval is 15 minutes.');
    await new Promise(() => {});
  } finally {
    await shutdown();
  }
}

if (require.main === module) {
  run().catch(error => {
    const message = /Missing required configuration|disabled|verification|could not be verified|Unsupported keepalive route/.test(error.message)
      ? error.message
      : 'Air Arabia keepalive worker failed safely';
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = { AirArabiaPortalAdapter, AIRPORTS };
