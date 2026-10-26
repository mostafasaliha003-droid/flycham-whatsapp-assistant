'use strict';

const { chromium } = require('playwright');
const { waitForAirArabiaCode } = require('./gmail-verification-provider');
const { verificationFormAction, verificationResultAction } = require('./portal-verification-form');
const { submitProbe } = require('./portal-search-probe');
const { openPassengerOptions } = require('./portal-options-probe');
const { continueWithTestPassenger } = require('./portal-test-passenger');
const { scanSeatPrices } = require('./portal-seat-prices');
const { scanAncillaryCatalogs } = require('./portal-ancillary-catalogs');
const { validateLiveRequest, quoteFromScans, expandLiveRequests, formatQuoteOptions } = require('./live-quote');
const { waitForFlightResults, readFlightTimes, selectFlightTimes, flightPairs } = require('./portal-flight-times');
const { startQuotePolling } = require('./quote-poller');
const { PortalSession, randomHeartbeatDate, HEARTBEAT_IDLE_MS, HEARTBEAT_CHECK_MS } = require('./portal-session');
const { IdlePortalSession } = require('./idle-portal-session');

const LOGIN_URL = 'https://agents.airarabia.com/xbe/public/showLogin.action';
// Enter through the user-supplied protected portal route so the supplier can
// save the requested destination before displaying its FORM login page.
const LOGIN_ENTRY_URL = 'https://agents.airarabia.com/xbe/private/showXBEMain.action';
const {AIRPORTS}=require('./airports');

const STAGES = new Set(['CONFIGURATION', 'BROWSER_START', 'OPEN_LOGIN_PAGE', 'LOGIN_FORM', 'LOGIN_SUBMIT', 'LOGIN_CONFIRM', 'VERIFICATION', 'SESSION', 'PROBE']);
const REASONS = new Set(['TIMEOUT', 'NETWORK', 'TLS', 'HTTP_ERROR', 'MANUAL_VERIFICATION', 'LOGIN_NOT_CONFIRMED', 'MISSING_USERNAME', 'MISSING_PASSWORD', 'UNSUPPORTED_ROUTE', 'UNEXPECTED', 'VERIFICATION_TIMEOUT', 'VERIFICATION_REJECTED', 'VERIFICATION_EXPIRED', 'VERIFICATION_NOT_CONFIRMED', 'VERIFIED_NAVIGATION_PENDING', 'FRAME_CHANGED', 'SELECTOR_AMBIGUOUS', 'TYPE_ERROR', 'VERIFICATION_FORM_UNAVAILABLE', 'CLOSE_FAILED']);

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
  const reason = /frame was detached|execution context was destroyed|cannot find context/i.test(message) ? 'FRAME_CHANGED'
    : /strict mode violation/i.test(message) ? 'SELECTOR_AMBIGUOUS'
    : error?.name === 'TypeError' ? 'TYPE_ERROR'
    : error?.name === 'TimeoutError' ? 'TIMEOUT'
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

function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (!value?.trim()) throw new PortalError('CONFIGURATION', name.endsWith('USERNAME') ? 'MISSING_USERNAME' : 'MISSING_PASSWORD');
  return value;
}

class AirArabiaPortalAdapter {
  constructor(page, { username, password, origin, destination, report = () => {}, verificationProvider = waitForAirArabiaCode }) {
    if (!AIRPORTS[origin] || !AIRPORTS[destination] || origin === destination) {
      throw new PortalError('CONFIGURATION', 'UNSUPPORTED_ROUTE');
    }
    this.page = page;
    this.username = username;
    this.password = password;
    this.origin = origin;
    this.destination = destination;
    this.report = report;
    this.verificationProvider = verificationProvider;
    this.verificationAttempted = false;
    this.loginResponsePages = new WeakSet();
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
      if (signOutFrame && !loginFormVisible && reservationFrame) {
        this.page = candidate;
        this.reservationControl = reservationControl;
        return reservationFrame || signOutFrame;
      }
    }
    return null;
  }

  async verificationFormReady(frame) {
    try {
      if (await frame.locator?.('#userOtp:visible').isVisible()) return 'locator';
    } catch (error) {
      if (!this.verificationLocatorFailureReported) {
        this.verificationLocatorFailureReported = true;
        this.report(safeFailureCode(error, 'VERIFICATION'));
      }
    }
    if (!frame.evaluate) return null;
    const state = await frame.evaluate(verificationFormAction, { operation: 'inspect' }).catch(() => null);
    if (state && !this.verificationDOMReported && /\/sendOTP(?:\.action)?$/.test(new URL(frame.url()).pathname)) {
      this.verificationDOMReported = true;
      this.report(`PORTAL_VERIFICATION_FORM_STATE_${JSON.stringify(state)}`);
    }
    if (state?.ready) return 'dom';
    return null;
  }

  async findVerificationFrame() {
    const pages = this.page.context ? this.page.context().pages() : [this.page];
    let pendingRoute = null;
    for (const candidate of pages) {
      if (candidate.isClosed?.()) continue;
      for (const frame of candidate.frames()) {
        try {
          const url = new URL(frame.url());
          if (url.origin !== new URL(LOGIN_URL).origin) continue;
          // A wrapper frame can share the OTP route. Prefer the frame that
          // actually owns a visible input over an earlier route-only match.
          if (await this.verificationFormReady(frame)) return frame;
          if (/\/(?:sendOTP|verifyOTP)(?:\.action)?$/.test(url.pathname)) pendingRoute = frame;
        } catch {}
      }
    }
    return pendingRoute;
  }

  async hasCaptchaChallenge() {
    const pages = this.page.context ? this.page.context().pages() : [this.page];
    for (const candidate of pages) {
      if (candidate.isClosed?.()) continue;
      for (const frame of candidate.frames()) {
        try {
          if (new URL(frame.url()).origin !== new URL(LOGIN_URL).origin) continue;
          if (await frame.locator?.('#captcha_txt:visible,iframe[src*="captcha"]:visible').count()) return true;
        } catch {}
      }
    }
    return Boolean(await this.page.locator?.('#captcha_txt').isVisible().catch(() => false));
  }

  async hasVerificationChallenge() {
    return Boolean(await this.findVerificationFrame()) || await this.hasCaptchaChallenge();
  }

  async resumeVerification() {
    // Resume only the supplier's existing challenge; never open a new login or
    // resend credentials while the operator is completing verification.
    if (await this.hasCaptchaChallenge() || !await this.findVerificationFrame()) {
      throw new PortalError('VERIFICATION', 'MANUAL_VERIFICATION');
    }
    if (!await this.waitForAuthentication(30000, { operatorVerification: true })) {
      throw new PortalError('VERIFICATION', 'VERIFICATION_NOT_CONFIRMED');
    }
    this.verificationAttempted = false;
    this.verificationNavigationResumed = false;
    this.report('PORTAL_AUTHENTICATED');
  }

  async isAuthenticated() {
    if (await this.hasVerificationChallenge()) {
      this.navigationFrame = null;
      this.reservationControl = null;
      return false;
    }
    this.navigationFrame = await this.findNavigationFrame();
    return Boolean(this.navigationFrame);
  }

  async waitForAuthentication(timeoutMs = 30000, { operatorVerification = false } = {}) {
    let deadline = Date.now() + timeoutMs;
    let verificationStatus = null;
    let verificationSubmittedAt = 0;
    do {
      const verification = await this.findVerificationFrame();
      if (verification && !this.verificationAttempted) {
        if (!operatorVerification) throw new PortalError('VERIFICATION', 'MANUAL_VERIFICATION');
        // Reacquire frames while the supplier replaces its login document.
        // A route alone can be present before the OTP form is ready.
        const ready = await this.verificationFormReady(verification);
        if (!ready) {
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }
        this.report('PORTAL_VERIFICATION_WAITING_FOR_OPERATOR');
        let code;
        try {
          code = await this.verificationProvider({ requestedAt: Date.now() });
          this.verificationAttempted = true;
          if (ready === 'dom') {
            const result = await verification.evaluate(verificationFormAction, { operation: 'submit', code });
            code = null;
            if (!result?.submitted) throw new PortalError('VERIFICATION', 'VERIFICATION_FORM_UNAVAILABLE');
          } else {
            await verification.locator('#userOtp:visible').fill(code);
            code = null;
            await verification.locator('#btnSubmit').click({ noWaitAfter: true });
          }
          this.report('PORTAL_VERIFICATION_SUBMITTED');
          verificationSubmittedAt = Date.now();
        } catch (error) {
          code = null;
          throw new PortalError('VERIFICATION', error.code === 'VERIFICATION_TIMEOUT' ? 'VERIFICATION_TIMEOUT' : 'MANUAL_VERIFICATION');
        }
        deadline = Date.now() + timeoutMs;
      }
      if (verification && this.verificationAttempted && verification.evaluate) {
        const result = await verification.evaluate(verificationResultAction, { operation: 'inspect' }).catch(() => null);
        const allowed = new Set(['CONFIRMED', 'UNCONFIRMED', 'EXPIRED', 'INVALID_CODE', 'ATTEMPT_LIMIT', 'SUPPLIER_MESSAGE']);
        if (allowed.has(result?.status)) {
          if (result.status !== verificationStatus) this.report('PORTAL_VERIFICATION_RESULT_' + result.status);
          verificationStatus = result.status;
          if (['EXPIRED', 'INVALID_CODE', 'ATTEMPT_LIMIT'].includes(result.status)) break;
          if (result.status === 'CONFIRMED' && !this.verificationNavigationResumed && Date.now() - verificationSubmittedAt >= 2000) {
            this.verificationNavigationResumed = true;
            const resumed = await verification.evaluate(verificationResultAction, { operation: 'resume' }).catch(() => null);
            this.report(resumed?.resumed ? 'PORTAL_VERIFICATION_SUPPLIER_NAVIGATION_RESUMED' : 'PORTAL_VERIFICATION_SUPPLIER_NAVIGATION_PENDING');
          }
        }
      }
      if (await this.isAuthenticated()) return true;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    if (await this.findVerificationFrame()) {
      await this.inspectSearchUI();
      const reason = !this.verificationAttempted ? 'VERIFICATION_FORM_UNAVAILABLE'
        : verificationStatus === 'EXPIRED' ? 'VERIFICATION_EXPIRED'
        : ['INVALID_CODE', 'ATTEMPT_LIMIT'].includes(verificationStatus) ? 'VERIFICATION_REJECTED'
        : verificationStatus === 'CONFIRMED' ? 'VERIFIED_NAVIGATION_PENDING' : 'VERIFICATION_NOT_CONFIRMED';
      throw new PortalError('VERIFICATION', reason);
    }
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

  trustedLoginDocument(target) {
    try {
      const url = new URL(target.url());
      return url.origin === new URL(LOGIN_URL).origin
        && url.pathname.split(';')[0] === new URL(LOGIN_URL).pathname;
    } catch { return false; }
  }

  async findLoginForm() {
    // Reusing the supplier's named winCC window does not emit a new popup.
    // Inspect only its trusted login documents, never hidden launcher inputs.
    const pages = this.page.context ? this.page.context().pages() : [this.page];
    const candidates = [];
    for (const candidate of pages) {
      if (candidate.isClosed?.()) continue;
      try { if (new URL(candidate.url()).origin !== new URL(LOGIN_URL).origin) continue; }
      catch { continue; }
      const main = candidate.mainFrame?.();
      const targets = [candidate, ...(candidate.frames?.() || []).filter(frame => frame !== main)];
      for (const target of targets) {
        if (!this.trustedLoginDocument(target)) continue;
        try {
          const visible = await Promise.all(['#username_txt', '#j_password', '#btnLogin'].map(selector => target.locator(selector).isVisible()));
          if (!visible.every(Boolean)) continue;
          const name = typeof candidate.evaluate === 'function'
            ? await candidate.evaluate(() => window.name).catch(() => '') : '';
          candidates.push({ page: candidate, target, named: name === 'winCC' });
        } catch {}
      }
    }
    const named = candidates.filter(candidate => candidate.named);
    const matches = named.length ? named : candidates;
    if (matches.length > 1) throw new PortalError('LOGIN_FORM', 'SELECTOR_AMBIGUOUS');
    return matches[0] || null;
  }

  async acquireLoginForm({ timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.hasVerificationChallenge()) throw new PortalError('LOGIN_CONFIRM', 'MANUAL_VERIFICATION');
      const found = await this.findLoginForm();
      if (found) {
        if (this.page !== found.page || found.target !== found.page) this.report('PORTAL_LOGIN_FORM_REACQUIRED');
        this.page = found.page;
        this.page.setDefaultTimeout?.(15000);
        return found.target;
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() <= deadline);
    throw new PortalError('LOGIN_FORM', 'TIMEOUT');
  }

  async assertLoginTargetSafe(target) {
    if (!this.trustedLoginDocument(target) || new URL(this.page.url()).origin !== new URL(LOGIN_URL).origin) {
      throw new PortalError('LOGIN_FORM', 'UNEXPECTED');
    }
    if (await this.hasVerificationChallenge()) throw new PortalError('LOGIN_CONFIRM', 'MANUAL_VERIFICATION');
    await this.assertNoChallenge(target);
  }

  observeLoginResponses(page = this.page) {
    // Reauthentication can reuse the same named window. Install our bounded
    // diagnostic once per page without retaining old pages or removing any
    // response handlers owned by the browser/session observer.
    if (!page || typeof page.on !== 'function' || this.loginResponsePages.has(page)) return;
    page.on('response', response => {
      try {
        const url = new URL(response.url());
        if (url.origin === new URL(LOGIN_URL).origin && /\/j_security_check$/.test(url.pathname)) {
          this.report(`PORTAL_LOGIN_RESPONSE_HTTP_${response.status()}`);
        }
      } catch {}
    });
    this.loginResponsePages.add(page);
  }

  async partialLoginRecoveryEligible() {
    // A sign-out header by itself is not an authenticated portal. Permit one
    // ordinary protected-page navigation only when the selected supplier
    // window is fully observable and has no visible login/security response.
    // Do not combine evidence from the hidden launcher or another popup.
    try {
      if (this.page.isClosed?.() || new URL(this.page.url()).origin !== new URL(LOGIN_URL).origin) return false;
      const frames = this.page.frames();
      if (!frames.length) return false;
      let signOut = false;
      for (const frame of frames) {
        const url = new URL(frame.url());
        if (url.origin !== new URL(LOGIN_URL).origin || /\/(?:sendOTP|verifyOTP)(?:\.action)?$/.test(url.pathname.split(';')[0])) return false;
        const state = await frame.evaluate(() => {
          if (!document.body) return { observed: false };
          const visible = element => {
            if (!element || !element.getClientRects().length) return false;
            for (let current = element; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
            }
            return true;
          };
          let frameVisible = true;
          try {
            for (let view = window; view !== view.top; view = view.parent) {
              if (view.parent.location.origin !== location.origin || !visible(view.frameElement)) { frameVisible = false; break; }
            }
          } catch { return { observed: false }; }
          const shown = element => frameVisible && visible(element);
          const chunks = [];
          if (document.body) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const parent = walker.currentNode.parentElement;
              if (parent && !parent.closest('script,style,noscript') && shown(parent)) chunks.push(walker.currentNode.textContent);
            }
          }
          const text = chunks.join(' ').replace(/\s+/g, ' ');
          const controls = Array.from(document.querySelectorAll('a,button,img,input,[role="button"],[role="link"],[role="menuitem"]')).filter(shown);
          const named = element => ['alt', 'title', 'value', 'aria-label'].map(name => element.getAttribute(name) || '').concat(element.textContent || '');
          return {
            observed: true,
            signOut: controls.some(element => named(element).some(label => /^(?:sign|log)\s*out$/i.test(label.trim()))),
            visibleLogin: Array.from(document.querySelectorAll('#username_txt,#j_password,#btnLogin,input[type="password"]')).some(shown),
            verification: Array.from(document.querySelectorAll('#userOtp,#captcha_txt,iframe[src*="captcha"]')).some(shown) || /captcha|verify (?:you|that you) are human|one[- ]time|\botp\b|verification code|security (?:code|challenge)|looked like a bot/i.test(text),
            accessDenied: /access denied|request (?:was )?(?:blocked|rejected)|forbidden|not authorized|account.{0,20}(?:locked|disabled|inactive)/i.test(text),
            invalidCredentials: /invalid.{0,30}(?:password|user)|incorrect.{0,30}(?:password|user)|credentials? (?:are |were )?(?:invalid|rejected)/i.test(text),
            passwordChange: /change (?:your )?password|password.{0,20}expir/i.test(text),
            sessionNotice: /already logged|active session|another session|concurrent session/i.test(text),
            supplierError: Array.from(document.querySelectorAll('#errorMSG,#spnError')).some(element => shown(element) && Boolean(element.textContent?.trim())),
          };
        });
        const vetoes = ['visibleLogin', 'verification', 'accessDenied', 'invalidCredentials', 'passwordChange', 'sessionNotice', 'supplierError'];
        if (state?.observed !== true || typeof state.signOut !== 'boolean' || vetoes.some(key => typeof state[key] !== 'boolean' || state[key])) return false;
        signOut ||= state.signOut;
      }
      return signOut;
    } catch { return false; }
  }

  async recoverPartialLogin() {
    if (!await this.partialLoginRecoveryEligible()) return false;
    this.report('PORTAL_PARTIAL_LOGIN_RECOVERY_STARTED');
    const response = await this.page.goto(LOGIN_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (response && response.status() >= 400) throw new PortalError('LOGIN_CONFIRM', 'HTTP_ERROR');
    // This is a single normal navigation, without credentials or an OTP
    // resubmission. A new challenge still stops through the usual guard.
    const confirmed = await this.waitForAuthentication(30000);
    this.report(confirmed ? 'PORTAL_PARTIAL_LOGIN_RECOVERY_CONFIRMED' : 'PORTAL_PARTIAL_LOGIN_RECOVERY_NOT_CONFIRMED');
    return confirmed;
  }

  async signIn() {
    this.verificationAttempted = false;
    this.verificationNavigationResumed = false;
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
      this.loginTarget = await this.acquireLoginForm();
      await this.assertLoginTargetSafe(this.loginTarget);
      await this.loginTarget.locator('#username_txt').fill(this.username);
      await this.assertLoginTargetSafe(this.loginTarget);
      await this.loginTarget.locator('#j_password').fill(this.password);
    });
    this.observeLoginResponses();
    this.report('PORTAL_STAGE_LOGIN_SUBMIT');
    await atStage('LOGIN_SUBMIT', async () => {
      await this.assertLoginTargetSafe(this.loginTarget);
      await this.loginTarget.locator('#btnLogin').click({ noWaitAfter: true });
    });
    this.report('PORTAL_STAGE_LOGIN_CONFIRM');
    await atStage('LOGIN_CONFIRM', async () => {
      if (!await this.waitForAuthentication(30000, { operatorVerification: true }) && !await this.recoverPartialLogin()) {
        await this.assertNoChallenge();
        await this.reportLoginResult();
        throw new PortalError('LOGIN_CONFIRM', 'LOGIN_NOT_CONFIRMED');
      }
    });
    this.verificationAttempted = false;
    this.verificationNavigationResumed = false;
    this.report('PORTAL_AUTHENTICATED');
  }

  async assertNoChallenge(scope = this.page) {
    const captcha = await scope.locator('#captcha_txt').isVisible().catch(() => false);
    // Supplier Browser.js overrides innerText with textContent, including hidden
    // scripts/error catalogs. Read only the supplier's visible error element.
    const errorMessage = scope.locator('#errorMSG');
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
        // Strip matrix parameters such as ;jsessionid without logging them.
        const resource = url.pathname.split('/').pop().split(';')[0];
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,70}$/.test(resource)) continue;
        const metadata = await frame.evaluate(() => {
          const staticName = value => /^(?:[A-Za-z_][A-Za-z0-9_.-]{0,60}|[1-9][0-9]?_display(?:Adult|Infant)(?:FirstName|LastName|Title|Nationality|DOB))$/.test(value || '') ? value : null;
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
          const choices = [];
          for (const id of ['classOfService','selectedCurrency','selSearchOptions','bookingType']) {
            const select = document.getElementById(id);
            if (select?.tagName !== 'SELECT') continue;
            choices.push({ id, options: Array.from(select.options).slice(0,20).map(option => ({
              value: staticName(option.value),
              label: /^[A-Za-z0-9 ()/._-]{1,50}$/.test(option.textContent.trim()) ? option.textContent.trim() : null,
            })) });
          }
          const trips = Array.from(document.querySelectorAll('input[name="searchType"][type="radio"]')).map(radio => ({ value: staticName(radio.value), labels: Array.from(radio.labels || []).map(label => label.textContent.replace(/\s+/g,' ').trim()).filter(label => /^(?:one\s*way|round\s*trip|return|multi[ -]?(?:city|destination))$/i.test(label)) }));
          const resultContainers = Array.from(document.querySelectorAll('[id]')).filter(element => visible(element) && /flight|fare|avail|outbound|inbound|segment|searchResult/i.test(element.id)).map(element => ({ tag: element.tagName, id: staticName(element.id), children: element.children.length })).filter(element => element.id).slice(0,40);
          const flightRows = Array.from(document.querySelectorAll('tr')).filter(row => visible(row) && /\bG9[ -]?\d{1,4}\b/i.test(row.textContent || '')).map(row => ({ id: staticName(row.id), cells: row.cells.length, routeCodesPresent: /\bSHJ\b/.test(row.textContent || '') && /\bDAM\b/.test(row.textContent || '') })).slice(0,20);
          // Read only short visible result values from exact supplier IDs.
          // This excludes passenger/account content and never clicks a fare or booking control.
          const resultValues = [];
          const resultIds = new Set(['outboundFlightNumber','inboundFlightNumber','outboundColumnBundle','inboundColumnBundle','outboundColumnBundlePrice','inboundColumnBundlePrice']);
          for (const el of document.querySelectorAll('[id]')) {
            if (!resultIds.has(el.id) || !visible(el)) continue;
            const value = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!value || value.length > 40) continue;
            const flight = /^(?:G9|3O|[A-Z0-9]{2})[ -]?\d{1,4}$/i.test(value);
            const bundle = /^(?:[A-Za-z0-9][A-Za-z0-9 _-]{0,29})$/.test(value);
            const price = /^(?:(?:AED|USD|EUR|GBP|SAR)\s*)?[\d,]+(?:\.\d{1,2})?(?:\s*(?:AED|USD|EUR|GBP|SAR))?$/i.test(value) && /\d/.test(value);
            if ((/FlightNumber$/i.test(el.id) && flight) || (/ColumnBundlePrice$/i.test(el.id) && price) || (/ColumnBundle$/i.test(el.id) && bundle)) {
              resultValues.push({ id: el.id, value });
            }
          }
          // Public static script paths let an operator inspect the booking
          // handler without clicking it. Strip all queries/matrix parameters;
          // never return inline scripts, request headers or session URLs.
          const scriptResources = Array.from(document.scripts || []).flatMap(script => {
            if (!script.src) return [];
            try {
              const url = new URL(script.src, location.href);
              if (url.origin !== location.origin || !/^\/[A-Za-z0-9_./-]+\.js$/i.test(url.pathname)) return [];
              return [url.pathname];
            } catch { return []; }
          });
          return { controls: controls.slice(0,30), fields: fields.sort((a,b) => Number(b.visible) - Number(a.visible)).slice(0,100), choices, trips, resultContainers, flightRows, resultValues: resultValues.slice(0,60), scriptResources: [...new Set(scriptResources)].slice(0,80), frameCount: document.querySelectorAll('frame,iframe').length };
        });
        this.report(`PORTAL_SEARCH_UI_${JSON.stringify({ resource, ...metadata })}`);
      } catch { this.report('PORTAL_SEARCH_UI_FRAME_UNAVAILABLE'); }
    }
  }

  async inspectReservationSearch({ timeoutMs = 30000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
    if (!await this.isAuthenticated()) throw new PortalError('SESSION', 'LOGIN_NOT_CONFIRMED');
    if (!this.reservationControl) {
      this.report('PORTAL_RESERVATION_MENU_UNAVAILABLE');
      await this.inspectSearchUI();
      return false;
    }
    // This is the observed navigation control, never a result's Book button.
    await this.reservationControl.click({ timeout: 15000 });
    this.report('PORTAL_RESERVATION_SEARCH_OPENED');
    const deadline = now() + timeoutMs;
    do {
      if (await this.findVerificationFrame()) throw new PortalError('VERIFICATION', 'MANUAL_VERIFICATION');
      for (const frame of this.page.frames()) {
        try {
          if (new URL(frame.url()).origin !== new URL(LOGIN_URL).origin) continue;
          const ready = await frame.evaluate(() => {
            const ids = ['fAirport', 'tAirport', 'departureDate', 'adultCount', 'btnSearch'];
            return ids.every(id => {
              const fields = document.querySelectorAll('[id="' + id + '"]');
              if (fields.length !== 1) return false;
              const field = fields[0], style = getComputedStyle(field);
              return !field.disabled && style.display !== 'none' && style.visibility !== 'hidden' && field.getClientRects().length > 0;
            });
          });
          if (ready === true) {
            this.searchFrame = frame;
            this.report('PORTAL_RESERVATION_SEARCH_FORM_CONFIRMED');
            await this.inspectSearchUI();
            return true;
          }
        } catch {}
      }
      if (now() >= deadline) break;
      await pause(500);
    } while (now() < deadline);
    this.report('PORTAL_RESERVATION_SEARCH_FORM_NOT_CONFIRMED');
    await this.inspectSearchUI();
    return false;
  }

  async runCustomerQuote(request,onProgress,assertCurrent=async()=>{}) {
    const dates=expandLiveRequests(request),results=[],coverage=[];
    const deadline=Date.now()+45*60*1000;let attempted=0,consecutiveDiscoveryFailures=0;
    for(const dated of dates){
      await assertCurrent();if(Date.now()>=deadline||results.length>=80)break;
      const day={date:dated.departureDate,status:'unverified',confirmed:0,failed:0};coverage.push(day);
      let choices;
      try{choices=(await this.runCustomerQuoteVariant(dated,null,true)).choices;consecutiveDiscoveryFailures=0;}
      catch(error){day.status=error.message==='NO_FLIGHTS_CONFIRMED'?'no_flights':'unverified';day.failed++;this.report(safeFailureCode(error,'PROBE'));if(onProgress)await onProgress('',{coverage});if(++consecutiveDiscoveryFailures>=3)break;continue;}
      for(const choice of flightPairs(choices)){
        await assertCurrent();if(Date.now()>=deadline||results.length>=80){day.failed++;break;}attempted++;
        let result;
        for(let retry=0;retry<2;retry++){
          await assertCurrent();
          try{result=await this.runCustomerQuoteVariant(dated,choice);break;}
          catch(error){const code=safeFailureCode(error,'PROBE');this.report(code);if(retry===0&&/TIMEOUT|NETWORK|FRAME_CHANGED/.test(code)){this.report('PORTAL_QUOTE_READ_RETRY');continue;}day.failed++;this.report('PORTAL_TIMING_OPTION_UNCONFIRMED');break;}
        }
        if(result){result.reference=results.length+1;results.push(result);day.confirmed++;if(onProgress)await onProgress('نتيجة مؤكدة، والمقارنة مستمرة:\n'+formatQuoteOptions(dated,[result],{complete:false,attempted,totalDates:dates.length,inProgress:true}),{offer:result,coverage});}
      }
      day.status=day.failed?'partial':'confirmed';if(onProgress)await onProgress('',{coverage});
    }
    for(const dated of dates)if(!coverage.some(d=>d.date===dated.departureDate))coverage.push({date:dated.departureDate,status:'unverified',confirmed:0,failed:0});
    const complete=coverage.every(d=>['confirmed','no_flights'].includes(d.status));
    this.report(complete?'PORTAL_TIMING_COMPARISON_COMPLETE':'PORTAL_TIMING_COMPARISON_PARTIAL');
    const detail='\n\nتغطية التواريخ:\n'+coverage.map(d=>`${d.date}: ${d.status==='confirmed'?'اكتمل فحص الخيارات':d.status==='no_flights'?'لا رحلات متاحة في نتائج المصدر':d.status==='partial'?'تأكدت بعض الخيارات، وبقية الفحص لم يكتمل':'لم يتأكد السعر'}`).join('\n');
    if(!results.length)return{reply:'لم تتأكد أسعار للطلب حتى الآن. تفاصيلك محفوظة؛ لم يتم حجز أو إصدار تذكرة.'+detail,outcome:'failed',coverage};
    return{reply:formatQuoteOptions(request,results,{complete,attempted,totalDates:dates.length})+detail,outcome:complete?'done':'partial',coverage};
  }

  async runCustomerQuoteVariant(request,choice,discoverOnly=false) {
    const config=validateLiveRequest(request);
    // New protected page for every request, serialized by PortalSession.run.
    await this.refreshProtectedPage();
    if(!await this.inspectReservationSearch())throw Error('SEARCH_NOT_READY');
    const prepared=await submitProbe(this.searchFrame,{...config,requestedReturnDate:config.returnDate,requestTripType:request.tripType,report:this.report});
    const oneWay=request.tripType==='one_way';
    if(prepared.tripKind!==(oneWay?'one-way':'return'))throw Error('TRIP_NOT_CONFIRMED');
    this.report('PORTAL_QUOTE_WAITING_FOR_FLIGHT_RESULTS');
    await waitForFlightResults(this.searchFrame,oneWay);
    this.report('PORTAL_QUOTE_FLIGHT_RESULTS_READY');
    if(oneWay&&!await this.searchFrame.evaluate(()=>UI_tabSearchFlights.strRetDate===''))throw Error('ONE_WAY_NOT_CONFIRMED');
    const choices=await readFlightTimes(this.searchFrame,oneWay);
    if(!await this.isAuthenticated())throw new PortalError('SESSION','LOGIN_NOT_CONFIRMED');
    this.onAuthenticatedActivity?.();
    if(discoverOnly)return{choices};
    const timing=choice?await selectFlightTimes(this.searchFrame,choice):{
      out:choices.out.find(f=>f.selected)||choices.out[0],back:choices.back.find(f=>f.selected)||choices.back[0]};
    if(!timing.out||(!oneWay&&!timing.back))throw Error('FLIGHT_TIMES_UNCONFIRMED');
    if(!choice)await selectFlightTimes(this.searchFrame,timing);
    this.report('PORTAL_QUOTE_TIMING_FARE_CONFIRMED');
    const safe=await this.searchFrame.evaluate(()=>typeof DATA_ResPro!=='undefined' && DATA_ResPro.initialParams?.seatBlock===false);
    if(!safe)throw Error('TEMPORARY_BLOCK_NOT_DISABLED');
    await openPassengerOptions(this.searchFrame,this.page,this.report);
    await continueWithTestPassenger(this.searchFrame,this.report);
    const seats=await scanSeatPrices(this.searchFrame,this.page,this.report);
    const catalogs=await scanAncillaryCatalogs(this.searchFrame,this.page,this.report);
    const price=quoteFromScans(request,seats,catalogs);
    if(!await this.isAuthenticated())throw new PortalError('SESSION','LOGIN_NOT_CONFIRMED');
    this.onAuthenticatedActivity?.();
    return {request,choices,timing,price};
  }

  async runSearchProbe({ departureDate }) {
    if (!await this.isAuthenticated()) throw new PortalError('SESSION', 'LOGIN_NOT_CONFIRMED');
    if (!this.searchFrame || this.searchFrame.isDetached?.()) {
      if (!await this.inspectReservationSearch()) return false;
    }
    this.report('PORTAL_PROBE_STARTED');
    try {
      const probe = await submitProbe(this.searchFrame, { origin: this.origin, destination: this.destination, departureDate, report: this.report });
      this.report(probe.tripKind === 'return' ? 'PORTAL_PROBE_TRIP_RETURN' : 'PORTAL_PROBE_TRIP_ONE_WAY');
      this.report('PORTAL_PROBE_SEARCH_SUBMITTED');
      await this.searchFrame.locator('button#btnBook:visible').first().waitFor({ state: 'visible', timeout: 45000 });
      this.report('PORTAL_PROBE_RESULTS_CONTROL_VISIBLE');
      await this.inspectSearchUI();
      await openPassengerOptions(this.searchFrame, this.page, this.report);
      await this.inspectSearchUI();
      await continueWithTestPassenger(this.searchFrame, this.report);
      await this.inspectSearchUI();
      await scanSeatPrices(this.searchFrame, this.page, this.report);
      await scanAncillaryCatalogs(this.searchFrame, this.page, this.report);
      // Reaching a result page is not a final ancillary-inclusive quote.
      return true;
    } catch (error) {
      const known = new Set(['AIRPORT_SELECTION_NOT_CONFIRMED', 'UNSUPPORTED_PROBE_ROUTE', 'INVALID_PROBE_DATE', 'ONE_WAY_CONTROL_NOT_CONFIRMED', 'SEARCH_OPTION_NOT_CONFIRMED', 'SEARCH_INPUTS_NOT_CONFIRMED']);
      this.report(known.has(error.message) ? `PORTAL_PROBE_${error.message}` : safeFailureCode(error, 'PROBE'));
      this.report('PORTAL_PROBE_NOT_VERIFIED_NO_CUSTOMER_PRICE');
      await this.inspectSearchUI();
      return false;
    }
  }

  async refreshProtectedPage() {
    if (!await this.isAuthenticated()) throw new PortalError('SESSION', 'LOGIN_NOT_CONFIRMED');
    // Keepalive always refreshes the protected page. A bounded flight-search
    // probe is a separate explicitly reported step, never an idle search loop.
    const response = await this.page.goto(LOGIN_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (response && response.status() >= 400) {
      const status = response.status();
      throw Object.assign(new PortalError('SESSION', 'HTTP_ERROR'), { transient: status >= 500 || status === 408 || status === 429 });
    }
    if (!await this.waitForAuthentication()) throw new PortalError('SESSION', 'LOGIN_NOT_CONFIRMED');
    if (!await this.isAuthenticated()) throw new PortalError('SESSION', 'LOGIN_NOT_CONFIRMED');
    this.searchFrame = null;
    this.onAuthenticatedActivity?.();
    this.report('PORTAL_HEARTBEAT_REFRESH_COMPLETED');
  }

  // Compatibility for callers predating the protected-page heartbeat name.
  async searchFlightsForHeartbeat() { return this.refreshProtectedPage(); }

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

// Owns one browser lifetime only. Queue polling and process shutdown belong to
// the caller, so an idle controller can close and recreate this runtime without
// parking or restarting the combined worker process.
async function openAirArabiaRuntime({ env = process.env, launch = options => chromium.launch(options), log = console, onSessionError = () => {} } = {}) {
  let browser;
  let session;
  let closing;
  let closed = false;
  const close = () => {
    if (closed) return closing || Promise.resolve();
    if (!closing) {
      const attempt = (async () => {
        let failed = false;
        try { if (session) await session.stop(); } catch { failed = true; }
        try {
          if (browser) await browser.close();
          if (typeof browser?.isConnected === 'function' && browser.isConnected()) failed = true;
        } catch { failed = true; }
        if (failed) throw new PortalError('SESSION', 'CLOSE_FAILED');
        closed = true;
      })();
      closing = attempt;
      // An explicit owner shutdown can retry a failed cleanup. Concurrent
      // callers still share one attempt, and successful closure stays final.
      attempt.catch(() => { if (closing === attempt) closing = null; });
    }
    return closing;
  };
  try {
    // Validate secrets before opening any connection. Values are never logged.
    const config = {
      username: requiredEnv('AIR_ARABIA_AGENT_USERNAME', env),
      password: requiredEnv('AIR_ARABIA_AGENT_PASSWORD', env),
      origin: env.AIR_ARABIA_KEEPALIVE_ORIGIN || 'SHJ',
      destination: env.AIR_ARABIA_KEEPALIVE_DESTINATION || 'DAM',
      report: code => log.log(code),
      verificationProvider: options => waitForAirArabiaCode({ ...options, env }),
    };
    log.log('PORTAL_STAGE_BROWSER_START');
    browser = await atStage('BROWSER_START', () => launch({ headless: true, args: ['--no-sandbox'] }));
    const page = await atStage('BROWSER_START', () => browser.newPage());
    page.setDefaultTimeout(15000);
    const adapter = new AirArabiaPortalAdapter(page, config);
    await adapter.signIn();
    log.log('PORTAL_STAGE_INITIAL_HEARTBEAT');
    session = new PortalSession(adapter, { idleMs: HEARTBEAT_IDLE_MS, checkMs: HEARTBEAT_CHECK_MS, report: code => log.log(code) });
    await session.initialize();
    if (env.AIR_ARABIA_INSPECT_SEARCH_UI === 'true') {
      await session.run(async portal => {
        if (await portal.inspectReservationSearch()) await portal.runSearchProbe({ departureDate: randomHeartbeatDate() });
      });
    }

    let errorReported = false;
    session.start(code => {
      if (errorReported || session.closed) return;
      errorReported = true;
      if (!session.authBlocked) session.state = 'unavailable';
      // Stop future heartbeat ticks without closing recursively from a failed
      // session operation. The owner can drain/close this lifetime safely.
      if (session.timer) clearInterval(session.timer);
      session.timer = null;
      log.error(code);
      log.error('PORTAL_BLOCKED_OPERATOR_REVIEW_NO_AUTOMATIC_RETRY');
      try { Promise.resolve(onSessionError(code, session)).catch(() => {}); } catch {}
    });
    log.log('Air Arabia keepalive worker started; idle protected-page refresh interval is 15 minutes.');
    return { session, browser, close };
  } catch (error) {
    await close();
    // Factory callers must never receive raw browser errors containing URLs,
    // credentials or supplier text. Retain only the existing fixed taxonomy.
    if (session?.authBlocked) throw new PortalError('SESSION', 'MANUAL_VERIFICATION');
    const code = safeFailureCode(error);
    for (const stage of STAGES) {
      const prefix = `PORTAL_${stage}_`;
      if (code.startsWith(prefix)) throw new PortalError(stage, code.slice(prefix.length));
    }
    throw new PortalError('SESSION', 'UNEXPECTED');
  }
}

async function run({ launch = options => chromium.launch(options), park = waitForShutdown, log = console, poll = startQuotePolling, openRuntime = openAirArabiaRuntime } = {}) {
  if (process.env.AIR_ARABIA_KEEPALIVE_ENABLED !== 'true') {
    log.log('Keepalive is disabled; worker is idle until AIR_ARABIA_KEEPALIVE_ENABLED=true');
    await park();
    return;
  }

  let runtime;
  let stopPolling;
  let shuttingDown;
  let failed = false;
  const shutdown = () => {
    if (!shuttingDown) shuttingDown = (async () => {
      if (stopPolling) await stopPolling();
      if (runtime) await runtime.close();
    })();
    return shuttingDown;
  };
  try {
    const idleEnabled=process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED==='true'&&process.env.GMAIL_OTP_ENABLED==='true'&&process.env.AIR_ARABIA_IDLE_BROWSER_ENABLED!=='false';
    if(idleEnabled){
      let managed;
      managed=new IdlePortalSession({open:()=>openRuntime({launch,log,onSessionError:()=>managed.block()}),idleMs:180000,report:code=>log.log(code+'_AIRARABIA')});
      log.log('PORTAL_IDLE_POLICY_ENABLED_AIRARABIA');
      runtime={close:()=>managed.stop()};
      // Verify the initial deployment's login. Later openings happen only
      // after the queue reports real customer or budgeted catalogue demand.
      await managed.ensureAwake();
      stopPolling=poll(managed,{log});
    }else{
      runtime = await openRuntime({ launch, log, onSessionError: () => shutdown() });
      if (process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED === 'true') stopPolling = poll(runtime.session, { log });
    }
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

module.exports = { AirArabiaPortalAdapter, AIRPORTS, LOGIN_ENTRY_URL, PortalError, safeFailureCode, openAirArabiaRuntime, run };
