'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { preparePortalImage, prepareDocumentImage, prepareResidenceImage } = require('../src/raad-attachments');

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

async function greyDocument({ paper = 180, ink = 120 } = {}) {
  const raw = Buffer.alloc(1200 * 800 * 3, paper);
  // A synthetic label plus four border markers make edge preservation visible.
  for (const [left, top, width, height] of [[0, 0, 12, 12], [1188, 0, 12, 12], [0, 788, 12, 12], [1188, 788, 12, 12], [120, 200, 960, 30]]) {
    for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) raw.fill(ink, (y * 1200 + x) * 3, (y * 1200 + x + 1) * 3);
  }
  return sharp(raw, { raw: { width: 1200, height: 800, channels: 3 } }).png().toBuffer();
}
async function pixel(bytes, x, y) {
  return [...await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}

test('measured enhancement improves low document contrast without cropping, enlarging or clipping its complete contents', async () => {
  const bytes = await greyDocument();
  const original = Buffer.from(bytes);
  const plain = await preparePortalImage(bytes, { enhance: false });
  const enhanced = await preparePortalImage(bytes);
  await assertSafeResult(enhanced, [bytes]);
  assert.deepEqual(bytes, original, 'original source bytes are never mutated');
  assert.equal(enhanced.width, 1200); assert.equal(enhanced.height, 800);
  assert.ok(enhanced.transformations.some(step => step.startsWith('measured_tonal_adjustment:')));
  assert.ok(enhanced.transformations.some(step => step.startsWith('mild_sharpen:')));
  const oldContrast = (await pixel(plain.bytes, 600, 100))[0] - (await pixel(plain.bytes, 600, 215))[0];
  const newContrast = (await pixel(enhanced.bytes, 600, 100))[0] - (await pixel(enhanced.bytes, 600, 215))[0];
  assert.ok(newContrast > oldContrast);
  for (const [x, y] of [[5, 5], [1194, 5], [5, 794], [1194, 794]]) assert.ok((await pixel(enhanced.bytes, x, y))[0] < (await pixel(enhanced.bytes, 600, 100))[0], 'all four original corner markers remain');
  const stats = await sharp(enhanced.bytes).stats();
  assert.ok(stats.channels.every(channel => channel.min > 0 && channel.max < 255), 'enhancement does not erase values into clipped endpoints');
  const again = await preparePortalImage(bytes);
  assert.deepEqual(again.bytes, enhanced.bytes); assert.equal(again.sha256, enhanced.sha256);
});

test('underexposed document lift is small and measured; clear, flat, transparent and portrait inputs are left tonally unchanged', async () => {
  const dark = await greyDocument({ paper: 80, ink: 20 });
  const improved = await preparePortalImage(dark);
  const originalMean = (await sharp(dark).stats()).channels[0].mean;
  const newMean = (await sharp(improved.bytes).stats()).channels[0].mean;
  assert.ok(newMean > originalMean && newMean - originalMean <= 7);
  assert.ok(improved.transformations.some(step => step.startsWith('measured_tonal_adjustment:')));
  const transparent = await sharp(await greyDocument()).ensureAlpha(0.8).png().toBuffer();
  for (const [bytes, options] of [[await greyDocument({ paper: 255, ink: 0 }), {}], [await image(1200, 800, '#505050'), {}], [transparent, {}], [await greyDocument(), { kind: 'portrait' }]]) {
    const enhanced = await preparePortalImage(bytes, { ...options, enhance: true });
    const plain = await preparePortalImage(bytes, { ...options, enhance: false });
    assert.deepEqual(enhanced.bytes, plain.bytes);
    assert.ok(!enhanced.transformations.some(step => /tonal_adjustment|sharpen/.test(step)));
  }
});

test('two-page passport composer retains complete unequal pages in supplied order without stretching either', async () => {
  const first = await image(1200, 700, '#ff0000');
  const second = await image(1000, 1200, '#0000ff');
  const result = await prepareDocumentImage([{ bytes: first, mimeType: 'image/png' }, { bytes: second, mimeType: 'image/png' }], { kind: 'passport' });
  await assertSafeResult(result, [first, second]);
  assert.equal(result.width, 1200); assert.equal(result.height, 1924);
  for (const [x, y] of [[0, 0], [1199, 0], [0, 699], [1199, 699]]) assert.deepEqual(await pixel(result.bytes, x, y), [255, 0, 0]);
  for (const [x, y] of [[100, 724], [1099, 724], [100, 1923], [1099, 1923]]) assert.deepEqual(await pixel(result.bytes, x, y), [0, 0, 255]);
  for (const [x, y] of [[600, 712], [0, 1200], [1199, 1200]]) assert.deepEqual(await pixel(result.bytes, x, y), [255, 255, 255]);
  const reversed = await prepareDocumentImage([second, first], { kind: 'passport' });
  assert.deepEqual(await pixel(reversed.bytes, 600, 0), [0, 0, 255]);
  assert.deepEqual(await pixel(reversed.bytes, 600, 1923), [255, 0, 0]);
});

test('general document composer preserves residence compatibility, records per-page enhancement and validates bounded options', async () => {
  const lowContrast = await greyDocument();
  const clear = await image(1200, 800, '#ffffff');
  const combined = await prepareDocumentImage([lowContrast, clear], { kind: 'passport' });
  assert.ok(combined.transformations.some(step => step.startsWith('part_1:measured_tonal_adjustment:')));
  assert.ok(!combined.transformations.some(step => step.startsWith('part_2:measured_tonal_adjustment:')));
  const residence = await prepareResidenceImage([lowContrast, clear]);
  const genericResidence = await prepareDocumentImage([lowContrast, clear], { kind: 'residence' });
  assert.deepEqual(residence.bytes, genericResidence.bytes);
  assert.deepEqual(residence.transformations, genericResidence.transformations);
  assert.ok((await prepareDocumentImage([clear], { kind: 'passport' })).transformations.includes('passport_single_part'));
  for (const invalid of [[], [clear, clear, clear], 'https://example.invalid/passport.jpg']) await assert.rejects(prepareDocumentImage(invalid));
  await assert.rejects(prepareDocumentImage([clear], { kind: 'portrait' }), { code: 'INVALID_IMAGE_KIND' });
  await assert.rejects(prepareDocumentImage([clear], { enhance: 'true' }), { code: 'INVALID_IMAGE_OPTIONS' });
  await assert.rejects(preparePortalImage(clear, { enhance: 1 }), { code: 'INVALID_IMAGE_OPTIONS' });
  await assert.rejects(prepareDocumentImage([clear], { maxBytes: 1000001 }), { code: 'INVALID_MAX_BYTES' });
});
