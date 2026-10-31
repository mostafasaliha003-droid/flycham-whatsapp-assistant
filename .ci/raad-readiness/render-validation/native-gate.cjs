'use strict';
// Build-time only; original worker UID=root, RUN --network=none, /app mounted RO.
const fs = require('node:fs');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const os = require('node:os');
const net = require('node:net');
const pathModule = require('node:path');
function verifyLoopbackOnly(readInterfaces = os.networkInterfaces) {
  const fail = () => { throw Error('RAAD_NATIVE_NETWORK_GUARD_FAILED'); };
  let found;
  try { found = readInterfaces(); } catch { return fail(); }
  if (!found || typeof found !== 'object' || Array.isArray(found)
      || Object.keys(found).length !== 1 || !Object.hasOwn(found, 'lo')
      || !Array.isArray(found.lo) || found.lo.length === 0) return fail();
  for (const item of found.lo) {
    const address = item?.address, family = net.isIP(typeof address === 'string' ? address : '');
    const ipv4 = family === 4 && /^127\./.test(address)
      && ['IPv4', 4].includes(item.family);
    const ipv6 = family === 6 && ['::1', '0:0:0:0:0:0:0:1'].includes(address)
      && ['IPv6', 6].includes(item.family);
    if (item?.internal !== true || (!ipv4 && !ipv6)) return fail();
  }
  return {method: 'node_os_networkInterfaces', observedInterfaces: ['lo'],
    addressCount: found.lo.length, allInternal: true};
}
function verifyBrowserCompatibility({imageBrowserPath, probe}) {
  const fail = () => { throw Error('RAAD_IMAGE_BROWSER_COMPATIBILITY_FAILED'); };
  try {
    if (imageBrowserPath !== '/ms-playwright' || typeof probe !== 'function') return fail();
    const withoutImageEnv = probe(false), withImageEnv = probe(true);
    for (const value of [withoutImageEnv, withImageEnv]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'exists,path,realPath,version'
          || typeof value.path !== 'string' || !pathModule.isAbsolute(value.path)
          || value.path.length > 512 || typeof value.exists !== 'boolean'
          || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)
          || value.exists && (typeof value.realPath !== 'string' || value.realPath.length > 512 || !pathModule.isAbsolute(value.realPath))
          || !value.exists && value.realPath !== null) return fail();
    }
    if (!withImageEnv.exists || !withImageEnv.path.startsWith('/ms-playwright/')
        || !withImageEnv.realPath.startsWith('/ms-playwright/')
        || pathModule.resolve(withImageEnv.path) !== withImageEnv.path
        || pathModule.resolve(withImageEnv.realPath) !== withImageEnv.realPath
        || withoutImageEnv.version !== withImageEnv.version) return fail();
    return {imageBrowserPath: '/ms-playwright', withoutImageEnv, withImageEnv,
      pathGuardPassed: true, scope: 'read-only executable path metadata; launch still required'};
  } catch { return fail(); }
}
function main() {
const path = '/tmp/raad-native-proof';
fs.mkdirSync(path, {recursive: true});
const expected = ['operator-readiness-tool-and-model-notice', 'model-size-and-hash',
  'sharp-native-image', 'qr-generation', 'tesseract-local-mrz-runtime',
  'application-owned-optical-child-runtime', 'pdf-tools', 'synthetic-pdf-conversion',
  'chromium-local-no-network', 'native-chromium-redirect-fence-before-follow',
  'whatsapp-source-entrypoint-disabled', 'raad-source-entrypoint-disabled'];
const input = JSON.parse(fs.readFileSync('/validation-input/inputs.json', 'utf8'));
const networkObservation = verifyLoopbackOnly();
const cleanEnv = {PATH: process.env.PATH, HOME: '/tmp', TMPDIR: '/tmp',
  LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test'};
const program = `const fs=require('node:fs');const{createRequire}=require('node:module');
const r=createRequire('/app/package.json');const p=r('playwright').chromium.executablePath();
const exists=fs.existsSync(p)&&fs.statSync(p).isFile();
console.log(JSON.stringify({path:p,realPath:exists?fs.realpathSync(p):null,exists,version:r('playwright/package.json').version}));`;
const observations = {};
let browserEnvironment;
try {
browserEnvironment = verifyBrowserCompatibility({imageBrowserPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
  probe: includeImagePath => {
    const result = spawnSync(process.execPath, ['-e', program], {cwd: '/app',
      env: includeImagePath ? {...cleanEnv, PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright'} : cleanEnv,
      timeout: 5000, maxBuffer: 8192, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    if (result.error || result.status !== 0) throw Error();
    const value = JSON.parse(result.stdout);
    observations[includeImagePath ? 'withImageEnv' : 'withoutImageEnv'] = value;
    return value;
  }});
} finally {
  const safeObservation = value => value ? {
    path: typeof value.path === 'string' && /^\/[\x20-\x7e]{0,511}$/.test(value.path) ? value.path : 'unavailable',
    realPath: value.realPath === null ? null : typeof value.realPath === 'string' && /^\/[\x20-\x7e]{0,511}$/.test(value.realPath) ? value.realPath : 'unavailable',
    exists: value.exists === true, version: typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version) ? value.version : 'unavailable',
  } : null;
  console.log(JSON.stringify({tag: 'RAAD_IMAGE_BROWSER_COMPATIBILITY',
    imagePathAllowlisted: process.env.PLAYWRIGHT_BROWSERS_PATH === '/ms-playwright',
    withoutImageEnv: safeObservation(observations.withoutImageEnv),
    withImageEnv: safeObservation(observations.withImageEnv), pathGuardPassed: Boolean(browserEnvironment)}));
}
fs.writeFileSync(path + '/browser-environment.json', JSON.stringify(browserEnvironment, null, 2) + '\n');
const child = spawn(process.execPath, ['/validation-input/container-preflight.cjs'], {
  cwd: '/app', env: {...cleanEnv, PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright'},
  stdio: ['ignore', 'pipe', 'pipe'], detached: true});
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
    ...networkObservation,
    browserEnvironment,
    runtime: 'derived worker stage before Python tooling installation',
    user: 'root (original worker default)', applicationMount: 'read-only bind from worker stage',
    stdoutEof: true, bytes: raw.length,
    sha256: crypto.createHash('sha256').update(raw).digest('hex')}, null, 2) + '\n');
  console.log('RAAD_NATIVE_GATE_PASSED');
});
}
module.exports = {verifyLoopbackOnly, verifyBrowserCompatibility};
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error?.message === 'RAAD_IMAGE_BROWSER_COMPATIBILITY_FAILED'
      ? 'RAAD_IMAGE_BROWSER_COMPATIBILITY_FAILED' : 'RAAD_NATIVE_NETWORK_GUARD_FAILED');
    process.exitCode = 1;
  }
}
