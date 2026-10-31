'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const UI = require('../src/visa-upload-ui');

const TOKEN = 'a'.repeat(43);
const session = overrides => ({ok: true, state: 'open', expiresAt: Date.now() + 7200000, maxBytes: 10485760, limits: {passport: 2, residence: 2, photo: 1}, files: [], whatsappUrl: 'https://wa.me/971500000001?text=' + encodeURIComponent('تم رفع المستندات'), ...overrides});
const file = (role = 'passport', overrides) => ({id: crypto.randomUUID(), role, mimeType: 'image/png', size: 1400, ...overrides});
test('bearer fragment and WhatsApp return destinations are restricted', () => {
  assert.equal(UI.cleanToken('#' + TOKEN), TOKEN);
  for (const value of ['#token=' + TOKEN, '#' + TOKEN + '?next=evil', '#%61'.repeat(43), 'https://wa.me/123']) assert.equal(UI.cleanToken(value), '');
  assert.equal(UI.safeWhatsapp('https://wa.me/971500000001?text=hello'), 'https://wa.me/971500000001?text=hello');
  for (const value of ['javascript:alert(1)', 'http://wa.me/971500000001', 'https://wa.me.evil.test/971500000001', 'https://wa.me@evil.test/971500000001', 'https://wa.me/971500000001#secret', 'https://wa.me/971500000001?redirect=https://evil.test', 'https://wa.me/971500000001?text=a&text=b']) assert.equal(UI.safeWhatsapp(value), null);
});
test('session facts reject over-limit, duplicate and malformed server file records', () => {
  const first = file();
  assert.equal(UI.normaliseSession(session({files: [first]})).files[0].id, first.id);
  assert.throws(() => UI.normaliseSession(session({files: [first, first]})), /UPLOAD_RESPONSE_INVALID/);
  assert.throws(() => UI.normaliseSession(session({files: [file('photo'), file('photo')]})), /UPLOAD_RESPONSE_INVALID/);
  assert.throws(() => UI.normaliseSession(session({files: [file('passport', {size: 10485761})]})), /UPLOAD_RESPONSE_INVALID/);
  assert.throws(() => UI.normaliseSession(session({files: [file('passport', {mimeType: 'text/html'})]})), /UPLOAD_RESPONSE_INVALID/);
  assert.equal(UI.normaliseSession(session({customer: 'do not expose', passportNumber: 'do not expose'})).customer, undefined);
});
test('pre-upload checks reject oversized and unsupported images and accept PDF for every role', () => {
  assert.equal(UI.fileProblem({size: 10485760, type: 'image/jpeg'}, 'photo'), null);
  assert.equal(UI.fileProblem({size: 10485761, type: 'image/jpeg'}, 'photo').length > 0, true);
  assert.equal(UI.fileProblem({size: 100, type: 'application/pdf'}, 'passport'), null);
  assert.equal(UI.fileProblem({size: 100, type: 'application/pdf'}, 'photo'), null);
  assert.equal(UI.fileProblem({size: 100, type: 'image/heic'}, 'passport').length > 0, true);
});

function harness({initial = session(), upload, api} = {}) {
  const requests = [], binaries = [], urls = [], revoked = [], zones = {}, nodes = {};
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.className = ''; this.value = ''; this._text = ''; this.classes = new Set(); this.classList = {add: value => this.classes.add(value), remove: value => this.classes.delete(value), toggle: (value, force) => force ? this.classes.add(value) : this.classes.delete(value)}; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this._text = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    async fire(type, event = {}) { for (const callback of this.listeners[type] || []) await callback({preventDefault() {}, ...event}); }
    closest() { return this.zone; }
    focus() { document.activeElement = this; }
  }
  const html = fs.readFileSync(require.resolve('../src/visa-upload.html'), 'utf8');
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes[id] = new Element('div');
  for (const role of ['passport', 'residence', 'photo']) { zones[role] = new Element('label'); nodes[role + '-input'].zone = zones[role]; }
  const document = {activeElement: null, getElementById: id => nodes[id], createElement: tag => new Element(tag)};
  let saved = structuredClone(initial);
  const response = (data, status = 200) => ({ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data)});
  const fetchImpl = async (path, options) => {
    requests.push({path, options});
    if (api) { const result = await api(path, options, saved); if (result) return result; }
    if (path.endsWith('/complete')) { saved.state = 'completed'; return response(saved); }
    if (options.method === 'DELETE') { saved.files = saved.files.filter(value => !path.endsWith(value.id)); return response(saved); }
    return response(saved);
  };
  const window = {location: {hash: '#' + TOKEN, pathname: '/documents'}, history: {replaceState: (...args) => urls.push(args)}, crypto: crypto.webcrypto, URL: {createObjectURL: () => 'blob:local-' + crypto.randomUUID(), revokeObjectURL: value => revoked.push(value)}, setInterval: () => 1, clearInterval() {}, addEventListener() {}, scrollTo() {}};
  const binaryRequest = async (path, options) => {
    binaries.push({path, options});
    options.onProgress(70);
    if (upload) return upload(path, options, saved, response);
    const created = file(options.headers['X-Upload-Role'], {clientKey: options.headers['X-Idempotency-Key'], size: options.body.size, mimeType: options.body.type}); saved.files.push(created);
    return {...saved, file: created};
  };
  const page = UI.createUploadPage({window, document, fetchImpl, binaryRequest});
  const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const add = async (role, files = [{type: 'image/png', size: 1400}]) => { nodes[role + '-input'].files = files; await nodes[role + '-input'].fire('change'); await tick(); };
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  return {page, nodes, requests, binaries, revoked, urls, add, tick, saved: () => saved, response, descendants};
}

test('single-role upload stays in its slot, reports actual save and completes before showing WhatsApp return', async () => {
  const h = harness(); await h.page.start();
  assert.deepEqual(h.urls[0], [null, '', '/documents']);
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(h.requests[0].path.includes(TOKEN), false);
  assert.equal(h.nodes['complete-button'].disabled, true);
  await h.add('residence', [{type: 'image/png', size: 1400}, {type: 'image/jpeg', size: 1200}]);
  assert.equal(h.binaries.length, 2);
  assert.equal(h.binaries.every(value => value.options.headers['X-Upload-Role'] === 'residence'), true);
  assert.equal(h.nodes['residence-files'].textContent.includes('تم الحفظ'), true);
  assert.equal(h.nodes['residence-input'].disabled, true);
  assert.equal(h.nodes['complete-button'].disabled, false);
  assert.equal(h.requests.some(value => value.path.endsWith('/complete')), false);
  await h.nodes['upload-form'].fire('submit');
  assert.equal(h.saved().state, 'completed');
  assert.equal(h.nodes['success-view'].hidden, false);
  assert.equal(h.nodes['whatsapp-link'].hidden, false);
  assert.equal(h.nodes['whatsapp-link'].href, h.saved().whatsappUrl);
  assert.equal(new URL(h.nodes['whatsapp-link'].href).searchParams.get('text'), 'تم رفع المستندات');
  assert.match(h.nodes['return-copy'].textContent, /رسالة «تم رفع المستندات». أرسلها هناك/);
  assert.equal(h.revoked.length, 2);
  assert.equal(h.requests.some(value => /payment|portal|consent/.test(value.path)), false);
});
test('uncertain upload retries its original idempotency key and never claims an unsaved image was saved', async () => {
  let attempts = 0;
  const h = harness({upload: async (path, options, saved) => {
    if (++attempts === 1) throw Object.assign(new Error('UPLOAD_NETWORK'), {code: 'UPLOAD_NETWORK'});
    const created = file('passport', {clientKey: options.headers['X-Idempotency-Key']}); saved.files.push(created); return {...saved, file: created};
  }});
  await h.page.start(); await h.add('passport');
  assert.equal(h.nodes['passport-files'].textContent.includes('تم الحفظ'), false);
  assert.equal(h.nodes['complete-button'].disabled, true);
  const retry = h.descendants(h.nodes['passport-files']).find(node => node.className === 'retry-file');
  const remove = h.descendants(h.nodes['passport-files']).find(node => node.className === 'remove-file');
  assert.equal(remove.disabled, true);
  await retry.fire('click'); await h.tick();
  assert.equal(h.binaries[0].options.headers['X-Idempotency-Key'], h.binaries[1].options.headers['X-Idempotency-Key']);
  assert.equal(h.nodes['passport-files'].textContent.includes('تم الحفظ'), true);
  assert.equal(h.nodes['complete-button'].disabled, false);
});
test('read-back reconciles an accepted upload whose response was lost by exact client key', async () => {
  const h = harness({upload: async (path, options, saved) => {
    saved.files.push(file('passport', {clientKey: options.headers['X-Idempotency-Key']})); throw Object.assign(new Error('UPLOAD_NETWORK'), {code: 'UPLOAD_NETWORK'});
  }});
  await h.page.start(); await h.add('passport');
  assert.equal(h.nodes['passport-files'].textContent.includes('تم الحفظ'), true);
  assert.equal(h.nodes['passport-files'].children.length, 1);
  assert.equal(h.nodes['complete-button'].disabled, false);
  assert.equal(h.binaries.length, 1);
});
test('definitely rejected image can be removed and replaced without trapping a filled slot', async () => {
  const h = harness({upload: async () => { throw Object.assign(new Error('UPLOAD_CONTENT_INVALID'), {code: 'UPLOAD_CONTENT_INVALID', status: 400}); }});
  await h.page.start(); await h.add('photo');
  const remove = h.descendants(h.nodes['photo-files']).find(node => node.className === 'remove-file');
  assert.equal(remove.disabled, false); await remove.fire('click');
  assert.equal(h.nodes['photo-files'].children.length, 0);
  assert.equal(h.nodes['photo-input'].disabled, false);
  assert.equal(h.revoked.length, 1);
});
test('file deletion removes only its server-owned exact ID and expiry prevents completion', async () => {
  const first = file('passport');
  const h = harness({initial: session({files: [first]})}); await h.page.start();
  const remove = h.descendants(h.nodes['passport-files']).find(node => node.className === 'remove-file'); await remove.fire('click');
  assert.equal(h.requests.at(-1).path, '/api/visa-upload/files/' + first.id);
  assert.equal(h.requests.at(-1).options.method, 'DELETE');
  assert.equal(h.nodes['passport-files'].children.length, 0);
  const expired = harness({initial: session({expiresAt: Date.now() - 1, files: [file()]})}); await expired.page.start(); await expired.nodes['upload-form'].fire('submit');
  assert.equal(expired.nodes['link-error'].hidden, false);
  assert.equal(expired.requests.some(value => value.path.endsWith('/complete')), false);
});
test('malicious session strings never become HTML or an external return link', async () => {
  const h = harness({initial: session({files: [file('passport', {filename: '<img src=x onerror=alert(1)>', customer: 'other'})], whatsappUrl: 'javascript:alert(1)', displayName: '<script>bad</script>'})}); await h.page.start();
  assert.equal(h.nodes['passport-files'].textContent.includes('onerror'), false);
  await h.nodes['upload-form'].fire('submit');
  assert.equal(h.nodes['whatsapp-link'].hidden, true);
});
test('a temporary connection failure can retry the same in-memory link without requesting a new credential', async () => {
  let attempts = 0;
  const h = harness({api: async path => { if (path.endsWith('/session') && ++attempts === 1) throw Error('offline'); }});
  await h.page.start();
  assert.equal(h.nodes['retry-session'].hidden, false);
  assert.equal(h.nodes['error-heading'].textContent, 'نحاول الاتصال بملفك');
  await h.nodes['retry-session'].fire('click');
  assert.equal(h.nodes['upload-view'].hidden, false);
  assert.equal(h.requests[1].options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(h.urls.length, 1);
});

const mrzOption = () => ({available: true, provider: 'openai', readerFingerprint: 'b'.repeat(64), inputPolicy: 'upright_page_internal_mrz_crop_v1', policySha256: 'c'.repeat(64), description: '<script>server text cannot supply consent copy</script>'});
test('optional OpenAI MRZ consent is hidden when unavailable and always starts unchecked', async () => {
  const absent = harness({initial: session({files: [file()]})}); await absent.page.start();
  assert.equal(absent.nodes['mrz-consent-option'].hidden, true); assert.equal(absent.nodes['mrz-consent'].checked, false);
  const present = harness({initial: session({files: [file()], mrzConsent: mrzOption()})}); await present.page.start();
  assert.equal(present.nodes['mrz-consent-option'].hidden, false); assert.equal(present.nodes['mrz-consent'].checked, false);
  assert.match(present.nodes['mrz-consent-copy'].textContent, /اختياري/); assert.match(present.nodes['mrz-consent-copy'].textContent, /OpenAI/); assert.match(present.nodes['mrz-consent-copy'].textContent, /MRZ/); assert.equal(present.nodes['mrz-consent-copy'].textContent.includes('<script>'), false);
  const html = fs.readFileSync(require.resolve('../src/visa-upload.html'), 'utf8'); assert.match(html, /id="mrz-consent" type="checkbox"/); assert.equal(/id="mrz-consent"[^>]*\bchecked\b/.test(html), false);
});
test('finishing without optional checkbox keeps empty legacy completion body', async () => {
  const h = harness({initial: session({files: [file()], mrzConsent: mrzOption()})}); await h.page.start(); await h.nodes['upload-form'].fire('submit');
  const complete = h.requests.find(value => value.path.endsWith('/complete')); assert.equal(complete.options.body, undefined); assert.equal(complete.options.headers['Content-Type'], undefined);
});
test('only affirmative checkbox sends bounded exact server policy, without media or client profile selection', async () => {
  const h = harness({initial: session({files: [file()], mrzConsent: mrzOption()})}); await h.page.start(); h.nodes['mrz-consent'].checked = true; await h.nodes['upload-form'].fire('submit');
  const complete = h.requests.find(value => value.path.endsWith('/complete')); assert.deepEqual(JSON.parse(complete.options.body), {mrzConsent: {accepted: true, policySha256: mrzOption().policySha256}}); assert.equal(complete.options.headers['Content-Type'], 'application/json'); assert.equal(complete.options.credentials, 'omit'); assert.equal(complete.options.referrerPolicy, 'no-referrer');
});
test('malformed remote consent profiles remain unavailable and never send opt-in', async () => {
  for (const changed of [{provider: 'other'}, {readerFingerprint: 'bad'}, {inputPolicy: '<script>'}, {policySha256: 'bad'}, {available: 'true'}]) {
    const h = harness({initial: session({files: [file()], mrzConsent: {...mrzOption(), ...changed}})}); await h.page.start(); h.nodes['mrz-consent'].checked = true; await h.nodes['upload-form'].fire('submit'); assert.equal(h.nodes['mrz-consent-option'].hidden, true); assert.equal(h.requests.find(value => value.path.endsWith('/complete')).options.body, undefined);
  }
});
test('changed advertised consent policy clears a prior checkbox selection', async () => {
  const h = harness({initial: session({files: [file()], mrzConsent: mrzOption()})}); await h.page.start(); h.nodes['mrz-consent'].checked = true; h.saved().mrzConsent.policySha256 = 'd'.repeat(64); await h.add('residence'); assert.equal(h.nodes['mrz-consent'].checked, false); await h.nodes['upload-form'].fire('submit'); assert.equal(h.requests.find(value => value.path.endsWith('/complete')).options.body, undefined);
});
test('privacy notice distinguishes Google Gemini full-page processing from optional OpenAI MRZ processing', () => {
  const html = fs.readFileSync(require.resolve('../src/privacy.html'), 'utf8'); assert.match(html, /Google Gemini/); assert.match(html, /OpenAI/); assert.match(html, /ترك ذلك الخيار دون تحديد لا يعطّل معالجة Google Gemini/); assert.match(html, /غير محدد مسبقًا/); assert.match(html, /لا يقدم هذا الإشعار ضمانًا بعدم الاحتفاظ/); assert.equal(html.includes('لا يطلب هذا المساعد صور جوازات السفر'), false); assert.equal(html.includes('لا توجد قاعدة بيانات لحفظ المحادثات'), false); assert.equal(html.includes('لا تتضمن إرسال محتوى المحادثة إلى مزود'), false);
});

test('completed-page revoke control is opt-in only and sends no source or profile selection',async()=>{
 const ordinary=harness({initial:session({state:'completed',files:[file()]})});await ordinary.page.start();assert.equal(ordinary.nodes['mrz-revoke-panel'].hidden,true);
 const h=harness({initial:session({state:'completed',files:[file()],mrzConsentRevocable:true}),api:async(path,options,saved)=>{if(path.endsWith('/mrz-consent/revoke')){delete saved.mrzConsentRevocable;return{ok:true,status:200,text:async()=>JSON.stringify(saved)};}}});await h.page.start();assert.equal(h.nodes['mrz-revoke-panel'].hidden,false);await h.nodes['mrz-revoke-button'].fire('click');const revoke=h.requests.find(value=>value.path.endsWith('/mrz-consent/revoke'));assert.equal(revoke.options.method,'POST');assert.equal(revoke.options.body,undefined);assert.equal(revoke.options.headers.Authorization,'Bearer '+TOKEN);assert.equal(h.nodes['mrz-revoke-panel'].hidden,true);assert.equal(h.nodes['mrz-revoke-status'].hidden,false);assert.match(h.nodes['mrz-revoke-status'].textContent,/لم تُنفذ بعد/);
});
test('uncertain revocation never claims success and leaves a retry control',async()=>{
 const h=harness({initial:session({state:'completed',files:[file()],mrzConsentRevocable:true}),api:async(path)=>{if(path.endsWith('/mrz-consent/revoke'))throw Error('synthetic connection loss');}});await h.page.start();await h.nodes['mrz-revoke-button'].fire('click');assert.equal(h.nodes['mrz-revoke-status'].hidden,true);assert.equal(h.nodes['mrz-revoke-error'].hidden,false);assert.equal(h.nodes['mrz-revoke-button'].disabled,false);assert.equal(h.nodes['mrz-revoke-panel'].hidden,false);
 const html=fs.readFileSync(require.resolve('../src/visa-upload.html'),'utf8');assert.match(html,/لا يحذف بيانات سبق إرسالها إلى OpenAI/);
});
