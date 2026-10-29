'use strict';

// Private, short-lived local OCR process. The parent owns and kills this process,
// including any native worker hidden inside a failed Tesseract initialization.
// No app secrets, paths supplied by customers, downloads or disk images enter it.
const path = require('node:path');
const {verifyPinnedModel, TESSERACT_VERSION, MAX_INPUT_BYTES} = require('./visa-mrz-optical');

let worker, initialized = false, initializing = false, busy = false;
const send = message => {
  if (!process.connected) return process.exit(1);
  try { process.send(message, error => { if (error) process.exit(1); }); } catch { process.exit(1); }
};
process.on('disconnect', () => process.exit(1));
process.on('message', async message => {
  if (!message || typeof message !== 'object') return process.exit(1);
  if (message.type === 'init') {
    if (initialized || initializing) return process.exit(1);
    initializing = true;
    try {
      if (message.lang !== 'mrz' || message.oem !== 1 || typeof message.directory !== 'string' || message.directory.length > 4096 || !path.isAbsolute(message.directory) || !verifyPinnedModel(message.directory) || require('tesseract.js/package.json').version !== TESSERACT_VERSION) throw Error();
      worker = await require('tesseract.js').createWorker('mrz', 1, {langPath: message.directory, cachePath: message.directory, cacheMethod: 'none', gzip: false, legacyCore: false, legacyLang: false, logger: () => {}, errorHandler: () => {}});
      initialized = true;
      send({type: 'ready'});
    } catch { send({type: 'init_failed'}); process.exit(1); }
    return;
  }
  if (!initialized || busy || !Number.isSafeInteger(message.id) || message.id < 1 || !['parameters', 'recognize'].includes(message.type)) return process.exit(1);
  busy = true;
  try {
    if (message.type === 'parameters') {
      const mode = message.parameters?.tessedit_pageseg_mode;
      if (![6, 11].includes(mode)) throw Error();
      await worker.setParameters({tessedit_pageseg_mode: mode, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', preserve_interword_spaces: '0', user_defined_dpi: '300'});
      send({type: 'result', id: message.id, ok: true});
    } else {
      if (!Buffer.isBuffer(message.bytes) || message.bytes.length < 32 || message.bytes.length > MAX_INPUT_BYTES) throw Error();
      const result = await worker.recognize(message.bytes, {}, {text: true});
      const text = result?.data?.text;
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 8192) throw Error();
      send({type: 'result', id: message.id, ok: true, text});
    }
  } catch { send({type: 'result', id: message.id, ok: false}); }
  finally { if (Buffer.isBuffer(message.bytes)) message.bytes.fill(0); busy = false; }
});
