'use strict';

// All conversion happens in memory. These helpers never fetch URLs, render PDFs,
// interpret document contents, or decide that a portrait/document is acceptable.
const crypto = require('node:crypto');
const sharp = require('sharp');

const MAX_OUTPUT_BYTES = 1000000;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 20000000;
const MAX_DIMENSION = 32767;
const DOCUMENT_LONG_EDGE = 1000;
const PORTRAIT_MIN_EDGE = 300;
const MIME_BY_FORMAT = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const READ_OPTIONS = { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true };
const WHITE = { r: 255, g: 255, b: 255 };
const JPEG_QUALITIES = [92, 85, 78, 72];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function maxBytesOption(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_BYTES) fail('INVALID_MAX_BYTES');
  return value;
}
function cleanMime(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('INVALID_IMAGE');
  return value.toLowerCase().split(';')[0].trim();
}
function dimensionsAt(width, height, scale) {
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Reject incomplete containers even when an image decoder would tolerate a
// missing trailer. The subsequent strict full decode checks the image data.
function inspectContainer(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    if (bytes.length < 4 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) fail('INVALID_IMAGE');
    return 'jpeg';
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, first = true, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || first && (type !== 'IHDR' || length !== 13)) fail('INVALID_IMAGE');
      if (type === 'acTL') fail('ANIMATED_IMAGE_UNSUPPORTED');
      first = false;
      offset += length + 12;
      if (type === 'IEND') {
        if (length !== 0 || offset !== bytes.length) fail('INVALID_IMAGE');
        ended = true;
        break;
      }
    }
    if (!ended) fail('INVALID_IMAGE');
    return 'png';
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('INVALID_IMAGE');
    return 'webp';
  }
  fail('INVALID_IMAGE');
}
function rethrowDecode(error) {
  if (error?.code && /^[A-Z_]+$/.test(error.code)) throw error;
  if (/pixel limit|exceeds.*pixel|image.*too large/i.test(String(error?.message))) fail('IMAGE_TOO_LARGE');
  fail('INVALID_IMAGE');
}
async function inspect(bytes, mimeType, kind) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail('INVALID_IMAGE');
  if (bytes.length > MAX_INPUT_BYTES) fail('IMAGE_TOO_LARGE');
  const mime = cleanMime(mimeType);
  if (mime === 'application/pdf' || bytes.subarray(0, 1024).toString('latin1').trimStart().startsWith('%PDF-')) fail('PDF_NEEDS_RASTER_CONVERSION');
  const format = inspectContainer(bytes);
  if (mime !== undefined && mime !== MIME_BY_FORMAT[format]) fail('INVALID_IMAGE');
  let metadata;
  try { metadata = await sharp(bytes, READ_OPTIONS).metadata(); } catch (error) { rethrowDecode(error); }
  if (metadata.format !== format) fail('INVALID_IMAGE');
  if ((metadata.pages || 1) !== 1 || metadata.pageHeight && metadata.pageHeight !== metadata.height) fail('ANIMATED_IMAGE_UNSUPPORTED');
  const { width, height } = metadata;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('INVALID_IMAGE');
  if (width * height > MAX_PIXELS || width > MAX_DIMENSION || height > MAX_DIMENSION) fail('IMAGE_TOO_LARGE');
  const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
  const oriented = { width: swapped ? height : width, height: swapped ? width : height };
  const legible = kind === 'portrait'
    ? oriented.width >= PORTRAIT_MIN_EDGE && oriented.height >= PORTRAIT_MIN_EDGE
    : Math.max(oriented.width, oriented.height) >= DOCUMENT_LONG_EDGE;
  if (!legible) fail('IMAGE_TOO_SMALL');
  return { bytes, format, metadata, ...oriented, sourceSha256: hash(bytes) };
}
function normalise(source) {
  // Sharp strips EXIF, ICC, XMP and other metadata unless explicitly retained.
  return sharp(source.bytes, READ_OPTIONS).rotate().flatten({ background: WHITE }).toColourspace('srgb');
}
async function encode(makePipeline, dimensions, format, quality) {
  try {
    let pipeline = makePipeline().resize({ ...dimensions, fit: 'inside', withoutEnlargement: true });
    pipeline = format === 'png'
      ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      : pipeline.jpeg({ quality, chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false });
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    return { bytes: result.data, mimeType: MIME_BY_FORMAT[format], width: result.info.width, height: result.info.height, format, quality };
  } catch (error) { rethrowDecode(error); }
}
async function candidates(makePipeline, dimensions, maxBytes) {
  let smallest;
  for (const [format, quality] of [['png', undefined], ...JPEG_QUALITIES.map(value => ['jpeg', value])]) {
    const result = await encode(makePipeline, dimensions, format, quality);
    if (!smallest || result.bytes.length < smallest.bytes.length) smallest = result;
    if (result.bytes.length <= maxBytes) return { result, smallest };
  }
  return { result: null, smallest };
}

async function fitImage({ makePipeline, width, height, minimumScale, isLegible, maxBytes }) {
  const full = await candidates(makePipeline, { width, height }, maxBytes);
  if (full.result) return full.result;
  // Keep the largest raster that fits at a bounded, documented JPEG quality.
  // Never shrink below the real-pixel legibility floor and never upscale.
  let low = minimumScale, high = 1;
  const minimum = dimensionsAt(width, height, low);
  if (!isLegible(minimum)) fail('SIZE_LIMIT_UNACHIEVABLE');
  let format = full.smallest.format;
  let best = await encode(makePipeline, minimum, format, 72);
  if (best.bytes.length > maxBytes) {
    format = format === 'png' ? 'jpeg' : 'png';
    best = await encode(makePipeline, minimum, format, 72);
    if (best.bytes.length > maxBytes) fail('SIZE_LIMIT_UNACHIEVABLE');
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const middle = (low + high) / 2;
    const dimensions = dimensionsAt(width, height, middle);
    if (!isLegible(dimensions)) { low = middle; continue; }
    const result = await encode(makePipeline, dimensions, format, 72);
    if (result.bytes.length <= maxBytes) { low = middle; best = result; } else high = middle;
  }
  const improved = await candidates(makePipeline, { width: best.width, height: best.height }, maxBytes);
  return improved.result || best;
}
function finish(encoded, sources, transformations, originalDimensions) {
  if (encoded.width !== originalDimensions.width || encoded.height !== originalDimensions.height) {
    transformations.push(`resize:${originalDimensions.width}x${originalDimensions.height}->${encoded.width}x${encoded.height}`);
  }
  transformations.push(encoded.format === 'jpeg' ? `encode_jpeg:quality=${encoded.quality}` : 'encode_png:lossless');
  return {
    bytes: encoded.bytes,
    mimeType: encoded.mimeType,
    sha256: hash(encoded.bytes),
    sourceSha256s: sources.map(source => source.sourceSha256),
    width: encoded.width,
    height: encoded.height,
    needsVisualReview: true,
    transformations
  };
}
function sourceTransformations(source) {
  const steps = ['strip_metadata', 'convert_to_srgb'];
  if (source.metadata.orientation >= 2 && source.metadata.orientation <= 8) steps.unshift('apply_exif_orientation');
  if (source.metadata.hasAlpha) steps.push('flatten_alpha_on_white');
  return steps;
}

async function preparePortalImage(bytes, { mimeType, maxBytes = MAX_OUTPUT_BYTES, kind = 'document' } = {}) {
  maxBytes = maxBytesOption(maxBytes);
  if (!['document', 'portrait'].includes(kind)) fail('INVALID_IMAGE_KIND');
  const source = await inspect(bytes, mimeType, kind);
  const isLegible = kind === 'portrait'
    ? dimensions => dimensions.width >= PORTRAIT_MIN_EDGE && dimensions.height >= PORTRAIT_MIN_EDGE
    : dimensions => Math.max(dimensions.width, dimensions.height) >= DOCUMENT_LONG_EDGE;
  const minimumScale = kind === 'portrait'
    ? Math.max(PORTRAIT_MIN_EDGE / source.width, PORTRAIT_MIN_EDGE / source.height)
    : DOCUMENT_LONG_EDGE / Math.max(source.width, source.height);
  const encoded = await fitImage({ makePipeline: () => normalise(source), width: source.width, height: source.height, minimumScale, isLegible, maxBytes });
  return finish(encoded, [source], sourceTransformations(source), source);
}

function residenceLayout(dimensions) {
  const width = Math.max(...dimensions.map(part => part.width));
  const gap = Math.max(16, Math.round(width * 0.02));
  return { width, height: dimensions.reduce((sum, part) => sum + part.height, 0) + gap, gap };
}
async function prepareResidenceImage(parts, { maxBytes = MAX_OUTPUT_BYTES } = {}) {
  maxBytes = maxBytesOption(maxBytes);
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2) fail('INVALID_RESIDENCE_PARTS');
  const inputs = parts.map(part => Buffer.isBuffer(part) ? { bytes: part } : part);
  if (inputs.some(part => !part || typeof part !== 'object' || !Buffer.isBuffer(part.bytes))) fail('INVALID_IMAGE');
  if (inputs.length === 1) {
    const result = await preparePortalImage(inputs[0].bytes, { mimeType: inputs[0].mimeType, maxBytes, kind: 'document' });
    result.transformations.push('residence_single_part');
    return result;
  }
  const sources = [];
  for (const input of inputs) sources.push(await inspect(input.bytes, input.mimeType, 'document'));
  let initialScale = 1;
  let dimensions = sources.map(source => dimensionsAt(source.width, source.height, initialScale));
  let layout = residenceLayout(dimensions);
  while (layout.width * layout.height > MAX_PIXELS || layout.width > MAX_DIMENSION || layout.height > MAX_DIMENSION) {
    initialScale *= Math.min(0.99, Math.sqrt(MAX_PIXELS / (layout.width * layout.height)) * 0.99,
      MAX_DIMENSION / layout.width * 0.99, MAX_DIMENSION / layout.height * 0.99);
    dimensions = sources.map(source => dimensionsAt(source.width, source.height, initialScale));
    layout = residenceLayout(dimensions);
  }
  if (dimensions.some(part => Math.max(part.width, part.height) < DOCUMENT_LONG_EDGE)) fail('SIZE_LIMIT_UNACHIEVABLE');
  const layers = [];
  let top = 0;
  for (let index = 0; index < sources.length; index++) {
    const part = await encode(() => normalise(sources[index]), dimensions[index], 'png');
    dimensions[index] = { width: part.width, height: part.height };
    layers.push({ input: part.bytes, left: Math.floor((layout.width - part.width) / 2), top });
    top += part.height + layout.gap;
  }
  // Materialise before resizing: Sharp applies resize ahead of composite even
  // when resize is chained afterwards, which would otherwise clip the layers.
  let composite;
  try {
    composite = await sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: WHITE } })
      .composite(layers).toColourspace('srgb').png({ compressionLevel: 9 }).toBuffer();
  } catch (error) { rethrowDecode(error); }
  // The completed canvas owns the pixels; release encoded side buffers before
  // trying successive output encodings on a memory-constrained worker.
  layers.length = 0;
  const makePipeline = () => sharp(composite, READ_OPTIONS);
  const minimumScale = Math.max(...dimensions.map(part => DOCUMENT_LONG_EDGE / Math.max(part.width, part.height)));
  const isLegible = output => dimensions.every(part => Math.max(
    Math.round(part.width * output.width / layout.width),
    Math.round(part.height * output.height / layout.height)
  ) >= DOCUMENT_LONG_EDGE);
  const encoded = await fitImage({ makePipeline, width: layout.width, height: layout.height, minimumScale, isLegible, maxBytes });
  const transformations = ['apply_exif_orientation_per_part', 'strip_metadata', 'convert_to_srgb', 'combine_full_parts_on_white_with_gap'];
  if (sources.some(source => source.metadata.hasAlpha)) transformations.push('flatten_alpha_on_white');
  if (initialScale < 1) transformations.push('resize_parts_to_pixel_guard');
  return finish(encoded, sources, transformations, layout);
}

module.exports = { preparePortalImage, prepareResidenceImage };
