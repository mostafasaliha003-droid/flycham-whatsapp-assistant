'use strict';

const {createHash} = require('node:crypto');

// Evaluation-only lifetime allowance. No date resets, refunds, pruning or network.
// A compatible store must explicitly attest its synchronous, atomic durable save.
// This contract does not establish Render persistence or multi-process atomicity.
const NAMESPACE = 'visaMrzEvaluationBudget';
const CAP_USD = 1;
const MAX_ATTEMPT_USD = 0.12;
const MICROS = 1000000;
const CAP_MICROS = 1000000;
const MAX_ATTEMPT_MICROS = 120000;
const HASH = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set(['accepted', 'rejected', 'error', 'timeout']);
const gates = new WeakMap();

class VisaMrzBudgetError extends Error {
  constructor(code) { super(code); this.name = 'VisaMrzBudgetError'; this.code = code; }
}

function fail(code) { throw new VisaMrzBudgetError(code); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function keys(value, expected) { return plain(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(','); }
function validHash(value) { return typeof value === 'string' && HASH.test(value); }
function deriveAttemptId(attemptKey, policyFingerprint) {
  if (!validHash(attemptKey) || !validHash(policyFingerprint)) fail('MRZ_BUDGET_INVALID_BINDING');
  return hash(attemptKey + ':' + policyFingerprint);
}
function reservationId(attemptId) { return hash('visa-mrz-evaluation-reservation-v1:' + attemptId); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function usdMicros(value, max, code, {zero = false} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !zero && value === 0 || value > max / MICROS) fail(code);
  return Math.ceil(value * MICROS);
}
function usage(value, code) {
  if (value === null || value === undefined) return null;
  if (!keys(value, ['input_tokens', 'output_tokens', 'total_tokens']) || !Object.values(value).every(integer) || value.input_tokens + value.output_tokens !== value.total_tokens) fail(code);
  return {input_tokens: value.input_tokens, output_tokens: value.output_tokens, total_tokens: value.total_tokens};
}
function compatible(store) {
  const contract = store?.visaMrzBudgetStorage;
  return plain(store?.data) && typeof store.save === 'function' && store.save.constructor === Function &&
    keys(contract, ['version', 'durable', 'synchronous', 'atomic']) && contract.version === 1 &&
    contract.durable === true && contract.synchronous === true && contract.atomic === true;
}
function emptyLedger() { return {version: 1, capMicrousd: CAP_MICROS, maxAttemptMicrousd: MAX_ATTEMPT_MICROS, reservations: [], settlements: []}; }
function validateLedger(ledger) {
  const code = 'MRZ_BUDGET_INVALID_LEDGER';
  if (!keys(ledger, ['version', 'capMicrousd', 'maxAttemptMicrousd', 'reservations', 'settlements']) || ledger.version !== 1 || ledger.capMicrousd !== CAP_MICROS || ledger.maxAttemptMicrousd !== MAX_ATTEMPT_MICROS || !Array.isArray(ledger.reservations) || !Array.isArray(ledger.settlements)) fail(code);
  const attempts = new Map(), ids = new Set(), attemptKeys = new Set();
  let sum = 0;
  for (const row of ledger.reservations) {
    if (!keys(row, ['reservationId', 'attemptId', 'attemptKey', 'policyFingerprint', 'reservedMicrousd']) || !validHash(row.attemptKey) || !validHash(row.policyFingerprint) || row.attemptId !== deriveAttemptId(row.attemptKey, row.policyFingerprint) || row.reservationId !== reservationId(row.attemptId) || !integer(row.reservedMicrousd) || row.reservedMicrousd === 0 || row.reservedMicrousd > MAX_ATTEMPT_MICROS || attempts.has(row.attemptId) || ids.has(row.reservationId) || attemptKeys.has(row.attemptKey)) fail(code);
    attempts.set(row.attemptId, row); ids.add(row.reservationId); attemptKeys.add(row.attemptKey);
    sum += row.reservedMicrousd;
    if (!Number.isSafeInteger(sum) || sum > CAP_MICROS) fail(code);
  }
  const settled = new Set();
  for (const row of ledger.settlements) {
    if (!keys(row, ['reservationId', 'attemptId', 'outcome', 'uncertain', 'retainedMicrousd', 'generationUsage', 'estimatedGenerationMicrousd', 'countReserveMicrousd']) || !attempts.has(row.attemptId) || settled.has(row.attemptId)) fail(code);
    const reservation = attempts.get(row.attemptId);
    if (row.reservationId !== reservation.reservationId || !OUTCOMES.has(row.outcome) || typeof row.uncertain !== 'boolean' || row.retainedMicrousd !== reservation.reservedMicrousd || row.outcome === 'timeout' && !row.uncertain) fail(code);
    if (row.generationUsage === undefined) fail(code);
    usage(row.generationUsage, code);
    if (row.estimatedGenerationMicrousd !== null && (!integer(row.estimatedGenerationMicrousd) || row.estimatedGenerationMicrousd > reservation.reservedMicrousd)) fail(code);
    if (row.countReserveMicrousd !== null && (!integer(row.countReserveMicrousd) || row.countReserveMicrousd > reservation.reservedMicrousd)) fail(code);
    if ((row.estimatedGenerationMicrousd ?? 0) + (row.countReserveMicrousd ?? 0) > reservation.reservedMicrousd) fail(code);
    if (row.outcome === 'accepted' && (row.uncertain || row.generationUsage === null || row.estimatedGenerationMicrousd === null || row.countReserveMicrousd === null)) fail(code);
    settled.add(row.attemptId);
  }
  return ledger;
}
function read(store) {
  return Object.hasOwn(store.data, NAMESPACE) ? validateLedger(store.data[NAMESPACE]) : emptyLedger();
}
function gateFor(store) {
  let gate = gates.get(store);
  if (!gate) { gate = {tail: Promise.resolve(), poisoned: false}; gates.set(store, gate); }
  return gate;
}
function serialize(store, action) {
  if (!compatible(store)) return Promise.reject(new VisaMrzBudgetError('MRZ_BUDGET_NOT_DURABLE'));
  const gate = gateFor(store);
  const operation = gate.tail.then(() => {
    if (!compatible(store) || gate.poisoned) fail('MRZ_BUDGET_NOT_DURABLE');
    return action(gate);
  });
  gate.tail = operation.catch(() => {});
  return operation;
}
function commit(store, ledger, gate) {
  const previous = store.data;
  store.data = {...previous, [NAMESPACE]: ledger};
  try {
    const result = store.save();
    if (result !== undefined && result !== true) {
      // Neither an explicit failure nor an unsupported/async return confirms a
      // durable commit under this store contract.
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      throw new Error('STORE_COMMIT_NOT_CONFIRMED');
    }
  } catch {
    store.data = previous;
    // A thrown save may have renamed its file before throwing. Do not reuse this
    // process/store after ambiguous persistence; restoring memory is not a refund.
    gate.poisoned = true;
    fail('MRZ_BUDGET_SAVE_FAILED');
  }
}
function validateBinding(input) {
  if (!plain(input) || input.attemptId !== deriveAttemptId(input.attemptKey, input.policyFingerprint)) fail('MRZ_BUDGET_INVALID_BINDING');
}
function result(row, existing) {
  return Object.freeze({committed: true, reservationId: row.reservationId, reservedUsd: row.reservedMicrousd / MICROS, capUsd: CAP_USD, existing});
}

function createVisaMrzBudget({stateStore} = {}) {
  // Reading/validating existing history is allowed here; allocation and save are not.
  if (plain(stateStore?.data) && Object.hasOwn(stateStore.data, NAMESPACE)) read(stateStore);
  return Object.freeze({
    get durable() { return compatible(stateStore) && gates.get(stateStore)?.poisoned !== true; },
    reserve(input) {
      return serialize(stateStore, gate => {
        validateBinding(input);
        if (input.budgetCapUsd !== CAP_USD) fail('MRZ_BUDGET_CAP_MISMATCH');
        const reservedMicrousd = usdMicros(input.maxUsd, MAX_ATTEMPT_MICROS, 'MRZ_BUDGET_INVALID_AMOUNT');
        const ledger = read(stateStore);
        const existing = ledger.reservations.find(row => row.attemptKey === input.attemptKey);
        if (existing) {
          if (existing.attemptId !== input.attemptId || existing.policyFingerprint !== input.policyFingerprint || existing.reservedMicrousd !== reservedMicrousd) fail('MRZ_BUDGET_ATTEMPT_MISMATCH');
          return result(existing, true);
        }
        const charged = ledger.reservations.reduce((sum, row) => sum + row.reservedMicrousd, 0);
        if (charged + reservedMicrousd > CAP_MICROS) fail('MRZ_BUDGET_CAP_EXCEEDED');
        const row = {reservationId: reservationId(input.attemptId), attemptId: input.attemptId, attemptKey: input.attemptKey, policyFingerprint: input.policyFingerprint, reservedMicrousd};
        const next = {...ledger, reservations: [...ledger.reservations, row]};
        commit(stateStore, next, gate);
        return result(row, false);
      });
    },
    settle(input) {
      return serialize(stateStore, gate => {
        validateBinding(input);
        const ledger = read(stateStore);
        const reservation = ledger.reservations.find(row => row.attemptId === input.attemptId);
        if (!reservation || reservation.attemptKey !== input.attemptKey || reservation.policyFingerprint !== input.policyFingerprint || reservation.reservationId !== input.reservationId) fail('MRZ_BUDGET_RESERVATION_MISMATCH');
        if (!OUTCOMES.has(input.outcome) || typeof input.uncertain !== 'boolean' || input.outcome === 'timeout' && !input.uncertain) fail('MRZ_BUDGET_INVALID_SETTLEMENT');
        if (input.retainUsd !== undefined && input.retainUsd !== reservation.reservedMicrousd / MICROS) fail('MRZ_BUDGET_REFUND_FORBIDDEN');
        const generationUsage = usage(input.generationUsage, 'MRZ_BUDGET_INVALID_SETTLEMENT');
        const estimatedGenerationMicrousd = input.estimatedGenerationUsd === undefined || input.estimatedGenerationUsd === null ? null : usdMicros(input.estimatedGenerationUsd, reservation.reservedMicrousd, 'MRZ_BUDGET_INVALID_SETTLEMENT', {zero: true});
        const countReserveMicrousd = input.countReserveUsd === undefined || input.countReserveUsd === null ? null : usdMicros(input.countReserveUsd, reservation.reservedMicrousd, 'MRZ_BUDGET_INVALID_SETTLEMENT', {zero: true});
        if ((estimatedGenerationMicrousd ?? 0) + (countReserveMicrousd ?? 0) > reservation.reservedMicrousd) fail('MRZ_BUDGET_INVALID_SETTLEMENT');
        if (input.outcome === 'accepted' && (input.uncertain || generationUsage === null || estimatedGenerationMicrousd === null || countReserveMicrousd === null)) fail('MRZ_BUDGET_INVALID_SETTLEMENT');
        const row = {reservationId: reservation.reservationId, attemptId: reservation.attemptId, outcome: input.outcome, uncertain: input.uncertain, retainedMicrousd: reservation.reservedMicrousd, generationUsage, estimatedGenerationMicrousd, countReserveMicrousd};
        const existing = ledger.settlements.find(item => item.attemptId === input.attemptId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(row)) fail('MRZ_BUDGET_SETTLEMENT_MISMATCH');
          return Object.freeze({committed: true, existing: true});
        }
        commit(stateStore, {...ledger, settlements: [...ledger.settlements, row]}, gate);
        return Object.freeze({committed: true, existing: false});
      });
    },
    status() {
      if (!compatible(stateStore) || gates.get(stateStore)?.poisoned) fail('MRZ_BUDGET_NOT_DURABLE');
      const ledger = read(stateStore);
      const chargedMicrousd = ledger.reservations.reduce((sum, row) => sum + row.reservedMicrousd, 0);
      return Object.freeze({capUsd: CAP_USD, maxAttemptUsd: MAX_ATTEMPT_USD, reservedUsd: chargedMicrousd / MICROS, remainingUsd: (CAP_MICROS - chargedMicrousd) / MICROS, reservations: ledger.reservations.length, settlements: ledger.settlements.length});
    },
  });
}

module.exports = {createVisaMrzBudget, deriveAttemptId, VisaMrzBudgetError, NAMESPACE, CAP_USD, MAX_ATTEMPT_USD};
