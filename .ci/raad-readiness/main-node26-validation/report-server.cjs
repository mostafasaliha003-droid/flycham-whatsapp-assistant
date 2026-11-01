'use strict';
// Aggregate-only reporter: no application, evidence or UI routes.
const http=require('node:http');
const EXPECTED=Object.freeze({
  "kind": "isolated_worker_image_validation",
  "functionalCommit": "ad16a50edb11f859102e3b91bf85db2fab9b5442",
  "functionalTree": "b9747bfbf28809cf0c1e470148169b192bd040e3",
  "applicationFingerprintSha256": "7e1d7f516f077a26c26843bab5abf2b784af481f5a410f2574c549b14c82b712",
  "applicationFiles": 431,
  "buildNonce": "raad-validation-20261101-ad16a50-worker-01",
  "workerRecipeSha256": "0f7552726f37e9f4cdf433137057a6ee49e056a8775f2d7001d42e62a5e3e977",
  "baseImageTag": "mcr.microsoft.com/playwright:v1.64.0-noble",
  "baseImageDigestObserved": false,
  "sourceSnapshotSha256": "4b0a5e673f65fcfd940373f14186ca2eb591578315fb45f6e35e637174103c93",
  "freshInstallPassed": true,
  "lockUnchanged": true,
  "nativeChecks": 12,
  "raadOverrideHealthPassed": true,
  "profileControlFiles": 13,
  "profileControlTests": 318,
  "profileControlsPassed": true,
  "scope": "additive_original_worker_recipe_with_pre_tool_overlay_native_checks",
  "fullSuiteRerun": false,
  "mrzAccuracyClaimed": false,
  "buildOnly": true,
  "releaseReady": false,
  "liveActions": 0
});
const RUNTIME_KEYS=['nodeVersion','npmVersion','glibcVersion'];
const KEYS=[...Object.keys(EXPECTED),...RUNTIME_KEYS,'evidenceSha256','evidenceBytes','evidenceChunks'];
const INVALID='REPORT_SUMMARY_INVALID';
function validateSummary(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).length!==KEYS.length||!KEYS.every(k=>Object.hasOwn(value,k)))throw Error(INVALID);
 for(const [k,v]of Object.entries(EXPECTED))if(value[k]!==v)throw Error(INVALID);
 if(!/^v\d{2}\.\d{1,3}\.\d{1,3}$/.test(value.nodeVersion)||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.npmVersion)||!/^\d{1,3}\.\d{1,3}$/.test(value.glibcVersion))throw Error(INVALID);
 if(!/^[a-f0-9]{64}$/.test(value.evidenceSha256)||!Number.isSafeInteger(value.evidenceBytes)||value.evidenceBytes<1||value.evidenceBytes>262144||!Number.isSafeInteger(value.evidenceChunks)||value.evidenceChunks<1||value.evidenceChunks>342)throw Error(INVALID);
 return Object.freeze({...EXPECTED,nodeVersion:value.nodeVersion,npmVersion:value.npmVersion,glibcVersion:value.glibcVersion,evidenceSha256:value.evidenceSha256,evidenceBytes:value.evidenceBytes,evidenceChunks:value.evidenceChunks});
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

