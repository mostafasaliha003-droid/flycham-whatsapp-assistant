'use strict';

const {safeGraphFailure} = require('./graph-api');
const {QUESTION_CATALOG, validateAnswer} = require('./visa-client-questions');
const {createHash} = require('node:crypto');
const sharp = require('sharp');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPTION = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1000000;
const OTP_TEMPLATE_BODY = 'تحديث مهمة متابعة طلب تأشيرة لدى شركة الرمال. مرجع المهمة: {{1}}. مرجع الإجراء: {{2}}. تحتاج المهمة إلى إجراء من مسؤول المكتب لاستكمال المعالجة. اختر «متابعة المهمة» لعرض الإجراء المطلوب.';
const PAYMENT_TEMPLATE_BODY = 'أهلاً، معك إسماعيل من شركة الرمال. تم تأكيد استلام دفعتك وبدأ تجهيز طلب التأشيرة. مرجع المتابعة: {{1}}. يرجى الرد على هذه الرسالة لاستكمال البيانات المطلوبة ومتابعة الطلب. هذا التأكيد لا يعني صدور التأشيرة.';
const TEMPLATE_REJECTION_CODES = new Set(['ABUSIVE_CONTENT', 'PROMOTIONAL', 'SCAM', 'INCORRECT_CATEGORY', 'TAG_CONTENT_MISMATCH', 'INVALID_FORMAT', 'CATEGORY_NOT_AVAILABLE', 'NONE']);
const FIELD_LABELS = Object.freeze({
  maritalStatus: 'الحالة الاجتماعية', previousNationality: 'جنسية سابقة', previousNationalityDetails: 'تفاصيل الجنسية السابقة',
  travelledLastFiveYears: 'سفر خلال خمس سنوات', travelHistory: 'تفاصيل السفر', performUmrah: 'نية أداء العمرة', gccResident: 'إقامة خليجية سارية',
  priorGccDeportation: 'إبعاد أو ترحيل سابق', priorGccRuleViolation: 'منع دخول أو مخالفة سابقة',
  'health.hospitalizedOrEmergency': 'تنويم بالمستشفى أو علاج طارئ حالياً', 'health.accidentDisability': 'إصابة حادث أو إعاقة', 'health.congenitalCondition': 'حالة صحية أو عيب خلقي',
  saudiAddress: 'العنوان في السعودية', birthPlace: 'مكان الميلاد', sex: 'الجنس في الجواز', latinFirstName: 'الاسم الأول باللاتينية', latinFamilyName: 'اسم العائلة باللاتينية',
  latinFatherName: 'اسم الأب باللاتينية', latinGrandfatherName: 'اسم الجد باللاتينية', arabicFirstName: 'الاسم الأول بالعربية', arabicFamilyName: 'اسم العائلة بالعربية',
  arabicFatherName: 'اسم الأب بالعربية', arabicGrandfatherName: 'اسم الجد بالعربية', passportNumber: 'رقم الجواز', passportType: 'نوع الجواز', nationalityCode: 'رمز الجنسية',
  issuingCountryCode: 'رمز دولة إصدار الجواز', birthDate: 'تاريخ الميلاد', issueDate: 'تاريخ إصدار الجواز', expiryDate: 'انتهاء الجواز', residenceExpiry: 'انتهاء الإقامة',
  emiratesId: 'رقم الهوية الإماراتية', entryDate: 'تاريخ الدخول', 'guardian.relationship': 'صلة ولي الأمر', 'guardian.status': 'تأشيرة ولي الأمر', 'guardian.visaReference': 'رقم تأشيرة ولي الأمر'
});

function failure(code, notDispatched = true) { return Object.assign(Error(code), {code, ...(notDispatched ? {notDispatched: true} : {})}); }
function recipientNumber(value) {
  if (typeof value !== 'string' || !/^\+?[1-9]\d{7,14}$/.test(value)) throw failure('VISA_WHATSAPP_RECIPIENT_INVALID');
  return value.replace(/^\+/, '');
}
function string(value, max, {multiline = true} = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
  return value.trim();
}
function identifier(value) { if (typeof value !== 'string' || !UUID.test(value)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID'); return value; }
function applicant(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 99) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID'); return value; }
function credentials(env) {
  const token = env.WHATSAPP_ACCESS_TOKEN, phoneId = env.WHATSAPP_PHONE_NUMBER_ID, version = env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
  if (typeof token !== 'string' || !token || typeof phoneId !== 'string' || !/^\d{5,30}$/.test(phoneId) || !/^v\d{1,3}\.\d{1,2}$/.test(version)) throw failure('VISA_WHATSAPP_CONFIG_MISSING');
  return {token, base: `https://graph.facebook.com/${version}/${phoneId}`};
}
function visaTemplateConfig(env = process.env) {
  return {name: env.RAAD_OTP_REQUEST_TEMPLATE || '', language: env.RAAD_OTP_REQUEST_TEMPLATE_LANGUAGE || 'ar', wabaId: env.SAUDI_VISA_WABA_ID || '', version: env.WHATSAPP_GRAPH_API_VERSION || 'v23.0'};
}
function visaTemplateRequest({name, language = 'ar'} = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9_]{1,100}$/.test(name) || typeof language !== 'string' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) throw failure('VISA_WHATSAPP_TEMPLATE_CONFIG_INVALID');
  return {name, language, category: 'UTILITY', components: [{type: 'BODY', text: OTP_TEMPLATE_BODY, example: {body_text: [['12345678-1234-4321-abcd-123456789abc', '12345678-1234-4321-abcd-123456789abd']]}}, {type: 'BUTTONS', buttons: [{type: 'QUICK_REPLY', text: 'متابعة المهمة'}]}]};
}
function visaPaymentTemplateConfig(env = process.env) {
  return {name: env.RAAD_VISA_PAYMENT_TEMPLATE || '', language: env.RAAD_VISA_PAYMENT_TEMPLATE_LANGUAGE || 'ar', wabaId: env.SAUDI_VISA_WABA_ID || '', version: env.WHATSAPP_GRAPH_API_VERSION || 'v23.0'};
}
function visaPaymentTemplateRequest({name, language = 'ar'} = {}) {
  // Keep the same bounded name/language validation as the OTP utility template.
  visaTemplateRequest({name, language});
  return {name, language, category: 'UTILITY', components: [{type: 'BODY', text: PAYMENT_TEMPLATE_BODY, example: {body_text: [['case-synthetic-example']]}}]};
}

// Reading the actual Meta approval is required. A configured name alone never
// authorizes delivery outside the recipient's customer service window.
function utilityTemplateSchemaMatches(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every(component => {
    const matching = actual.filter(item => item?.type === component.type);
    if (matching.length !== 1) return false;
    const item = matching[0];
    if (component.type === 'BODY') return item.text === component.text;
    if (component.type === 'BUTTONS') return Array.isArray(item.buttons) && item.buttons.length === 1 && item.buttons[0]?.type === 'QUICK_REPLY' && item.buttons[0].text === component.buttons[0].text;
    return false;
  });
}
function createApprovedUtilityGate({env = process.env, fetchImpl = (...args) => fetch(...args), now = Date.now} = {}, configFor, requestFor) {
  let until = 0, approved = false, state = 'not_configured', pending = null, cachedConfig = null, rejectedReason = null;
  const check = async (config, accessToken) => {
    rejectedReason = null;
    let expected;
    try { expected = requestFor(config); } catch { state = 'not_configured'; return false; }
    if (!/^\d{5,30}$/.test(config.wabaId) || !/^v\d{1,3}\.\d{1,2}$/.test(config.version) || !accessToken) { state = 'not_configured'; return false; }
    try {
      const response = await fetchImpl(`https://graph.facebook.com/${config.version}/${config.wabaId}/message_templates?name=${encodeURIComponent(config.name)}&fields=name,status,language,category,components,rejected_reason`, {headers: {Authorization: 'Bearer ' + accessToken}, signal: AbortSignal.timeout(10000)});
      if (!response.ok) { state = 'unverified'; return false; }
      const data = await response.json(), template = Array.isArray(data?.data) ? data.data.find(item => item?.name === config.name && item.language === config.language) : null;
      if (!template) { state = 'missing'; return false; }
      if (template.status !== 'APPROVED') {
        state = ['PENDING', 'REJECTED', 'PAUSED', 'DISABLED'].includes(template.status) ? template.status.toLowerCase() : 'unverified';
        // This field is a diagnostic code, never a raw provider explanation.
        // Unknown values may contain arbitrary template/private data.
        if (state === 'rejected') rejectedReason = typeof template.rejected_reason === 'string' && template.rejected_reason.length <= 80 && TEMPLATE_REJECTION_CODES.has(template.rejected_reason) ? template.rejected_reason : template.rejected_reason == null ? 'UNAVAILABLE' : 'UNRECOGNIZED_REJECTION_REASON';
        return false;
      }
      if (template.category !== 'UTILITY' || !utilityTemplateSchemaMatches(template.components, expected.components)) { state = 'schema_mismatch'; return false; }
      state = 'approved'; return true;
    } catch { state = 'unverified'; return false; }
  };
  const gate = async () => {
    const config = configFor(env), fingerprint = JSON.stringify([config.name, config.language, config.wabaId, config.version, env.WHATSAPP_ACCESS_TOKEN]);
    if (fingerprint !== cachedConfig) { cachedConfig = fingerprint; until = 0; approved = false; pending = null; }
    if (now() < until) return approved;
    if (pending) return pending;
    const work = check(config, env.WHATSAPP_ACCESS_TOKEN).then(result => { if (fingerprint !== cachedConfig) return false; approved = result; until = now() + 60000; return result; }).finally(() => { if (pending === work) pending = null; });
    pending = work; return work;
  };
  gate.status = () => ({state, approved, checked: until > 0, ...(state === 'rejected' ? {rejectedReason: rejectedReason || 'UNAVAILABLE'} : {})});
  return gate;
}
function createVisaTemplateGate(options = {}) { return createApprovedUtilityGate(options, visaTemplateConfig, visaTemplateRequest); }
function createVisaPaymentTemplateGate(options = {}) { return createApprovedUtilityGate(options, visaPaymentTemplateConfig, visaPaymentTemplateRequest); }

function interactive(text, token, options, summary = false) {
  const rows = options.map(option => ({id: `${summary ? 'visa_confirm' : 'visa_answer'}:${token}:${option.id}`, title: option.label}));
  return rows.length <= 3
    ? {type: 'interactive', interactive: {type: 'button', body: {text}, action: {buttons: rows.map(reply => ({type: 'reply', reply}))}}}
    : {type: 'interactive', interactive: {type: 'list', body: {text}, action: {button: 'اختر الإجابة', sections: [{rows}]}}};
}
function optionsFor(value, summary = false) {
  if (!Array.isArray(value) || value.length > 10 || summary && value.length !== 2) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
  const options = value.map(option => {
    if (!option || typeof option.id !== 'string' || !OPTION.test(option.id)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    if (!summary && !['string', 'boolean', 'number'].includes(typeof option.value) || typeof option.value === 'number' && !Number.isFinite(option.value)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    if (typeof option.value === 'string') string(option.value, 1500, {multiline: false});
    return {id: option.id, label: string(option.label, value.length <= 3 ? 20 : 24, {multiline: false})};
  });
  if (new Set(options.map(option => option.id)).size !== options.length || summary && (options[0].id !== 'confirm' || options[1].id !== 'correct')) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
  return options;
}
function renderSummary(payload) {
  const heading = string(payload.text, 1024), token = identifier(payload.token);
  applicant(payload.applicantIndex);
  const options = optionsFor(payload.options, true);
  if (!Array.isArray(payload.entries) || !payload.entries.length || payload.entries.length > 40) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
  const fields = new Set();
  const entries = payload.entries.map(entry => {
    if (!entry || typeof entry.field !== 'string' || !Object.hasOwn(FIELD_LABELS, entry.field) || fields.has(entry.field)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    fields.add(entry.field); string(entry.label, 1024);
    const definition = QUESTION_CATALOG[entry.field];
    if (entry.value === null) {
      // Only an explicitly answered controlling choice can make its catalog
      // detail inapplicable. Null never supplies a missing medical answer.
      const dependency = definition?.dependsOn;
      const controlling = dependency && payload.entries.find(item => item?.field === dependency.field);
      if (!controlling || controlling.value === dependency.value) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
      try { validateAnswer(dependency.field, controlling.value); } catch { throw failure('VISA_WHATSAPP_PAYLOAD_INVALID'); }
      return `${FIELD_LABELS[entry.field]}: غير منطبق`;
    }
    try { validateAnswer(entry.field, entry.value); } catch { throw failure('VISA_WHATSAPP_PAYLOAD_INVALID'); }
    let value;
    if (typeof entry.value === 'boolean') value = entry.value ? 'نعم' : 'لا';
    else if (typeof entry.value === 'string') {
      value = string(entry.value, 1500, {multiline: false});
      if (definition?.type === 'choice') {
        const option = definition.options.find(item => item.value === entry.value);
        if (!option) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
        value = option.label;
      }
    }
    else throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    return `${FIELD_LABELS[entry.field]}: ${value}`;
  });
  const full = heading + '\n\n' + entries.join('\n');
  if (full.length <= 1024) return [interactive(full, token, options, true)];
  const chunks = []; let chunk = heading;
  for (const entry of entries) { if (chunk.length + entry.length + 1 > 4096) { chunks.push({type: 'text', text: {preview_url: false, body: chunk}}); chunk = ''; } chunk += (chunk ? '\n' : '') + entry; }
  if (chunk) chunks.push({type: 'text', text: {preview_url: false, body: chunk}});
  chunks.push(interactive(heading, token, options, true));
  return chunks;
}
function renderPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
  if (payload.type === 'text') return [{type: 'text', text: {preview_url: false, body: string(payload.text, 4096)}}];
  if (payload.type === 'question') {
    const body = string(payload.text, 1024), token = identifier(payload.token), options = optionsFor(payload.options);
    applicant(payload.applicantIndex);
    if (typeof payload.field !== 'string' || !Object.hasOwn(FIELD_LABELS, payload.field)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    return [options.length ? interactive(body, token, options) : {type: 'text', text: {preview_url: false, body}}];
  }
  if (payload.type === 'answer_summary') return renderSummary(payload);
  if (payload.type === 'document') {
    identifier(payload.mediaId);
    if (payload.mimeType !== 'application/pdf' || typeof payload.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.pdf$/i.test(payload.filename)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    string(payload.caption, 1024);
    return null;
  }
  if (payload.type === 'image') {
    identifier(payload.mediaId);
    if (!['passport', 'residence', 'photo'].includes(payload.kind) || !['image/jpeg', 'image/png'].includes(payload.mimeType)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    if (payload.purpose !== undefined && !['raad_portal_upload', 'visa_client_preview'].includes(payload.purpose)) throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    string(payload.caption, 1024);
    return null;
  }
  throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
}

function createVisaWhatsAppAdapter({env = process.env, fetchImpl = (...args) => fetch(...args), mediaStore, journal, templateGate, paymentTemplateGate, now = Date.now} = {}) {
  const gate = templateGate || createVisaTemplateGate({env, fetchImpl, now});
  const paymentGate = paymentTemplateGate || createVisaPaymentTemplateGate({env, fetchImpl, now});
  const windowOpen = recipient => { try { return journal?.summary?.(recipient)?.serviceWindowOpen === true; } catch { return false; } };
  const paused = reason => ({paused: true, reason});
  async function guardNow(guard) {
    if (typeof guard !== 'function') throw failure('VISA_WHATSAPP_GUARD_REQUIRED');
    try { if (await guard() === false) throw failure('VISA_WHATSAPP_MESSAGE_SUPERSEDED'); }
    catch { throw failure('VISA_WHATSAPP_MESSAGE_SUPERSEDED'); }
  }
  async function request(url, options) {
    let response;
    try { response = await fetchImpl(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30000)}); }
    catch { throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false); }
    let data;
    try { data = await response.json(); } catch { throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false); }
    if (!response.ok) throw failure(safeGraphFailure(response.status, data), false);
    if (data?.error) throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false);
    return data;
  }
  async function dispatch(recipient, message, guard, config, requiresWindow) {
    await guardNow(guard);
    if (requiresWindow && !windowOpen(recipient)) return paused('service_window_closed');
    const result = await request(config.base + '/messages', {method: 'POST', headers: {Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json'}, body: JSON.stringify({messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...message})});
    if (typeof result?.messages?.[0]?.id !== 'string' || !result.messages[0].id || result.messages[0].id.length > 500) throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false);
    // Return only the acceptance ID. Never persist an arbitrary provider echo.
    return {messages: [{id: result.messages[0].id}]};
  }
  async function sendOperatorOtp(input, guard, metadata = {}) {
    if (!input || typeof input !== 'object') throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
    const recipient = recipientNumber(env.RAAD_OTP_OWNER_WHATSAPP || env.RAAD_OTP_OWNER_RECIPIENT), jobId = identifier(input.jobId || metadata.jobId), challengeId = identifier(input.challengeId || metadata.challengeId);
    const body = string(input.text, 4096);
    if (input.recipient !== undefined && recipientNumber(input.recipient) !== recipient) throw failure('VISA_WHATSAPP_RECIPIENT_MISMATCH');
    await guardNow(guard);
    if (String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false') return {dryRun: true};
    if (windowOpen(recipient)) return dispatch(recipient, {type: 'text', text: {preview_url: false, body}}, guard, credentials(env), true);
    if (metadata.noticeMessageId !== undefined) return {...paused('owner_action_required'), noticeMessageId: string(metadata.noticeMessageId, 500, {multiline: false})};
    const config = credentials(env);
    let approved = false;
    try { approved = await gate() === true; } catch {}
    if (!approved) return paused('approved_utility_template_required');
    await guardNow(guard);
    const template = visaTemplateConfig(env); visaTemplateRequest(template);
    const notice = await dispatch(recipient, {type: 'template', template: {name: template.name, language: {code: template.language}, components: [{type: 'body', parameters: [{type: 'text', text: jobId}, {type: 'text', text: challengeId}]}, {type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{type: 'payload', payload: 'visa_owner_action:' + challengeId}]}]}}, guard, config, false);
    // This acceptance belongs to the operational notice only. The actual
    // prompt is sent after the owner's reply reopens the service window.
    return {...paused('owner_action_required'), noticeMessageId: notice.messages[0].id};
  }
  async function sendOperatorNotice(input,guard){
    const recipient=recipientNumber(env.RAAD_OPERATOR_NOTICE_WHATSAPP),jobId=identifier(input.jobId),noticeId=identifier(input.noticeId),body=string(input.text,4096);
    if(recipientNumber(input.recipient)!==recipient)throw failure('VISA_WHATSAPP_RECIPIENT_MISMATCH');
    await guardNow(guard);if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return{dryRun:true};
    if(windowOpen(recipient))return dispatch(recipient,{type:'text',text:{preview_url:false,body}},guard,credentials(env),true);
    if(input.noticeMessageId)return{...paused('owner_action_required'),noticeMessageId:string(input.noticeMessageId,500,{multiline:false})};
    let approved=false;try{approved=await gate()===true;}catch{}if(!approved)return paused('approved_utility_template_required');
    await guardNow(guard);const template=visaTemplateConfig(env);visaTemplateRequest(template);
    const notice=await dispatch(recipient,{type:'template',template:{name:template.name,language:{code:template.language},components:[{type:'body',parameters:[{type:'text',text:jobId},{type:'text',text:noticeId}]},{type:'button',sub_type:'quick_reply',index:'0',parameters:[{type:'payload',payload:'visa_operator_action:'+noticeId}]}]}},guard,credentials(env),false);
    return{...paused('owner_action_required'),noticeMessageId:notice.messages[0].id};
  }
  async function sendReceiptNotice(input,guard){
    const recipient=recipientNumber(env.RAAD_RECEIPT_NOTICE_WHATSAPP||require('./visa-receipt-notifications').RECEIPT_NOTICE_RECIPIENT),jobId=identifier(input.jobId),noticeId=identifier(input.noticeId),body=string(input.text,4096);
    if(recipientNumber(input.recipient)!==recipient)throw failure('VISA_WHATSAPP_RECIPIENT_MISMATCH');
    await guardNow(guard);if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return{dryRun:true};
    if(windowOpen(recipient))return dispatch(recipient,{type:'text',text:{preview_url:false,body}},guard,credentials(env),true);
    if(input.noticeMessageId)return{...paused('owner_action_required'),noticeMessageId:string(input.noticeMessageId,500,{multiline:false})};
    let approved=false;try{approved=await gate()===true;}catch{}if(!approved)return paused('approved_utility_template_required');
    await guardNow(guard);const template=visaTemplateConfig(env);visaTemplateRequest(template);
    const notice=await dispatch(recipient,{type:'template',template:{name:template.name,language:{code:template.language},components:[{type:'body',parameters:[{type:'text',text:jobId},{type:'text',text:noticeId}]},{type:'button',sub_type:'quick_reply',index:'0',parameters:[{type:'payload',payload:'visa_receipt_action:'+noticeId}]}]}},guard,credentials(env),false);
    return{...paused('owner_action_required'),noticeMessageId:notice.messages[0].id};
  }
  async function sendCoordinationNotice(input,guard){
    const recipient=recipientNumber('971507993145'),jobId=identifier(input.jobId),noticeId=identifier(input.noticeId),body=string(input.text,4096);
    if(recipientNumber(input.recipient)!==recipient)throw failure('VISA_WHATSAPP_RECIPIENT_MISMATCH');
    await guardNow(guard);if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return{dryRun:true};
    if(windowOpen(recipient))return input.questionOnly?{windowOpen:true}:dispatch(recipient,{type:'text',text:{preview_url:false,body}},guard,credentials(env),true);
    if(input.noticeMessageId)return{...paused('owner_action_required'),noticeMessageId:string(input.noticeMessageId,500,{multiline:false})};
    let approved=false;try{approved=await gate()===true;}catch{}if(!approved)return paused('approved_utility_template_required');
    await guardNow(guard);const template=visaTemplateConfig(env);visaTemplateRequest(template);
    const notice=await dispatch(recipient,{type:'template',template:{name:template.name,language:{code:template.language},components:[{type:'body',parameters:[{type:'text',text:jobId},{type:'text',text:noticeId}]},{type:'button',sub_type:'quick_reply',index:'0',parameters:[{type:'payload',payload:'visa_coordination_action:'+noticeId}]}]}},guard,credentials(env),false);
    return{...paused('owner_action_required'),noticeMessageId:notice.messages[0].id};
  }
  async function send(to, payload, guard, metadata = {}) {
    const recipient = recipientNumber(to), rendered = renderPayload(payload);
    if (metadata?.kind === 'owner_otp_request') {
      if (payload.type !== 'text') throw failure('VISA_WHATSAPP_PAYLOAD_INVALID');
      return sendOperatorOtp({recipient, jobId: metadata.jobId, challengeId: metadata.challengeId, text: payload.text}, guard, metadata);
    }
    const operatorCoordination=metadata?.coordination?.actor==='operator' && recipient===recipientNumber('971507993145') && metadata.coordination.recipient===recipient && ['applicant_question','applicant_answer_summary'].includes(metadata.kind) && ['question','answer_summary'].includes(payload.type);
    if (!operatorCoordination && recipientNumber(metadata?.customer) !== recipient) throw failure('VISA_WHATSAPP_RECIPIENT_MISMATCH');
    await guardNow(guard);
    if (String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false') return {dryRun: true};
    if (!windowOpen(recipient)) {
      if (metadata?.kind !== 'payment_confirmation' || payload.type !== 'text') return paused('service_window_closed');
      const caseId = metadata.caseId;
      if (typeof caseId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(caseId) || /^\d{8,16}$/.test(caseId)) return paused('payment_case_reference_required');
      let approved = false;
      try { approved = await paymentGate() === true; } catch {}
      if (!approved) return paused('approved_utility_template_required');
      await guardNow(guard);
      const template = visaPaymentTemplateConfig(env); visaPaymentTemplateRequest(template);
      return dispatch(recipient, {type: 'template', template: {name: template.name, language: {code: template.language}, components: [{type: 'body', parameters: [{type: 'text', text: caseId}]}]}}, guard, credentials(env), false);
    }
    const config = credentials(env);
    if (payload.type === 'image') {
      if (typeof mediaStore?.read !== 'function' || typeof mediaStore?.get !== 'function') throw failure('VISA_WHATSAPP_IMAGE_UNAVAILABLE');
      let file, expected;
      const purpose = payload.purpose || 'raad_portal_upload';
      const current = () => {
        const raw = mediaStore.records?.[payload.mediaId];
        if (!raw || raw.customer !== metadata.customer || raw.purpose !== purpose || raw.kind !== payload.kind || raw.mimeType !== payload.mimeType || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= now() || !Array.isArray(raw.sourceIds) || raw.sourceIds.length < 1 || raw.sourceIds.length > 2 || new Set(raw.sourceIds).size !== raw.sourceIds.length || expected && raw.checksum !== expected) throw failure('VISA_WHATSAPP_IMAGE_INVALID');
        for (const id of raw.sourceIds) {
          if (typeof id !== 'string' || !UUID.test(id)) throw failure('VISA_WHATSAPP_IMAGE_INVALID');
          let source; try { source = mediaStore.get(id, {customer: metadata.customer}); } catch { throw failure('VISA_WHATSAPP_IMAGE_INVALID'); }
          if (!source || source.customer !== metadata.customer || source.id !== id || !Number.isFinite(source.expiresAt) || source.expiresAt <= now() || source.purpose) throw failure('VISA_WHATSAPP_IMAGE_INVALID');
        }
        return raw;
      };
      try {
        current();
        try { file = await mediaStore.read(payload.mediaId, {customer: metadata.customer}); } catch { throw failure('VISA_WHATSAPP_IMAGE_UNAVAILABLE'); }
        if (file?.metadata?.customer !== metadata.customer || file.metadata.id !== payload.mediaId || file.metadata.mimeType !== payload.mimeType || !Buffer.isBuffer(file.bytes) || !file.bytes.length || file.bytes.length > MAX_IMAGE_BYTES) throw failure('VISA_WHATSAPP_IMAGE_INVALID');
        expected = createHash('sha256').update(file.bytes).digest('hex');
        if (current().checksum !== expected) throw failure('VISA_WHATSAPP_IMAGE_INVALID');
        try {
          const image = sharp(file.bytes, {failOn: 'warning', limitInputPixels: 20000000, sequentialRead: true}), info = await image.metadata();
          if (!['jpeg', 'png'].includes(info.format) || 'image/' + (info.format === 'jpeg' ? 'jpeg' : 'png') !== payload.mimeType || (info.pages || 1) !== 1 || !info.width || !info.height || info.width * info.height > 20000000) throw Error('invalid');
          const decoded = await image.raw().toBuffer(); decoded.fill(0);
        } catch { throw failure('VISA_WHATSAPP_IMAGE_INVALID'); }
        await guardNow(guard); current();
        if (!windowOpen(recipient)) return paused('service_window_closed');
        const form = new FormData(); form.set('messaging_product', 'whatsapp'); form.set('type', payload.mimeType); form.set('file', new Blob([file.bytes], {type: payload.mimeType}), `raad-${payload.kind}.${payload.mimeType === 'image/png' ? 'png' : 'jpg'}`);
        const uploaded = await request(config.base + '/media', {method: 'POST', headers: {Authorization: 'Bearer ' + config.token}, body: form});
        if (typeof uploaded?.id !== 'string' || !/^\d{1,100}$/.test(uploaded.id)) throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false);
        return dispatch(recipient, {type: 'image', image: {id: uploaded.id, caption: payload.caption.trim()}}, async () => { await guardNow(guard); current(); }, config, true);
      } finally { file?.bytes?.fill?.(0); }
    }
    if (payload.type === 'document') {
      if (typeof mediaStore?.read !== 'function') throw failure('VISA_WHATSAPP_DOCUMENT_UNAVAILABLE');
      let file;
      try { file = await mediaStore.read(payload.mediaId, {customer: metadata.customer}); }
      catch { throw failure('VISA_WHATSAPP_DOCUMENT_UNAVAILABLE'); }
      if (file?.metadata?.customer !== metadata.customer || file.metadata.id !== payload.mediaId || file.metadata.mimeType !== 'application/pdf' || file.metadata.expiresAt !== undefined && (!Number.isFinite(file.metadata.expiresAt) || file.metadata.expiresAt <= now()) || !Buffer.isBuffer(file.bytes) || !file.bytes.length || file.bytes.length > MAX_PDF_BYTES || !file.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw failure('VISA_WHATSAPP_DOCUMENT_INVALID');
      const form = new FormData(); form.set('messaging_product', 'whatsapp'); form.set('type', 'application/pdf'); form.set('file', new Blob([file.bytes], {type: 'application/pdf'}), payload.filename);
      await guardNow(guard);
      if (!windowOpen(recipient)) return paused('service_window_closed');
      const uploaded = await request(config.base + '/media', {method: 'POST', headers: {Authorization: 'Bearer ' + config.token}, body: form});
      if (typeof uploaded?.id !== 'string' || !/^\d{1,100}$/.test(uploaded.id)) throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false);
      return dispatch(recipient, {type: 'document', document: {id: uploaded.id, filename: payload.filename, caption: payload.caption.trim()}}, guard, config, true);
    }
    let result;
    for (const message of rendered) {
      let next;
      try { next = await dispatch(recipient, message, guard, config, true); }
      catch (error) { if (result && error?.notDispatched) throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false); throw error; }
      if (next.paused) { if (result) throw failure('VISA_WHATSAPP_OUTCOME_UNCERTAIN', false); return next; }
      result = next;
    }
    return result;
  }
  async function templateReady(configFor, requestFor, check) {
    try {
      credentials(env);
      const config = configFor(env); requestFor(config);
      if (!/^\d{5,30}$/.test(config.wabaId)) return false;
      return await check() === true;
    } catch { return false; }
  }
  async function notificationReadiness() {
    if (String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false') return {paymentTemplateApproved: false, ownerTemplateApproved: false};
    const [paymentTemplateApproved, ownerTemplateApproved] = await Promise.all([templateReady(visaPaymentTemplateConfig, visaPaymentTemplateRequest, paymentGate), templateReady(visaTemplateConfig, visaTemplateRequest, gate)]);
    return {paymentTemplateApproved, ownerTemplateApproved};
  }
  async function ownerNotificationReady() {
    if (String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false') return false;
    let owner;
    try { owner = recipientNumber(env.RAAD_OTP_OWNER_WHATSAPP || env.RAAD_OTP_OWNER_RECIPIENT); credentials(env); }
    catch { return false; }
    try {
      const summary = journal?.summary?.(owner), lastInboundAt = summary?.lastInboundAt ?? journal?.get?.(owner)?.lastInboundAt, currentTime = now();
      // The native application can take 30 minutes and its challenge 5 more.
      // A boolean window flag cannot prove that this much time remains.
      if (summary?.serviceWindowOpen === true && Number.isFinite(lastInboundAt) && Number.isFinite(currentTime) && lastInboundAt >= 0 && lastInboundAt <= currentTime && currentTime - lastInboundAt <= 86400000 - 35 * 60000) return true;
    } catch {}
    return templateReady(visaTemplateConfig, visaTemplateRequest, gate);
  }
  return {send, sendOperatorOtp, sendOperatorNotice, sendReceiptNotice, sendCoordinationNotice, notificationReadiness, ownerNotificationReady, templateStatus: () => gate.status?.() || {state: 'unverified', approved: false}, paymentTemplateStatus: () => paymentGate.status?.() || {state: 'unverified', approved: false}};
}

module.exports = {createVisaWhatsAppAdapter, createVisaTemplateGate, visaTemplateConfig, visaTemplateRequest, OTP_TEMPLATE_BODY, createVisaPaymentTemplateGate, visaPaymentTemplateConfig, visaPaymentTemplateRequest, PAYMENT_TEMPLATE_BODY};
