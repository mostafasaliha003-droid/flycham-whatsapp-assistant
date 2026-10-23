'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');

const VERIFICATION_FILE = '/tmp/airarabia-verification-code';

async function takeVerificationCode(path, requestedAt) {
  let file;
  try {
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 32) {
      throw Object.assign(new Error('Invalid verification file'), { code: 'VERIFICATION_FILE_INVALID' });
    }
    const value = (await file.readFile('utf8')).trim();
    await file.close();
    file = null;
    await fs.unlink(path);
    if (info.mtimeMs < requestedAt) return null;
    if (!/^[A-Za-z0-9]{4,12}$/.test(value)) {
      throw Object.assign(new Error('Invalid verification code format'), { code: 'VERIFICATION_FILE_INVALID' });
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

async function waitForVerificationCode({ path = VERIFICATION_FILE, requestedAt = Date.now(), timeoutMs = 10 * 60 * 1000, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  do {
    const code = await takeVerificationCode(path, requestedAt);
    if (code) return code;
    if (now() >= deadline) break;
    await pause(1000);
  } while (now() <= deadline);
  throw Object.assign(new Error('Operator verification timed out'), { code: 'VERIFICATION_TIMEOUT' });
}

module.exports = { VERIFICATION_FILE, takeVerificationCode, waitForVerificationCode };
