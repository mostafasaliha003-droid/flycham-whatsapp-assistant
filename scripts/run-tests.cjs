'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

// Every run owns its storage and starts without deployment credentials.
const temporaryParent = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryParent, 'remal-tests-'));
const env = {};
for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TZ']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  NODE_ENV: 'test',
  TEMP: root,
  TMP: root,
  TMPDIR: root,
  REMAL_TEST_ROOT: root,
  ASSISTANT_STATE_KEY: crypto.randomBytes(32).toString('hex'),
  NODE_OPTIONS: '--require "' + path.join(__dirname, 'offline-network-guard.cjs').replaceAll('\\', '/') + '"'
});
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'),
  env,
  stdio: 'inherit'
});
function cleanup() {
  if (path.dirname(root) === temporaryParent && path.basename(root).startsWith('remal-tests-')) {
    try { fs.rmSync(root, {recursive: true, force: true}); }
    catch { console.error('TEST_TEMP_CLEANUP_FAILED'); }
  }
}
child.once('error', () => {
  cleanup();
  console.error('TEST_RUNNER_START_FAILED');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  cleanup();
  process.exitCode = signal ? 1 : code ?? 1;
});
