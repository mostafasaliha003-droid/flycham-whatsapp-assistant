'use strict';
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const source = process.env.MAIN_TEST_SOURCE;
const requireApp = createRequire(path.join(source, 'package.json'));
async function main() {
  const sharp = requireApp('sharp');
  assert.equal(sharp.versions.sharp, '0.35.5');
  assert.equal(sharp.versions.vips, '8.18.7');
  assert.equal(sharp.versions.rsvg, '2.63.2');
  const png = await sharp({create: {width: 100, height: 80, channels: 3,
    background: 'white'}}).rotate(90).png().toBuffer();
  const info = await sharp(png).metadata();
  assert.equal(info.width, 80); assert.equal(info.height, 100);
  const model = fs.readFileSync(path.join(source, 'var/mrz-model/mrz.traineddata'));
  assert.equal(model.length, 1452847);
  assert.equal(createHash('sha256').update(model).digest('hex'),
    'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01');
  console.log(JSON.stringify({passed: true, node: process.version,
    sharp: sharp.versions.sharp, vips: sharp.versions.vips,
    rsvg: sharp.versions.rsvg, syntheticImage: true, modelVerified: true,
    liveActions: 0}));
}
main().catch(() => {console.error('MAIN_NATIVE_SMOKE_FAILED'); process.exitCode = 1;});
