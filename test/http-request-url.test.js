'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');

test('invalid request authorities and targets return 400 while the real server remains usable', {timeout: 20000}, async t => {
  const child = spawn(process.execPath, ['-e', `
    const {createServer} = require('./src/server');
    const server = createServer();
    server.listen(0, '127.0.0.1', () => console.log('TEST_PORT ' + server.address().port));
  `], {
    cwd: path.resolve(__dirname, '..'),
    env: {...process.env, FARE_CATALOG_ENABLED: 'false', SAUDI_VISA_ENABLED: 'false',
      ASSISTANT_AI_PROVIDER: 'disabled', CONSULTANT_ORCHESTRATOR_ENABLED: 'false',
      RAAD_VISA_AUTOMATION_ENABLED: 'false', DRY_RUN: 'true', WHATSAPP_VERIFY_TOKEN: 'synthetic-url-verification'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(Error('Server exited before readiness')));
    child.stdout.on('data', bytes => {
      const match = String(bytes).match(/TEST_PORT (\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  function request(target = '/health', host = 'localhost', method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({hostname: '127.0.0.1', port, path: target, method, headers: {Host: host}}, res => {
        let body = '';
        res.on('data', bytes => { body += bytes; });
        res.on('end', () => resolve({status: res.statusCode, body}));
      });
      req.on('error', reject);
      req.end();
    });
  }
  for (const [target, host] of [
    ['/health', '['], ['/health', 'localhost:invalid'], ['http://[', 'localhost'], ['//[', 'localhost']
  ]) {
    const result = await request(target, host);
    assert.deepEqual(result, {status: 400, body: 'Invalid request'});
    assert.equal((await request()).status, 200);
  }
  assert.equal((await request('/health?x=1', '[::1]:1234')).status, 200);
  assert.equal((await request('http://example.invalid/health')).status, 200);
  assert.deepEqual(await request('/privacy', 'localhost', 'HEAD'), {status: 200, body: ''});
  assert.equal((await request('/missing-route')).status, 404);
  assert.equal((await request('/internal/assistant/status')).status, 401);
  assert.deepEqual(await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=synthetic-url-verification&hub.challenge=12345'), {status: 200, body: '12345'});
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(errors, /ERR_INVALID_URL|unhandled/i);
});
