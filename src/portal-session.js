'use strict';

// Hosting/adapter wiring is deliberately separate: this class cannot keep a
// ChatGPT browser alive and does not store credentials or perform sign-in itself.
const HEARTBEAT_IDLE_MS = 15 * 60 * 1000;
const HEARTBEAT_CHECK_MS = 60 * 1000;

function randomHeartbeatDate(now = Date.now, random = Math.random) {
  const daysAhead = 30 + Math.floor(random() * 61); // 30–90 days ahead
  const date = new Date(now() + daysAhead * 24 * 60 * 60 * 1000);
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

class PortalSession {
  constructor(adapter, { now = Date.now, random = Math.random, idleMs = HEARTBEAT_IDLE_MS, checkMs = HEARTBEAT_CHECK_MS, retryMs = 60000 } = {}) {
    for (const method of ['isAuthenticated', 'signIn', 'searchFlightsForHeartbeat']) {
      if (typeof adapter?.[method] !== 'function') throw new TypeError(`Missing adapter.${method}`);
    }
    if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || !Number.isSafeInteger(checkMs) || checkMs < 1000 || !Number.isSafeInteger(retryMs) || retryMs < 1000) throw new RangeError('Invalid session interval');
    this.adapter = adapter;
    this.now = now;
    this.random = random;
    this.idleMs = idleMs;
    this.checkMs = checkMs;
    this.retryMs = retryMs;
    this.lastActivity = now();
    this.retryAt = 0;
    this.authBlocked = false;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.timer = null;
    this.closed = false;
  }
  async ensureSession() {
    if (this.authBlocked) throw new Error('Portal authentication requires operator review');
    if (await this.adapter.isAuthenticated()) return;
    if (this.now() < this.retryAt) throw new Error('Portal sign-in is awaiting retry or operator review');
    this.retryAt = this.now() + this.retryMs;
    // The real adapter must stop for CAPTCHA, verification and rejected login;
    // it must never retry those challenges automatically or bypass them.
    try {
      await this.adapter.signIn();
      if (!await this.adapter.isAuthenticated()) throw new Error('Portal sign-in was not verified');
    } catch {
      this.authBlocked = true;
      throw new Error('Portal authentication requires operator review');
    }
    this.retryAt = 0;
  }
  run(task) {
    if (this.closed) return Promise.reject(new Error('Portal session is closing'));
    this.pending += 1;
    const job = this.tail.then(async () => {
      await this.ensureSession();
      try { return await task(this.adapter); }
      finally { this.lastActivity = this.now(); }
    });
    this.tail = job.catch(() => {}).finally(() => { this.pending -= 1; });
    return job;
  }
  heartbeat() {
    if (this.closed || this.pending || this.now() - this.lastActivity < this.idleMs) return Promise.resolve(false);
    return this.run(async adapter => {
      // Idle only. Search a bounded, synthetic date; never select a result or book.
      await adapter.searchFlightsForHeartbeat({ departureDate: randomHeartbeatDate(this.now, this.random) });
      if (!await adapter.isAuthenticated()) throw new Error('Portal expired during heartbeat');
      return true;
    });
  }
  start(onError) {
    if (this.closed || typeof onError !== 'function') throw new TypeError('A session error handler is required');
    // Check often enough to run near the 15-minute idle target even after a
    // customer request resets lastActivity just after a previous check.
    if (!this.timer) this.timer = setInterval(() => { this.heartbeat().catch(() => onError('PORTAL_SESSION_UNAVAILABLE')); }, this.checkMs);
  }
  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tail;
  }
}
module.exports = { PortalSession, randomHeartbeatDate, HEARTBEAT_IDLE_MS, HEARTBEAT_CHECK_MS };
