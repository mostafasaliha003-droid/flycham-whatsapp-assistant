'use strict';

// Run manually inside the deployed service. Uses the running server's durable
// budget and fixed synthetic probe; never opens customer files or prints keys.
async function check({env = process.env, fetchImpl = fetch} = {}) {
  if (!env.RAAD_JOB_BRIDGE_KEY || !env.RAAD_ACCOUNTANT_KEY) throw Error('PROBE_AUTH_NOT_CONFIGURED');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PROBE_PORT_INVALID');
  const base = 'http://127.0.0.1:' + port + '/internal/assistant/visa-portal';
  const headers = {Authorization: 'Bearer ' + env.RAAD_JOB_BRIDGE_KEY};
  const health = await fetchImpl(base + '/health', {headers, redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!health.ok) throw Error('PROBE_HEALTH_UNAVAILABLE');
  const {documentOcr} = await health.json();
  if (documentOcr?.provider !== 'cline' || documentOcr?.model !== 'cline-pass/qwen3.8-max' || documentOcr?.ready !== true) throw Error('CLINE_DOCUMENT_READER_NOT_READY');
  const result = await fetchImpl(base + '/document-ocr/probe', {method: 'POST', headers: {...headers, 'x-accountant-key': env.RAAD_ACCOUNTANT_KEY}, redirect: 'error', signal: AbortSignal.timeout(75000)});
  const data = await result.json();
  const safe = {http: result.status, provider: 'cline', model: documentOcr.model, ok: data.ok === true, synthetic: data.synthetic === true};
  for (const name of ['fieldsRead', 'expectedFields', 'durationMs', 'providerStatus']) if (Number.isFinite(data[name])) safe[name] = data[name];
  for (const name of ['error', 'reason', 'stage', 'schemaSection', 'fieldName', 'schemaIssue']) if (typeof data[name] === 'string' && /^[A-Za-z_]{1,80}$/.test(data[name])) safe[name] = data[name];
  return safe;
}
if (require.main === module) check().then(result => {console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;}).catch(error => {console.log(JSON.stringify({ok:false,error:/^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'CLINE_DOCUMENT_PROBE_FAILED'}));process.exitCode = 1;});
module.exports = {check};
