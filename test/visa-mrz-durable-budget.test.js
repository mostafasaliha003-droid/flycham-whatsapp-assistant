'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {
  createDurableMrzBudget, provisionDurableMrzBudgetOffline, deriveAttemptId, NAMESPACE,
} = require('../src/visa-mrz-durable-budget');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const POLICY = hash('synthetic-production-policy'), EVIDENCE = hash('synthetic-eight-evaluation-attempt-reconciliation');
const KEY = 'synthetic-durable-budget-state-key-only';
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrz-durable-budget-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const config = {file: path.join(directory, 'budget.enc'), key: KEY, policyFingerprint: POLICY, capUsd: 2, persistentStateConfirmed: true, ...overrides};
  return {directory, config, provision(extra = {}) { return provisionDurableMrzBudgetOffline({...config, ownerApproved: true, historyReconciled: true, historyEvidenceSha256: EVIDENCE, historicalSpentUsd: 0.96, ...extra}); }};
}
function request(number, overrides = {}) {
  const attemptKey = hash('synthetic-attempt:' + number);
  return {attemptKey, policyFingerprint: POLICY, attemptId: deriveAttemptId(attemptKey, POLICY), maxUsd: 0.12, budgetCapUsd: 2, ...overrides};
}
function settlement(input, reservation, overrides = {}) {
  return {...input, reservationId: reservation.reservationId, retainUsd: 0.12, outcome: 'accepted', uncertain: false, generationUsage: {input_tokens: 100, output_tokens: 20, total_tokens: 120}, estimatedGenerationUsd: 0.01, countReserveUsd: 0.005, ...overrides};
}
async function opened(t, config) {
  const budget = createDurableMrzBudget(config); await budget.open();
  t.after(() => { try { budget.close(); } catch {} }); return budget;
}
function child(config) {
  const script = `
    const {createDurableMrzBudget} = require(process.argv[1]);
    const config = JSON.parse(process.argv[2]);
    const budget = createDurableMrzBudget(config);
    budget.open().then(() => {
      process.send({opened:true});
      process.on('message', message => {
        if (message === 'close') { budget.close(); process.exit(0); }
        else if (message && message.reserve) budget.reserve(message.reserve).then(reservation => process.send({reservation}), error => process.send({code:error.code}));
      });
    }, error => { process.send({code:error.code}); process.exitCode = 0; process.disconnect(); });
  `;
  return spawn(process.execPath, ['-e', script, path.resolve(__dirname, '../src/visa-mrz-durable-budget.js'), JSON.stringify(config)], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
}

test('construction is side-effect-free; persistent state, key, cap and existing history are mandatory', async t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.directory);
  const budget = createDurableMrzBudget(f.config);
  assert.equal(budget.durable, false); assert.deepEqual(fs.readdirSync(f.directory), before);
  assert.throws(() => createDurableMrzBudget({...f.config, persistentStateConfirmed: false}), {code: 'MRZ_BUDGET_PERSISTENCE_UNCONFIRMED'});
  for (const capUsd of [undefined, 0, 1e-14, NaN, Infinity, 1000.000001, '2', 0.1234567]) assert.throws(() => createDurableMrzBudget({...f.config, capUsd}), {code: 'MRZ_BUDGET_INVALID_CAP'});
  assert.throws(() => createDurableMrzBudget({...f.config, key: undefined}), {code: 'MRZ_BUDGET_KEY_REQUIRED'});
  await assert.rejects(budget.open(), {code: 'MRZ_BUDGET_LEDGER_MISSING'});
  assert.equal(budget.durable, false); assert.deepEqual(fs.readdirSync(f.directory), before);
  await assert.rejects(budget.reserve(request(1)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
  assert.equal(fs.existsSync(f.config.file), false);
});

test('offline provisioning requires explicit reconciled conservative history and never overwrites', async t => {
  const f = fixture(t);
  for (const extra of [{ownerApproved: false}, {historyReconciled: false}, {historyEvidenceSha256: undefined}]) assert.throws(() => f.provision(extra), {code: 'MRZ_BUDGET_HISTORY_APPROVAL_REQUIRED'});
  for (const historicalSpentUsd of [undefined, 0, 0.95, -1, 2.01, 0.9600001]) assert.throws(() => f.provision({historicalSpentUsd}), {code: 'MRZ_BUDGET_INVALID_HISTORY'});
  assert.deepEqual(fs.readdirSync(f.directory), []);
  f.provision(); const bytes = fs.readFileSync(f.config.file);
  assert.equal(bytes.includes(Buffer.from(KEY)), false); assert.equal(bytes.includes(Buffer.from(EVIDENCE)), false);
  assert.equal(bytes.includes(Buffer.from('reservations')), false);
  assert.equal(fs.statSync(f.config.file).mode & 0o777, 0o600);
  const anchor = fs.readFileSync(f.config.file + '.anchor');
  assert.equal(anchor.includes(Buffer.from(EVIDENCE)), false); assert.equal(anchor.includes(Buffer.from('ledgerCiphertextSha256')), false);
  assert.equal(fs.statSync(f.config.file + '.anchor').mode & 0o777, 0o600);
  assert.throws(() => f.provision(), {code: 'MRZ_BUDGET_ALREADY_EXISTS'});
  assert.deepEqual(fs.readFileSync(f.config.file), bytes);
  const budget = await opened(t, f.config);
  assert.equal(budget.status().historicalSpentUsd, 0.96); assert.equal(budget.status().reservations, 0);
  assert.equal(budget.status().reservedUsd, 0.96); assert.equal(budget.status().remainingUsd, 1.04);
  assert.throws(() => f.provision(), {code: 'MRZ_BUDGET_LOCKED'});
});

test('historical spend permanently consumes cap including cap with no remaining allowance', async t => {
  const f = fixture(t, {capUsd: 0.96}); f.provision(); const budget = await opened(t, f.config);
  assert.equal(budget.status().remainingUsd, 0);
  await assert.rejects(budget.reserve(request(1, {budgetCapUsd: 0.96})), {code: 'MRZ_BUDGET_CAP_EXCEEDED'});
  assert.equal(budget.status().reservedUsd, 0.96);
});

test('reservations are atomic, serialized, replay-idempotent and retained across restart and clock changes', async t => {
  const f = fixture(t); f.provision(); let now = 1;
  const budget = await opened(t, {...f.config, now: () => now});
  const results = await Promise.all(Array.from({length: 20}, (_, i) => budget.reserve(request(i)).then(value => ({value}), error => ({error}))));
  assert.equal(results.filter(row => row.value).length, 8);
  assert.equal(results.filter(row => row.error?.code === 'MRZ_BUDGET_CAP_EXCEEDED').length, 12);
  assert.equal(budget.status().reservedUsd, 1.92); assert.equal(budget.status().remainingUsd, 0.08);
  const first = await budget.reserve(request(0)); assert.equal(first.existing, true);
  assert.equal(first.committed, true); assert.equal(first.reservedUsd, 0.12); assert.equal(first.capUsd, 2);
  await assert.rejects(budget.reserve(request(0, {maxUsd: 0.1})), {code: 'MRZ_BUDGET_ATTEMPT_MISMATCH'});
  await assert.rejects(budget.reserve(request(0, {budgetCapUsd: 3})), {code: 'MRZ_BUDGET_CAP_MISMATCH'});
  const other = hash('synthetic-other-policy');
  await assert.rejects(budget.reserve(request(0, {policyFingerprint: other, attemptId: deriveAttemptId(request(0).attemptKey, other)})), {code: 'MRZ_BUDGET_POLICY_MISMATCH'});
  now = Number.MAX_SAFE_INTEGER; assert.equal(budget.status().remainingUsd, 0.08);
  budget.close(); assert.equal(budget.durable, false);
  const reopened = await opened(t, f.config);
  assert.equal(reopened.status().reservedUsd, 1.92); assert.equal((await reopened.reserve(request(0))).existing, true);
  await assert.rejects(reopened.reserve(request(100)), {code: 'MRZ_BUDGET_CAP_EXCEEDED'});
});

test('all outcomes retain full reservation; settlements are exact-idempotent and cannot refund', async t => {
  const f = fixture(t); f.provision(); const budget = await opened(t, f.config);
  for (const [index, outcome] of ['accepted', 'rejected', 'error', 'timeout'].entries()) {
    const input = request(index), reservation = await budget.reserve(input);
    const final = settlement(input, reservation, outcome === 'accepted' ? {} : {outcome, uncertain: true, generationUsage: null, estimatedGenerationUsd: null, countReserveUsd: null});
    assert.deepEqual(await budget.settle(final), {committed: true, existing: false});
    assert.deepEqual(await budget.settle(final), {committed: true, existing: true});
    await assert.rejects(budget.settle({...final, retainUsd: 0}), {code: 'MRZ_BUDGET_REFUND_FORBIDDEN'});
    await assert.rejects(budget.settle({...final, outcome: outcome === 'accepted' ? 'rejected' : 'error', uncertain: !final.uncertain}), {code: 'MRZ_BUDGET_SETTLEMENT_MISMATCH'});
    assert.equal((await budget.reserve(input)).existing, true);
  }
  assert.equal(budget.status().reservedUsd, 1.44); assert.equal(budget.status().settlements, 4);
  assert.equal(budget.status().sequence, 9);
});

test('invalid bindings, reservation amounts, usage and accepted/timeout settlements fail closed', async t => {
  const f = fixture(t); f.provision(); const budget = await opened(t, f.config);
  for (const overrides of [{attemptKey: 'private-document'}, {attemptId: hash('wrong')}, {policyFingerprint: POLICY.toUpperCase()}]) await assert.rejects(budget.reserve(request(1, overrides)), {code: 'MRZ_BUDGET_INVALID_BINDING'});
  for (const maxUsd of [0, -1, 0.120001, '0.12', NaN, Infinity]) await assert.rejects(budget.reserve(request(1, {maxUsd})), {code: 'MRZ_BUDGET_INVALID_AMOUNT'});
  const input = request(1), reservation = await budget.reserve(input), good = settlement(input, reservation);
  for (const extra of [{outcome: 'timeout', uncertain: false}, {outcome: 'accepted', uncertain: true}, {generationUsage: null}, {generationUsage: {input_tokens: 1, output_tokens: 1, total_tokens: 3}}, {estimatedGenerationUsd: 0.12, countReserveUsd: 0.01}]) await assert.rejects(budget.settle({...good, ...extra}), {code: 'MRZ_BUDGET_INVALID_SETTLEMENT'});
  await assert.rejects(budget.settle({...good, reservationId: hash('wrong')}), {code: 'MRZ_BUDGET_RESERVATION_MISMATCH'});
  assert.equal(budget.status().reservedUsd, 1.08); assert.equal(budget.status().settlements, 0);
});

test('close refuses queued operations, and a new process cannot share an owned ledger', async t => {
  const f = fixture(t); f.provision(); const budget = createDurableMrzBudget(f.config);
  const opening = budget.open(); assert.throws(() => budget.close(), {code: 'MRZ_BUDGET_BUSY'}); await opening;
  t.after(() => { try { budget.close(); } catch {} });
  const operation = budget.reserve(request(1)); assert.throws(() => budget.close(), {code: 'MRZ_BUDGET_BUSY'}); await operation;
  const competitor = child(f.config); t.after(() => competitor.kill());
  const result = await once(competitor, 'message'); assert.deepEqual(result[0], {code: 'MRZ_BUDGET_LOCKED'});
  assert.equal(budget.durable, true);
});

test('separate process lifetime lock releases only on orderly close; killed owners leave a blocking lock', async t => {
  const f = fixture(t); f.provision(); const owner = child(f.config); t.after(() => owner.kill());
  assert.deepEqual((await once(owner, 'message'))[0], {opened: true});
  const contender = createDurableMrzBudget(f.config);
  await assert.rejects(contender.open(), {code: 'MRZ_BUDGET_LOCKED'});
  const ownerExit = once(owner, 'exit'); owner.send('close'); await ownerExit;
  const next = child(f.config); t.after(() => next.kill()); assert.deepEqual((await once(next, 'message'))[0], {opened: true});
  const killed = once(next, 'exit'); next.kill('SIGKILL'); await killed;
  const stale = fs.readFileSync(f.config.file + '.lock');
  await assert.rejects(createDurableMrzBudget(f.config).open(), {code: 'MRZ_BUDGET_LOCKED'});
  assert.deepEqual(fs.readFileSync(f.config.file + '.lock'), stale);
});

test('corruption, wrong key, policy/cap mismatch and missing ledger never create allowance', async t => {
  const f = fixture(t); f.provision(); const bytes = fs.readFileSync(f.config.file);
  for (const extra of [{key: 'synthetic-wrong-key'}, {policyFingerprint: hash('other')}, {capUsd: 3}]) await assert.rejects(createDurableMrzBudget({...f.config, ...extra}).open(), {code: 'MRZ_BUDGET_INVALID_LEDGER'});
  const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1; fs.writeFileSync(f.config.file, corrupted);
  await assert.rejects(createDurableMrzBudget(f.config).open(), {code: 'MRZ_BUDGET_INVALID_LEDGER'});
  assert.deepEqual(fs.readFileSync(f.config.file), corrupted);
  fs.unlinkSync(f.config.file);
  await assert.rejects(createDurableMrzBudget(f.config).open(), {code: 'MRZ_BUDGET_LEDGER_MISSING'});
  assert.equal(fs.existsSync(f.config.file), false);
});

test('lock symlinks and ledger symlinks are refused without modifying their targets', async t => {
  const f = fixture(t); f.provision(); const target = path.join(f.directory, 'target'); fs.writeFileSync(target, 'synthetic untouched');
  fs.symlinkSync(target, f.config.file + '.lock');
  await assert.rejects(createDurableMrzBudget(f.config).open(), {code: 'MRZ_BUDGET_LOCKED'});
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic untouched'); fs.unlinkSync(f.config.file + '.lock');
  fs.unlinkSync(f.config.file); fs.symlinkSync(target, f.config.file);
  await assert.rejects(createDurableMrzBudget(f.config).open(), {code: 'MRZ_BUDGET_OPEN_FAILED'});
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic untouched');
});

test('loss or replacement of lock inode/token poisons the owner and never removes the replacement', async t => {
  for (const kind of ['replace', 'token', 'delete']) {
    const f = fixture(t); f.provision(); const budget = await opened(t, f.config), lock = f.config.file + '.lock';
    if (kind === 'replace') { const replacement = lock + '.replacement'; fs.writeFileSync(replacement, fs.readFileSync(lock), {mode: 0o600}); fs.renameSync(replacement, lock); }
    else if (kind === 'token') fs.writeFileSync(lock, '{}', {mode: 0o600});
    else fs.unlinkSync(lock);
    assert.equal(budget.durable, false);
    await assert.rejects(budget.reserve(request(1)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
    assert.throws(() => budget.close(), {code: 'MRZ_BUDGET_OWNERSHIP_LOST'});
    assert.equal(fs.existsSync(lock), kind !== 'delete');
  }
});

test('valid prior ciphertext replay and external ledger deletion/replacement poison an open owner', async t => {
  for (const kind of ['replay', 'delete', 'same-bytes-new-inode']) {
    const f = fixture(t); f.provision(); const before = fs.readFileSync(f.config.file), budget = await opened(t, f.config);
    await budget.reserve(request(1));
    if (kind === 'replay') fs.writeFileSync(f.config.file, before);
    else if (kind === 'delete') fs.unlinkSync(f.config.file);
    else { const replacement = f.config.file + '.replacement'; fs.writeFileSync(replacement, fs.readFileSync(f.config.file), {mode: 0o600}); fs.renameSync(replacement, f.config.file); }
    assert.equal(budget.durable, false); assert.throws(() => budget.status(), {code: 'MRZ_BUDGET_NOT_DURABLE'});
    await assert.rejects(budget.reserve(request(2)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
  }
});

test('actual process restart rejects restoring only the old ledger or only the old anchor', async t => {
  for (const restored of ['ledger', 'anchor']) {
    const f = fixture(t); f.provision();
    const oldLedger = fs.readFileSync(f.config.file), oldAnchor = fs.readFileSync(f.config.file + '.anchor');
    const writer = child(f.config); t.after(() => writer.kill());
    assert.deepEqual((await once(writer, 'message'))[0], {opened: true});
    const reserved = once(writer, 'message'); writer.send({reserve: request(1)});
    assert.equal((await reserved)[0].reservation.committed, true);
    const exited = once(writer, 'exit'); writer.send('close'); await exited;
    fs.writeFileSync(restored === 'ledger' ? f.config.file : f.config.file + '.anchor', restored === 'ledger' ? oldLedger : oldAnchor);
    const restarted = child(f.config); t.after(() => restarted.kill());
    assert.deepEqual((await once(restarted, 'message'))[0], {code: 'MRZ_BUDGET_ANCHOR_MISMATCH'});
    assert.throws(() => f.provision(), {code: 'MRZ_BUDGET_ALREADY_EXISTS'});
  }
});

test('missing, corrupt or foreign anchors fail closed and partial pairs are never reprovisioned', async t => {
  for (const kind of ['missing-ledger', 'missing-anchor', 'corrupt-anchor', 'foreign-anchor']) {
    const f = fixture(t); f.provision(); const file = kind === 'missing-ledger' ? f.config.file : f.config.file + '.anchor';
    if (kind.startsWith('missing')) fs.unlinkSync(file);
    else if (kind === 'corrupt-anchor') { const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes); }
    else { const other = fixture(t); other.provision(); fs.writeFileSync(file, fs.readFileSync(other.config.file + '.anchor')); }
    const before = new Map(fs.readdirSync(f.directory).map(name => [name, fs.readFileSync(path.join(f.directory, name))]));
    const budget = createDurableMrzBudget(f.config);
    const code = kind === 'missing-ledger' ? 'MRZ_BUDGET_LEDGER_MISSING' : kind === 'missing-anchor' ? 'MRZ_BUDGET_ANCHOR_MISSING' : kind === 'corrupt-anchor' ? 'MRZ_BUDGET_INVALID_ANCHOR' : 'MRZ_BUDGET_ANCHOR_MISMATCH';
    await assert.rejects(budget.open(), {code}); assert.equal(budget.durable, false);
    await assert.rejects(budget.reserve(request(1)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
    assert.throws(() => f.provision(), {code: 'MRZ_BUDGET_ALREADY_EXISTS'});
    assert.deepEqual(fs.readdirSync(f.directory), [...before.keys()]);
    for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.directory, name)), bytes);
  }
});

test('anchor deletion, corruption, replacement and symlinks poison an open owner', async t => {
  for (const kind of ['delete', 'corrupt', 'replace', 'symlink']) {
    const f = fixture(t); f.provision(); const budget = await opened(t, f.config), file = f.config.file + '.anchor';
    if (kind === 'delete') fs.unlinkSync(file);
    else if (kind === 'corrupt') { const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes); }
    else if (kind === 'replace') { const replacement = file + '.replacement'; fs.writeFileSync(replacement, fs.readFileSync(file), {mode: 0o600}); fs.renameSync(replacement, file); }
    else { fs.unlinkSync(file); fs.symlinkSync(f.config.file, file); }
    assert.equal(budget.durable, false);
    await assert.rejects(budget.reserve(request(1)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
  }
});

test('failures around every durable two-file step never authorize work and poison the instance', async t => {
  for (const stage of ['ledger-write', 'ledger-fsync', 'anchor-write', 'anchor-fsync', 'ledger-rename-before', 'ledger-rename-after', 'first-directory-fsync', 'ledger-readback', 'anchor-rename-before', 'anchor-rename-after', 'second-directory-fsync', 'final-ledger-readback', 'final-anchor-readback']) {
    const f = fixture(t); f.provision(); let enabled = false, publications = 0, fired = false;
    const files = new Map();
    const fault = () => { fired = true; throw Error('synthetic injected ' + stage); };
    const temporaryKind = fd => {
      const name = String(files.get(fd));
      return !name.endsWith('.tmp') ? null : name.startsWith(f.config.file + '.anchor.') ? 'anchor' : 'ledger';
    };
    const injected = new Proxy(fs, {get(target, name) {
      if (name === 'openSync') return (...args) => { const fd = fs.openSync(...args); files.set(fd, args[0]); return fd; };
      if (name === 'closeSync') return fd => { files.delete(fd); return fs.closeSync(fd); };
      if (name === 'writeSync') return (...args) => { if (enabled && !fired && stage === temporaryKind(args[0]) + '-write') fault(); return fs.writeSync(...args); };
      if (name === 'fsyncSync') return fd => {
        if (enabled && !fired && stage === temporaryKind(fd) + '-fsync') fault();
        if (enabled && !fired && files.get(fd) === f.directory && ((stage === 'first-directory-fsync' && publications === 1) || (stage === 'second-directory-fsync' && publications === 2))) fault();
        return fs.fsyncSync(fd);
      };
      if (name === 'renameSync') return (...args) => {
        const kind = args[1] === f.config.file ? 'ledger' : 'anchor';
        if (enabled && !fired && stage === kind + '-rename-before') fault();
        const result = fs.renameSync(...args); publications++;
        if (enabled && !fired && stage === kind + '-rename-after') fault();
        return result;
      };
      if (name === 'readFileSync') return (...args) => {
        const file = files.get(args[0]);
        if (enabled && !fired && ((stage === 'ledger-readback' && publications === 1 && file === f.config.file) || (stage === 'final-ledger-readback' && publications === 2 && file === f.config.file) || (stage === 'final-anchor-readback' && publications === 2 && file === f.config.file + '.anchor'))) fault();
        return fs.readFileSync(...args);
      };
      return target[name];
    }});
    const budget = await opened(t, {...f.config, fsImpl: injected}); enabled = true;
    let providerCalls = 0;
    await assert.rejects((async () => { await budget.reserve(request(1)); providerCalls++; })(), {code: 'MRZ_BUDGET_SAVE_FAILED'});
    assert.equal(fired, true); assert.equal(providerCalls, 0); assert.equal(budget.durable, false);
    await assert.rejects(budget.reserve(request(2)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
    budget.close();
    if (publications === 1) {
      await assert.rejects(createDurableMrzBudget(f.config).open(), {code: 'MRZ_BUDGET_ANCHOR_MISMATCH'});
      assert.throws(() => f.provision(), {code: 'MRZ_BUDGET_ALREADY_EXISTS'});
    } else {
      const restarted = await opened(t, f.config);
      assert.equal(restarted.status().reservedUsd, publications === 2 ? 1.08 : 0.96);
      if (publications === 2) assert.equal((await restarted.reserve(request(1))).existing, true);
    }
  }
});

test('acquisition failures close descriptors and leave partial locks for explicit offline recovery', t => {
  for (const failedFstat of [1, 3]) {
    const f = fixture(t), descriptors = new Set(); let fstats = 0;
    const injected = new Proxy(fs, {get(target, name) {
      if (name === 'openSync') return (...args) => { const fd = fs.openSync(...args); descriptors.add(fd); return fd; };
      if (name === 'closeSync') return fd => { descriptors.delete(fd); return fs.closeSync(fd); };
      if (name === 'fstatSync') return (...args) => { if (++fstats === failedFstat) throw Error('synthetic acquire failure'); return fs.fstatSync(...args); };
      return target[name];
    }});
    assert.throws(() => f.provision({fsImpl: injected}), /synthetic acquire failure/);
    assert.equal(descriptors.size, 0); assert.equal(fs.existsSync(f.config.file), false);
    assert.equal(fs.existsSync(f.config.file + '.lock'), failedFstat === 3);
    if (failedFstat === 3) assert.throws(() => f.provision(), {code: 'MRZ_BUDGET_LOCKED'});
  }
});

test('offline provisioning retains incomplete publications and refuses to overwrite their history', async t => {
  for (const stage of ['ledger-link-after', 'ledger-directory-fsync', 'anchor-link-before', 'anchor-link-after', 'anchor-directory-fsync', 'final-readback']) {
    const f = fixture(t), files = new Map(); let links = 0, fired = false;
    const fault = () => { fired = true; throw Error('synthetic provisioning ' + stage); };
    const injected = new Proxy(fs, {get(target, name) {
      if (name === 'openSync') return (...args) => { const fd = fs.openSync(...args); files.set(fd, args[0]); return fd; };
      if (name === 'closeSync') return fd => { files.delete(fd); return fs.closeSync(fd); };
      if (name === 'linkSync') return (...args) => {
        const kind = args[1] === f.config.file ? 'ledger' : 'anchor';
        if (!fired && stage === kind + '-link-before') fault();
        const result = fs.linkSync(...args); links++;
        if (!fired && stage === kind + '-link-after') fault();
        return result;
      };
      if (name === 'fsyncSync') return fd => {
        if (!fired && files.get(fd) === f.directory && ((stage === 'ledger-directory-fsync' && links === 1) || (stage === 'anchor-directory-fsync' && links === 2))) fault();
        return fs.fsyncSync(fd);
      };
      if (name === 'readFileSync') return (...args) => { if (!fired && stage === 'final-readback' && links === 2 && files.get(args[0]) === f.config.file) fault(); return fs.readFileSync(...args); };
      return target[name];
    }});
    assert.throws(() => f.provision({fsImpl: injected}), /synthetic provisioning/); assert.equal(fired, true); assert.equal(files.size, 0);
    const current = new Map(fs.readdirSync(f.directory).map(name => [name, fs.readFileSync(path.join(f.directory, name))]));
    assert.throws(() => f.provision(), {code: 'MRZ_BUDGET_ALREADY_EXISTS'});
    for (const [name, bytes] of current) assert.deepEqual(fs.readFileSync(path.join(f.directory, name)), bytes);
    const budget = createDurableMrzBudget(f.config);
    if (stage === 'anchor-directory-fsync' || stage === 'final-readback') {
      await budget.open(); assert.equal(budget.status().reservedUsd, 0.96); budget.close();
    } else {
      await assert.rejects(budget.open()); assert.equal(budget.durable, false);
      await assert.rejects(budget.reserve(request(1)), {code: 'MRZ_BUDGET_NOT_DURABLE'});
    }
  }
});

test('ambiguous settlement persistence retains the full reservation across restart', async t => {
  const f = fixture(t); f.provision(); let failAfterRename = false;
  const injected = new Proxy(fs, {get(target, name) {
    if (name === 'renameSync') return (...args) => { fs.renameSync(...args); if (failAfterRename && args[1] === f.config.file + '.anchor') { failAfterRename = false; throw Error('synthetic post-rename settlement ambiguity'); } };
    return target[name];
  }});
  const budget = await opened(t, {...f.config, fsImpl: injected}), input = request(1), reserved = await budget.reserve(input);
  const final = settlement(input, reserved, {outcome: 'timeout', uncertain: true, generationUsage: null, estimatedGenerationUsd: null, countReserveUsd: null});
  failAfterRename = true;
  await assert.rejects(budget.settle(final), {code: 'MRZ_BUDGET_SAVE_FAILED'}); assert.equal(budget.durable, false); budget.close();
  const restarted = await opened(t, f.config);
  assert.equal(restarted.status().reservedUsd, 1.08); assert.equal(restarted.status().settlements, 1);
  assert.deepEqual(await restarted.settle(final), {committed: true, existing: true});
});

test('state key Buffer32 and its original string use the same encryption derivation; separate namespace rejects other data', async t => {
  const f = fixture(t); f.provision();
  const budget = await opened(t, {...f.config, key: crypto.createHash('sha256').update(KEY).digest()});
  assert.equal(budget.durable, true); budget.close();
  const wrongNamespace = Buffer.from(fs.readFileSync(f.config.file)); wrongNamespace[0] ^= 1; fs.writeFileSync(f.config.file, wrongNamespace);
  await assert.rejects(createDurableMrzBudget(f.config).open(), {code: 'MRZ_BUDGET_INVALID_LEDGER'});
  assert.equal(NAMESPACE, 'visaMrzProductionBudgetV1');
});
