'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {AssistantState} = require('../src/assistant-state');

test('standard and direct test invocations cannot consume an ambient encrypted deployment snapshot', {timeout: 30000}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-sentinel-'));
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'state-allowed-'));
  const file = path.join(root, 'deployment.enc');
  const key = 'synthetic-deployment-encryption-key';
  const sentinel = 'SYNTHETIC_PENDING_MESSAGE_DO_NOT_CONSUME';
  const store = new AssistantState({file, key});
  store.data.inbox = {owner: {firstAt: Date.now(), lastAt: Date.now(), messages: [{text: sentinel}]}};
  store.save();
  const before = fs.readFileSync(file);
  const source = path.resolve(__dirname, '../src/assistant-state.js');
  const probe = path.join(root, 'probe.test.cjs');
  fs.writeFileSync(probe, "const {test}=require('node:test'); const {AssistantState}=require(" + JSON.stringify(source) + "); test('ambient read',()=>new AssistantState());");
  const env = {...process.env, ASSISTANT_STATE_PATH: file, ASSISTANT_STATE_KEY: key, REMAL_TEST_ROOT: allowed};
  delete env.NODE_TEST_CONTEXT;
  const direct = spawnSync(process.execPath, ['--test', probe], {env, encoding: 'utf8', timeout: 10000});
  assert.notEqual(direct.status, 0);
  assert.match(direct.stdout + direct.stderr, /TEST_STATE_ISOLATION_REQUIRED/);
  assert.doesNotMatch(direct.stdout + direct.stderr, new RegExp(sentinel));
  assert.deepEqual(fs.readFileSync(file), before);

  fs.writeFileSync(probe, "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {AssistantState}=require(" + JSON.stringify(source) + "); test('isolated read',()=>{assert.equal(process.env.CLINE_API_KEY,undefined);assert.equal(process.env.ASSISTANT_STATE_PATH,undefined);assert.equal(new AssistantState().file,undefined);});");
  const standard = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/run-tests.cjs'), probe], {
    env: {...env, CLINE_API_KEY: 'synthetic-deployment-provider-key'}, encoding: 'utf8', timeout: 15000
  });
  assert.equal(standard.status, 0, standard.stdout + standard.stderr);
  assert.doesNotMatch(standard.stdout + standard.stderr, new RegExp(sentinel));
  assert.deepEqual(fs.readFileSync(file), before);

  const production = spawnSync(process.execPath, ['-e', "const {AssistantState}=require(" + JSON.stringify(source) + ");console.log(Boolean(new AssistantState().data.inbox.owner));"], {
    env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(production.status, 0, production.stderr);
  assert.equal(production.stdout.trim(), 'true');
});
