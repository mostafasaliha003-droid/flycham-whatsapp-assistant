'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createVisaMrzBudget, deriveAttemptId, NAMESPACE} = require('../src/visa-mrz-budget');

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const policy = hash('synthetic-evaluation-policy');
const contract = () => ({version: 1, durable: true, synchronous: true, atomic: true});
function store(data = {historicalNamespace: {unchanged: ['existing-audit-event']}}) {
  return {
    data, persisted: clone(data), saves: 0, visaMrzBudgetStorage: contract(),
    save() { this.saves++; if (this.onSave) this.onSave(); this.persisted = clone(this.data); },
  };
}
function request(index, overrides = {}) {
  const attemptKey = hash('synthetic-attempt-' + index);
  return {attemptKey, policyFingerprint: policy, attemptId: deriveAttemptId(attemptKey, policy), maxUsd: 0.12, budgetCapUsd: 1, ...overrides};
}
function settlement(input, reserved, overrides = {}) {
  return {
    attemptId: input.attemptId, attemptKey: input.attemptKey, policyFingerprint: input.policyFingerprint,
    reservationId: reserved.reservationId, outcome: 'accepted', uncertain: false, retainUsd: 0.12,
    countReserveUsd: 0.03, generationUsage: {input_tokens: 100, output_tokens: 10, total_tokens: 110},
    estimatedGenerationUsd: 0.002, ...overrides,
  };
}

test('constructing a budget neither initializes a namespace nor saves or edits any historical state', async () => {
  const backing = store(), reference = backing.data, before = JSON.stringify(backing.data);
  const budget = createVisaMrzBudget({stateStore: backing});
  assert.equal(budget.durable, true);
  assert.equal(backing.data, reference); assert.equal(JSON.stringify(backing.data), before); assert.equal(backing.saves, 0);
  assert.equal(Object.hasOwn(backing.data, NAMESPACE), false);
  assert.deepEqual(budget.status(), {capUsd: 1, maxAttemptUsd: 0.12, reservedUsd: 0, remainingUsd: 1, reservations: 0, settlements: 0});
  assert.equal(JSON.stringify(backing.data), before); assert.equal(backing.saves, 0);
  await budget.reserve(request(1));
  const oldLedger = backing.data[NAMESPACE], old = JSON.stringify(backing.data);
  createVisaMrzBudget({stateStore: backing});
  assert.equal(backing.data[NAMESPACE], oldLedger); assert.equal(JSON.stringify(backing.data), old); assert.equal(backing.saves, 1);
});

test('memory-only, undeclared, asynchronous or incompatible stores never claim durability or receive a reservation', async () => {
  const cases = [undefined, {}, {data: {}, save() {}}, {...store(), visaMrzBudgetStorage: {...contract(), durable: false}}, {...store(), visaMrzBudgetStorage: {...contract(), synchronous: false}}, {...store(), visaMrzBudgetStorage: {...contract(), atomic: false}}, {...store(), visaMrzBudgetStorage: {...contract(), version: 2}}, {...store(), async save() { throw Error('must not call'); }}];
  for (const backing of cases) {
    const budget = createVisaMrzBudget({stateStore: backing});
    assert.equal(budget.durable, false);
    await assert.rejects(budget.reserve(request(1)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
    if (backing?.data) assert.equal(Object.hasOwn(backing.data, NAMESPACE), false);
  }
});

test('an existing unknown, corrupt or foreign ledger fails closed without migration, replacement or save', () => {
  for (const invalid of [undefined, null, [], {}, {version: 2}, {version: 1, capMicrousd: 1000000, maxAttemptMicrousd: 120000, reservations: [], settlements: [], privateField: 'NEVER_PERSIST'}]) {
    const backing = store({historicalNamespace: {event: 1}, [NAMESPACE]: invalid}), reference = backing.data;
    const before = JSON.stringify(backing.data);
    assert.throws(() => createVisaMrzBudget({stateStore: backing}), {code: 'MRZ_BUDGET_INVALID_LEDGER'});
    assert.equal(backing.data, reference); assert.equal(JSON.stringify(backing.data), before); assert.equal(backing.saves, 0);
  }
});

test('reserve commits a hash-only row before returning permission and leaves unrelated history byte-for-byte intact', async () => {
  const backing = store(), historical = backing.data.historicalNamespace, input = request(1);
  backing.onSave = function () { assert.equal(this.data[NAMESPACE].reservations.length, 1); };
  const budget = createVisaMrzBudget({stateStore: backing});
  const reserved = await budget.reserve({...input, rawImage: 'UNTRUSTED_IMAGE', secret: 'UNTRUSTED_SECRET', documentFields: {name: 'UNTRUSTED_NAME'}});
  assert.deepEqual(reserved, {committed: true, existing: false, reservationId: hash('visa-mrz-evaluation-reservation-v1:' + input.attemptId), reservedUsd: 0.12, capUsd: 1});
  assert.deepEqual(backing.persisted, backing.data); assert.equal(backing.saves, 1);
  assert.equal(backing.data.historicalNamespace, historical);
  assert.equal(JSON.stringify(backing.data).includes('UNTRUSTED'), false);
  assert.deepEqual(Object.keys(backing.data[NAMESPACE].reservations[0]).sort(), ['reservationId', 'attemptId', 'attemptKey', 'policyFingerprint', 'reservedMicrousd'].sort());
  assert.equal(Object.isFrozen(reserved), true);
});

test('durable reservation survives an actual atomic local file save and a fresh budget instance', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrz-budget-unit-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'synthetic-budget.json');
  const backing = {data: {}, visaMrzBudgetStorage: contract(), save() {
    const temporary = file + '.part';
    fs.writeFileSync(temporary, JSON.stringify(this.data), {mode: 0o600, flush: true});
    fs.renameSync(temporary, file);
    const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }};
  const input = request(1), first = await createVisaMrzBudget({stateStore: backing}).reserve(input);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted[NAMESPACE].reservations[0].reservationId, first.reservationId);
  const reopened = store(persisted), second = await createVisaMrzBudget({stateStore: reopened}).reserve(input);
  assert.equal(second.existing, true); assert.equal(reopened.saves, 0);
  assert.equal(fs.existsSync(file + '.part'), false);
});

test('a failed reservation save restores the exact prior memory object and poisons reuse of the uncertain store', async () => {
  const backing = store(), previous = backing.data;
  backing.onSave = () => { throw Error('PRIVATE_STORAGE_DETAIL'); };
  const budget = createVisaMrzBudget({stateStore: backing});
  await assert.rejects(budget.reserve(request(1)), error => error.code === 'MRZ_BUDGET_SAVE_FAILED' && !error.message.includes('PRIVATE'));
  assert.equal(backing.data, previous); assert.equal(Object.hasOwn(backing.data, NAMESPACE), false);
  assert.equal(budget.durable, false);
  backing.onSave = null;
  await assert.rejects(createVisaMrzBudget({stateStore: backing}).reserve(request(2)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
  assert.equal(backing.saves, 1);
});

test('a misleading synchronous contract returning a promise cannot authorize an attempt or silently become durable', async () => {
  const backing = store(), previous = backing.data;
  backing.save = function () { return Promise.reject(Error('synthetic-late-save-failure')); };
  const budget = createVisaMrzBudget({stateStore: backing});
  await assert.rejects(budget.reserve(request(1)), {code: 'MRZ_BUDGET_SAVE_FAILED'});
  await Promise.resolve();
  assert.equal(backing.data, previous); assert.equal(budget.durable, false);
});

test('false or unsupported save returns roll memory back and stop consumers before any provider call', async () => {
  for (const unsupported of [false, null, 0, '', {}, () => true]) {
    const backing = store(), previous = backing.data;
    backing.save = function () { this.saves++; return unsupported; };
    const budget = createVisaMrzBudget({stateStore: backing});
    let providerCalls = 0;
    const consumer = async () => { await budget.reserve(request(1)); providerCalls++; };
    await assert.rejects(consumer(), {code: 'MRZ_BUDGET_SAVE_FAILED'});
    assert.equal(providerCalls, 0); assert.equal(backing.data, previous); assert.equal(budget.durable, false);
    assert.equal(backing.saves, 1);
  }
  const backing = store(), save = backing.save;
  backing.save = function () { save.call(this); return true; };
  assert.equal((await createVisaMrzBudget({stateStore: backing}).reserve(request(1))).committed, true);
  assert.deepEqual(backing.persisted, backing.data);
});

test('duplicate concurrent attempts share one committed reservation and cannot authorize another API call', async () => {
  const backing = store(), first = createVisaMrzBudget({stateStore: backing}), second = createVisaMrzBudget({stateStore: backing});
  const results = await Promise.all([first.reserve(request(1)), second.reserve(request(1)), first.reserve(request(1))]);
  assert.deepEqual(results.map(row => row.existing), [false, true, true]);
  assert.equal(new Set(results.map(row => row.reservationId)).size, 1);
  assert.equal(backing.saves, 1); assert.equal(backing.data[NAMESPACE].reservations.length, 1);
});

test('operations from multiple budgets using the same store serialize at the lifetime cap', async () => {
  const backing = store(), a = createVisaMrzBudget({stateStore: backing}), b = createVisaMrzBudget({stateStore: backing});
  const results = await Promise.allSettled(Array.from({length: 12}, (_, i) => (i % 2 ? a : b).reserve(request(i))));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 8);
  for (const row of results.filter(row => row.status === 'rejected')) assert.equal(row.reason.code, 'MRZ_BUDGET_CAP_EXCEEDED');
  assert.equal(backing.saves, 8); assert.equal(a.status().reservedUsd, 0.96); assert.equal(a.status().remainingUsd, 0.04);
});

test('same attempt key cannot be reused under a changed policy, amount or cap', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1);
  await budget.reserve(input);
  const before = JSON.stringify(backing.data), otherPolicy = hash('changed-policy');
  await assert.rejects(budget.reserve({...input, policyFingerprint: otherPolicy, attemptId: deriveAttemptId(input.attemptKey, otherPolicy)}), {code: 'MRZ_BUDGET_ATTEMPT_MISMATCH'});
  await assert.rejects(budget.reserve({...input, maxUsd: 0.1}), {code: 'MRZ_BUDGET_ATTEMPT_MISMATCH'});
  await assert.rejects(budget.reserve({...input, budgetCapUsd: 2}), {code: 'MRZ_BUDGET_CAP_MISMATCH'});
  assert.equal(JSON.stringify(backing.data), before); assert.equal(backing.saves, 1);
});

test('unhashed identifiers, wrong deterministic bindings and invalid amounts are rejected without ledger changes', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing});
  for (const overrides of [{attemptKey: 'PRIVATE_DOCUMENT'}, {policyFingerprint: policy.toUpperCase()}, {attemptId: hash('wrong-binding')}]) await assert.rejects(budget.reserve(request(1, overrides)), {code: 'MRZ_BUDGET_INVALID_BINDING'});
  for (const maxUsd of [0, -0.01, 0.120001, 1, NaN, Infinity, '0.12']) await assert.rejects(budget.reserve(request(1, {maxUsd})), {code: 'MRZ_BUDGET_INVALID_AMOUNT'});
  assert.equal(backing.saves, 0); assert.equal(Object.hasOwn(backing.data, NAMESPACE), false);
});

test('accepted result settlement is persisted first with sanitized numeric usage and no provider payload', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  const committed = await budget.settle({...settlement(input, reserved), rawOutput: 'PRIVATE_OCR_OUTPUT', reasonCode: 'PRIVATE_REASON', request: {image: 'PRIVATE_IMAGE'}});
  assert.deepEqual(committed, {committed: true, existing: false});
  assert.equal(backing.saves, 2); assert.deepEqual(backing.persisted, backing.data);
  const row = backing.data[NAMESPACE].settlements[0];
  assert.equal(row.outcome, 'accepted'); assert.equal(row.retainedMicrousd, 120000);
  assert.equal(row.countReserveMicrousd, 30000); assert.equal(row.estimatedGenerationMicrousd, 2000);
  assert.deepEqual(row.generationUsage, {input_tokens: 100, output_tokens: 10, total_tokens: 110});
  assert.equal(JSON.stringify(row).includes('PRIVATE'), false);
  assert.equal(budget.status().reservedUsd, 0.12);
});

test('settlement save failure preserves the committed reservation and denies acceptance without overwriting history', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  const before = backing.data, persistedBefore = clone(backing.persisted);
  backing.onSave = () => { throw Error('synthetic-settle-save-failure'); };
  await assert.rejects(budget.settle(settlement(input, reserved)), {code: 'MRZ_BUDGET_SAVE_FAILED'});
  assert.equal(backing.data, before); assert.deepEqual(backing.persisted, persistedBefore);
  assert.equal(backing.data[NAMESPACE].reservations[0].reservedMicrousd, 120000);
  assert.equal(backing.data[NAMESPACE].settlements.length, 0); assert.equal(budget.durable, false);
});

test('uncertain timeouts permanently retain the full reserve and cannot later be refunded or relabelled accepted', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  const timeout = settlement(input, reserved, {outcome: 'timeout', uncertain: true, generationUsage: null, estimatedGenerationUsd: null});
  await budget.settle(timeout);
  const before = JSON.stringify(backing.data);
  await assert.rejects(budget.settle({...timeout, retainUsd: 0}), {code: 'MRZ_BUDGET_REFUND_FORBIDDEN'});
  await assert.rejects(budget.settle(settlement(input, reserved)), {code: 'MRZ_BUDGET_SETTLEMENT_MISMATCH'});
  assert.equal(JSON.stringify(backing.data), before); assert.equal((await budget.reserve(input)).existing, true);
  for (let i = 2; i <= 8; i++) await budget.reserve(request(i));
  await assert.rejects(budget.reserve(request(9)), {code: 'MRZ_BUDGET_CAP_EXCEEDED'});
  const reopened = createVisaMrzBudget({stateStore: store(clone(backing.persisted))});
  await assert.rejects(reopened.reserve(request(9)), {code: 'MRZ_BUDGET_CAP_EXCEEDED'});
  assert.equal(reopened.status().reservedUsd, 0.96);
});

test('known low generation cost does not release lifetime allowance or edit any prior reservation/settlement row', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  await budget.settle(settlement(input, reserved, {estimatedGenerationUsd: 0}));
  const oldReservations = backing.data[NAMESPACE].reservations, oldSettlements = backing.data[NAMESPACE].settlements;
  const oldRow = JSON.stringify(oldReservations[0]), oldSettled = JSON.stringify(oldSettlements[0]);
  await budget.reserve(request(2));
  assert.equal(JSON.stringify(oldReservations[0]), oldRow); assert.equal(JSON.stringify(oldSettlements[0]), oldSettled);
  assert.equal(oldReservations.length, 1); assert.equal(oldSettlements.length, 1);
  assert.equal(budget.status().reservedUsd, 0.24);
});

test('identical settlement is idempotent, while a conflicting retry cannot replace its immutable record', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input), final = settlement(input, reserved);
  await budget.settle(final);
  const before = JSON.stringify(backing.data), saves = backing.saves;
  assert.deepEqual(await budget.settle(final), {committed: true, existing: true});
  await assert.rejects(budget.settle({...final, outcome: 'rejected'}), {code: 'MRZ_BUDGET_SETTLEMENT_MISMATCH'});
  await assert.rejects(budget.settle({...final, countReserveUsd: 0.02}), {code: 'MRZ_BUDGET_SETTLEMENT_MISMATCH'});
  assert.equal(backing.saves, saves); assert.equal(JSON.stringify(backing.data), before);
});

test('settlement enforces reservation binding and cannot create an unreserved attempt', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  const before = JSON.stringify(backing.data);
  await assert.rejects(budget.settle(settlement(request(2), reserved)), {code: 'MRZ_BUDGET_RESERVATION_MISMATCH'});
  await assert.rejects(budget.settle({...settlement(input, reserved), reservationId: hash('another-reservation')}), {code: 'MRZ_BUDGET_RESERVATION_MISMATCH'});
  assert.equal(JSON.stringify(backing.data), before); assert.equal(backing.saves, 1);
});

test('accepted settlement requires known bounded cost and valid token arithmetic; malformed usage never reaches ledger', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  const invalid = [
    {uncertain: true}, {generationUsage: null}, {estimatedGenerationUsd: null}, {estimatedGenerationUsd: 0.121},
    {countReserveUsd: null}, {countReserveUsd: -0.01}, {countReserveUsd: 0.121},
    {countReserveUsd: NaN}, {estimatedGenerationUsd: 0.1, countReserveUsd: 0.03},
    {estimatedGenerationUsd: NaN}, {outcome: 'PRIVATE_UNKNOWN'}, {uncertain: 'false'},
    {generationUsage: {input_tokens: 100, output_tokens: 10, total_tokens: 100}},
    {generationUsage: {input_tokens: -1, output_tokens: 10, total_tokens: 9}},
    {generationUsage: {input_tokens: 1.5, output_tokens: 10, total_tokens: 11.5}},
    {generationUsage: {input_tokens: 100, output_tokens: 10, total_tokens: 110, privateDocument: 'PRIVATE_FIELD'}},
    {outcome: 'timeout', uncertain: false},
  ];
  for (const overrides of invalid) await assert.rejects(budget.settle(settlement(input, reserved, overrides)), {code: 'MRZ_BUDGET_INVALID_SETTLEMENT'});
  assert.equal(backing.saves, 1); assert.equal(backing.data[NAMESPACE].settlements.length, 0);
});

test('unknown count usage is stored as null while the permanent maximum remains charged; cost history is checked on reload', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  await budget.settle(settlement(input, reserved, {outcome: 'error', uncertain: true, generationUsage: null, estimatedGenerationUsd: null, countReserveUsd: null}));
  const row = backing.data[NAMESPACE].settlements[0];
  assert.equal(row.countReserveMicrousd, null); assert.equal(row.retainedMicrousd, 120000);
  const prior = JSON.stringify(backing.data);
  createVisaMrzBudget({stateStore: backing});
  assert.equal(JSON.stringify(backing.data), prior); assert.equal(backing.saves, 2);
  for (const mutate of [
    item => { item.countReserveMicrousd = -1; },
    item => { item.countReserveMicrousd = 120001; },
    item => { item.countReserveMicrousd = 30000; item.estimatedGenerationMicrousd = 100000; },
    item => { delete item.countReserveMicrousd; },
  ]) {
    const invalid = clone(backing.data); mutate(invalid[NAMESPACE].settlements[0]);
    assert.throws(() => createVisaMrzBudget({stateStore: store(invalid)}), {code: 'MRZ_BUDGET_INVALID_LEDGER'});
  }
});

test('corrupt persisted ledger rows fail closed without silent repair, migration or sensitive-field retention', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing});
  await budget.reserve(request(1));
  const canonical = clone(backing.data);
  const mutations = [
    data => { data[NAMESPACE].capMicrousd = 2000000; },
    data => { data[NAMESPACE].reservations[0].reservedMicrousd = 0; },
    data => { data[NAMESPACE].reservations[0].privateText = 'PRIVATE_FIELD'; },
    data => { data[NAMESPACE].reservations.push(clone(data[NAMESPACE].reservations[0])); },
    data => { data[NAMESPACE].settlements.push({reservationId: hash('unknown')}); },
  ];
  for (const mutate of mutations) {
    const data = clone(canonical); mutate(data); const invalid = store(data), before = JSON.stringify(data);
    assert.throws(() => createVisaMrzBudget({stateStore: invalid}), {code: 'MRZ_BUDGET_INVALID_LEDGER'});
    assert.equal(JSON.stringify(invalid.data), before); assert.equal(invalid.saves, 0);
  }
});

test('fractional generation estimates are rounded upward and never create negative or floating reserve balances', async () => {
  const backing = store(), budget = createVisaMrzBudget({stateStore: backing}), input = request(1), reserved = await budget.reserve(input);
  await budget.settle(settlement(input, reserved, {estimatedGenerationUsd: 0.0000001}));
  assert.equal(backing.data[NAMESPACE].settlements[0].estimatedGenerationMicrousd, 1);
  assert.equal(budget.status().reservedUsd, 0.12); assert.equal(budget.status().remainingUsd, 0.88);
});
