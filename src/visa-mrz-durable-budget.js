'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// This ledger is deliberately independent of AssistantState and the evaluation
// allowance. Persistence of the containing volume must be confirmed by its owner.
// A separately fsynced anchor detects one-file ledger/anchor rollback across a
// restart. No external monotonic authority is available: rolling back both files
// (or a whole volume) is outside this contract. Offline recovery must preserve
// both current files and reconcile all spending before reopening.
const NAMESPACE = 'visaMrzProductionBudgetV1';
const ANCHOR_NAMESPACE = NAMESPACE + ':commitAnchor';
const MICROS = 1000000;
const MAX_ATTEMPT_MICROS = 120000;
const MIN_HISTORY_MICROS = 960000; // conservative evaluation ceiling, not an invoice
const MAX_CAP_MICROS = 1000 * MICROS; // representation bound, never authorization
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set(['accepted', 'rejected', 'error', 'timeout']);
const AAD = Buffer.from(NAMESPACE + ':aes-256-gcm:1');
const ANCHOR_AAD = Buffer.from(ANCHOR_NAMESPACE + ':aes-256-gcm:1');

class DurableMrzBudgetError extends Error {
  constructor(code) { super(code); this.name = 'DurableMrzBudgetError'; this.code = code; }
}
function fail(code) { throw new DurableMrzBudgetError(code); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function keys(value, expected) { return plain(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(','); }
function validHash(value) { return typeof value === 'string' && HASH.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function deriveAttemptId(attemptKey, policyFingerprint) {
  if (!validHash(attemptKey) || !validHash(policyFingerprint)) fail('MRZ_BUDGET_INVALID_BINDING');
  return hash(attemptKey + ':' + policyFingerprint);
}
function reservationId(attemptId) { return hash(NAMESPACE + ':reservation:' + attemptId); }
function usdMicros(value, max, code, {zero = false, exact = false} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!zero && value === 0) || value > max / MICROS) fail(code);
  const scaled = value * MICROS, rounded = Math.round(scaled);
  // Caps/history must be explicitly representable; reservations round upward.
  if (exact && Math.abs(scaled - rounded) > 1e-7) fail(code);
  const amount = exact ? rounded : Math.ceil(scaled);
  if (!integer(amount) || (!zero && amount === 0) || amount > max) fail(code);
  return amount;
}
function usage(value, code) {
  if (value === null || value === undefined) return null;
  if (!keys(value, ['input_tokens', 'output_tokens', 'total_tokens']) || !Object.values(value).every(integer) || !Number.isSafeInteger(value.input_tokens + value.output_tokens) || value.input_tokens + value.output_tokens !== value.total_tokens) fail(code);
  return {input_tokens: value.input_tokens, output_tokens: value.output_tokens, total_tokens: value.total_tokens};
}
function configuration(options) {
  const {file, key, policyFingerprint, capUsd, persistentStateConfirmed, now = Date.now, fsImpl = fs} = options || {};
  if (persistentStateConfirmed !== true) fail('MRZ_BUDGET_PERSISTENCE_UNCONFIRMED');
  if (typeof file !== 'string' || !path.isAbsolute(file) || file !== path.resolve(file) || !validHash(policyFingerprint) || typeof now !== 'function') fail('MRZ_BUDGET_INVALID_CONFIGURATION');
  let base;
  if (Buffer.isBuffer(key) && key.length === 32) base = Buffer.from(key);
  else if (typeof key === 'string' && key.length > 0) base = crypto.createHash('sha256').update(key).digest();
  else fail('MRZ_BUDGET_KEY_REQUIRED');
  const capMicrousd = usdMicros(capUsd, MAX_CAP_MICROS, 'MRZ_BUDGET_INVALID_CAP', {exact: true});
  const encryptionKey = crypto.createHash('sha256').update(NAMESPACE + ':key:').update(base).digest();
  base.fill(0);
  const anchorKey = crypto.createHash('sha256').update(ANCHOR_NAMESPACE + ':key:').update(encryptionKey).digest();
  return {file, anchorFile: file + '.anchor', lockFile: file + '.lock', directory: path.dirname(file), policyFingerprint, capMicrousd, now, fs: fsImpl, encryptionKey, anchorKey};
}
function validateLedger(ledger, config) {
  const code = 'MRZ_BUDGET_INVALID_LEDGER';
  if (!keys(ledger, ['namespace', 'version', 'ledgerId', 'sequence', 'policyFingerprint', 'capMicrousd', 'maxAttemptMicrousd', 'history', 'reservations', 'settlements']) || ledger.namespace !== NAMESPACE || ledger.version !== 1 || !validHash(ledger.ledgerId) || !integer(ledger.sequence) || ledger.sequence === 0 || ledger.policyFingerprint !== config.policyFingerprint || ledger.capMicrousd !== config.capMicrousd || ledger.maxAttemptMicrousd !== MAX_ATTEMPT_MICROS || !keys(ledger.history, ['reconciled', 'evidenceSha256', 'spentMicrousd']) || ledger.history.reconciled !== true || !validHash(ledger.history.evidenceSha256) || !integer(ledger.history.spentMicrousd) || ledger.history.spentMicrousd < MIN_HISTORY_MICROS || ledger.history.spentMicrousd > ledger.capMicrousd || !Array.isArray(ledger.reservations) || !Array.isArray(ledger.settlements)) fail(code);
  const attempts = new Map(), ids = new Set(), attemptKeys = new Set();
  let spent = ledger.history.spentMicrousd;
  for (const row of ledger.reservations) {
    if (!keys(row, ['reservationId', 'attemptId', 'attemptKey', 'policyFingerprint', 'reservedMicrousd']) || !validHash(row.attemptKey) || row.policyFingerprint !== ledger.policyFingerprint || row.attemptId !== deriveAttemptId(row.attemptKey, row.policyFingerprint) || row.reservationId !== reservationId(row.attemptId) || !integer(row.reservedMicrousd) || row.reservedMicrousd === 0 || row.reservedMicrousd > MAX_ATTEMPT_MICROS || attempts.has(row.attemptId) || ids.has(row.reservationId) || attemptKeys.has(row.attemptKey)) fail(code);
    attempts.set(row.attemptId, row); ids.add(row.reservationId); attemptKeys.add(row.attemptKey);
    spent += row.reservedMicrousd;
    if (!Number.isSafeInteger(spent) || spent > ledger.capMicrousd) fail(code);
  }
  const settled = new Set();
  for (const row of ledger.settlements) {
    if (!keys(row, ['reservationId', 'attemptId', 'outcome', 'uncertain', 'retainedMicrousd', 'generationUsage', 'estimatedGenerationMicrousd', 'countReserveMicrousd']) || !attempts.has(row.attemptId) || settled.has(row.attemptId)) fail(code);
    const reservation = attempts.get(row.attemptId);
    if (row.reservationId !== reservation.reservationId || !OUTCOMES.has(row.outcome) || typeof row.uncertain !== 'boolean' || row.retainedMicrousd !== reservation.reservedMicrousd || (row.outcome === 'timeout' && !row.uncertain)) fail(code);
    usage(row.generationUsage, code);
    if (row.estimatedGenerationMicrousd !== null && (!integer(row.estimatedGenerationMicrousd) || row.estimatedGenerationMicrousd > reservation.reservedMicrousd)) fail(code);
    if (row.countReserveMicrousd !== null && (!integer(row.countReserveMicrousd) || row.countReserveMicrousd > reservation.reservedMicrousd)) fail(code);
    if ((row.estimatedGenerationMicrousd ?? 0) + (row.countReserveMicrousd ?? 0) > reservation.reservedMicrousd) fail(code);
    if (row.outcome === 'accepted' && (row.uncertain || row.generationUsage === null || row.estimatedGenerationMicrousd === null || row.countReserveMicrousd === null)) fail(code);
    settled.add(row.attemptId);
  }
  // Every persisted change advances once, including the provisioning record.
  if (ledger.sequence !== 1 + ledger.reservations.length + ledger.settlements.length) fail(code);
  return ledger;
}
function encodeDocument(document, aad, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(document)), cipher.final()]);
  return Buffer.concat([aad, Buffer.from([0]), iv, cipher.getAuthTag(), encrypted]);
}
function decodeDocument(bytes, aad, key, code) {
  const header = aad.length + 1;
  if (bytes.length < header + 28 || !bytes.subarray(0, aad.length).equals(aad) || bytes[aad.length] !== 0) fail(code);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(header, header + 12));
    decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(header + 12, header + 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(header + 28)), decipher.final()]).toString('utf8'));
  } catch { fail(code); }
}
function makeAnchor(ledger, bytes) {
  return {namespace: ANCHOR_NAMESPACE, version: 1, ledgerId: ledger.ledgerId, sequence: ledger.sequence, policyFingerprint: ledger.policyFingerprint, capMicrousd: ledger.capMicrousd, historyEvidenceSha256: ledger.history.evidenceSha256, historicalSpentMicrousd: ledger.history.spentMicrousd, ledgerCiphertextSha256: hash(bytes)};
}
function validateAnchor(anchor, ledger, bytes) {
  if (!keys(anchor, ['namespace', 'version', 'ledgerId', 'sequence', 'policyFingerprint', 'capMicrousd', 'historyEvidenceSha256', 'historicalSpentMicrousd', 'ledgerCiphertextSha256']) || JSON.stringify(anchor) !== JSON.stringify(makeAnchor(ledger, bytes))) fail('MRZ_BUDGET_ANCHOR_MISMATCH');
  return anchor;
}
function sameInode(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function regular(stat) { return stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()); }
function writeAll(io, fd, bytes, beforeWrite = () => {}) {
  let offset = 0;
  while (offset < bytes.length) {
    beforeWrite();
    const count = io.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(count) || count <= 0) throw Error('MRZ_SHORT_WRITE');
    offset += count;
  }
}
function ioSession(config) {
  const io = config.fs, constants = io.constants || fs.constants;
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) fail('MRZ_BUDGET_UNSUPPORTED_FILESYSTEM');
  let directoryFd, directoryStat, lockFd, lockStat, lockBytes;
  function directoryOwned() {
    if (directoryFd === undefined || !sameInode(io.fstatSync(directoryFd), directoryStat) || io.realpathSync(config.directory) !== config.directory || !sameInode(io.lstatSync(config.directory), directoryStat)) fail('MRZ_BUDGET_OWNERSHIP_LOST');
  }
  function owner() {
    directoryOwned();
    const stat = io.lstatSync(config.lockFile), held = io.fstatSync(lockFd);
    if (!regular(stat) || !regular(held) || !sameInode(stat, lockStat) || !sameInode(held, lockStat)) fail('MRZ_BUDGET_OWNERSHIP_LOST');
    const bytes = Buffer.alloc(lockBytes.length + 1), count = io.readSync(lockFd, bytes, 0, bytes.length, 0);
    if (count !== lockBytes.length || !bytes.subarray(0, count).equals(lockBytes) || !sameInode(io.lstatSync(config.lockFile), lockStat)) fail('MRZ_BUDGET_OWNERSHIP_LOST');
  }
  function release() {
    let error;
    if (lockFd !== undefined) {
      try { owner(); io.unlinkSync(config.lockFile); io.fsyncSync(directoryFd); } catch (caught) { error = caught; }
      try { io.closeSync(lockFd); } catch (caught) { error ||= caught; }
      lockFd = undefined;
    }
    if (directoryFd !== undefined) { try { io.closeSync(directoryFd); } catch (caught) { error ||= caught; } directoryFd = undefined; }
    if (error) throw error;
  }
  function acquire() {
    // The directory must already exist. Neither open nor provisioning creates it.
    try {
      directoryFd = io.openSync(config.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directoryStat = io.fstatSync(directoryFd); directoryOwned();
      try {
        lockFd = io.openSync(config.lockFile, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if (error.code === 'EEXIST' || error.code === 'ELOOP') fail('MRZ_BUDGET_LOCKED');
        throw error;
      }
      lockStat = io.fstatSync(lockFd);
      lockBytes = Buffer.from(JSON.stringify({namespace: NAMESPACE, version: 1, token: crypto.randomBytes(32).toString('hex'), pid: process.pid}));
      if (!regular(lockStat)) fail('MRZ_BUDGET_OWNERSHIP_LOST');
      writeAll(io, lockFd, lockBytes); io.fsyncSync(lockFd); io.fsyncSync(directoryFd); owner();
    } catch (error) {
      // A partial lock is never automatically broken: recovery is an offline task.
      if (lockFd !== undefined) { try { io.closeSync(lockFd); } catch {} lockFd = undefined; }
      if (directoryFd !== undefined) { try { io.closeSync(directoryFd); } catch {} directoryFd = undefined; }
      throw error;
    }
  }
  function readBlob(file, missingCode = 'MRZ_BUDGET_LEDGER_MISSING') {
    owner();
    let fd;
    try {
      try { fd = io.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') fail(missingCode); throw error; }
      const stat = io.fstatSync(fd);
      if (!regular(stat) || stat.size > MAX_FILE_BYTES || stat.size < 1 || !sameInode(io.lstatSync(file), stat)) fail('MRZ_BUDGET_INVALID_LEDGER');
      const bytes = io.readFileSync(fd);
      if (bytes.length !== stat.size || !sameInode(io.lstatSync(file), stat)) fail('MRZ_BUDGET_INVALID_LEDGER');
      owner(); return {bytes, etag: hash(bytes), stat};
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function read() {
    const blob = readBlob(config.file), ledger = validateLedger(decodeDocument(blob.bytes, AAD, config.encryptionKey, 'MRZ_BUDGET_INVALID_LEDGER'), config);
    const anchor = readBlob(config.anchorFile, 'MRZ_BUDGET_ANCHOR_MISSING');
    const document = decodeDocument(anchor.bytes, ANCHOR_AAD, config.anchorKey, 'MRZ_BUDGET_INVALID_ANCHOR');
    validateAnchor(document, ledger, blob.bytes); owner();
    return {...blob, ledger, anchor: {...anchor, document}};
  }
  function unchangedBlob(file, expected) {
    const actual = readBlob(file);
    if (actual.etag !== expected.etag || !sameInode(actual.stat, expected.stat)) fail('MRZ_BUDGET_LEDGER_CHANGED');
    return actual;
  }
  function unchanged(expected) {
    const actual = read();
    if (actual.etag !== expected.etag || actual.anchor.etag !== expected.anchor.etag || actual.ledger.sequence !== expected.ledger.sequence || actual.ledger.ledgerId !== expected.ledger.ledgerId || !sameInode(actual.stat, expected.stat) || !sameInode(actual.anchor.stat, expected.anchor.stat)) fail('MRZ_BUDGET_LEDGER_CHANGED');
    return actual;
  }
  function absent(file) {
    owner();
    try { io.lstatSync(file); fail('MRZ_BUDGET_ALREADY_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function temporary(file, bytes) {
    const name = file + '.' + crypto.randomBytes(24).toString('hex') + '.tmp';
    let fd;
    try {
      owner(); fd = io.openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const stat = io.fstatSync(fd);
      if (!regular(stat)) fail('MRZ_BUDGET_OWNERSHIP_LOST');
      writeAll(io, fd, bytes, owner); owner(); io.fsyncSync(fd);
      return {name, stat};
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function publish(staged, file, replace) {
    owner();
    const stat = io.lstatSync(staged.name);
    if (!regular(stat) || !sameInode(stat, staged.stat)) fail('MRZ_BUDGET_OWNERSHIP_LOST');
    if (replace) { owner(); io.renameSync(staged.name, file); }
    else {
      // Atomic create-without-overwrite for offline provisioning. A crash between
      // link/unlink leaves a non-regular-for-this-contract hardlink and fails shut.
      owner(); io.linkSync(staged.name, file); owner(); io.unlinkSync(staged.name);
    }
    owner(); io.fsyncSync(directoryFd);
  }
  function save(ledger, expected) {
    owner();
    if (expected) unchanged(expected);
    else { absent(config.file); absent(config.anchorFile); }
    validateLedger(ledger, config);
    const bytes = encodeDocument(ledger, AAD, config.encryptionKey);
    if (bytes.length > MAX_FILE_BYTES) fail('MRZ_BUDGET_LEDGER_FULL');
    const anchorBytes = encodeDocument(makeAnchor(ledger, bytes), ANCHOR_AAD, config.anchorKey);
    // Both temp files are independently fsynced before either current file moves.
    // The two publications intentionally fail shut if interrupted between them;
    // no API call may report a reservation committed until both are durable.
    const stagedLedger = temporary(config.file, bytes), stagedAnchor = temporary(config.anchorFile, anchorBytes);
    if (expected) unchanged(expected);
    else { absent(config.file); absent(config.anchorFile); }
    publish(stagedLedger, config.file, Boolean(expected));
    const written = readBlob(config.file);
    if (!written.bytes.equals(bytes)) fail('MRZ_BUDGET_SAVE_FAILED');
    if (expected) unchangedBlob(config.anchorFile, expected.anchor);
    else absent(config.anchorFile);
    unchangedBlob(config.file, written);
    publish(stagedAnchor, config.anchorFile, Boolean(expected));
    const committed = read();
    if (!committed.bytes.equals(bytes) || !committed.anchor.bytes.equals(anchorBytes) || committed.ledger.sequence !== ledger.sequence) fail('MRZ_BUDGET_SAVE_FAILED');
    return committed;
    // No unverified unlink after failures. Partial pairs and encrypted temps are
    // retained for explicit offline reconciliation; never refund or auto-repair.
  }
  return {acquire, owner, read, unchanged, save, release};
}
function validateBinding(input, config) {
  if (!plain(input) || input.attemptId !== deriveAttemptId(input.attemptKey, input.policyFingerprint)) fail('MRZ_BUDGET_INVALID_BINDING');
  if (input.policyFingerprint !== config.policyFingerprint) fail('MRZ_BUDGET_POLICY_MISMATCH');
}

function createDurableMrzBudget(options) {
  const config = configuration(options); // no filesystem access or allocation
  let session, snapshot, opened = false, poisoned = false, pending = 0, tail = Promise.resolve();
  function checked() {
    if (!opened || poisoned) fail('MRZ_BUDGET_NOT_DURABLE');
    try { session.unchanged(snapshot); } catch { poisoned = true; fail('MRZ_BUDGET_NOT_DURABLE'); }
    return snapshot.ledger;
  }
  function serial(action) {
    pending++;
    const operation = tail.then(() => action());
    tail = operation.catch(() => {});
    return operation.finally(() => { pending--; });
  }
  function commit(ledger) {
    try { snapshot = session.save(ledger, snapshot); }
    catch { poisoned = true; fail('MRZ_BUDGET_SAVE_FAILED'); }
  }
  const budget = Object.freeze({
    get durable() { try { checked(); return true; } catch { return false; } },
    open() {
      return serial(() => {
        if (opened || session || poisoned) fail('MRZ_BUDGET_ALREADY_OPENED');
        session = ioSession(config);
        try { session.acquire(); snapshot = session.read(); opened = true; return budget; }
        catch (error) {
          poisoned = true;
          try { session.release(); } catch {}
          if (error.code === 'ENOENT') fail('MRZ_BUDGET_LEDGER_MISSING');
          if (error instanceof DurableMrzBudgetError) throw error;
          fail('MRZ_BUDGET_OPEN_FAILED');
        }
      });
    },
    reserve(input) {
      return serial(() => {
        const ledger = checked(); validateBinding(input, config);
        if (input.budgetCapUsd !== config.capMicrousd / MICROS) fail('MRZ_BUDGET_CAP_MISMATCH');
        const reservedMicrousd = usdMicros(input.maxUsd, MAX_ATTEMPT_MICROS, 'MRZ_BUDGET_INVALID_AMOUNT');
        const existing = ledger.reservations.find(row => row.attemptKey === input.attemptKey);
        if (existing && (existing.attemptId !== input.attemptId || existing.reservedMicrousd !== reservedMicrousd)) fail('MRZ_BUDGET_ATTEMPT_MISMATCH');
        const row = existing || {reservationId: reservationId(input.attemptId), attemptId: input.attemptId, attemptKey: input.attemptKey, policyFingerprint: input.policyFingerprint, reservedMicrousd};
        if (!existing) {
          const spent = ledger.history.spentMicrousd + ledger.reservations.reduce((sum, item) => sum + item.reservedMicrousd, 0);
          if (spent + reservedMicrousd > config.capMicrousd) fail('MRZ_BUDGET_CAP_EXCEEDED');
          commit({...ledger, sequence: ledger.sequence + 1, reservations: [...ledger.reservations, row]});
        }
        return Object.freeze({committed: true, reservationId: row.reservationId, reservedUsd: row.reservedMicrousd / MICROS, capUsd: config.capMicrousd / MICROS, existing: Boolean(existing)});
      });
    },
    settle(input) {
      return serial(() => {
        const ledger = checked(); validateBinding(input, config);
        const reservation = ledger.reservations.find(row => row.attemptId === input.attemptId);
        if (!reservation || reservation.attemptKey !== input.attemptKey || reservation.reservationId !== input.reservationId) fail('MRZ_BUDGET_RESERVATION_MISMATCH');
        if (!OUTCOMES.has(input.outcome) || typeof input.uncertain !== 'boolean' || input.outcome === 'timeout' && !input.uncertain) fail('MRZ_BUDGET_INVALID_SETTLEMENT');
        if (input.retainUsd !== undefined && input.retainUsd !== reservation.reservedMicrousd / MICROS) fail('MRZ_BUDGET_REFUND_FORBIDDEN');
        const code = 'MRZ_BUDGET_INVALID_SETTLEMENT', generationUsage = usage(input.generationUsage, code);
        const estimatedGenerationMicrousd = input.estimatedGenerationUsd === undefined || input.estimatedGenerationUsd === null ? null : usdMicros(input.estimatedGenerationUsd, reservation.reservedMicrousd, code, {zero: true});
        const countReserveMicrousd = input.countReserveUsd === undefined || input.countReserveUsd === null ? null : usdMicros(input.countReserveUsd, reservation.reservedMicrousd, code, {zero: true});
        if ((estimatedGenerationMicrousd ?? 0) + (countReserveMicrousd ?? 0) > reservation.reservedMicrousd || input.outcome === 'accepted' && (input.uncertain || generationUsage === null || estimatedGenerationMicrousd === null || countReserveMicrousd === null)) fail(code);
        const row = {reservationId: reservation.reservationId, attemptId: reservation.attemptId, outcome: input.outcome, uncertain: input.uncertain, retainedMicrousd: reservation.reservedMicrousd, generationUsage, estimatedGenerationMicrousd, countReserveMicrousd};
        const existing = ledger.settlements.find(item => item.attemptId === input.attemptId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(row)) fail('MRZ_BUDGET_SETTLEMENT_MISMATCH');
          return Object.freeze({committed: true, existing: true});
        }
        commit({...ledger, sequence: ledger.sequence + 1, settlements: [...ledger.settlements, row]});
        return Object.freeze({committed: true, existing: false});
      });
    },
    status() {
      const ledger = checked(), reserved = ledger.history.spentMicrousd + ledger.reservations.reduce((sum, row) => sum + row.reservedMicrousd, 0);
      return Object.freeze({capUsd: config.capMicrousd / MICROS, maxAttemptUsd: MAX_ATTEMPT_MICROS / MICROS, reservedUsd: reserved / MICROS, remainingUsd: (config.capMicrousd - reserved) / MICROS, reservations: ledger.reservations.length, settlements: ledger.settlements.length, historicalSpentUsd: ledger.history.spentMicrousd / MICROS, policyFingerprint: ledger.policyFingerprint, sequence: ledger.sequence, historyEvidenceSha256: ledger.history.evidenceSha256});
    },
    close() {
      if (pending !== 0) fail('MRZ_BUDGET_BUSY');
      if (!opened) return;
      opened = false;
      try { session.release(); } catch { poisoned = true; fail('MRZ_BUDGET_OWNERSHIP_LOST'); }
    },
  });
  return budget;
}

// Explicit offline operator entry point only. The application must never call it.
// Flags record a caller's approval/reconciliation attestation; they cannot prove
// owner identity, invoice accuracy or that the underlying mount is persistent.
function provisionDurableMrzBudgetOffline(options) {
  const config = configuration(options);
  if (options.ownerApproved !== true || options.historyReconciled !== true || !validHash(options.historyEvidenceSha256)) fail('MRZ_BUDGET_HISTORY_APPROVAL_REQUIRED');
  const spentMicrousd = usdMicros(options.historicalSpentUsd, config.capMicrousd, 'MRZ_BUDGET_INVALID_HISTORY', {exact: true});
  if (spentMicrousd < MIN_HISTORY_MICROS) fail('MRZ_BUDGET_INVALID_HISTORY');
  const ledger = {namespace: NAMESPACE, version: 1, ledgerId: crypto.randomBytes(32).toString('hex'), sequence: 1, policyFingerprint: config.policyFingerprint, capMicrousd: config.capMicrousd, maxAttemptMicrousd: MAX_ATTEMPT_MICROS, history: {reconciled: true, evidenceSha256: options.historyEvidenceSha256, spentMicrousd}, reservations: [], settlements: []};
  const session = ioSession(config);
  let acquired = false;
  try {
    session.acquire(); acquired = true; session.save(ledger, null);
    return Object.freeze({provisioned: true, capUsd: config.capMicrousd / MICROS, historicalSpentUsd: spentMicrousd / MICROS, policyFingerprint: config.policyFingerprint});
  } finally { if (acquired) session.release(); }
}

module.exports = {createDurableMrzBudget, provisionDurableMrzBudgetOffline, deriveAttemptId, DurableMrzBudgetError, NAMESPACE, MAX_ATTEMPT_USD: MAX_ATTEMPT_MICROS / MICROS, MIN_HISTORICAL_SPENT_USD: MIN_HISTORY_MICROS / MICROS};
