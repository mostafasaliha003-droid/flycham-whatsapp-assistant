'use strict';

// Hosting/adapter wiring is deliberately separate: this class cannot keep a
// ChatGPT browser alive and does not store credentials or perform sign-in itself.
class PortalSession {
  constructor(adapter, { now = Date.now, idleMs = 120000, retryMs = 60000 } = {}) {
    for (const method of ['isAuthenticated', 'signIn', 'openSearch']) {
      if (typeof adapter?.[method] !== 'function') throw new TypeError(`Missing adapter.${method}`);
    }
    if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || !Number.isSafeInteger(retryMs) || retryMs < 1000) throw new RangeError('Invalid session interval');
    this.adapter = adapter;
    this.now = now;
    this.idleMs = idleMs;
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
      // Idle only. Never click a booking-flow button during a customer quote.
      await adapter.openSearch();
      if (!await adapter.isAuthenticated()) throw new Error('Portal expired during heartbeat');
      return true;
    });
  }
  start(onError) {
    if (this.closed || typeof onError !== 'function') throw new TypeError('A session error handler is required');
    if (!this.timer) this.timer = setInterval(() => { this.heartbeat().catch(() => onError('PORTAL_SESSION_UNAVAILABLE')); }, this.idleMs);
  }
  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tail;
  }
}
module.exports = { PortalSession };
