'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AirArabiaPortalAdapter, AIRPORTS } = require('../src/airarabia-worker');

test('keepalive adapter permits only the explicitly configured verified airport codes', () => {
  assert.deepEqual(AIRPORTS, { SHJ: 'SHJ - Sharjah', DAM: 'DAM - Damascus' });
  assert.throws(() => new AirArabiaPortalAdapter({}, {
    username: 'x', password: 'y', origin: 'DXB', destination: 'DAM',
  }), /Unsupported keepalive route configuration/);
  const adapter = new AirArabiaPortalAdapter({}, {
    username: 'x', password: 'y', origin: 'SHJ', destination: 'DAM',
  });
  assert.equal(adapter.origin, 'SHJ');
  assert.equal(adapter.destination, 'DAM');
});
