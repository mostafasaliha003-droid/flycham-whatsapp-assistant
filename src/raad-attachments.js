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
// Use the same real-pixel short-edge floor as the intake reader. A long
// one-row crop must not count as a complete upload merely because it is wide.
// These geometry bounds do not establish that the document text is readable.
const DOCUMENT_SHORT_EDGE = 300;
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
function documentLegible({ width, height }) {
  return Math.max(width, height) >= DOCUMENT_LONG_EDGE && Math.min(width, height) >= DOCUMENT_SHORT_EDGE;
}
function documentMinimumScale({ width, height }) {
  return Math.max(DOCUMENT_LONG_EDGE / Math.max(width, height), DOCUMENT_SHORT_EDGE / Math.min(width, height));
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
    : documentLegible(oriented);
  if (!legible) fail('IMAGE_TOO_SMALL');
  return { bytes, format, metadata, ...oriented, sourceSha256: hash(bytes) };
}
function normalise(source) {
  // Sharp strips EXIF, ICC, XMP and other metadata unless explicitly retained.
  let pipeline = sharp(source.bytes, READ_OPTIONS).rotate().flatten({ background: WHITE }).toColourspace('srgb');
  if (source.enhancement) {
    const { gain, offset } = source.enhancement;
    pipeline = pipeline.linear(gain, offset).sharpen({ sigma: 0.5, m1: 0.25, m2: 0.5, x1: 2, y2: 1, y3: 1 });
  }
  return pipeline;
}
// Improve only measured low-contrast or underexposed document pixels. These
// bounded, conventional filters cannot reconstruct missing text or pixels.
// Full-image extrema constrain the linear step so no channel is clipped; the
// sharpening adds at most one L-channel unit in either direction. Portraits
// never enter this step, and an already clear or flat image stays unchanged.
async function measureDocumentEnhancement(source, enabled) {
  if (typeof enabled !== 'boolean') fail('INVALID_IMAGE_OPTIONS');
  if (!enabled) return;
  // Stats describe original channel values. Rotation leaves them unchanged;
  // transparent, profile-converted and other colour spaces are deliberately
  // left alone rather than estimating their flattened/converted extrema.
  if (source.metadata.hasAlpha || source.metadata.icc || source.metadata.depth !== 'uchar' || !['srgb', 'b-w'].includes(source.metadata.space)) return;
  let stats;
  try { stats = await sharp(source.bytes, READ_OPTIONS).stats(); } catch (error) { rethrowDecode(error); }
  const channels = stats.channels.slice(0, 3);
  const minimum = Math.min(...channels.map(channel => channel.min));
  const maximum = Math.max(...channels.map(channel => channel.max));
  const span = maximum - minimum;
  const mean = channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length;
  const deviation = channels.reduce((sum, channel) => sum + channel.stdev, 0) / channels.length;
  if (span < 24 || deviation < 3) return;
  const gain = span <= 160 && minimum >= 8 && maximum <= 247 ? 1.08 : 1;
  const lift = mean < 110 && maximum <= 239 ? Math.min(6, (110 - mean) * 0.12) : 0;
  if (gain === 1 && lift === 0) return;
  // Leave one value of headroom for sharpening. The original pixels, their
  // edges and dimensions are retained; no automatic crop, fill or upscale.
  const offset = Math.round(Math.max(1 - gain * minimum, Math.min(254 - gain * maximum, (1 - gain) * mean + lift)) * 1000000) / 1000000;
  source.enhancement = { gain, offset };
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
  if (source.enhancement) {
    steps.push(`measured_tonal_adjustment:gain=${source.enhancement.gain},offset=${source.enhancement.offset}`);
    steps.push('mild_sharpen:sigma=0.5,max_luminance_delta=1');
  }
  return steps;
}

async function preparePortalImage(bytes, { mimeType, maxBytes = MAX_OUTPUT_BYTES, kind = 'document', enhance = true } = {}) {
  maxBytes = maxBytesOption(maxBytes);
  if (!['document', 'portrait'].includes(kind)) fail('INVALID_IMAGE_KIND');
  if (typeof enhance !== 'boolean') fail('INVALID_IMAGE_OPTIONS');
  const source = await inspect(bytes, mimeType, kind);
  if (kind === 'document') await measureDocumentEnhancement(source, enhance);
  const isLegible = kind === 'portrait'
    ? dimensions => dimensions.width >= PORTRAIT_MIN_EDGE && dimensions.height >= PORTRAIT_MIN_EDGE
    : documentLegible;
  const minimumScale = kind === 'portrait'
    ? Math.max(PORTRAIT_MIN_EDGE / source.width, PORTRAIT_MIN_EDGE / source.height)
    : documentMinimumScale(source);
  const encoded = await fitImage({ makePipeline: () => normalise(source), width: source.width, height: source.height, minimumScale, isLegible, maxBytes });
  return finish(encoded, [source], sourceTransformations(source), source);
}

function residenceLayout(dimensions) {
  const width = Math.max(...dimensions.map(part => part.width));
  const gap = Math.max(16, Math.round(width * 0.02));
  return { width, height: dimensions.reduce((sum, part) => sum + part.height, 0) + gap, gap };
}
async function prepareDocumentImage(parts, { kind = 'passport', maxBytes = MAX_OUTPUT_BYTES, enhance = true } = {}) {
  maxBytes = maxBytesOption(maxBytes);
  if (!['passport', 'residence'].includes(kind)) fail('INVALID_IMAGE_KIND');
  if (typeof enhance !== 'boolean') fail('INVALID_IMAGE_OPTIONS');
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2) fail(kind === 'residence' ? 'INVALID_RESIDENCE_PARTS' : 'INVALID_DOCUMENT_PARTS');
  const inputs = parts.map(part => Buffer.isBuffer(part) ? { bytes: part } : part);
  if (inputs.some(part => !part || typeof part !== 'object' || !Buffer.isBuffer(part.bytes))) fail('INVALID_IMAGE');
  if (inputs.length === 1) {
    const result = await preparePortalImage(inputs[0].bytes, { mimeType: inputs[0].mimeType, maxBytes, kind: 'document', enhance });
    result.transformations.push(`${kind}_single_part`);
    return result;
  }
  const sources = [];
  for (const input of inputs) {
    const source = await inspect(input.bytes, input.mimeType, 'document');
    await measureDocumentEnhancement(source, enhance);
    sources.push(source);
  }
  let initialScale = 1;
  let dimensions = sources.map(source => dimensionsAt(source.width, source.height, initialScale));
  let layout = residenceLayout(dimensions);
  while (layout.width * layout.height > MAX_PIXELS || layout.width > MAX_DIMENSION || layout.height > MAX_DIMENSION) {
    initialScale *= Math.min(0.99, Math.sqrt(MAX_PIXELS / (layout.width * layout.height)) * 0.99,
      MAX_DIMENSION / layout.width * 0.99, MAX_DIMENSION / layout.height * 0.99);
    dimensions = sources.map(source => dimensionsAt(source.width, source.height, initialScale));
    layout = residenceLayout(dimensions);
  }
  if (dimensions.some(part => !documentLegible(part))) fail('SIZE_LIMIT_UNACHIEVABLE');
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
  const minimumScale = Math.max(...dimensions.map(documentMinimumScale));
  const isLegible = output => dimensions.every(part => documentLegible({
    width: Math.round(part.width * output.width / layout.width),
    height: Math.round(part.height * output.height / layout.height)
  }));
  const encoded = await fitImage({ makePipeline, width: layout.width, height: layout.height, minimumScale, isLegible, maxBytes });
  const transformations = ['apply_exif_orientation_per_part', 'strip_metadata', 'convert_to_srgb', 'combine_full_parts_on_white_with_gap'];
  sources.forEach((source, index) => {
    if (source.enhancement) transformations.push(...sourceTransformations(source).filter(step => /^(measured_tonal_adjustment|mild_sharpen):/.test(step)).map(step => `part_${index + 1}:${step}`));
  });
  if (sources.some(source => source.metadata.hasAlpha)) transformations.push('flatten_alpha_on_white');
  if (initialScale < 1) transformations.push('resize_parts_to_pixel_guard');
  return finish(encoded, sources, transformations, layout);
}

async function prepareResidenceImage(parts, options = {}) {
  return prepareDocumentImage(parts, { ...options, kind: 'residence' });
}

module.exports = { preparePortalImage, prepareDocumentImage, prepareResidenceImage };
