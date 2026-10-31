'use strict';
// Final image: this stdlib reporter only. No application runtime or raw evidence.
const http = require('node:http');

const EXPECTED = Object.freeze({
  kind: 'isolated_build_validation',
  functionalCommit: 'f019ad03652121abf75774f5ebe3d5325206f9eb',
  functionalTree: '218c5149f6c8ae9e29075894422da9be94382a54',
  applicationFingerprintSha256: 'a59e55daf716d668d6adcb26b9a57fbb9b4497f03b925a3300637063a890e53b',
  applicationFiles: 417,
  unitTests: 2629,
  unitPassed: 2629,
  unitFiles: 208,
  nativeChecks: 12,
  buildNonce: 'raad-validation-20261031-f019ad0-03',
  buildOnly: true,
  releaseReady: false,
  liveActions: 0,
});
const SHA256 = /^[a-f0-9]{64}$/;
const KEYS = Object.freeze(['kind', 'functionalCommit', 'functionalTree',
  'applicationFingerprintSha256', 'applicationFiles', 'unitTests', 'unitPassed',
  'unitFiles', 'nativeChecks', 'workerRecipeSha256', 'sourceSnapshotSha256',
  'evidenceSha256', 'evidenceBytes', 'evidenceChunks', 'buildNonce', 'buildOnly',
  'releaseReady', 'liveActions']);
const INVALID = 'REPORT_SUMMARY_INVALID';

function validateSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).length !== KEYS.length
      || !KEYS.every(key => Object.hasOwn(value, key))) throw Error(INVALID);
  for (const key of Object.keys(EXPECTED)) if (value[key] !== EXPECTED[key]) throw Error(INVALID);
  for (const key of ['workerRecipeSha256', 'sourceSnapshotSha256', 'evidenceSha256'])
    if (typeof value[key] !== 'string' || !SHA256.test(value[key])) throw Error(INVALID);
  if (!Number.isSafeInteger(value.evidenceBytes) || value.evidenceBytes < 1
      || value.evidenceBytes > 1048576 || !Number.isSafeInteger(value.evidenceChunks)
      || value.evidenceChunks < 1 || value.evidenceChunks > 512) throw Error(INVALID);

  // Explicit projection: never retain or spread an input object into output.
  return Object.freeze({
    kind: EXPECTED.kind,
    functionalCommit: EXPECTED.functionalCommit,
    functionalTree: EXPECTED.functionalTree,
    applicationFingerprintSha256: EXPECTED.applicationFingerprintSha256,
    applicationFiles: EXPECTED.applicationFiles,
    unitTests: EXPECTED.unitTests,
    unitPassed: EXPECTED.unitPassed,
    unitFiles: EXPECTED.unitFiles,
    nativeChecks: EXPECTED.nativeChecks,
    workerRecipeSha256: value.workerRecipeSha256,
    sourceSnapshotSha256: value.sourceSnapshotSha256,
    evidenceSha256: value.evidenceSha256,
    evidenceBytes: value.evidenceBytes,
    evidenceChunks: value.evidenceChunks,
    buildNonce: EXPECTED.buildNonce,
    buildOnly: true,
    releaseReady: false,
    liveActions: 0,
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
