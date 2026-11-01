'use strict';
const {createDocumentProbe} = require('./visa-document-probe');
const {POLICY_FINGERPRINT} = require('./visa-document-vision');

// Explicitly enabled, fixed synthetic verification. Persist intent before the
// provider call so restarts cannot replay this diagnostic for the same policy.
async function runDocumentSmoke({vision, store, env = process.env, now = Date.now, report = value => console.log('DOCUMENT_VISION_SMOKE_' + JSON.stringify(value))} = {}) {
  if (env.RAAD_DOCUMENT_OCR_SMOKE_ENABLED !== 'true') return null;
  if (!store?.data || typeof store.save !== 'function') return null;
  const previous = store.data.documentVisionSmoke;
  if (previous?.policy === POLICY_FINGERPRINT) {report({reused:true,state:previous.state,...previous.result});return previous.result || null;}
  if (!vision?.ready?.()) {const result={ok:false,error:'DOCUMENT_VISION_NOT_READY'};report(result);return result;}
  store.data.documentVisionSmoke = {policy:POLICY_FINGERPRINT,state:'running',startedAt:now()};
  try {store.save();} catch {report({ok:false,error:'DOCUMENT_SMOKE_STATE_UNAVAILABLE'});return null;}
  const result = await createDocumentProbe({vision,now})();
  store.data.documentVisionSmoke = {...store.data.documentVisionSmoke,state:'completed',result,finishedAt:now()};
  try {store.save();} catch {report({ok:false,error:'DOCUMENT_SMOKE_STATE_UNAVAILABLE'});return null;}
  report({reused:false,...result});return result;
}
module.exports = {runDocumentSmoke};
