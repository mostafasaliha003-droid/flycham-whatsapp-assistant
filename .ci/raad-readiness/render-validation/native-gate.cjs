'use strict';
// Build-time only; original worker UID=root, RUN --network=none, /app mounted RO.
const fs = require('node:fs');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const path = '/tmp/raad-native-proof';
fs.mkdirSync(path, {recursive: true});
const expected = ['operator-readiness-tool-and-model-notice', 'model-size-and-hash',
  'sharp-native-image', 'qr-generation', 'tesseract-local-mrz-runtime',
  'application-owned-optical-child-runtime', 'pdf-tools', 'synthetic-pdf-conversion',
  'chromium-local-no-network', 'native-chromium-redirect-fence-before-follow',
  'whatsapp-source-entrypoint-disabled', 'raad-source-entrypoint-disabled'];
const input = JSON.parse(fs.readFileSync('/validation-input/inputs.json', 'utf8'));
const interfaces = fs.readdirSync('/sys/class/net').sort();
if (interfaces.length !== 1 || interfaces[0] !== 'lo') {
  console.error('RAAD_NATIVE_NETWORK_GUARD_FAILED'); process.exit(1);
}
const child = spawn(process.execPath, ['/validation-input/container-preflight.cjs'], {
  cwd: '/app', env: {PATH: process.env.PATH, HOME: '/tmp', TMPDIR: '/tmp',
    LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test'}, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
let chunks = [], size = 0, overflow = false, timedOut = false;
const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
const add = bytes => {
  size += bytes.length;
  if (size > 128 * 1024) { overflow = true; killGroup(); return; }
  chunks.push(bytes);
};
child.stdout.on('data', add); child.stderr.on('data', add);
const timer = setTimeout(() => { timedOut = true; killGroup(); }, 180000);
child.on('error', () => { console.error('RAAD_NATIVE_GATE_SPAWN_FAILED'); process.exitCode = 1; });
child.on('close', async code => {
  clearTimeout(timer);
  const raw = Buffer.concat(chunks);
  fs.writeFileSync(path + '/native-preflight.log', raw);
  const encoded = raw.toString('base64'), parts = encoded.match(/.{1,1024}/g) || [];
  const metadata = {tag: 'RAAD_NATIVE_EVIDENCE', encoding: 'base64', bytes: raw.length,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'), chunks: parts.length};
  console.log(JSON.stringify({...metadata, event: 'begin'}));
  for (let index = 0; index < parts.length; index++) {
    console.log(JSON.stringify({tag: metadata.tag, event: 'chunk', index: index + 1, data: parts[index]}));
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  console.log(JSON.stringify({...metadata, event: 'end', eof: true}));
  let footer;
  try { footer = JSON.parse(raw.toString('utf8').trim().split('\n').at(-1)); } catch {}
  const passed = raw.toString('utf8').split('\n').filter(line => line.startsWith('PASS ')).map(line => line.slice(5));
  if (code !== 0 || timedOut || overflow || JSON.stringify(passed) !== JSON.stringify(expected)
      || footer?.status !== 'passed' || footer.liveActions !== 0
      || JSON.stringify(footer.checks) !== JSON.stringify(expected)) {
    console.error('RAAD_NATIVE_GATE_FAILED'); process.exitCode = 1; return;
  }
  fs.writeFileSync(path + '/native-proof.json', JSON.stringify({passed: true,
    checks: expected, nativeChecks: expected.length, liveActions: 0,
    functionalCommit: input.functionalCommit, applicationFingerprintSha256: input.applicationFingerprintSha256,
    buildNonce: input.buildNonce, network: 'Dockerfile RUN --network=none',
    observedInterfaces: interfaces,
    runtime: 'derived worker stage before Python tooling installation',
    user: 'root (original worker default)', applicationMount: 'read-only bind from worker stage',
    stdoutEof: true, bytes: raw.length,
    sha256: crypto.createHash('sha256').update(raw).digest('hex')}, null, 2) + '\n');
  console.log('RAAD_NATIVE_GATE_PASSED');
});
