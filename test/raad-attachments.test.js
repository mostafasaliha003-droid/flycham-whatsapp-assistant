'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { preparePortalImage, prepareResidenceImage } = require('../src/raad-attachments');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const image = (width, height, background = '#2378ae', format = 'png') =>
  sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer();

function noise(width, height, initialSeed = 123456789) {
  const bytes = Buffer.alloc(width * height * 3);
  let seed = initialSeed;
  for (let i = 0; i < bytes.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[i] = seed >>> 24;
  }
  return sharp(bytes, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function assertSafeResult(result, sourceBytes, maxBytes = 1000000) {
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.ok(result.bytes.length <= maxBytes);
  assert.ok(['image/jpeg', 'image/png'].includes(result.mimeType));
  assert.equal(result.sha256, hash(result.bytes));
  assert.deepEqual(result.sourceSha256s, sourceBytes.map(hash));
  assert.equal(result.needsVisualReview, true);
  assert.ok(Array.isArray(result.transformations));
  assert.ok(result.transformations.length > 0);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.width, result.width);
  assert.equal(metadata.height, result.height);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.iptc, undefined);
  assert.equal(metadata.orientation, undefined);
  return metadata;
}

test('normalizes a real raster and strips EXIF after applying orientation', async () => {
  const blueHalf = await image(500, 600, '#0000ff');
  const bytes = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#ff0000' } })
    .composite([{ input: blueHalf, left: 500, top: 0 }])
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.ok((await sharp(bytes).metadata()).exif);
  const result = await preparePortalImage(bytes, { mimeType: 'image/jpeg' });
  await assertSafeResult(result, [bytes]);
  assert.equal(result.width, 600);
  assert.equal(result.height, 1000);
  const { data, info } = await sharp(result.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const top = (250 * info.width + 300) * info.channels;
  const bottom = (750 * info.width + 300) * info.channels;
  assert.ok(data[top] > 230 && data[top + 2] < 25);
  assert.ok(data[bottom + 2] > 230 && data[bottom] < 25);
});

test('supports PNG and WEBP without upscaling or cropping', async () => {
  for (const format of ['png', 'webp']) {
    const bytes = await image(1200, 760, '#32905c', format);
    const result = await preparePortalImage(bytes, { mimeType: `image/${format}` });
    await assertSafeResult(result, [bytes]);
    assert.equal(result.width, 1200);
    assert.equal(result.height, 760);
  }
});

test('compresses a large synthetic raster within the portal cap while retaining document resolution', async () => {
  const bytes = await noise(1800, 1200);
  assert.ok(bytes.length > 1000000);
  const result = await preparePortalImage(bytes, { maxBytes: 850000 });
  await assertSafeResult(result, [bytes], 850000);
  assert.ok(Math.max(result.width, result.height) >= 1000);
  assert.ok(result.width <= 1800 && result.height <= 1200);
  assert.ok(Math.abs(result.width / result.height - 1.5) < 0.005);
});

test('requires a legible source instead of upscaling small documents or portraits', async () => {
  await assert.rejects(preparePortalImage(await image(999, 650)));
  await assert.rejects(preparePortalImage(await image(299, 400), { kind: 'portrait' }));
  const portrait = await image(320, 400, '#aaaaaa');
  const result = await preparePortalImage(portrait, { kind: 'portrait' });
  await assertSafeResult(result, [portrait]);
  assert.equal(result.width, 320);
  assert.equal(result.height, 400);
  // Pixel size cannot establish face suitability, background compliance, or legal acceptance.
  assert.equal(result.needsVisualReview, true);
});

test('rejects PDF bytes explicitly instead of pretending they are a rendered image', async () => {
  const bytes = Buffer.from('%PDF-1.7\nSynthetic raster conversion fixture\n%%EOF');
  await assert.rejects(preparePortalImage(bytes, { mimeType: 'application/pdf' }), { code: 'PDF_NEEDS_RASTER_CONVERSION' });
  await assert.rejects(prepareResidenceImage([bytes]), { code: 'PDF_NEEDS_RASTER_CONVERSION' });
});

test('rejects non-buffers, unsupported image formats, mismatched MIME types and damaged images', async () => {
  const png = await image(1200, 800);
  const gif = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#224466' } }).gif().toBuffer();
  for (const bytes of [Buffer.from('not an image'), Buffer.alloc(0), png.subarray(0, Math.floor(png.length / 2)), gif]) {
    await assert.rejects(preparePortalImage(bytes));
  }
  for (const bytes of ['https://example.invalid/document.png', new Uint8Array(png), { bytes: png }]) {
    await assert.rejects(preparePortalImage(bytes));
  }
  await assert.rejects(preparePortalImage(png, { mimeType: 'image/jpeg' }));
  await assert.rejects(preparePortalImage(png, { mimeType: 'text/html' }));
});

test('rejects animated WEBP instead of silently dropping residence or document frames', async () => {
  const raw = Buffer.alloc(1000 * 1400 * 3);
  raw.fill(255, 1000 * 700 * 3);
  const animated = await sharp(raw, { raw: { width: 1000, height: 1400, channels: 3, pageHeight: 700 } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  await assert.rejects(preparePortalImage(animated, { mimeType: 'image/webp' }));
  await assert.rejects(prepareResidenceImage([animated]));
});

test('enforces the absolute byte limit, input size guard, pixel guard and achievable quality', async () => {
  const png = await image(1200, 800);
  for (const maxBytes of [0, -1, 1000001, NaN, Infinity, 12.5, '1000000']) {
    await assert.rejects(preparePortalImage(png, { maxBytes }));
    await assert.rejects(prepareResidenceImage([png], { maxBytes }));
  }
  await assert.rejects(preparePortalImage(Buffer.alloc(25 * 1024 * 1024 + 1)));
  await assert.rejects(preparePortalImage(await image(5000, 4001)));
  await assert.rejects(preparePortalImage(png, { maxBytes: 1 }));
});

test('combines both complete residence sides on a white canvas and records both source hashes', async () => {
  const front = await image(1200, 800, '#ff0000');
  const back = await image(1200, 800, '#0000ff');
  const result = await prepareResidenceImage([{ bytes: front, mimeType: 'image/png' }, { bytes: back, mimeType: 'image/png' }]);
  await assertSafeResult(result, [front, back]);
  const { data, info } = await sharp(result.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0, blue = 0, white = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    if (r > 230 && g < 25 && b < 25) red++;
    if (b > 230 && r < 25 && g < 25) blue++;
    if (r > 240 && g > 240 && b > 240) white++;
  }
  assert.ok(red >= 1200 * 800 * 0.99, 'front side is preserved at its full source resolution');
  assert.ok(blue >= 1200 * 800 * 0.99, 'back side is preserved at its full source resolution');
  assert.ok(white > 0, 'a visible white gap separates the complete sides');
});

test('residence compression scales the complete composite and respects each side legibility', async () => {
  const front = await noise(1800, 1200);
  const back = await noise(1800, 1200, 987654321);
  const result = await prepareResidenceImage([front, back]);
  await assertSafeResult(result, [front, back]);
  assert.ok(result.width < 1800, 'noisy residence sides require the whole composite to be resized');
  assert.ok(result.width >= 1000, 'both landscape sides retain a real-pixel long edge of at least 1000');
  assert.ok(Math.abs(result.width / result.height - 1800 / 2436) < 0.005);
  await assert.rejects(prepareResidenceImage([front, back], { maxBytes: 1000 }));
});

test('one residence image remains complete; missing and extra sides are rejected', async () => {
  const bytes = await image(1000, 650);
  const result = await prepareResidenceImage([bytes]);
  await assertSafeResult(result, [bytes]);
  assert.equal(result.width, 1000);
  assert.equal(result.height, 650);
  await assert.rejects(prepareResidenceImage([]));
  await assert.rejects(prepareResidenceImage([bytes, bytes, bytes]));
  await assert.rejects(prepareResidenceImage('https://example.invalid/residence.png'));
  await assert.rejects(prepareResidenceImage([bytes, await image(500, 400)]));
});

test('the same synthetic source and options yield deterministic bytes and hashes', async () => {
  const bytes = await image(1100, 700, '#39628b', 'webp');
  const first = await preparePortalImage(bytes);
  const second = await preparePortalImage(bytes);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.transformations, second.transformations);
});
