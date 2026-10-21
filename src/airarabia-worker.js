'use strict';

const { chromium } = require('playwright');
const { PortalSession, randomHeartbeatDate, HEARTBEAT_IDLE_MS, HEARTBEAT_CHECK_MS } = require('./portal-session');

const LOGIN_URL = 'https://agents.airarabia.com/xbe/public/showLogin.action';
// Enter through the user-supplied protected portal route so the supplier can
// save the requested destination before displaying its FORM login page.
const LOGIN_ENTRY_URL = 'https://agents.airarabia.com/xbe/private/showXBEMain.action';
const AIRPORTS = {
  SHJ: 'SHJ - Sharjah',
  DAM: 'DAM - Damascus',
};

const STAGES = new Set(['CONFIGURATION', 'BROWSER_START', 'OPEN_LOGIN_PAGE', 'LOGIN_FORM', 'LOGIN_SUBMIT', 'LOGIN_CONFIRM', 'SESSION']);
const REASONS = new Set(['TIMEOUT', 'NETWORK', 'TLS', 'HTTP_ERROR', 'MANUAL_VERIFICATION', 'LOGIN_NOT_CONFIRMED', 'MISSING_USERNAME', 'MISSING_PASSWORD', 'UNSUPPORTED_ROUTE', 'UNEXPECTED']);

class PortalError extends Error {
  constructor(stage, reason) {
    super(`PORTAL_${stage}_${reason}`);
    this.stage = stage;
    this.reason = reason;
  }
}

function safeFailureCode(error, stage = 'SESSION') {
  if (error instanceof PortalError && STAGES.has(error.stage) && REASONS.has(error.reason)) return `PORTAL_${error.stage}_${error.reason}`;
  const message = String(error?.message || '');
  const reason = error?.name === 'TimeoutError' ? 'TIMEOUT'
    : /ERR_CERT_|ERR_SSL_/i.test(message) ? 'TLS'
    : /ERR_(NAME_NOT_RESOLVED|CONNECTION_|INTERNET_|NETWORK_|PROXY_|TIMED_OUT)|ECONN|ENOTFOUND/i.test(message) ? 'NETWORK'
    : 'UNEXPECTED';
  return `PORTAL_${STAGES.has(stage) ? stage : 'SESSION'}_${reason}`;
}

async function atStage(stage, action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof PortalError) throw error;
    const code = safeFailureCode(error, stage);
    throw new PortalError(stage, code.slice(`PORTAL_${stage}_`.length));
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new PortalError('CONFIGURATION', name.endsWith('USERNAME') ? 'MISSING_USERNAME' : 'MISSING_PASSWORD');
  return value;
}

class AirArabiaPortalAdapter {
  constructor(page, { username, password, origin, destination, report = () => {} }) {
    if (!AIRPORTS[origin] || !AIRPORTS[destination] || origin === destination) {
      throw new PortalError('CONFIGURATION', 'UNSUPPORTED_ROUTE');
    }
    this.page = page;
    this.username = username;
    this.password = password;
    this.origin = origin;
    this.destination = destination;
    this.report = report;
  }

  async findVisibleControl(frame, pattern) {
    // Supplier controls may be images with alt/title names or form buttons.
    const candidates = ['link', 'button', 'img', 'menuitem'].map(role => frame.getByRole?.(role, { name: pattern })).filter(Boolean);
    if (frame.getByTitle) candidates.push(frame.getByTitle(pattern));
    if (frame.getByAltText) candidates.push(frame.getByAltText(pattern));
    candidates.push(frame.getByText(pattern));
    for (const locator of candidates) {
      try {
        const count = await locator.count();
        for (let index = 0; index < Math.min(count, 20); index++) {
          const element = locator.nth(index);
          if (await element.isVisible()) return element;
        }
      } catch {}
    }
    return null;
  }

  async findNavigationFrame() {
    // Both authenticated controls must belong to one trusted portal window;
    // legacy headers and reservation menus may occupy different child frames.
    const pages = this.page.context ? this.page.context().pages() : [this.page];
    for (const candidate of pages) {
      if (candidate.isClosed?.()) continue;
      let signOutFrame = null;
      let loginFormVisible = false;
      let reservationFrame = null;
      let reservationControl = null;
      for (const frame of candidate.frames()) {
        try {
          if (new URL(frame.url()).origin !== new URL(LOGIN_URL).origin) continue;
          if (await this.findVisibleControl(frame, /^(?:sign|log)\s*out$/i)) signOutFrame = frame;
          if (await frame.locator?.('#j_password').isVisible().catch(() => false)) loginFormVisible = true;
          const reservation = await this.findVisibleControl(frame, /^make\s*reservation$/i);
          if (reservation) { reservationFrame = frame; reservationControl = reservation; }
        } catch {}
      }
      const privateWindow = new URL(candidate.url()).origin === new URL(LOGIN_URL).origin && new URL(candidate.url()).pathname.startsWith('/xbe/private/');
      if (signOutFrame && !loginFormVisible && (reservationFrame || privateWindow)) {
        this.page = candidate;
        this.reservationControl = reservationControl;
        return reservationFrame || signOutFrame;
      }
    }
    return null;
  }

  async isAuthenticated() {
    this.navigationFrame = await this.findNavigationFrame();
    return Boolean(this.navigationFrame);
  }

  async waitForAuthentication(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.isAuthenticated()) return true;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return false;
  }

  async reportLoginResult() {
    // Only fixed classifications are logged; never page text, URLs or account data.
    const username = this.page.locator('#username_txt');
    if (await username.isVisible().catch(() => false)) this.report('PORTAL_LOGIN_RESULT_LOGIN_FORM_VISIBLE');
    try {
      const url = new URL(this.page.url());
      if (url.origin === new URL(LOGIN_URL).origin && url.pathname.startsWith('/xbe/private/')) {
        this.report('PORTAL_LOGIN_RESULT_PRIVATE_PAGE');
      }
    } catch {}
    const errorElement = this.page.locator('#errorMSG');
    if (await errorElement.isVisible().catch(() => false)) {
      const message = await errorElement.textContent({ timeout: 5000 }).catch(() => '');
      const reason = /inactive|disabled|locked/i.test(message) ? 'ACCOUNT_REVIEW'
        : /invalid|user.*password|password.*user/i.test(message) ? 'CREDENTIALS_REJECTED'
        : 'SUPPLIER_MESSAGE';
      this.report(`PORTAL_LOGIN_RESULT_${reason}`);
    }
    const pages = this.page.context ? this.page.context().pages() : [this.page];
    this.report(`PORTAL_LOGIN_DIAGNOSTIC_WINDOW_COUNT_${pages.length}`);
    for (const candidate of pages) {
      for (const frame of candidate.frames()) {
      try {
        const url = new URL(frame.url());
        if (url.origin !== new URL(LOGIN_URL).origin) continue;
        // Return classifications only from the browser, never raw visible text.
        const state = await frame.evaluate(() => {
          const visible = el => {
            const style = getComputedStyle(el);
            return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
          };
          const chunks = [];
          if (document.body) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const parent = walker.currentNode.parentElement;
              if (parent && !parent.closest('script,style,noscript') && visible(parent)) chunks.push(walker.currentNode.textContent);
            }
          }
          const text = chunks.join(' ').replace(/\s+/g, ' ');
          return {
            bodyHidden: Boolean(document.body && !visible(document.body)),
            frames: document.querySelectorAll('frame,iframe').length,
            loginInput: Boolean(document.querySelector('#username_txt')),
            passwordInput: Boolean(document.querySelector('input[type="password"]')),
            signOutText: /sign\s*out/i.test(text),
            reservationText: /make\s+reservation/i.test(text),
            signOutNamedControl: Array.from(document.querySelectorAll('[alt],[title],input[value],[aria-label]')).some(el => visible(el) && ['alt','title','value','aria-label'].some(name => /^(?:sign|log)\s*out$/i.test(el.getAttribute(name) || ''))),
            reservationNamedControl: Array.from(document.querySelectorAll('[alt],[title],input[value],[aria-label]')).some(el => visible(el) && ['alt','title','value','aria-label'].some(name => /^make\s*reservation$/i.test(el.getAttribute(name) || ''))),
            verification: /captcha|verify (you|that you) are human|looked like a bot|security challenge/i.test(text),
            accessDenied: /access denied|request (was )?(blocked|rejected)|forbidden|not authorized/i.test(text),
            invalidCredentials: /invalid.{0,30}(password|user)|incorrect.{0,30}(password|user)/i.test(text),
            passwordChange: /change (your )?password|password.{0,20}expir/i.test(text),
            sessionNotice: /already logged|active session|another session|concurrent session/i.test(text),
          };
        });
        const route = url.pathname === new URL(LOGIN_URL).pathname ? 'LOGIN'
          : /j_security_check$/.test(url.pathname) ? 'LOGIN_HANDLER'
          : url.pathname.startsWith('/xbe/private/') ? 'PRIVATE' : 'OTHER';
        this.report(`PORTAL_LOGIN_DIAGNOSTIC_${JSON.stringify({ route, ...state })}`);
      } catch { this.report('PORTAL_LOGIN_DIAGNOSTIC_FRAME_UNAVAILABLE'); }
      }
    }
    this.report('PORTAL_LOGIN_RESULT_AUTHENTICATION_MARKERS_NOT_CONFIRMED');
  }

  async signIn() {
    this.report('PORTAL_STAGE_OPEN_LOGIN_PAGE');
    await atStage('OPEN_LOGIN_PAGE', async () => {
      // The supplier's fullScreen2() opens its real login in a named winCC
      // popup and deliberately leaves the launcher document hidden.
      const popupReady = this.page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
      // Third-party frames can keep the full load event pending. Wait for the
      // document, then explicitly verify the actual form instead.
      const response = await this.page.goto(LOGIN_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && response.status() >= 400) throw new PortalError('OPEN_LOGIN_PAGE', 'HTTP_ERROR');
      const popup = await popupReady;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 45000 });
        const target = new URL(popup.url());
        if (target.origin !== new URL(LOGIN_URL).origin || target.pathname !== new URL(LOGIN_URL).pathname) {
          throw new PortalError('OPEN_LOGIN_PAGE', 'UNEXPECTED');
        }
        this.page = popup;
        this.page.setDefaultTimeout(15000);
        this.report('PORTAL_LOGIN_WINDOW_SELECTED');
      }
    });
    this.report('PORTAL_STAGE_LOGIN_FORM');
    await atStage('LOGIN_FORM', async () => {
      await this.page.locator('#username_txt').waitFor({ state: 'visible', timeout: 30000 });
      await this.page.locator('#j_password').waitFor({ state: 'visible', timeout: 30000 });
      await this.assertNoChallenge();
      await this.page.locator('#username_txt').fill(this.username);
      await this.page.locator('#j_password').fill(this.password);
    });
    this.page.on?.('response', response => {
      try {
        const url = new URL(response.url());
        if (url.origin === new URL(LOGIN_URL).origin && /\/j_security_check$/.test(url.pathname)) {
          this.report(`PORTAL_LOGIN_RESPONSE_HTTP_${response.status()}`);
        }
      } catch {}
    });
    this.report('PORTAL_STAGE_LOGIN_SUBMIT');
    await atStage('LOGIN_SUBMIT', () => this.page.locator('#btnLogin').click({ noWaitAfter: true }));
    this.report('PORTAL_STAGE_LOGIN_CONFIRM');
    await atStage('LOGIN_CONFIRM', async () => {
      if (!await this.waitForAuthentication()) {
        await this.assertNoChallenge();
        await this.reportLoginResult();
        throw new PortalError('LOGIN_CONFIRM', 'LOGIN_NOT_CONFIRMED');
      }
    });
    this.report('PORTAL_AUTHENTICATED');
  }

  async assertNoChallenge() {
    const captcha = await this.page.locator('#captcha_txt').isVisible().catch(() => false);
    // Supplier Browser.js overrides innerText with textContent, including hidden
    // scripts/error catalogs. Read only the supplier's visible error element.
    const errorMessage = this.page.locator('#errorMSG');
    const text = await errorMessage.isVisible().catch(() => false)
      ? await errorMessage.textContent({ timeout: 5000 }).catch(() => '') : '';
    if (captcha || /captcha|verify you are human|verification|one[- ]time|\botp\b|security code|looked like a bot/i.test(text)) {
      throw new PortalError('LOGIN_CONFIRM', 'MANUAL_VERIFICATION');
    }
  }

  async inspectSearchUI() {
    // Navigation/form metadata only: no input values, account text, cookies,
    // passenger rows, scripts, query strings or full URLs are returned.
    for (const frame of this.page.frames()) {
      try {
        const url = new URL(frame.url());
        if (url.origin !== new URL(LOGIN_URL).origin) continue;
        const resource = url.pathname.split('/').pop();
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,70}$/.test(resource)) continue;
        const metadata = await frame.evaluate(() => {
          const staticName = value => /^[A-Za-z_][A-Za-z0-9_.-]{0,60}$/.test(value || '') ? value : null;
          const visible = el => getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
          const menuName = /^(?:(?:make|new|create|modify|manage|view|search|find|book)\s*)?(?:reservations?|bookings?|flights?|search)(?:\s*(?:search|reservations?|flights?))?$/i;
          const controls = [];
          for (const el of document.querySelectorAll('a,button,input[type="button"],input[type="submit"],img,[onclick]')) {
            const labels = ['aria-label','title','alt','value'].map(name => el.getAttribute(name) || '');
            if (['A','BUTTON','SPAN','TD'].includes(el.tagName) && el.children.length < 4) labels.push(el.textContent || '');
            const label = labels.map(value => value.replace(/\s+/g, ' ').trim()).find(value => value.length < 65 && menuName.test(value));
            const action = (el.getAttribute('onclick') || '').match(/^\s*([A-Za-z_][A-Za-z0-9_]{0,60})\s*\(/)?.[1] || null;
            if (!label && !(action && /reserv|booking|search|flight/i.test(action))) continue;
            controls.push({ tag: el.tagName, id: staticName(el.id), label: label || null, action, visible: visible(el) });
          }
          const fields = [];
          if (document.querySelector('form') && !document.querySelector('#j_password')) {
            for (const el of document.querySelectorAll('input,select,button')) {
              fields.push({ tag: el.tagName, id: staticName(el.id), name: staticName(el.name), type: staticName(el.type), visible: visible(el) });
            }
          }
          return { controls: controls.slice(0,30), fields: fields.slice(0,50), frameCount: document.querySelectorAll('frame,iframe').length };
        });
        this.report(`PORTAL_SEARCH_UI_${JSON.stringify({ resource, ...metadata })}`);
      } catch { this.report('PORTAL_SEARCH_UI_FRAME_UNAVAILABLE'); }
    }
  }

  async selectAirport(frame, selector, code) {
    const field = frame.locator(selector);
    await field.fill(code);
    await field.press('ArrowDown');
    await frame.getByText(AIRPORTS[code], { exact: true }).click({ timeout: 10000 });
  }

  async searchFlightsForHeartbeat({ departureDate }) {
    if (!await this.isAuthenticated()) throw new Error('Portal session expired before heartbeat search');

    if (!this.reservationControl) {
      // The authenticated main page is a safe supplier request. Reloading it
      // refreshes both server activity and the portal's client idle timer.
      // Do not manufacture a reservation-menu selector when none is observed.
      const response = await this.page.goto(LOGIN_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && response.status() >= 400) throw new PortalError('SESSION', 'HTTP_ERROR');
      if (!await this.waitForAuthentication()) throw new Error('Portal session was not retained after refresh');
      this.report('PORTAL_HEARTBEAT_REFRESH_COMPLETED');
      return;
    }
    await this.reservationControl.click();
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
    this.report('PORTAL_HEARTBEAT_SEARCH_COMPLETED');
  }
}

function waitForShutdown() {
  return new Promise(resolve => {
    const timer = setInterval(() => {}, 60_000);
    const stop = () => {
      clearInterval(timer);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function run({ launch = options => chromium.launch(options), park = waitForShutdown, log = console } = {}) {
  if (process.env.AIR_ARABIA_KEEPALIVE_ENABLED !== 'true') {
    log.log('Keepalive is disabled; worker is idle until AIR_ARABIA_KEEPALIVE_ENABLED=true');
    await park();
    return;
  }

  let browser;
  let session;
  let failed = false;
  const shutdown = async () => {
    if (session) await session.stop().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  };
  try {
    // Validate secrets before opening any connection. Values are never logged.
    const config = {
      username: requiredEnv('AIR_ARABIA_AGENT_USERNAME'),
      password: requiredEnv('AIR_ARABIA_AGENT_PASSWORD'),
      origin: process.env.AIR_ARABIA_KEEPALIVE_ORIGIN || 'SHJ',
      destination: process.env.AIR_ARABIA_KEEPALIVE_DESTINATION || 'DAM',
      report: code => log.log(code),
    };
    log.log('PORTAL_STAGE_BROWSER_START');
    browser = await atStage('BROWSER_START', () => launch({ headless: true, args: ['--no-sandbox'] }));
    const page = await atStage('BROWSER_START', () => browser.newPage());
    page.setDefaultTimeout(15000);
    const adapter = new AirArabiaPortalAdapter(page, config);
    await adapter.signIn();
    log.log('PORTAL_STAGE_INITIAL_HEARTBEAT');
    await adapter.searchFlightsForHeartbeat({ departureDate: randomHeartbeatDate() });
    if (process.env.AIR_ARABIA_INSPECT_SEARCH_UI === 'true') await adapter.inspectSearchUI();
    session = new PortalSession(adapter, { idleMs: HEARTBEAT_IDLE_MS, checkMs: HEARTBEAT_CHECK_MS });

    let errorReported = false;
    session.start(code => {
      if (!errorReported) {
        errorReported = true;
        log.error(code);
        // A failed authentication/search must not start an automatic retry loop.
        shutdown().catch(() => {});
        log.error('PORTAL_BLOCKED_OPERATOR_REVIEW_NO_AUTOMATIC_RETRY');
      }
    });
    log.log('Air Arabia keepalive worker started; idle search interval is 15 minutes.');
    await park();
  } catch (error) {
    failed = true;
    log.error(safeFailureCode(error));
    log.error('PORTAL_BLOCKED_OPERATOR_REVIEW_NO_AUTOMATIC_RETRY');
  } finally {
    await shutdown();
  }
  // Stay idle after a failure instead of exiting and having the host repeat
  // login on every process restart. Only an operator's redeploy can retry.
  if (failed) await park();
}

if (require.main === module) {
  run().catch(() => {
    console.error('PORTAL_SESSION_UNEXPECTED');
    process.exitCode = 1;
  });
}

module.exports = { AirArabiaPortalAdapter, AIRPORTS, LOGIN_ENTRY_URL, PortalError, safeFailureCode, run };
