'use strict';
// Test harness only. No change to application source or service configuration.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const nativeSpawn = cp.spawn;
const net = require('node:net');
const source = path.resolve(process.env.MAIN_TEST_SOURCE || '/INVALID');
const port = Number(process.env.MAIN_TEST_PORT);
const entry = path.resolve(process.argv[1] || '/INVALID');
const npmCli = path.resolve(process.env.MAIN_TEST_NPM_CLI || '/INVALID');
const nativeHelper = path.join(__dirname, 'main-native-smoke.cjs');
const role = entry === npmCli ? 'npm' :
  entry === path.join(source, 'src/server.js') ? 'main' :
    entry === nativeHelper ? 'native' : 'invalid';
const flags = {
  DRY_RUN: 'true', SAUDI_VISA_ENABLED: 'false',
  RAAD_VISA_AUTOMATION_ENABLED: 'false', FARE_CATALOG_ENABLED: 'false',
  CONSULTANT_ORCHESTRATOR_ENABLED: 'false',
};
function validEnv(env) {
  for (const [key, value] of Object.entries(flags)) assert.equal(env[key], value);
  for (const key of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'RAAD_JOB_BRIDGE_KEY',
    'RAAD_BROWSER_WORKER_URL', 'RAAD_MOFA_USERNAME', 'RAAD_MOFA_PASSWORD',
    'OPENAI_API_KEY', 'GEMINI_API_KEY', 'BRAVE_SEARCH_API_KEY']) assert.ok(!env[key]);
  assert.equal(env.NODE_OPTIONS, '--require ' + __filename);
  assert.equal(env.ASSISTANT_STATE_PATH, process.env.MAIN_TEST_STATE_PATH);
  assert.equal(env.ASSISTANT_STATE_KEY, 'synthetic-main-start-state-fixture');
}
assert.notEqual(role, 'invalid');
assert.equal(process.version, 'v26.13.0');
assert.equal(process.cwd(), source);
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
validEnv(process.env);
function event(name) {
  fs.appendFileSync(process.env.MAIN_TEST_FENCE_EVENTS,
    JSON.stringify({event: name, role, node: process.version}) + '\n');
}
if (role === 'npm') assert.deepEqual(process.argv.slice(2), ['start']);
else assert.equal(process.argv.length, 2);
// The unchanged existing guard fences fetch, http/https, net/TLS/DNS/UDP,
// child processes, and listeners to numeric loopback. It logs every denial.
require('./loopback-network-guard.cjs');
const fencedListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  assert.equal(role, 'main');
  assert.equal(args[0], port);
  // src/server.js uses listen(PORT, callback). Clamp only this exact form.
  assert.equal(args.length, 2); assert.equal(typeof args[1], 'function');
  event('main-listen-forced-127.0.0.1');
  return fencedListen.call(this, port, '127.0.0.1', args[1]);
};
if (role === 'npm') {
  let spawned = false;
  cp.spawn = function (command, args, options) {
    assert.equal(spawned, false);
    assert.ok(command === 'sh' || command === '/bin/sh');
    assert.deepEqual(args, ['-c', 'node src/server.js']);
    assert.equal(options?.cwd, source);
    assert.equal(options.shell, false);
    validEnv(options.env);
    assert.equal(options.env.MAIN_TEST_SOURCE, source);
    assert.equal(options.env.MAIN_TEST_PORT, String(port));
    spawned = true;
    event('allowed-exact-npm-start-child');
    return nativeSpawn.call(this, command, args, options);
  };
}
event('preload-active');

