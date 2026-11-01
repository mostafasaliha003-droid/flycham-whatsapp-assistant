'use strict';
// Fresh final image: aggregate-only stdlib reporter, no app or evidence routes.
const http = require('node:http');
const EXPECTED = Object.freeze({
  "kind": "isolated_main_node26_validation",
  "functionalCommit": "ad16a50edb11f859102e3b91bf85db2fab9b5442",
  "functionalTree": "b9747bfbf28809cf0c1e470148169b192bd040e3",
  "applicationFingerprintSha256": "7e1d7f516f077a26c26843bab5abf2b784af481f5a410f2574c549b14c82b712",
  "applicationFiles": 431,
  "buildNonce": "raad-validation-20261101-ad16a50-01",
  "nodeVersion": "v26.13.0",
  "npmVersion": "11.20.0",
  "debianVersion": "12",
  "glibcVersion": "2.36",
  "pdfToolsVersion": "22.12.0",
  "freshInstallPassed": true,
  "lockUnchanged": true,
  "baselineChecks": 4,
  "startupPassed": true,
  "pdfChecks": 3,
  "profileControlFiles": 13,
  "profileControlsPassed": true,
  "baseImageDigest": "sha256:a3bba7dc7dbcc1f37c2856c51fc9a7fac96608f50cb87b1b4e4d8b8c85ae988e",
  "sourceSnapshotSha256": "4b0a5e673f65fcfd940373f14186ca2eb591578315fb45f6e35e637174103c93",
  "scope": "derived_debian12_validation_not_platform_image_equivalence",
  "fullSuiteRerun": false,
  "mrzAccuracyClaimed": false,
  "buildOnly": true,
  "releaseReady": false,
  "liveActions": 0
});
const KEYS = Object.freeze(["kind", "functionalCommit", "functionalTree", "applicationFingerprintSha256", "applicationFiles", "buildNonce", "nodeVersion", "npmVersion", "debianVersion", "glibcVersion", "pdfToolsVersion", "freshInstallPassed", "lockUnchanged", "baselineChecks", "startupPassed", "pdfChecks", "profileControlFiles", "profileControlsPassed", "baseImageDigest", "sourceSnapshotSha256", "scope", "fullSuiteRerun", "mrzAccuracyClaimed", "buildOnly", "releaseReady", "liveActions", "evidenceSha256", "evidenceBytes", "evidenceChunks"]);
const SHA256 = /^[a-f0-9]{64}$/;
const INVALID = 'REPORT_SUMMARY_INVALID';
function validateSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).length !== KEYS.length
      || !KEYS.every(key => Object.hasOwn(value, key))) throw Error(INVALID);
  for (const key of Object.keys(EXPECTED)) if (value[key] !== EXPECTED[key]) throw Error(INVALID);
  if (typeof value.evidenceSha256 !== 'string' || !SHA256.test(value.evidenceSha256)
      || !Number.isSafeInteger(value.evidenceBytes) || value.evidenceBytes < 1 || value.evidenceBytes > 262144
      || !Number.isSafeInteger(value.evidenceChunks) || value.evidenceChunks < 1 || value.evidenceChunks > 342) throw Error(INVALID);
  return Object.freeze({
    kind: EXPECTED.kind,
    functionalCommit: EXPECTED.functionalCommit,
    functionalTree: EXPECTED.functionalTree,
    applicationFingerprintSha256: EXPECTED.applicationFingerprintSha256,
    applicationFiles: EXPECTED.applicationFiles,
    buildNonce: EXPECTED.buildNonce,
    nodeVersion: EXPECTED.nodeVersion,
    npmVersion: EXPECTED.npmVersion,
    debianVersion: EXPECTED.debianVersion,
    glibcVersion: EXPECTED.glibcVersion,
    pdfToolsVersion: EXPECTED.pdfToolsVersion,
    freshInstallPassed: EXPECTED.freshInstallPassed,
    lockUnchanged: EXPECTED.lockUnchanged,
    baselineChecks: EXPECTED.baselineChecks,
    startupPassed: EXPECTED.startupPassed,
    pdfChecks: EXPECTED.pdfChecks,
    profileControlFiles: EXPECTED.profileControlFiles,
    profileControlsPassed: EXPECTED.profileControlsPassed,
    baseImageDigest: EXPECTED.baseImageDigest,
    sourceSnapshotSha256: EXPECTED.sourceSnapshotSha256,
    scope: EXPECTED.scope,
    fullSuiteRerun: EXPECTED.fullSuiteRerun,
    mrzAccuracyClaimed: EXPECTED.mrzAccuracyClaimed,
    buildOnly: EXPECTED.buildOnly,
    releaseReady: EXPECTED.releaseReady,
    liveActions: EXPECTED.liveActions,
    evidenceSha256: value.evidenceSha256,
    evidenceBytes: value.evidenceBytes,
    evidenceChunks: value.evidenceChunks,
  });
}
function parsePort(value) {
  if (value === undefined) return 10000;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value)) throw Error('REPORT_PORT_INVALID');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('REPORT_PORT_INVALID');
  return port;
}

function createReportServer(summary) {
  const report = Buffer.from(JSON.stringify(validateSummary(summary)) + '\n');
  const health = Buffer.from('{"status":"reporter_alive","releaseReady":false,"liveActions":0}\n');
  const missing = Buffer.from('{"error":"not_found"}\n');
  const method = Buffer.from('{"error":"method_not_allowed"}\n');
  const unavailable = Buffer.from('{"error":"report_unavailable"}\n');
  const server = http.createServer((request, response) => {
    try {
      let status, body;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        status = 405; body = method; response.setHeader('allow', 'GET, HEAD');
      } else if (request.url === '/health') { status = 200; body = health; }
      else if (request.url === '/report') { status = 200; body = report; }
      else { status = 404; body = missing; }
      response.writeHead(status, {'content-type': 'application/json; charset=utf-8',
        'content-length': body.length, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', connection: 'close'});
      response.end(request.method === 'HEAD' ? undefined : body);
      request.resume();
    } catch {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(500, {'content-type': 'application/json; charset=utf-8',
        'content-length': unavailable.length, connection: 'close'});
      response.end(request.method === 'HEAD' ? undefined : unavailable);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

module.exports = {EXPECTED, validateSummary, parsePort, createReportServer};
if (require.main === module) {
  try {
    // The only runtime file read is this fixed build-produced aggregate.
    const raw = require('node:fs').readFileSync('/report/public-summary.json', 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 8192) throw Error(INVALID);
    const server = createReportServer(JSON.parse(raw));
    const port = parsePort(process.env.PORT);
    server.on('error', () => { process.stderr.write('REPORT_SERVER_STARTUP_FAILED\n'); process.exitCode = 1; });
    server.listen(port, '0.0.0.0');
  } catch {
    process.stderr.write('REPORT_SERVER_STARTUP_FAILED\n'); process.exitCode = 1;
  }
}

