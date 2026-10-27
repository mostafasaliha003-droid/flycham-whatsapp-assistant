'use strict';

// Read-only provider configuration check. This module cannot create a browser,
// run an Agent task, upload documents, accept terms, or enter an OTP.
// GET detail is a bare profile object, not {data: profile}:
// https://docs.tinyfish.ai/api-reference/browser-context-profiles/get-a-browser-context-profile
const PROFILE_ORIGIN = 'https://agent.tinyfish.ai';
const MAX_BODY_BYTES = 200 * 1024;
const TIMEOUT_MS = 15000;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;

class CheckFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

function configuredValues(env, privateConfig) {
  const rawKey = env?.RAAD_TINYFISH_API_KEY;
  const rawProfile = env?.RAAD_TINYFISH_PROFILE_ID || privateConfig?.tinyfishProfileId;
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  const profileId = typeof rawProfile === 'string' ? rawProfile.trim() : '';
  // Restrict the configured ID to one path segment. No caller-supplied URLs,
  // query strings, traversal, or header control characters are accepted.
  return {
    key: key.length <= 4096 && /^[\x21-\x7e]+$/.test(key) ? key : '',
    profileId: PROFILE_ID.test(profileId) ? profileId : ''
  };
}

function validProfile(value, profileId) {
  // Required fields/types from the public GET /v1/profiles/{profileId} schema.
  // Extra provider fields are never returned, including cookies or site names.
  return object(value) && value.id === profileId && typeof value.name === 'string' &&
    text(value.created_at) && Array.isArray(value.domains) && value.domains.every(domain =>
      object(domain) && text(domain.domain) && count(domain.cookie_count) &&
      count(domain.local_storage_origin_count) && text(domain.last_accessed_at) &&
      text(domain.last_written_at) && text(domain.last_written_by_run_id));
}

async function boundedJson(response, withinDeadline) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new CheckFailure('TINYFISH_RESPONSE_TOO_LARGE');
  }
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentType) ||
      typeof response.body?.getReader !== 'function') throw new CheckFailure('TINYFISH_RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = [];
  let size = 0, finished = false;
  try {
    while (true) {
      const chunk = await withinDeadline(reader.read());
      if (chunk.done) { finished = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw new CheckFailure('TINYFISH_RESPONSE_INVALID');
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new CheckFailure('TINYFISH_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw new CheckFailure('TINYFISH_RESPONSE_INVALID'); }
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function httpReason(status) {
  if (status === 401) return 'TINYFISH_CREDENTIAL_REJECTED';
  if (status === 403) return 'TINYFISH_ACCESS_DENIED';
  if (status === 404) return 'TINYFISH_PROFILE_UNAVAILABLE';
  if (status === 429) return 'TINYFISH_RATE_LIMITED';
  if (status >= 500) return 'TINYFISH_PROVIDER_UNAVAILABLE';
  if (status >= 300 && status < 400) return 'TINYFISH_REDIRECT_REJECTED';
  return 'TINYFISH_PROVIDER_REJECTED';
}

class RaadTinyFishProfile {
  #env;
  #privateConfig;
  #fetch;

  constructor({env = process.env, privateConfig = {}, fetchImpl = global.fetch} = {}) {
    this.#env = env;
    this.#privateConfig = privateConfig;
    this.#fetch = fetchImpl;
  }

  status() {
    const {key, profileId} = configuredValues(this.#env, this.#privateConfig);
    return {configured: Boolean(key && profileId), profileConfigured: Boolean(profileId), executionConnected: false};
  }

  async check() {
    const {key, profileId} = configuredValues(this.#env, this.#privateConfig);
    const result = {
      configured: Boolean(key && profileId), profileConfigured: Boolean(profileId),
      executionConnected: false, checked: false, providerReachable: false,
      profileAvailable: false, portalAuthenticationChecked: false, ok: false,
      reason: 'TINYFISH_NOT_CONFIGURED'
    };
    if (!result.configured) return result;
    if (typeof this.#fetch !== 'function') return {...result, reason: 'TINYFISH_FETCH_UNAVAILABLE'};

    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new CheckFailure('TINYFISH_TIMEOUT'));
    }, TIMEOUT_MS);
    const withinDeadline = promise => Promise.race([promise, deadline]);
    result.checked = true;
    try {
      const response = await withinDeadline(this.#fetch(
        `${PROFILE_ORIGIN}/v1/profiles/${encodeURIComponent(profileId)}`,
        {method: 'GET', headers: {'X-API-Key': key, Accept: 'application/json'}, redirect: 'error', signal: controller.signal}
      ));
      if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) throw new CheckFailure('TINYFISH_RESPONSE_INVALID');
      result.providerReachable = true;
      if (response.status !== 200) return {...result, reason: httpReason(response.status)};
      const profile = await boundedJson(response, withinDeadline);
      if (!validProfile(profile, profileId)) throw new CheckFailure('TINYFISH_PROFILE_RESPONSE_INVALID');
      return {...result, ok: true, profileAvailable: true, reason: 'TINYFISH_PROFILE_AVAILABLE'};
    } catch (error) {
      return {...result, reason: error instanceof CheckFailure ? error.code : controller.signal.aborted ? 'TINYFISH_TIMEOUT' : 'TINYFISH_NETWORK_ERROR'};
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

module.exports = {RaadTinyFishProfile};
