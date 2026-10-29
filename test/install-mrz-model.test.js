'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {installModel, MODEL_URL, MODEL_BYTES} = require('../scripts/install-mrz-model');

test('optical model installer pins URL, rejects wrong hash and leaves no model', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mrz-install-test-'));
  try {
    await assert.rejects(installModel({directory, fetchImpl: async (url, options) => {
      assert.equal(url, MODEL_URL);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(Buffer.alloc(MODEL_BYTES));
    }}), /MRZ_MODEL_INVALID/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('optical model installer bounds downloaded bytes and cancels the response', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mrz-install-test-'));
  let cancelled = false;
  try {
    await assert.rejects(installModel({directory, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MODEL_BYTES + 1)); },
      cancel() { cancelled = true; }
    }))}), /MRZ_MODEL_INVALID/);
    assert.equal(cancelled, true);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});
