'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PortalSession } = require('../src/portal-session');
function fixture() {
  let now = 0, authenticated = true, logins = 0, heartbeats = 0;
  const adapter = { isAuthenticated: async () => authenticated, signIn: async () => { logins++; authenticated = true; }, openSearch: async () => { heartbeats++; } };
  const session = new PortalSession(adapter, { now: () => now });
  return { session, adapter, advance: n => { now += n; }, expire: () => { authenticated = false; }, stats: () => ({ logins, heartbeats }) };
}
test('performs idle heartbeat after two minutes and not after recent activity', async () => {
  const f = fixture();
  assert.equal(await f.session.heartbeat(), false);
  f.advance(120000);
  assert.equal(await f.session.heartbeat(), true);
  await f.session.tail;
  assert.equal(await f.session.heartbeat(), false);
  assert.deepEqual(f.stats(), { logins: 0, heartbeats: 1 });
  await f.session.stop();
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
