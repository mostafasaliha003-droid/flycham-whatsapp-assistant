'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { takeVerificationCode, waitForVerificationCode } = require('../src/operator-verification');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-verification-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'code');
}

test('operator code must be private, fresh and consumed only once', async t => {
  const file = await fixture(t);
  const requestedAt = Date.now() - 1000;
  await fs.writeFile(file, '123456\n', { mode: 0o600 });
  assert.equal(await takeVerificationCode(file, requestedAt), '123456');
  assert.equal(await takeVerificationCode(file, requestedAt), null);
});

test('stale codes are discarded and never reused for a new challenge', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, '123456', { mode: 0o600 });
  await fs.utimes(file, new Date(0), new Date(0));
  assert.equal(await takeVerificationCode(file, Date.now()), null);
  await assert.rejects(fs.access(file));
});

test('world-readable code files and symbolic links are rejected', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, '123456', { mode: 0o644 });
  await fs.chmod(file, 0o644);
  await assert.rejects(takeVerificationCode(file, 0), { code: 'VERIFICATION_FILE_INVALID' });
  await fs.symlink(file, file + '-link');
  await assert.rejects(takeVerificationCode(file + '-link', 0), { code: 'ELOOP' });
});

test('missing operator input times out without submitting anything', async t => {
  const file = await fixture(t);
  await assert.rejects(waitForVerificationCode({ path: file, timeoutMs: 0 }), { code: 'VERIFICATION_TIMEOUT' });
});
