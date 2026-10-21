'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PortalSession, randomHeartbeatDate, HEARTBEAT_IDLE_MS } = require('../src/portal-session');
function fixture() {
  let now = 0, authenticated = true, logins = 0, heartbeats = 0;
  const adapter = { isAuthenticated: async () => authenticated, signIn: async () => { logins++; authenticated = true; }, searchFlightsForHeartbeat: async ({ departureDate }) => { assert.equal(departureDate.split('/').length, 3); heartbeats++; } };
  const session = new PortalSession(adapter, { now: () => now, random: () => 0, idleMs: 120000, checkMs: 1000 });
  return { session, adapter, advance: n => { now += n; }, expire: () => { authenticated = false; }, stats: () => ({ logins, heartbeats }) };
}
test('searches on an idle heartbeat and not after recent activity', async () => {
  const f = fixture();
  assert.equal(await f.session.heartbeat(), false);
  f.advance(120000);
  assert.equal(await f.session.heartbeat(), true);
  await f.session.tail;
  assert.equal(await f.session.heartbeat(), false);
  assert.deepEqual(f.stats(), { logins: 0, heartbeats: 1 });
  await f.session.stop();
});
test('uses a randomized date 30 to 90 days in the future and defaults to a 15-minute interval', () => {
  assert.equal(HEARTBEAT_IDLE_MS, 15 * 60 * 1000);
  const now = () => Date.UTC(2026, 0, 1);
  const earliest = new Date(now() + 30 * 86400000);
  const latest = new Date(now() + 90 * 86400000);
  const toDate = value => { const [day, month, year] = value.split('/').map(Number); return Date.UTC(year, month - 1, day); };
  assert.equal(toDate(randomHeartbeatDate(now, () => 0)), Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate()));
  assert.equal(toDate(randomHeartbeatDate(now, () => 0.999999)), Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate()));
});
test('serializes quotes and does not reset the search during an active quote', async () => {
  const f = fixture();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const first = f.session.run(async () => { events.push('first'); entered(); await gate; events.push('done'); });
  await started;
  const second = f.session.run(async () => { events.push('second'); });
  f.advance(120000);
  assert.equal(await f.session.heartbeat(), false);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'done', 'second']);
  assert.equal(f.stats().heartbeats, 0);
  await f.session.stop();
});
test('reauthenticates an expired session and verifies it before executing a quote', async () => {
  const f = fixture();
  f.expire();
  assert.equal(await f.session.run(async () => 'quote'), 'quote');
  assert.equal(f.stats().logins, 1);
  await f.session.stop();
});
test('stops repeated authentication attempts after a rejected login', async () => {
  const f = fixture();
  f.expire();
  let attempts = 0, tasks = 0;
  f.adapter.signIn = async () => { attempts++; throw new Error('rejected'); };
  await assert.rejects(f.session.run(async () => { tasks++; }));
  f.advance(500000);
  await assert.rejects(f.session.run(async () => { tasks++; }));
  assert.equal(attempts, 1);
  assert.equal(tasks, 0);
  await f.session.stop();
});
test('graceful stop drains current work and rejects new jobs', async () => {
  const f = fixture();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const job = f.session.run(async () => { entered(); await gate; });
  await started;
  const stopped = f.session.stop();
  await assert.rejects(f.session.run(async () => {}));
  release(); await job; await stopped;
  assert.equal(await f.session.heartbeat(), false);
});
