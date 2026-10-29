'use strict';

// Build-time installation of one licensed, immutable optical model. No customer
// image, credential, configurable URL or runtime download is involved.
const {createHash, randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MODEL_URL = 'https://raw.githubusercontent.com/DoubangoTelecom/tesseractMRZ/1e7adfecda5f3c9ae1fb12cf6b4b8c3958c63e46/tessdata_fast/mrz.traineddata';
const MODEL_SHA256 = 'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01';
const MODEL_BYTES = 1452847;
const MODEL_DIRECTORY = path.resolve(__dirname, '../var/mrz-model');

function matches(bytes) {
  return bytes.length === MODEL_BYTES && createHash('sha256').update(bytes).digest('hex') === MODEL_SHA256;
}

async function installModel({fetchImpl = fetch, directory = MODEL_DIRECTORY} = {}) {
  const target = path.join(directory, 'mrz.traineddata');
  try { if (matches(await fs.readFile(target))) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(MODEL_URL, {redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok || !response.body) throw Error('MRZ_MODEL_DOWNLOAD_FAILED');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MODEL_BYTES) { await reader.cancel(); throw Error('MRZ_MODEL_INVALID'); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, size);
    if (!matches(bytes)) throw Error('MRZ_MODEL_INVALID');
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const temporary = path.join(directory, `.mrz-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, bytes, {mode: 0o600, flag: 'wx'}); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, {force: true}); }
  } finally { reader.releaseLock(); }
}

if (require.main === module) installModel().then(() => console.log('MRZ optical model verified.')).catch(() => { console.error('MRZ_MODEL_INSTALL_FAILED'); process.exitCode = 1; });

module.exports = {installModel, matches, MODEL_URL, MODEL_SHA256, MODEL_BYTES, MODEL_DIRECTORY};
