'use strict';

// Hosting/adapter wiring is deliberately separate: this class cannot keep a
// ChatGPT browser alive and does not store credentials or perform sign-in itself.
const HEARTBEAT_IDLE_MS = 15 * 60 * 1000;
const HEARTBEAT_CHECK_MS = 60 * 1000;

function transientFailure(error) {
  return error?.transient === true || error?.name === 'TimeoutError'
    || ['TIMEOUT', 'NETWORK', 'FRAME_CHANGED'].includes(error?.reason)
    || error?.code === 'PORTAL_SESSION_EXPIRED'
    || (error?.stage === 'SESSION' && error?.reason === 'LOGIN_NOT_CONFIRMED')
    || error?.message === 'FLYCHAM_SESSION_UNAVAILABLE'
    || /ERR_(?:NAME_NOT_RESOLVED|CONNECTION_|INTERNET_|NETWORK_|PROXY_|TIMED_OUT)|ECONN|ENOTFOUND|frame was detached|execution context was destroyed/i.test(String(error?.message || ''));
}
function securityFailure(error) {
  const classification=[error?.code,error?.reason,error?.message].filter(v=>typeof v==='string').join(' ');
  return /CAPTCHA|MANUAL_VERIFICATION|VERIFICATION_(?:REJECTED|EXPIRED|TIMEOUT|NOT_CONFIRMED|FORM_UNAVAILABLE)|BAD_CREDENTIALS|PASSWORD_CHANGE_REQUIRED|EXISTING_SESSION|UNTRUSTED_ORIGIN/.test(classification);
}

function randomHeartbeatDate(now = Date.now, random = Math.random) {
  const daysAhead = 30 + Math.floor(random() * 61); // 30–90 days ahead
  const date = new Date(now() + daysAhead * 24 * 60 * 60 * 1000);
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

class PortalSession {
  constructor(adapter, { now = Date.now, random = Math.random, idleMs = HEARTBEAT_IDLE_MS, checkMs = HEARTBEAT_CHECK_MS, retryMs = 60000, report = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    for (const method of ['isAuthenticated', 'signIn']) {
      if (typeof adapter?.[method] !== 'function') throw new TypeError(`Missing adapter.${method}`);
    }
    if (typeof adapter.refreshProtectedPage !== 'function' && typeof adapter.searchFlightsForHeartbeat !== 'function') throw new TypeError('Missing adapter.refreshProtectedPage');
    if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || !Number.isSafeInteger(checkMs) || checkMs < 1000 || !Number.isSafeInteger(retryMs) || retryMs < 1000) throw new RangeError('Invalid session interval');
    this.adapter = adapter;
    this.now = now;
    this.random = random;
    this.idleMs = idleMs;
    this.checkMs = checkMs;
    this.retryMs = retryMs;
    this.report = report;
    this.pause = pause;
    this.lastActivity = now();
    this.lastSuccessfulActivityAt = null;
    this.state = 'starting';
    this.retryAt = 0;
    this.heartbeatFailures = 0;
    this.authBlocked = false;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.timer = null;
    this.closed = false;
    // Adapters call this only after a protected navigation/search has succeeded
    // and the supplier's authenticated controls have been rechecked.
    this.adapter.onAuthenticatedActivity = () => this.touchAuthenticatedActivity();
  }
  touchAuthenticatedActivity() {
    if (this.closed || this.authBlocked) return;
    this.lastActivity = this.lastSuccessfulActivityAt = this.now();
    this.state = 'ready';
    this.retryAt = 0;
  }
  isReady() {
    return !this.closed && !this.authBlocked && this.state === 'ready'
      && this.lastSuccessfulActivityAt !== null
      && this.now() - this.lastSuccessfulActivityAt <= this.idleMs + 2 * this.checkMs;
  }
  healthStatus() {
    return { state: this.closed ? 'closed' : this.isReady() ? 'ready' : this.state === 'ready' ? 'stale' : this.state,
      lastSuccessfulActivityAt: this.lastSuccessfulActivityAt,
      lastSuccessfulActivityAgeMs: this.lastSuccessfulActivityAt === null ? null : Math.max(0, this.now() - this.lastSuccessfulActivityAt),
      authBlocked: this.authBlocked, closed: this.closed };
  }
  blockAuthentication() {
    this.authBlocked = true;
    this.state = 'blocked';
    this.report('PORTAL_AUTHENTICATION_OPERATOR_REQUIRED');
  }
  async refreshProtectedPage() {
    const refresh = this.adapter.refreshProtectedPage || this.adapter.searchFlightsForHeartbeat;
    await refresh.call(this.adapter);
    return true;
  }
  async initialize() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.run(() => this.refreshProtectedPage(), { recordsActivity: true });
        this.report('PORTAL_PROTECTED_HEALTH_CONFIRMED');
        return;
      } catch (error) {
        if (this.authBlocked || !transientFailure(error) || attempt) throw error;
        this.report('PORTAL_PROTECTED_REFRESH_RETRY_SCHEDULED');
        await this.pause(Math.min(this.retryMs, 1000));
      }
    }
  }
  async ensureSession() {
    if (this.authBlocked) throw new Error('Portal authentication requires operator review');
    if (await this.adapter.isAuthenticated()) return;
    // The real adapter must stop for CAPTCHA, verification and rejected login;
    // it must never retry those challenges automatically or bypass them.
    let verificationChallenge = false;
    try {
      if (await this.adapter.hasVerificationChallenge?.()) {
        verificationChallenge = true;
        this.state = 'verification';
        this.report('PORTAL_VERIFICATION_OPERATOR_REQUIRED');
        if (typeof this.adapter.resumeVerification !== 'function') throw new Error('MANUAL_VERIFICATION');
        await this.adapter.resumeVerification();
      } else {
        this.state = 'recovering';
        this.report('PORTAL_REAUTHENTICATION_STARTED');
        await this.adapter.signIn();
      }
      if (!await this.adapter.isAuthenticated()) throw new Error('Portal sign-in was not verified');
    } catch (error) {
      // A navigation timeout or lost frame during ordinary sign-in is not a
      // rejected credential. Preserve that typed failure for the existing
      // bounded initialize/heartbeat retry. Verification challenges themselves
      // remain operator-controlled even if their DOM operation times out.
      if (!verificationChallenge && !securityFailure(error) && transientFailure(error)) throw error;
      this.blockAuthentication();
      throw new Error('Portal authentication requires operator review');
    }
    this.retryAt = 0;
  }
  run(task, { recordsActivity = false } = {}) {
    if (this.closed) return Promise.reject(new Error('Portal session is closing'));
    this.pending += 1;
    const job = this.tail.then(async () => {
      try {
        await this.ensureSession();
        const result = await task(this.adapter);
        if (!await this.adapter.isAuthenticated()) throw Object.assign(new Error('Portal session expired'), { code: 'PORTAL_SESSION_EXPIRED' });
        // Failed discovery/parsing is not evidence of successful portal work.
        if (recordsActivity && result !== false && result?.outcome !== 'failed') this.touchAuthenticatedActivity();
        return result;
      } catch (error) {
        if (securityFailure(error)) this.blockAuthentication();
        else if (!this.authBlocked && transientFailure(error)) {
          this.state = 'recovering';
          this.retryAt = this.now() + this.retryMs;
        }
        throw error;
      }
    });
    this.tail = job.catch(() => {}).finally(() => { this.pending -= 1; });
    return job;
  }
  heartbeat() {
    if (this.closed || this.authBlocked || this.pending || this.now() < this.retryAt
      || (this.state !== 'recovering' && this.now() - this.lastActivity < this.idleMs)) return Promise.resolve(false);
    this.report('PORTAL_PROTECTED_REFRESH_STARTED');
    return this.run(() => this.refreshProtectedPage(), { recordsActivity: true }).then(() => {
      this.heartbeatFailures = 0;
      this.report('PORTAL_PROTECTED_REFRESH_COMPLETED');
      return true;
    }).catch(error => {
      if (!this.authBlocked && transientFailure(error) && this.heartbeatFailures++ === 0) {
        this.report('PORTAL_PROTECTED_REFRESH_RETRY_SCHEDULED');
        return false;
      }
      if (!this.authBlocked) this.state = 'unavailable';
      this.report(this.authBlocked ? 'PORTAL_PROTECTED_REFRESH_AUTHENTICATION_BLOCKED' : 'PORTAL_PROTECTED_REFRESH_FAILED');
      throw error;
    });
  }
  start(onError) {
    if (this.closed || typeof onError !== 'function') throw new TypeError('A session error handler is required');
    // Check often enough to run near the 15-minute idle target even after a
    // successful supplier activity occurs just after a previous check.
    if (!this.timer) this.timer = setInterval(() => { this.heartbeat().catch(() => onError('PORTAL_SESSION_UNAVAILABLE')); }, this.checkMs);
  }
  async stop() {
    this.closed = true;
    this.state = 'closed';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tail;
  }
}
module.exports = { PortalSession, randomHeartbeatDate, HEARTBEAT_IDLE_MS, HEARTBEAT_CHECK_MS };
