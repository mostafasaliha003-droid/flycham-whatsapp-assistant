'use strict';
const {paymentReceiptFollowup}=require('./visa-payment-followup');
const {documentClarificationCopy,documentConfirmationCopy,workflowProgressReply}=require('./visa-workflow-progress');

const P = require('./saudi-visa-policy');
const {normalize} = P;
const KINDS = Object.freeze({passport: 'الجواز', residence: 'الهوية أو الإقامة', photo: 'الصورة الشخصية'});
const CONTEXT_MS = 15 * 60 * 1000;
const IMAGE_INTENTS = new Set(['merge', 'enhance', 'send_prepared']);
const ISSUE_COPY = Object.freeze({
  DOCUMENT_UNREADABLE:'ممكن تبعت صورة أوضح للمستند كاملًا، بدون انعكاس؟',
  DOCUMENT_IMAGE_UNSUITABLE:'ممكن تبعت الصورة بحجمها الأصلي؟',
  DOCUMENT_PORTRAIT_REQUIRED:'ممكن تبعت صورة شخصية واضحة بخلفية بيضاء؟'
});
const documentWords = /صور(?:ه|تين)?|الصور|اوراق|جواز|هوي(?:ه|تي|ته|تها|تهم)|اقامه|مستند|مرفق|\b(?:pdf|passport|identity|residence|photo|image|document)s?\b/i;
function detectDocumentStep(text) {
  const value = normalize(typeof text === 'string' ? text.slice(0, 12000) : '').replace(/\s+/g, ' ');
  // These requests belong to the financial, medical or personal-answer flows.
  if (/حساب|ايبان|بنك|دفع|تحويل|ايصال|سعر|قديش|بكم|رسوم|تامين|صحي|صحه|طبي|متزوج|اجتماعي|ترحيل|حرمان|ابعاد/.test(value)) return null;
  if (/^(?:طيب\s+)?شو\s+(?:المطلوب|ناقص|النواقص)(?:\s+(?:هلق|هلء|الان|بعد))?[.!؟? ]*$/.test(value)) return 'requirements';
  if (/^(?:(?:طيب|تمام|اوكي|حاضر|ماشي|ان شاء الله|هلق)\s*[،,]?\s*)*(?:(?:رح|راح|سوف)\s+(?:ابعت|ابعث|ارسل)(?:لك|الكم|ها|هم|هن)?|(?:ابعتلك|ابعثلك|ارسللك)\s+(?:الاوراق|المستندات|الصور))(?:\s+(?:الاوراق|المستندات|الصور|الجواز|الهويه|هلق|الان|بعد شوي|قريبا|لو سمحت))*[.!؟? ]*$/.test(value)) return 'will_send';
  if (/كيف\s+(?:بقدم|اقدم|بدي\s+(?:قدم|اقدم))|شو\s+(?:ابعت|ابعث|ارسل)(?:لك|الكم)?|شو\s+بدك\s+(?:ابعت|ابعث|ارسل)|شو\s+(?:الاوراق|المستندات|الصور)(?:\s+المطلوب[هه]?)?|(?:الاوراق|المستندات)\s+المطلوب[هه]?|طريقه\s+التقديم/.test(value)) return 'requirements';
  if (/(?:بدي|حابب|اريد)\s+(?:اقدم|قدم)(?:\s|$)|جاهز\s+(?:للتقديم|اقدم)|خلينا\s+(?:نقدم|نبلش)|\bi (?:want|would like) to apply\b/.test(value)) return 'apply';
  return null;
}
function requestedKind(text) {
  const kinds = [];
  if (/جواز|\bpassport\b/i.test(text)) kinds.push('passport');
  if (/هوي(?:ه|تي|ته|تها|تهم)|اقامه|\b(?:identity|residence|emirates id)\b/i.test(text)) kinds.push('residence');
  if (/صور(?:ه|تي)\s*(?:الشخصيه|شخصيه)|الصوره الشخصيه|\bportrait\b|\bpersonal photo\b/i.test(text)) kinds.push('photo');
  return kinds.length === 1 ? kinds[0] : null;
}
function shortKind(text) {
  const value = normalize(typeof text === 'string' ? text : '').replace(/[؟?!.]+$/g, '').trim();
  return /^(?:(?:نسخه|صوره)\s+)?(?:الجواز|جواز|جوازي|الهويه|هويه|هويتي|الاقامه|اقامه|الصوره الشخصيه|صوره شخصيه|صورتي الشخصيه|passport|identity|emirates id|residence|portrait|personal photo)$/.test(value) ? requestedKind(value) : null;
}
function pronounReference(value) {
  return /^(?:(?:ممكن|لو سمحت|بليز|ارجوك)\s+)?(?:ادمج(?:هم|هن|هما)|اجمع(?:هم|هن|هما)|حسن(?:ها|هم|هن)|وضح(?:ها|هم|هن)|عدل(?:ها|هم|هن)|رتب(?:ها|هم|هن)|ارسل(?:ها|هم|هن)|ابعت(?:ها|هم|هن)|ابعث(?:ها|هم|هن))(?:\s+(?:لو سمحت|بليز|الي|لي))?[؟?!. ]*$/.test(value);
}
function detectDocumentIntent(text, {hasAttachments = false, hasDocumentContext = false} = {}) {
  const value = normalize(typeof text === 'string' ? text.slice(0, 12000) : '').replace(/\s+/g, ' ');
  if (!value) return null;
  const document = documentWords.test(value), kind = requestedKind(value);
  if(hasDocumentContext&&(/^(?:(?:طيب|يعني|قصدك)\s+)?(?:اي|ايا|ايه)\s+(?:مستند|ملف|صوره|ورقه)(?:\s+(?:بالضبط|مو واضح|مش واضح|غير واضح|مو مقروء|غير مقروء))?[.!؟? ]*$/.test(value)||/شو\s+(?:(?:الي|اللي)\s+)?(?:مو|مش|غير)\s+(?:واضح|مقروء)/.test(value)))return {intent:'status',kind};
  const sentDocuments = /(?:^|\s)(?:بعتلك|بعتتلك|بعثتلك|ارسلتلك|ارسلت لكم|ارسلتها|بعتهم|بعتن|بعتلكم)(?=\s|$|[؟?!.،,])/.test(value);
  const completeness = /^(?:(?:طيب|هل|يعني)\s+)?(?:مو\s*كاملين|مش\s*كاملين|كاملين|مكتملين|شو\s+ناقص)[.!؟? ]*$/.test(value) || /^(?:الاوراق|المستندات|الصور)\s+(?:مو\s*كاملين|مش\s*كاملين|كامل[هه]|مكتمل[هه]|ناقص[هه])[.!؟? ]*$/.test(value);
  if ((document || hasDocumentContext) && (sentDocuments || completeness) && !/(?:رح|راح|سوف|بدي)\s+(?:ابعت|ابعث|ارسل)|لا\s+(?:تبعت|ترسل)/.test(value)) return {intent: 'status', kind};
  if (hasDocumentContext && /^(?:طيب\s+)?(?:شو صار(?:\s+(?:معكن|معكم))?|وين وصلتو|شو وضع الملف|بالانتظار|بانتظارك|ناطر)[.!؟? ]*$/.test(value)) return {intent: 'status', kind};
  const step = detectDocumentStep(value);
  if (step) return {intent: step === 'will_send' ? 'will_send' : 'prepare_application', kind: null};
  if (/تم\s+(?:رفع|ارسال|ارفاق)\s+(?:الصور|المستندات|الاوراق)|رفعت\s+(?:الصور|المستندات|الاوراق)/.test(value)) return {intent: 'status', kind};
  const link = /رابط|لينك|\blink\b/.test(value), upload = /رفع|ارفاق|ارفع|ارفق|تحميل المستند|\bupload\b|\battach\b/.test(value);
  // A payment/insurance link is not the document upload page.
  if (link && (upload || document) && !/(?:رابط|لينك)\s*(?:الدفع|دفع|التامين|تامين)/.test(value)) return {intent: 'upload_link', kind};
  if (hasDocumentContext && /^(?:خلصت|خلصتهم|جهزت|جهزتها|جهزتهم|جهزتهن|دمجتهم|دمجتهن|قراتهم|قريتهم)[؟?!. ]*$/.test(value)) return {intent: 'status', kind};
  const pronoun = pronounReference(value);
  const referencesAttachments = document || (hasAttachments || hasDocumentContext) && pronoun;
  if (!referencesAttachments) return null;
  if (/(?:لا|ما|مو)\s+(?:تدمج|تحسن|تعدل|ترسل|تبعت)|بدون\s+(?:دمج|تحسين|تعديل|ارسال)|\b(?:do not|don't)\s+(?:merge|enhance|send|edit)\b/.test(value)) return null;
  if (/ادمج|دمج|اجمع|جمع(?:لي|هم|هن)|\b(?:merge|combine|stitch)\b/.test(value)) return {intent: 'merge', kind};
  const changingFacts=/(?:عدل|تعديل|غير|تغيير).{0,30}(?:رقم|تاريخ|اسم|بيانات|معلومات)/.test(value);
  if (!changingFacts&&/حسن|تحسين|وضح(?:ها|هم|هن|لي)?(?=\s|$|[،,.؟?])|تعديل الصوره|عدل(?:لي|ها|هم|هن)?(?=\s|$|[،,.؟?])|رتب(?:لي|ها|هم|هن)?(?=\s|$|[،,.؟?])|قص(?:لي|ها|هم|هن)(?=\s|$|[،,.؟?])|دور(?:ها|هم|هن)(?=\s|$|[،,.؟?])|\b(?:enhance|improve|crop|rotate|brighten|edit)\b/.test(value)) return {intent: 'enhance', kind};
  const preparingToUpload = /(?:بدي|كيف|رح|راح)\s+(?:ارسل|ابعت|ابعث)|(?:ارسل|ابعت|ابعث)(?:ها)?\s+(?:لك|الكم)|\b(?:i will send|how (?:do|can) i (?:send|upload))\b/.test(value);
  if (!preparingToUpload && /ارسل|ابعت|ابعث|بعتلي|ورجيني|عاين|\b(?:send|show|download)\b/.test(value) && (kind || pronoun || /جاهز|مجهز|مدموج|نسخه|لي الصوره|الصور الي|\b(?:prepared|ready|merged|me)\b/.test(value))) return {intent: 'send_prepared', kind};
  if (/قرا(?:ت|يتها|يتهم|تهن)|قريت|قراءه|واضح|دمجت|جهزت|خلصت|شو صار|وين وصلت|حاله الصور|\b(?:read|ready|status|finished|clear)\b/.test(value) && !/جود(?:ه|تها)\s*(?:المطلوبه|مطلوبه)|ما هي|شو (?:الصور|المستندات|الاوراق) المطلوب/.test(value)) return {intent: 'status', kind};
  return null;
}
function snapshot(documentIntake, customer) {
  try { const result = documentIntake?.summary?.(customer); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; }
}
function hasPrepared(summary, kind) {
  return Boolean(kind && Array.isArray(summary?.applicants) && summary.applicants.some(applicant => typeof applicant?.documents?.[kind] === 'string' && applicant.documents[kind].length > 0));
}
function receivedDocuments(store, customer, summary, now) {
  const current = store?.data?.visaCases?.[customer];
  if (current && Number.isFinite(current.createdAt) && (!summary?.caseId || summary.caseId === current.id)) {
    const receipts = store.data.visaFulfilment?.cases?.[customer]?.receipts || {};
    const count = Object.values(store.data.visaMedia || {}).filter(item => item?.customer === customer && !item.purpose && !Object.hasOwn(receipts, item.id) && item.receivedAt >= current.createdAt && item.expiresAt > now && (item.type === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(item.mimeType) || item.type === 'document' && item.mimeType === 'application/pdf')).length;
    return {count, exists: count > 0};
  }
  if (Number.isSafeInteger(summary?.sourceCount) && summary.sourceCount >= 0 && summary.sourceCount <= 1000) return {count: summary.sourceCount, exists: summary.sourceCount > 0};
  return {count: null, exists: Array.isArray(summary?.applicants) && summary.applicants.some(applicant => Object.values(applicant?.documents || {}).some(value => typeof value === 'string' && value.length > 0))};
}
function receivedCopy(received) {
  return received.count === 1 ? 'وصلني مرفق واحد ضمن ملفك.' : received.count > 1 ? `وصلتني ${received.count} مرفقات ضمن ملفك.` : 'المستندات الموجودة محفوظة ضمن ملفك.';
}
function preparationCopy(summary, received) {
  if (!received.exists) return 'للبداية ابعت صفحة بيانات الجواز كاملة، وجهي الهوية الإماراتية، وصورة شخصية واضحة بخلفية بيضاء. الصور أو PDF مناسبين، وإذا المستند صفحتين ابعتهن سوا.';
  const issues = [...(Array.isArray(summary?.issues) ? summary.issues : []), ...(Array.isArray(summary?.applicants) ? summary.applicants.flatMap(applicant => Array.isArray(applicant?.issues) ? applicant.issues : []) : [])];
  const clarification=documentClarificationCopy(summary);if(clarification)return clarification;
  if (!summary || ['not_started', 'waiting_case', 'disabled'].includes(summary.status)) return receivedCopy(received) + ' منكمل مراجعتها، وإذا بقي جزء ناقص رح نحدده إلك. ما في داعي تعيد الصور كلها.';
  return statusReply(summary);
}
function statusReply(summary, {kind = null, hasAttachments = false} = {}) {
  if (!summary || ['disabled', 'not_started', 'waiting_case'].includes(summary.status)) return hasAttachments
    ? 'منكمل تجهيز هالصور ضمن ملفك. إذا عندك صفحتين لنفس الجواز أو وجهي الهوية، ابعتهن كاملين هون حتى يترتبوا مع بعض.'
    : 'ابعث صور الجواز والهوية من الجهتين والصورة الشخصية هون، ومنرتّب كل مستند بملفك. إذا المستند صورتين، ابعتهن كاملين.';
  if (['processing', 'queued', 'running', 'retry'].includes(summary.status)) return 'وصلت أوراقك، شكرًا إلك. عم نجهّز ملفك.';
  const clarification=documentClarificationCopy(summary);if(clarification)return clarification;
  if (kind && summary.status === 'ready' && !hasPrepared(summary, kind)) return `نسخة ${KINDS[kind]} لسه ما تأكد تجهيزها ضمن ملفك. منراجع المستند المطلوب قبل إرسال نسخة منه.`;
  if (summary.status === 'ready') return kind && hasPrepared(summary, kind)
    ? `النسخة المجهزة من ${KINDS[kind]} موجودة بملفك.`
    : 'أوراقك جاهزة، ومنكمل معك الخطوة التالية.';
  if (summary.status === 'needs_confirmation') return documentConfirmationCopy(summary);
  const issues = [...(Array.isArray(summary.issues) ? summary.issues : []), ...(Array.isArray(summary.applicants) ? summary.applicants.flatMap(applicant => Array.isArray(applicant?.issues) ? applicant.issues : []) : [])];
  const actionable=new Set(['DOCUMENT_UNREADABLE','DOCUMENT_IMAGE_UNSUITABLE','DOCUMENT_PORTRAIT_REQUIRED']);
  const lines = [...new Set(issues.filter(issue=>actionable.has(issue?.code)).map(issue => ISSUE_COPY[issue.code]).filter(Boolean))].slice(0, 1);
  return lines.length ? lines.join('\n') : 'أوراقك محفوظة معنا، ومنخبرك إذا احتجنا أي معلومة إضافية.';
}
function accepted(result) {
  if (!result || result.paused || result.dryRun || result.uncertain || result.ok === false) return false;
  const id = result.messages?.[0]?.id || (result.accepted === true ? result.messageId : null);
  return typeof id === 'string' && id.length > 0 && id.length <= 500 && !/[\u0000-\u0020\u007f-\u009f]/u.test(id);
}
function uploadUrl(result) {
  if (!result || typeof result.url !== 'string' || result.url.length > 2048 || /[\u0000-\u0020\u007f-\u009f]/u.test(result.url)) return null;
  try { const url = new URL(result.url); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}

// Callbacks own authorization, current-case/source guards and actual delivery.
// This layer only recognizes the request and renders bounded application copy.
function createVisaDocumentConversation({documentIntake, createUploadLink, sendPrepared, store, now = Date.now, operatorCoordination=false} = {}) {
  if (typeof documentIntake?.summary !== 'function') throw Error('DOCUMENT_CONVERSATION_CONFIGURATION_REQUIRED');
  const fallback = new Map();
  const stored = customer => store?.data ? store.data.serviceSessions?.[customer]?.documentConversation : fallback.get(customer);
  const clear = customer => {
    if (store?.data) {
      if (!store.data.serviceSessions?.[customer]?.documentConversation) return;
      delete store.data.serviceSessions[customer].documentConversation;
      try { store.save(); } catch {}
    } else fallback.delete(customer);
  };
  const caseId = (summary, customer) => {
    const id = summary?.caseId || store?.data?.visaCases?.[customer]?.id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
  };
  const context = (customer, summary) => {
    const value = stored(customer), currentCase = caseId(summary, customer), stamp = now();
    if (!value) return null;
    if (!currentCase || value.caseId !== currentCase || !Number.isFinite(value.expiresAt) || value.expiresAt <= stamp || value.expiresAt > stamp + CONTEXT_MS || value.pendingIntent !== null && !IMAGE_INTENTS.has(value.pendingIntent) || value.lastKind !== null && !Object.hasOwn(KINDS, value.lastKind) || value.uploadOfferedAt != null && (!Number.isFinite(value.uploadOfferedAt) || value.uploadOfferedAt > stamp)) { clear(customer); return null; }
    return value;
  };
  const remember = (customer, summary, {pendingIntent = null, lastKind = null, uploadOfferedAt} = {}) => {
    const currentCase = caseId(summary, customer);
    if (!currentCase) return;
    const old = context(customer, summary);
    const value = {caseId: currentCase, pendingIntent, lastKind, expiresAt: now() + CONTEXT_MS, uploadOfferedAt: uploadOfferedAt === undefined ? old?.uploadOfferedAt ?? null : uploadOfferedAt};
    if (store?.data) {
      store.data.serviceSessions ||= {};
      store.data.serviceSessions[customer] ||= {};
      store.data.serviceSessions[customer].documentConversation = value;
      try { store.save(); } catch { delete store.data.serviceSessions[customer].documentConversation; }
    } else fallback.set(customer, value);
  };
  return {async handle(customer, text, {hasAttachments = false, requestId} = {}) {
    const direct = detectDocumentIntent(text, {hasAttachments});
    const possibleContextual = detectDocumentIntent(text, {hasAttachments, hasDocumentContext: true}), roleAnswer = shortKind(text);
    const linkFollowup = stored(customer)?.uploadOfferedAt != null && /رابط|لينك|\blink\b/.test(normalize(text || '')) && !/دفع|تامين|حساب|بنك/.test(normalize(text || ''));
    if (!direct && !possibleContextual && !roleAnswer && !hasAttachments && !linkFollowup) { clear(customer); return {handled: false}; }
    const summary = snapshot(documentIntake, customer), previous = context(customer, summary);
    const hasDocumentContext = Boolean(caseId(summary, customer) && (previous || receivedDocuments(store, customer, summary, now()).exists || ['processing', 'queued', 'running', 'retry', 'ready', 'needs_confirmation', 'needs_review'].includes(summary?.status)));
    let request = direct || (hasDocumentContext ? possibleContextual : null);
    if (!request && linkFollowup && previous?.uploadOfferedAt != null) request = {intent: 'upload_link', kind: null};
    if (!request && roleAnswer && previous?.pendingIntent) request = {intent: previous.pendingIntent, kind: roleAnswer};
    if (!request) {
      if (hasAttachments) remember(customer, summary, {lastKind: requestedKind(normalize(text || ''))});
      else clear(customer);
      return {handled: false};
    }
    if (!request.kind && previous?.lastKind && pronounReference(normalize(text || '').replace(/\s+/g, ' '))) request = {...request, kind: previous.lastKind};
    const result = {handled: true, intent: request.intent, kind: request.kind};
    if (['status','prepare_application'].includes(request.intent)) {
      const progress=workflowProgressReply(store,customer,summary,now());
      if(progress){remember(customer,summary);return {...result,reply:progress};}
    }
    if(operatorCoordination&&['status','prepare_application'].includes(request.intent)){remember(customer,summary);return {...result,reply:require('./remal-service-policy').response('processing')};}
    if (['prepare_application', 'will_send'].includes(request.intent)) {
      const currentCase = store?.data?.visaCases?.[customer], received = receivedDocuments(store, customer, summary, now());
      const products = currentCase?.applicants?.map(person => P.productFor(person)) || [];
      // Qualification and original-document routes remain with the visa engine.
      // A request to proceed never authorizes a different product or a payment.
      if (!currentCase?.quote?.rows?.length || currentCase.quote.requiresReview || !products.length || products.some(product => !product.code.startsWith('tourist'))) return {handled: false};
      remember(customer, summary);
      if (request.intent === 'will_send') return {...result, reply: received.exists
        ? 'تمام، المرفقات اللي وصلت محفوظة ضمن ملفك. ابعت أي جزء باقي هون، ومنكمل على نفس الطلب.'
        : 'تمام، ابعتهن هون لما تجهز، وأنا معك ومنكمل على نفس الطلب.'};
      let reply = preparationCopy(summary, received);
      const documentsPresent = ['ready','needs_confirmation'].includes(summary?.status) && ['passport','residence','photo'].every(kind => hasPrepared(summary,kind));
      if (documentsPresent || received.exists) return {...result, reply:[reply,paymentReceiptFollowup(store,customer,summary)].filter(Boolean).join('\n\n')};
      const recentlyOffered = Number.isFinite(previous?.uploadOfferedAt) && now() - previous.uploadOfferedAt <= CONTEXT_MS;
      if (recentlyOffered) reply += received.exists ? '\nإذا بدك تضيف صورة ناقصة، فيك تستخدم رابط الرفع اللي أرسلته قبل شوي.' : '\nفيك تستخدم رابط الرفع اللي أرسلته قبل شوي، أو تبعت الصور هون.';
      else if (typeof createUploadLink === 'function') {
        try {
          const url = uploadUrl(await createUploadLink(customer, {kind: null}));
          if (url) { remember(customer, summary, {uploadOfferedAt: now()}); reply += (received.exists ? '\n\nإذا بدك تضيف صورة ناقصة، فيك تستخدم رابط ملفك الخاص:' : '\n\nوفيك ترفعهم من رابط ملفك الخاص بدل إرسالهم على واتساب:') + '\n' + url + '\nبعد ما تخلص اضغط «تم» وارجع لهالمحادثة.'; }
        } catch {}
      }
      return {...result, reply};
    }
    remember(customer, summary, {pendingIntent: IMAGE_INTENTS.has(request.intent) && !request.kind ? request.intent : null, lastKind: request.kind || previous?.lastKind || null});
    if (request.intent === 'upload_link') {
      if (typeof createUploadLink === 'function') {
        try {
          const url = uploadUrl(await createUploadLink(customer, {kind: request.kind}));
          if (url) { remember(customer, summary, {lastKind: request.kind, uploadOfferedAt: now()}); return {...result, reply: 'ارفع الجواز والهوية والصورة الشخصية من هالرابط الخاص بملفك:\n' + url + '\n\nبعد ما تخلص اضغط «تم» أو ارجع لهالمحادثة، ومنكمل من نفس النقطة.'}; }
        } catch {}
      }
      return {...result, reply: 'فيك تبعت الصور أو PDF هون بنفس المحادثة. ابعت صفحات الجواز ووجهي الهوية والصورة الشخصية، ومنربطهم بملفك.'};
    }
    if (['merge', 'enhance', 'send_prepared'].includes(request.intent)) {
      if (!request.kind && (request.intent === 'send_prepared' || ['ready', 'needs_confirmation'].includes(summary?.status))) return {...result, reply: 'أي نسخة تقصد: الجواز، الهوية، أو الصورة الشخصية؟'};
      if (request.kind && typeof sendPrepared === 'function' && ['ready', 'needs_confirmation', 'needs_review'].includes(summary?.status)) {
        try {
          const sent = await sendPrepared(customer, {kind: request.kind, intent: request.intent, requestId});
          if (accepted(sent)) return {...result, sent: true, ...(sent.preview === true ? {preview: true} : {}), reply: sent.preview === true
            ? `أرسلت لك نسخة للمعاينة من ${KINDS[request.kind]} هنا. هاي نسخة للمعاينة قبل استخدامها بالطلب.`
            : `أرسلت لك النسخة المجهزة من ${KINDS[request.kind]} هنا.`};
          if (sent?.reason === 'kind_required') return {...result, reply: 'أي نسخة تقصد: الجواز، الهوية، أو الصورة الشخصية؟'};
          if (['not_ready','still_processing','preview_review_required'].includes(sent?.reason)) return {...result, reply: statusReply(snapshot(documentIntake, customer), {...request, hasAttachments})};
          if (['applicant_required','multiple_applicants'].includes(sent?.reason)) return {...result, reply: 'لأي متقدم بدك النسخة؟ حتى نرسل المستند الصحيح بدون خلط الملفات.'};
          if (sent?.paused || sent?.reason === 'service_window_closed') return {...result, reply: 'إرسال النسخة بانتظار استكمال المتابعة على نفس المحادثة.'};
          return {...result, reply: 'ما قدرت ابعت النسخة هلأ. ' + statusReply(snapshot(documentIntake, customer), {...request, hasAttachments})};
        } catch { return {...result, reply: 'ما قدرت ابعت النسخة هلأ. ' + statusReply(snapshot(documentIntake, customer), {...request, hasAttachments})}; }
      }
    }
    const received = request.intent === 'status' ? receivedDocuments(store, customer, summary, now()) : null;
    const reply = received?.exists ? preparationCopy(summary, received) : statusReply(summary, {...request, hasAttachments});
    return {...result, reply: [reply,request.intent==='status'?paymentReceiptFollowup(store,customer,summary):''].filter(Boolean).join('\n\n')};
  }};
}

module.exports = {createVisaDocumentConversation, detectDocumentIntent, detectDocumentStep, statusReply};
