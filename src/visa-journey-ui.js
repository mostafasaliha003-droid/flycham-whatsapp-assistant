'use strict';
/* Protected operations UI. No customer communication is sent by this module. */
(function (root, factory) {
  const api = factory(typeof module==='object'&&module.exports?require('./visa-operator-guidance'):root.RemalVisaOperatorGuidance);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemalVisaJourney = api;
})(typeof window === 'undefined' ? globalThis : window, function (operatorGuidance) {
  const stages = Object.freeze({
    awaiting_payment: ['بانتظار دفعة العميل', 'neutral'],
    awaiting_accountant: ['بانتظار اعتماد المحاسب', 'warn'],
    queued: ['في قائمة التجهيز', 'neutral'],
    preparing: ['رعد يجهّز الطلب', 'blue'],
    awaiting_client: ['بانتظار إجابة العميل', 'warn'],
    awaiting_otp: ['بانتظار تحقق صاحب الحساب', 'warn'],
    saved: ['الطلب محفوظ · دون دفع الرسوم', ''],
    manually_completed: ['استُكمل يدويًا · بتأكيد الموظف', ''],
    printing: ['جارٍ إنشاء نسخة PDF', 'blue'],
    sending: ['جارٍ إرسال نسخة العميل', 'blue'],
    accepted: ['قُبل إرسال النسخة', 'blue'],
    delivered: ['وصلت النسخة للعميل', ''],
    blocked: ['تحتاج تدخّل الفريق', 'danger'],
    not_started: ['لم يبدأ التجهيز', 'neutral'],
    unknown: ['بانتظار تحديث موثوق', 'neutral']
  });
  const aliases = {awaiting_verification: 'awaiting_accountant', receipt_received: 'awaiting_accountant', payment_verified: 'queued', needs_information: 'awaiting_client', ready_for_portal_review: 'queued', ready: 'queued', running: 'preparing', draft: 'preparing', awaiting_answers: 'awaiting_client', needs_followup: 'awaiting_client', awaiting_answer_confirmation: 'awaiting_client', waiting_otp: 'awaiting_otp', saved_application: 'saved', portal_review_required: 'blocked', cancelled: 'blocked', stale: 'blocked', sent: 'accepted', failed: 'blocked', uncertain: 'blocked'};
  const blockerLabels = Object.freeze({OPERATOR_CHALLENGE_EXPIRED:'انتهت مهلة التحقق المرئي؛ افتح جلسة تحقق جديدة',LOGIN_CAPTCHA_TIMEOUT:'انتهت مهلة التحقق المرئي؛ افتح جلسة تحقق جديدة',SAVE_UNCERTAIN:'لم تتأكد نتيجة الحفظ؛ يلزم فحص رعد قبل إعادة التقديم',SAVE_PREFLIGHT_PASSED:'اكتمل فحص النموذج دون حفظ أو إرسال',DOCUMENTS_READING: 'جارٍ قراءة المستندات ومطابقة بياناتها', OWNER_NOTIFICATION_NOT_READY: 'بانتظار جاهزية واتساب لمسؤول المكتب؛ سيُستأنف الطلب تلقائياً عند الجاهزية', BROWSER_STARTING: 'جارٍ تجهيز قناة التقديم؛ سيُستأنف الطلب عند جاهزيتها', DOCUMENTS_REVIEW_REQUIRED: 'راجع المستندات والبيانات في تبويب رعد قبل بدء التقديم', DOCUMENT_DATA_REVIEW_REQUIRED: 'استكمل مطابقة بيانات المستندات قبل التقديم', DOCUMENT_DATA_CONFLICT: 'إجابة المتقدم تختلف عن المستند؛ طابق البيانات قبل المتابعة', DOCUMENTS_REQUIRED: 'اربط الجواز والإقامة والصورة الشخصية بالمتقدم', PREPARATION_REVIEW_REQUIRED: 'استكمل متطلبات تجهيز الملف في تبويب رعد', PORTAL_START_UNCERTAIN: 'نتيجة بدء التقديم غير مؤكدة؛ راجع المرجع قبل الاستئناف', ACCOUNTANT_APPROVAL_REQUIRED: 'اعتماد المحاسب لدفعة هذا الملف مطلوب', CLIENT_ANSWERS_REQUIRED: 'استكمال إجابات المتقدم وتأكيدها', CUSTOMER_BLOCKED: 'التواصل مع العميل محظور · راجع إعدادات المحادثة', COMPLAINT_ACTIVE: 'حسم الشكوى المفتوحة مع الإدارة', HUMAN_OWNERSHIP: 'المحادثة لدى موظف · راجع تسليمها للفريق الآلي', CASE_AMENDMENT_PENDING: 'حسم تعديل ملف التأشيرة قبل استئناف التجهيز', CASE_ALREADY_PROCESSED: 'الملف سبق تقديمه أو معالجته · يحتاج مراجعة', AUTOMATION_PAUSED: 'المتابعة الآلية متوقفة', CASE_CHANGED: 'تغير ملف العميل · أعد مراجعة هذه النسخة', BROWSER_INTERRUPTED: 'انقطع اتصال البوابة · راجع المرحلة قبل الاستئناف', BROWSER_LEASE_EXPIRED: 'انتهت جلسة البوابة · يلزم مراجعتها', OTP_ATTEMPTS_EXHAUSTED: 'تعذر إكمال التحقق · يحتاج تدخّل صاحب الحساب', OTP_RESUME_UNCERTAIN: 'نتيجة استئناف التحقق غير مؤكدة · راجع البوابة', DELIVERY_OUTCOME_UNCERTAIN: 'نتيجة إرسال النسخة غير مؤكدة · تحقق قبل إعادة الإرسال'});
  const eventLabels = Object.freeze({manual_completion_reported:'أكد الموظف استكمال الطلب يدويًا',receipt_received: 'استُلم إيصال العميل للمراجعة', accountant_payment_approved: 'اعتمد المحاسب وصول دفعة العميل', payment_approved: 'اعتمد المحاسب وصول دفعة العميل', case_invalidated: 'تغيرت متطلبات الملف · أُوقفت النسخة السابقة', job_claimed: 'بدأ رعد تجهيز بيانات المتقدم', client_questions_requested: 'أُعدت أسئلة استكمال بيانات المتقدم', applicant_answers_confirmed: 'أكد المتقدم إجاباته', owner_otp_requested: 'طُلب تحقق صاحب الحساب عبر القناة الآمنة', application_saved_without_payment: 'حُفظ الطلب دون دفع رسوم البوابة', message_accepted: 'قُبلت محاولة الإرسال لدى خدمة واتساب', message_delivered: 'تأكد وصول الرسالة للعميل'});
  function blockerText(item) { return typeof item === 'string' ? operatorGuidance?.guidanceFor(item)?.summary || blockerLabels[item] || (/[ء-ي]/.test(item) ? item : 'راجع متطلبات المرحلة في ملف العميل') : item?.label || item?.message || 'راجع متطلبات المرحلة'; }
  function stageOf(value) { const key = aliases[value] || value; return Object.hasOwn(stages, key) ? key : 'unknown'; }
  function applicantStage(job, messages = []) {
    let stage = stageOf(job.state || job.status || job.stage);
    if (stage === 'saved') { const delivery = messages.filter(message => message.kind === 'application_request_copy' && message.jobId === job.id).at(-1); if (delivery && ['sending', 'accepted', 'delivered', 'failed', 'uncertain'].includes(delivery.state)) stage = stageOf(delivery.state); }
    return stage;
  }
  function paymentOf(item) {
    const approval = item.approval, raw = item.clientPayment || item.payment || item.visaCase?.payment || {}, status = raw.status || item.paymentStatus || item.visaCase?.paymentStatus;
    const verified = approval ? approval.state === 'approved' : ['verified', 'confirmed', 'approved'].includes(status);
    const receipts = Array.isArray(item.receipts) ? item.receipts : [], currentReceipts = receipts.filter(receipt => !item.caseSignature || receipt.caseSignature === item.caseSignature);
    const receipt = raw.receiptMediaId || item.receiptMediaId || approval?.receiptId || raw.receipt?.id || currentReceipts.at(-1)?.mediaId || null;
    if (approval?.state === 'approved') return {...raw, verified, receiptMediaId: receipt, status: 'verified', amount: approval.amount, reference: approval.reference};
    return { ...raw, verified, receiptMediaId: receipt, status: verified ? 'verified' : receipt || ['awaiting_verification', 'pending', 'receipt_received', 'awaiting_accountant'].includes(status) ? 'awaiting_accountant' : 'awaiting_payment' };
  }
  function receiptChoices(item) {
    const rows = new Map(), receipts = Array.isArray(item.receipts) ? item.receipts : [], available = value => !['unavailable', 'failed', 'expired'].includes(value.status) && (!value.customer || String(value.customer) === item.customer);
    for (const receipt of receipts) { const id = receipt.mediaId || receipt.id; if (typeof id === 'string' && available(receipt)) rows.set(id, {...receipt, id, registered: true, current: !item.caseSignature || !receipt.caseSignature || receipt.caseSignature === item.caseSignature}); }
    for (const file of Array.isArray(item.media) ? item.media : []) { if (typeof file.id !== 'string' || !available(file) || file.purpose || file.status === 'application_copy' || file.derived === true || file.isDerived === true || file.sourceIds?.length || !/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimeType || '')) continue; rows.set(file.id, {...file, ...rows.get(file.id), id: file.id}); }
    return [...rows.values()];
  }
  const documentFields = Object.freeze({latinFirstName:'الاسم الأول باللاتينية',latinFamilyName:'اسم العائلة باللاتينية',latinFatherName:'اسم الأب باللاتينية',latinGrandfatherName:'اسم الجد باللاتينية',latinFullName:'الاسم الكامل باللاتينية',arabicFirstName:'الاسم الأول بالعربية',arabicFatherName:'اسم الأب بالعربية',arabicGrandfatherName:'اسم الجد بالعربية',arabicFamilyName:'اسم العائلة بالعربية',arabicFullName:'الاسم الكامل بالعربية',passportNumber:'رقم الجواز',passportType:'نوع الجواز',nationalityCode:'الجنسية',issuingCountryCode:'دولة إصدار الجواز',birthDate:'تاريخ الميلاد',birthPlace:'مكان الميلاد',sex:'الجنس في الجواز',issueDate:'إصدار الجواز',expiryDate:'انتهاء الجواز',emiratesId:'الهوية الإماراتية',residenceExpiry:'انتهاء الإقامة'});
  const documentIssueLabels = Object.freeze({INVALID_EXTRACTION:'تعذرت قراءة المستند؛ يلزم ملف أوضح أو مراجعة البيانات.',DOCUMENT_UNREADABLE:'المستند غير واضح بما يكفي لقراءة البيانات المطلوبة.',SOURCE_CONFLICT:'تغير المرفق أثناء القراءة؛ راجع النسخة الحالية.',DOCUMENT_UNASSIGNED:'لم يُربط المستند بمتقدم محدد؛ راجع ربط المستندات في رعد.',PASSPORT_MISSING:'لم تُحدد صفحة جواز واضحة لهذا المتقدم.',PASSPORT_MRZ_REQUIRED:'يلزم ظهور السطرين أسفل صفحة الجواز بوضوح.',PASSPORT_MRZ_INVALID:'قراءة المنطقة الآلية في الجواز تحتاج مراجعة.',PASSPORT_MRZ_DATE_AMBIGUOUS:'راجع التاريخ الكامل في الجواز؛ لا يُستنتج القرن من المنطقة الآلية.',PASSPORT_VIZ_MRZ_MISMATCH:'اختلف النص الظاهر عن القراءة الآلية في الجواز؛ راجع القيمة مع المستند.',CASE_DATA_MISMATCH:'بيانات المستند تختلف عن بيانات الملف؛ يلزم توضيحها مع المتقدم.',MULTIPLE_PASSPORTS:'توجد جوازات مختلفة مرتبطة بالمتقدم؛ حدّد الجواز الحالي.',RESIDENCE_MISSING:'لم تُربط هوية أو إقامة مقروءة ومطابقة لهذا المتقدم.',DOCUMENT_IDENTITY_MISMATCH:'بيانات الهوية أو الإقامة لا تتطابق مع الجواز؛ راجع المستند والمتقدم.',RESIDENCE_CONFLICT:'توجد بيانات مختلفة بين صور الهوية والإقامة؛ يلزم توضيحها.',DOCUMENT_FIELD_REQUIRED:'المعلومة غير ظاهرة أو غير مؤكدة؛ استكملها من المستند أو المتقدم.',DOCUMENT_FIELD_INVALID:'القيمة المقروءة تحتاج مراجعة أو تصحيحًا من المستند.',PASSPORT_VALIDITY:'صلاحية الجواز تحتاج مراجعة مع تاريخ الدخول.',RESIDENCE_VALIDITY:'صلاحية الإقامة تحتاج مراجعة مع تاريخ التقديم.',APPLICANT_REQUIRED:'حدّد المتقدم وعدد المتقدمين قبل ربط المستندات.'});
  function documentReviewState(review) {
    const status = review?.status || 'not_started';
    if (review?.enabled === false || status === 'disabled') return {key:'disabled',label:'القراءة الآلية غير مفعلة',tone:'neutral',copy:'يمكن مراجعة المستندات واستكمال البيانات من محرر رعد.'};
    if (status === 'provider_unavailable' || review?.configured === false && review?.enabled === true) return {key:'provider_unavailable',label:'خدمة القراءة غير متاحة',tone:'warn',copy:'راجع المستندات والبيانات في محرر رعد حتى تتاح خدمة القراءة.'};
    return ({queued:{key:'queued',label:'بانتظار قراءة المستندات',tone:'neutral',copy:'الملفات في قائمة القراءة والمطابقة. تظهر النتائج بعد معالجتها.'},processing:{key:'processing',label:'جارٍ قراءة المستندات ومطابقتها',tone:'blue',copy:'تُقرأ البيانات وتُقارن مستندات كل متقدم؛ لم تكتمل النتيجة بعد.'},ready:{key:'ready',label:'اكتملت القراءة والمطابقة الآلية',tone:'',copy:'تظهر أدناه القيم التي أعادتها الخدمة لهذه النسخة. يبقى تأكيد العميل للحقائق الشخصية مطلوبًا.'},needs_confirmation:{key:'needs_confirmation',label:'بانتظار تأكيد العميل',tone:'warn',copy:'تنتظر المطابقة استكمال معلومات لم تظهر في المستندات من العميل. لم تُملأ هذه القيم تلقائيًا.'},needs_review:{key:'needs_review',label:'تحتاج مراجعة أو توضيحًا',tone:'warn',copy:'راجع أسباب الاختلاف أو النقص، ثم استكمل المعلومات مع المتقدم أو من محرر رعد.'},waiting_case:{key:'waiting_case',label:'بانتظار ملف المتقدم',tone:'neutral',copy:'يلزم ملف متقدم محدد لربط المستندات وقراءة بياناتها.'},not_started:{key:'not_started',label:'لم تصل نتيجة قراءة بعد',tone:'neutral',copy:'تظهر القراءة والمطابقة هنا عند توفر نتيجة محفوظة للمستندات.'}})[status] || {key:'not_started',label:'بانتظار تحديث القراءة',tone:'neutral',copy:'لم تصل نتيجة مكتملة يمكن عرضها بعد.'};
  }
  function documentIssueText(issue) { return typeof issue?.message === 'string' && /[ء-ي]/.test(issue.message) ? issue.message : documentIssueLabels[issue?.code] || 'راجع المستند والمعلومة المطلوبة في محرر رعد.'; }
  function visibleDocumentFields(fields) { return Object.entries(documentFields).filter(([key]) => typeof fields?.[key] === 'string' && fields[key].trim()).map(([key,label]) => ({key,label,value:fields[key]})); }
  function normalize(item) {
    const v = item.visaCase || item, workflow = item.workflow || item.journey || v.workflow || {}, payment = paymentOf(item);
    const messages = item.messages || workflow.messages || [], rawJobs = item.jobs || workflow.jobs || [], jobs = rawJobs.filter(job => !item.approval?.id || !job.approvalId || job.approvalId === item.approval.id), jobStages = jobs.map(job => applicantStage(job, messages));
    let stage = stageOf(workflow.state || workflow.status || workflow.stage || item.workflowState || item.stage || item.status);
    if (jobStages.length) stage = ['blocked', 'awaiting_otp', 'awaiting_client', 'preparing', 'queued', 'printing', 'saved', 'sending', 'accepted', 'delivered', 'manually_completed'].find(key => jobStages.includes(key)) || stage;
    if (item.blockedReason && item.blockedReason !== 'HUMAN_OWNERSHIP') stage = 'blocked';
    if (stage === 'unknown' && !jobs.length && !workflow.state && !workflow.status && !workflow.stage) stage = payment.verified ? 'queued' : payment.status;
    if (!payment.verified && payment.status === 'awaiting_accountant' && ['unknown', 'queued', 'preparing', 'awaiting_payment', 'not_started'].includes(stage)) stage = 'awaiting_accountant';
    const customer = String(item.customer?.id || item.customer?.customer || item.customerId || (typeof item.customer === 'string' ? item.customer : '') || v.customer || '');
    return { ...item, id: String(item.caseId || v.caseId || v.id || item.id || customer), customer, name: item.customer?.name || item.name || item.customerName || customer || 'عميل الرمال', stage, payment,
      revision: item.revision ?? v.revision, caseSignature: item.caseSignature || item.expectedCaseSignature || workflow.caseSignature || v.caseSignature,
      applicants: jobs.length ? jobs.map(job => ({...job, stage: applicantStage(job, messages), state: applicantStage(job, messages), nextAction: job.blockedReason ? blockerText(job.blockedReason) : undefined})) : Array.isArray(workflow.applicants) ? workflow.applicants : Array.isArray(item.applicants) ? item.applicants : v.facts?.applicants || [],
      applicantCount: Number(item.applicantCount || v.applicantCount || v.facts?.applicantCount || 0),
      blockers: Array.isArray(workflow.blockers) ? workflow.blockers : Array.isArray(item.blockers) ? item.blockers : [],
      timeline: Array.isArray(workflow.timeline) ? workflow.timeline : Array.isArray(item.timeline) ? item.timeline : [],
      workflow, governmentFees: item.governmentFees || workflow.governmentFees || {status: 'unpaid'} };
  }
  function matches(item, filter, query) {
    if (query && ![item.name, item.customer, item.id].some(value => String(value).toLowerCase().includes(query.toLowerCase()))) return false;
    if (filter === 'payment') return item.payment.status === 'awaiting_accountant';
    if (filter === 'attention') return ['blocked', 'awaiting_client', 'awaiting_otp'].includes(item.stage);
    return filter === 'all' || item.stage === filter;
  }
  function create({ request, media, openConversation, toast, onChange }) {
    const container = document.getElementById('visa-workspace-root');
    const state = {items: [], filter: 'all', query: '', loaded: false, loading: false, error: '', accountantKey: '', capabilities: {}, epoch: 0, selected: null, review: null, urls: new Set(), attempts: new Map()};
    const n = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
    const badge = (text, tone = '') => n('span', 'pill ' + tone, text);
    const button = (text, fn, primary = false) => { const b = n('button', 'button ' + (primary ? 'primary' : 'subtle'), text); b.type = 'button'; b.onclick = fn; return b; };
    const statusBadge = stage => badge(stages[stageOf(stage)][0], stages[stageOf(stage)][1]);
    const money = value => Number.isFinite(Number(value)) && value !== null && value !== '' ? new Intl.NumberFormat('ar-AE', {style: 'currency', currency: 'AED', maximumFractionDigits: 2}).format(Number(value)) : 'غير مسجل';
    const stamp = value => { const date = new Date(value); return Number.isFinite(+date) ? new Intl.DateTimeFormat('ar-AE', {timeZone: 'Asia/Dubai', dateStyle: 'short', timeStyle: 'short'}).format(date) : '—'; };
    const auth = () => state.accountantKey ? {'X-Accountant-Key': state.accountantKey} : {};
    const adapter = {
      list: () => request('visa-workflow?limit=100', 'GET', undefined, auth()),
      detail: id => request('visa-workflow/' + encodeURIComponent(id), 'GET', undefined, auth()),
      approve: (id, body) => request('visa-workflow/' + encodeURIComponent(id) + '/confirm-payment', 'POST', body, auth()),
      reread: (id, body) => request('visa-workflow/' + encodeURIComponent(id) + '/reread-document', 'POST', body, auth())
    };
    function modal(title, className = '') {
      const dialog = n('dialog', 'vj-dialog ' + className), head = n('header', 'vj-dialog-head'), titleNode = n('h2', '', title), close = button('×', () => dialog.close());
      titleNode.id = 'vj-dialog-title-' + Math.random().toString(36).slice(2); dialog.setAttribute('aria-labelledby', titleNode.id); close.className = 'icon-button'; close.setAttribute('aria-label', 'إغلاق'); close.onclick = () => { if (!dialog.dataset.busy) dialog.close(); }; head.append(titleNode, close); dialog.append(head);
      dialog.addEventListener('click', event => { if (event.target === dialog && !dialog.dataset.busy) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
      dialog.addEventListener('cancel', event => { if (dialog.dataset.busy) event.preventDefault(); });
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])')].filter(control => !control.hidden && control.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1), active = document.activeElement;
        if (!first) { event.preventDefault(); return; }
        if (!dialog.contains(active) || event.shiftKey && active === first || !event.shiftKey && active === last) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      });
      dialog.addEventListener('close', () => { dialog.remove(); }); document.body.append(dialog); return dialog;
    }
    function showMessage(title, copy, onConfirm) {
      return new Promise(resolve => {
        const dialog = modal(title, 'vj-confirm-dialog'), body = n('div', 'vj-dialog-body'), actions = n('div', 'vj-modal-actions');
        body.append(n('p', 'muted', copy)); actions.append(button('إلغاء', () => dialog.close()), button('متابعة', () => { resolve(true); dialog.close(); if (onConfirm) onConfirm(); }, true)); body.append(actions); dialog.append(body); dialog.addEventListener('close', () => resolve(false), {once: true}); dialog.showModal();
      });
    }
    function paymentCards(item) {
      const wrap = n('div', 'vj-money-grid'), client = n('article', 'vj-money-card ' + (item.payment.verified ? 'verified' : 'pending')), government = n('article', 'vj-money-card government');
      client.append(n('span', 'vj-money-label', 'دفعة العميل إلى الرمال'), n('strong', '', money(item.payment.amount ?? item.quote?.total)), badge(item.payment.verified ? 'اعتمد المحاسب وصول المبلغ' : item.payment.status === 'awaiting_accountant' ? 'الإيصال مستلم · الاعتماد معلّق' : 'لم يتأكد وصول الدفعة', item.payment.verified ? '' : 'warn'));
      government.append(n('span', 'vj-money-label', 'رسوم بوابة التأشيرات'), n('strong', '', item.governmentFees.status === 'paid' ? 'مسجلة كمدفوعة' : 'غير مدفوعة'), n('p', '', 'يتوقف رعد عند صفحة الدفع ويختار «رجوع». تُحفظ نسخة الطلب دون سداد الرسوم.'));
      wrap.append(client, government); return wrap;
    }
    function skeleton() { const wrap = n('div', 'vj-skeleton-grid'); wrap.setAttribute('role', 'status'); wrap.setAttribute('aria-label', 'جارٍ تحميل بيانات الرحلة'); for (let i = 0; i < 4; i++) { const row = n('div', 'vj-skeleton'); row.append(n('span'), n('span'), n('span')); wrap.append(row); } return wrap; }
    function render() {
      if (!container) return;
      const focused = document.activeElement?.dataset?.vjFocus, selection = document.activeElement?.selectionStart;
      container.replaceChildren();
      const hero = n('section', 'vj-hero'), intro = n('div', 'vj-hero-copy'), motif = n('div', 'vj-hero-emblem'); motif.setAttribute('aria-hidden', 'true'); motif.append(n('span', '', 'ر'), n('small', '', 'REMAL'));
      intro.append(n('p', 'vj-overline', 'REMAL · VISA OPERATIONS'), n('h2', '', 'من الإيصال إلى نسخة العميل.'), n('p', '', 'مسار واحد واضح للمحاسب، وإسماعيل، ورعد. كل خطوة تبدأ بعد تأكيد متطلباتها.'));
      const heroActions = n('div', 'vj-hero-actions'); heroActions.append(button('↻  تحديث الرحلة', () => refresh()), button(state.accountantKey ? 'صلاحية المحاسب مفعّلة' : 'دخول المحاسب', () => accountantDialog())); intro.append(heroActions); hero.append(intro, motif); container.append(hero);
      const metrics = n('div', 'vj-metrics');
      for (const [label, count, tone, note] of [
        ['بانتظار المحاسب', state.items.filter(x => x.payment.status === 'awaiting_accountant').length, 'amber', 'وصول الإيصال لا يثبت التحويل'],
        ['قيد التجهيز', state.items.filter(x => ['queued', 'preparing', 'printing'].includes(x.stage)).length, 'teal', 'متابعة مستقلة لكل متقدم'],
        ['بانتظار استكمال', state.items.filter(x => ['awaiting_client', 'awaiting_otp', 'blocked'].includes(x.stage)).length, 'gold', 'إجابة عميل أو تدخّل الفريق'],
        ['وصلت للعميل', state.items.filter(x => x.stage === 'delivered').length, 'navy', 'وصول مؤكد من خدمة الإرسال']
      ]) { const card = n('article', 'vj-metric ' + tone), top = n('div'); top.append(n('span', '', label), n('strong', '', state.loaded ? new Intl.NumberFormat('ar').format(count) : '—')); card.append(top, n('p', '', note)); metrics.append(card); } container.append(metrics);
      const pipeline = n('section', 'vj-pipeline'); pipeline.setAttribute('aria-label', 'مسار عمل التأشيرات');
      for (const [index, title, desc] of [[1, 'اعتماد الدفعة', 'المحاسب يتحقق من التحويل'], [2, 'تأكيد واستكمال', 'إسماعيل يتابع إجابات العميل'], [3, 'تجهيز وحفظ', 'رعد يجهّز الطلب دون دفع'], [4, 'طباعة وإرسال', 'نسخة PDF ومتابعة الوصول']]) { const step = n('div', 'vj-pipeline-step'), copy = n('div'); copy.append(n('strong', '', title), n('span', '', desc)); step.append(n('span', 'vj-step-number', String(index).padStart(2, '0')), copy); pipeline.append(step); } container.append(pipeline);
      const board = n('section', 'vj-board'), heading = n('div', 'vj-board-heading'), title = n('div'); title.append(n('p', 'eyebrow', 'ملفات التأشيرات'), n('h3', '', 'ما الذي يحتاج خطوتك التالية؟'));
      const search = n('input'); search.type = 'search'; search.placeholder = 'ابحث باسم العميل أو رقم الملف'; search.setAttribute('aria-label', 'بحث ملفات التأشيرات'); search.value = state.query; search.dataset.vjFocus = 'search'; search.oninput = () => { state.query = search.value; render(); }; heading.append(title, search); board.append(heading);
      const tabs = n('div', 'vj-filter-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'تصفية مرحلة الملف');
      for (const [key, text] of [['all', 'كل الملفات'], ['payment', 'اعتماد المحاسب'], ['attention', 'تحتاج متابعة'], ['saved', 'محفوظة'], ['delivered', 'وصلت للعميل']]) { const b = button(text, () => { state.filter = key; render(); }); b.className = 'vj-filter' + (state.filter === key ? ' active' : ''); b.setAttribute('aria-pressed', String(state.filter === key)); tabs.append(b); } board.append(tabs);
      if (state.error) { const error = n('div', 'vj-inline-error'); error.setAttribute('role', 'alert'); error.append(n('p', '', state.error), button('إعادة المحاولة', () => refresh())); board.append(error); }
      const results = state.items.filter(item => matches(item, state.filter, state.query));
      if (state.loading && !state.loaded) board.append(skeleton());
      else if (!results.length) { const empty = n('div', 'vj-empty'); empty.append(n('span', 'vj-empty-icon', '▤'), n('h3', '', state.items.length ? 'لا توجد ملفات بهذه التصفية' : 'تبدأ الرحلة عند إنشاء ملف تأشيرة'), n('p', '', state.items.length ? 'جرّب اسمًا آخر أو اعرض كل الملفات.' : 'ستظهر هنا ملفات العملاء وإيصالاتهم ومراحل تجهيز كل متقدم.')); if (state.items.length) empty.append(button('عرض كل الملفات', () => { state.query = ''; state.filter = 'all'; render(); })); board.append(empty); }
      else { const list = n('div', 'vj-case-list'); for (const item of results) list.append(caseCard(item)); board.append(list); }
      const foot = n('div', 'vj-board-footer'); foot.append(n('span', '', 'تعرض الحالات المحفوظة من الخدمة · التوقيت دبي'), n('span', '', results.length + ' ملف')); board.append(foot); container.append(board);
      const note = n('aside', 'vj-policy-note'); note.append(n('span', 'vj-note-symbol', '✓'), n('p', '', 'دفعة العميل مستقلة عن رسوم البوابة. «قُبل الإرسال» تعني قبول خدمة واتساب للمحاولة؛ تظهر «وصلت» فقط عند تأكيد الوصول.')); container.append(note);
      if (focused) { const input = container.querySelector('[data-vj-focus="' + focused + '"]'); input?.focus({preventScroll: true}); if (input && Number.isInteger(selection)) { try { input.setSelectionRange(selection, selection); } catch {} } }
    }
    function caseCard(item) {
      const card = n('article', 'vj-case-card'), head = n('div', 'vj-case-head'), avatar = n('span', 'vj-case-avatar', Array.from(item.name)[0] || 'ع'), identity = n('div', 'vj-case-identity'); identity.append(n('h4', '', item.name), n('span', '', 'ملف ' + item.id)); head.append(avatar, identity, statusBadge(item.stage)); card.append(head);
      const meta = n('div', 'vj-case-meta'); meta.append(n('span', '', (item.applicantCount || item.applicants.length || '—') + ' متقدم'), n('span', '', 'آخر تحديث ' + stamp(item.updatedAt || item.workflow.updatedAt))); card.append(meta); if (item.documentReview) { const review = documentReviewState(item.documentReview), status = n('div', 'vj-document-card-state'); status.append(n('span', '', 'قراءة المستندات'), badge(review.label, review.tone)); card.append(status); }
      const next = n('div', 'vj-next-action'); next.append(n('span', '', 'الخطوة التالية'), n('strong', '', nextStep(item))); card.append(next);
      const footer = n('div', 'vj-case-footer'); footer.append(badge(item.payment.verified ? 'دفعة العميل معتمدة' : item.payment.status === 'awaiting_accountant' ? 'الإيصال قيد الاعتماد' : 'لم تتأكد دفعة العميل', item.payment.verified ? '' : 'warn'), button(item.payment.status === 'awaiting_accountant' ? 'مراجعة الإيصال ←' : 'متابعة الملف ←', () => item.payment.status === 'awaiting_accountant' ? reviewPayment(item.customer) : openCase(item.customer), item.payment.status === 'awaiting_accountant')); card.append(footer); return card;
    }
    function nextStep(item) {
      const blocker = item.blockers.find(value => value !== 'HUMAN_OWNERSHIP' || item.stage === 'blocked'); if (blocker) return blockerText(blocker);
      return {manually_completed:'سُجل استكمال الطلب يدويًا؛ لن يعيد رعد محاولة تقديمه', awaiting_accountant: 'المحاسب يؤكد المبلغ المحوّل ومرجعه', awaiting_payment: 'انتظار وصول دفعة العميل والتحقق منها', queued: 'تأكيد إسماعيل للعميل ثم بدء تجهيز رعد', preparing: 'تجهيز المستندات ومراجعة بيانات المتقدم', awaiting_client: 'استكمال الإجابات الشخصية والصحية مع العميل', awaiting_otp: 'صاحب الحساب يُكمل تحقق واتساب في القناة الآمنة', saved: 'إنشاء نسخة PDF من الطلب المحفوظ', printing: 'انتظار اكتمال إنشاء نسخة PDF', sending: 'انتظار نتيجة إرسال النسخة', accepted: 'متابعة إشعار وصول النسخة من واتساب', delivered: 'اكتمل تسليم نسخة الطلب المحفوظ', blocked: 'مراجعة العائق ثم استئناف المرحلة الحالية'}[item.stage] || 'افتح الملف لمراجعة آخر حالة محفوظة';
    }
    function documentReviewPanel(item, dialog) {
      const review = item.documentReview, info = documentReviewState(review), section = n('section', 'vj-document-review'), heading = n('div', 'vj-document-review-head'), title = n('div');
      section.setAttribute('aria-label', 'قراءة ومطابقة البيانات'); title.append(n('p', 'eyebrow', 'المستندات · متابعة داخلية'), n('h3', '', 'قراءة ومطابقة البيانات')); heading.append(title, badge(info.label, info.tone)); section.append(heading, n('p', 'vj-document-intro', info.copy));
      const showIssues = values => { const list = n('ul', 'vj-document-issues'); for (const issue of values) { const row = n('li'), field = typeof issue?.field === 'string' ? documentFields[issue.field.replace(/^fields\./,'')] : null; if (field) row.append(n('strong', '', field + ': ')); row.append(n('span', '', documentIssueText(issue))); list.append(row); } return list; };
      if (Array.isArray(review?.issues) && review.issues.length) section.append(showIssues(review.issues));
      for (const [index, applicant] of (Array.isArray(review?.applicants) ? review.applicants : []).entries()) {
        const result = documentReviewState({status:applicant.status}), card = n('article', 'vj-document-applicant'), head = n('div', 'vj-document-applicant-head'), ordinal = (Number.isInteger(applicant.applicantIndex) ? applicant.applicantIndex : index) + 1;
        head.append(n('strong', '', 'المتقدم ' + ordinal), badge(result.key === 'ready' ? 'القراءة والمطابقة مكتملة' : result.label, result.tone)); card.append(head); if (applicant.awaitingPayment === true) { const pending = badge('بانتظار اعتماد الدفعة', 'neutral'); pending.className += ' vj-document-payment-pending'; card.append(pending); }
        const documents = n('div', 'vj-document-sources');
        for (const [key,label] of [['passport','الجواز'],['residence','الهوية / الإقامة'],['photo','الصورة الشخصية']]) { const source = applicant.documents?.[key], linked = typeof source === 'string' && source.length > 0 || Array.isArray(source) && source.length > 0 || source && typeof source === 'object' && typeof source.mediaId === 'string'; documents.append(n('span', linked ? 'linked' : 'missing', (linked ? '✓ ' : '○ ') + label + (linked ? ' · مرتبط' : ' · لم يُربط'))); } card.append(documents);
        const evidence = applicant.evidence || {}, checks = n('div', 'vj-document-checks'); if (evidence.passportMrzChecked === true) checks.append(n('span', '', '✓ مقارنة النص الظاهر مع منطقة الجواز الآلية')); if (evidence.matchedResidence === true) checks.append(n('span', '', '✓ مطابقة الهوية / الإقامة مع بيانات الجواز')); if (checks.children.length) card.append(checks);
        const required = (Array.isArray(applicant.clientFieldsRequired) ? applicant.clientFieldsRequired : []).filter(field => typeof field === 'string' && Object.hasOwn(documentFields, field));
        if (required.length) { const pending = n('div', 'vj-document-client-required'); pending.append(n('strong', '', 'يُستكمل من العميل'), n('p', '', 'هذه المعلومات لم تظهر في المستندات وتحتاج إجابة العميل؛ لم تُملأ تلقائيًا.')); const labels = n('div'); for (const field of required) labels.append(n('span', '', documentFields[field])); pending.append(labels); card.append(pending); }
        const issues = Array.isArray(applicant.issues) ? applicant.issues : []; if (issues.length) card.append(showIssues(issues));
        const fields = visibleDocumentFields(applicant.fields); if (fields.length) {
          const details = n('details', 'vj-document-fields'); details.open = result.key === 'needs_review'; details.append(n('summary', '', fields.length + ' قيمة مقروءة من المستندات')); const grid = n('dl');
          for (const field of fields) { const row = n('div', 'vj-document-field'), dt = n('dt', '', field.label), dd = n('dd', '', field.value), sources = Array.isArray(evidence.fieldSources?.[field.key]) ? evidence.fieldSources[field.key] : [], affected = issues.some(issue => issue?.field?.replace(/^fields\./,'') === field.key); dd.dir = field.key.startsWith('arabic') || field.key === 'birthPlace' ? 'auto' : 'ltr'; row.append(dt, dd);
            const sourceLabels = [...new Set(sources.map(source => ({visible_and_mrz_checked:'الجواز · مقارنة بالمنطقة الآلية',visible_and_passport_identity_matched:'الهوية / الإقامة · مطابقة ببيانات الجواز',visible_unconfirmed:'قراءة مرئية تحتاج مراجعة'})[source.method] || 'قراءة من مستند مرفق'))]; const note = n('small', affected ? 'needs-review' : '', affected ? 'تحتاج مراجعة · ' + (sourceLabels.join('، ') || 'راجع الملاحظة أعلاه') : sourceLabels.join('، ') || 'قيمة أعادتها خدمة القراءة'); row.append(note); grid.append(row);
          } details.append(grid); card.append(details);
        } else card.append(n('p', 'vj-document-empty', result.key === 'processing' || result.key === 'queued' ? 'ستظهر القيم بعد اكتمال القراءة.' : 'لم تصل قيم مقروءة يمكن عرضها لهذا المتقدم.'));
        section.append(card);
      }
      const footer = n('div', 'vj-document-footer'); footer.append(n('p', '', 'المطابقة آلية بين البيانات المقروءة؛ لا تثبت أصالة الوثائق أو تحقق الجهة الحكومية. لا تُستكمل الأسماء أو القيم غير المقروءة بالتخمين.')); if (review?.updatedAt) footer.append(n('time', '', 'آخر نتيجة ' + stamp(review.updatedAt))); section.append(footer);
      const originals = new Map((Array.isArray(item.media) ? item.media : []).filter(file => typeof file?.id === 'string' && !file.purpose && !file.derived && !file.isDerived && !file.sourceIds?.length && (!file.customer || String(file.customer) === item.customer) && !['unavailable','failed','expired','application_copy'].includes(file.status) && /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimeType || '')).map(file => [file.id,file]));
      const sources = (Array.isArray(review?.rereadSources) ? review.rereadSources : []).filter(source => originals.has(source?.mediaId) && source.caseId === review.caseId && source.caseId === item.id && Number.isSafeInteger(source.generation) && source.generation === review.generation && /^[a-f0-9]{64}$/.test(source.sourceSha256 || ''));
      if (sources.length) {
        const area = n('div', 'vj-document-reread'), status = n('p', 'muted small'); status.setAttribute('role','status');
        area.append(n('h4', '', 'قراءة أصل محفوظ'), n('p', 'muted small', 'يعيد هذا الإجراء قراءة الملف الأصلي المحفوظ بواسطة خدمة القراءة المهيأة. لا يؤكد الهوية أو الدفعة أو موافقة العميل.'));
        let pending = false;
        const controls = [];
        const kindLabels = {passport:'الجواز',uae_id_front:'الهوية الإماراتية · الوجه الأمامي',uae_id_back:'الهوية الإماراتية · الوجه الخلفي',portrait:'الصورة الشخصية',other:'مستند غير مصنف'};
        const originalIds = [...originals.keys()];
        for (const source of sources) {
          const file = originals.get(source.mediaId), row = n('div', 'vj-document-reread-source'), binding = {caseId:source.caseId,mediaId:source.mediaId,sourceSha256:source.sourceSha256,generation:source.generation};
          const action = button('إعادة قراءة الأصل المحفوظ', async () => {
            if (pending || action.disabled || !dialog.open) return;
            const epoch = state.epoch; pending = true; for (const control of controls) control.disabled = true; status.textContent = 'جارٍ طلب إعادة قراءة الأصل المحفوظ…';
            try {
              await adapter.reread(item.customer, binding);
              if (epoch !== state.epoch || !dialog.open) return;
              status.textContent = 'أُضيف الأصل المحفوظ إلى قائمة القراءة؛ لم تُعتمد الهوية أو الدفعة أو موافقة العميل.';
              const fresh = await fetchCase(item.customer);
              if (epoch !== state.epoch || !dialog.open) return;
              section.replaceChildren(...documentReviewPanel(fresh, dialog).children);
            } catch {
              if (epoch === state.epoch && dialog.open) status.textContent = 'لم يتأكد طلب إعادة القراءة. حدّث الملف لمراجعة حالته قبل المحاولة مجددًا.';
            }
          });
          action.disabled = source.allowed !== true; controls.push(action);
          const kinds = [...new Set((Array.isArray(source.kinds) ? source.kinds : [source.kind]).filter(kind => typeof kind === 'string' && Object.hasOwn(kindLabels,kind)))], label = 'المرفق الأصلي ' + (originalIds.indexOf(source.mediaId) + 1) + ' · ' + (kinds.length ? kinds.map(kind => kindLabels[kind]).join('، ') : kindLabels.other);
          row.append(n('span', '', label), n('small', '', 'وصل ' + stamp(source.receivedAt)), n('small', '', file.filename || 'المرفق الأصلي'), action); if (source.allowed !== true) row.append(n('small', '', 'إعادة القراءة غير متاحة لهذه النسخة.')); area.append(row);
        }
        area.append(status); section.append(area);
      }
      if (['needs_review','provider_unavailable','disabled'].includes(info.key)) { const action = button('مراجعة المستندات والبيانات في رعد', () => { dialog.close(); openConversation(item.customer); document.getElementById('view-inbox')?.classList.add('show-details'); }); action.className += ' vj-document-action'; section.append(action); }
      return section;
    }
    async function refresh() {
      if (state.loading) return; const epoch = state.epoch; state.loading = true; state.error = ''; render();
      try { const result = await adapter.list(); if (epoch !== state.epoch) return; state.items = (result.items || result.cases || []).map(normalize); state.capabilities = result.capabilities || {}; state.loaded = true; }
      catch (error) { if (epoch === state.epoch) state.error = error.message || 'تعذر تحديث رحلة التأشيرات. أعد المحاولة.'; }
      finally { if (epoch === state.epoch) { state.loading = false; render(); } }
    }
    async function fetchCase(id) { const result = await adapter.detail(id); return normalize(result.item || result.case || result); }
    function liveDialog(job){
      const epoch=state.epoch,dialog=modal('شاشة رعد المباشرة','vj-live-dialog');
      const body=n('div','vj-dialog-body vj-live-viewer'),toolbar=n('div','vj-live-toolbar'),badge=n('span','vj-live-badge','جارٍ الاتصال'),phase=n('strong','vj-live-phase','متابعة خطوات التقديم'),clock=n('time','vj-live-clock'),screen=n('div','vj-live-screen'),image=n('img','vj-live-image'),status=n('p','vj-live-status','جارٍ الاتصال بجلسة رعد الحالية…');
      image.alt='شاشة جلسة رعد الحالية · حقول الإدخال محجوبة';image.hidden=true;status.setAttribute('role','status');
      const labels={preflight:'تجهيز جلسة التقديم',login:'تسجيل الدخول والتحقق',lookup:'التحقق من الطلبات الحالية',personal_info:'بيانات المتقدم',health:'الإفصاح الصحي',residence:'بيانات الإقامة',upload:'رفع المستندات',review:'مراجعة البيانات',form:'تعبئة نموذج الطلب',documents:'رفع المستندات',application_sms:'التحقق من رقم الهاتف',save:'حفظ الطلب',save_preflight:'مراجعة النموذج',insurance:'اختيار التأمين',payment:'مراجعة الخطوة الأخيرة',request_copy:'تجهيز نسخة الطلب',done:'انتهت الجلسة'};
      let timer=null,staleTimer=null,busy=false,enabled=true,objectUrl=null;
      const clearFrame=()=>{clearTimeout(staleTimer);image.hidden=true;image.removeAttribute('src');if(objectUrl){URL.revokeObjectURL(objectUrl);state.urls.delete(objectUrl);objectUrl=null;}badge.classList.remove('is-live');};
      const pause=button('إيقاف المشاهدة',()=>{enabled=!enabled;pause.textContent=enabled?'إيقاف المشاهدة':'استئناف المشاهدة';clearTimeout(timer);if(enabled)update();else{clearFrame();badge.textContent='المشاهدة متوقفة';status.textContent='المشاهدة متوقفة عندك؛ إيقافها لا يغيّر تنفيذ رعد.';}});
      toolbar.append(badge,phase,clock,pause);screen.append(image);body.append(toolbar,screen,status,n('p','vj-live-note','للمشاهدة فقط · تحديث تلقائي كل 3 ثوانٍ أثناء فتح الشاشة. حقول الإدخال والإطارات محجوبة لحماية البيانات ورموز التحقق.'));dialog.append(body);
      async function update(){
        if(busy||!enabled||!dialog.open||document.hidden||epoch!==state.epoch)return;busy=true;
        try{
          const result=await request('visa-operator/'+encodeURIComponent(job.id)+'/live','GET');
          if(!dialog.open||document.hidden||!enabled||epoch!==state.epoch)return;
          phase.textContent=labels[result.phase]||'متابعة خطوات التقديم';
          if(result.active!==true){clearFrame();clock.textContent='';badge.textContent='لا توجد جلسة مفتوحة';status.textContent=result.state==='portal_review_required'?'جلسة رعد متوقفة وتحتاج مراجعة. سبب التوقف ظاهر في تفاصيل ملف الطلب.':result.state==='saved_application'?'انتهت جلسة المتصفح لهذا الطلب. نتيجة الحفظ والمتابعة ظاهرة في تفاصيل الملف.':'لا توجد شاشة متصفح نشطة لهذا الطلب الآن. ستظهر هنا عند فتح جلسة رعد.';return;}
          if(result.jobId!==job.id||result.readOnly!==true||result.redacted!==true||typeof result.image!=='string'||result.image.length>700000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(result.image)||!Number.isFinite(result.capturedAt)||Date.now()-result.capturedAt>10000||result.capturedAt>Date.now()+5000)throw Error('LIVE_FRAME_UNCONFIRMED');
          const binary=atob(result.image.slice(23)),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length>500000)throw Error('LIVE_FRAME_TOO_LARGE');
          const next=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));state.urls.add(next);const old=objectUrl;objectUrl=next;image.src=next;image.hidden=false;if(old){URL.revokeObjectURL(old);state.urls.delete(old);}
          clearTimeout(staleTimer);staleTimer=setTimeout(()=>{if(dialog.open){clearFrame();badge.textContent='بانتظار صورة حديثة';status.textContent='تأخر تحديث الشاشة. جارٍ إعادة الاتصال.';}},Math.max(0,Math.min(10000,10000-(Date.now()-result.capturedAt))));
          badge.textContent='مباشر';badge.classList.add('is-live');clock.textContent='آخر صورة '+new Intl.DateTimeFormat('ar-AE',{timeZone:'Asia/Dubai',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(result.capturedAt));clock.dateTime=new Date(result.capturedAt).toISOString();status.textContent='المشاهدة متصلة بجلسة رعد الحالية.';
        }catch{if(dialog.open&&epoch===state.epoch){clearFrame();badge.textContent='إعادة اتصال';status.textContent='تعذرت مشاهدة الجلسة الآن. ستُعاد محاولة الاتصال تلقائيًا؛ لا تُعرض صورة قديمة.';}}
        finally{busy=false;if(enabled&&dialog.open&&!document.hidden&&epoch===state.epoch)timer=setTimeout(update,3000);}
      }
      const visibility=()=>{clearTimeout(timer);if(document.hidden){clearFrame();badge.textContent='المشاهدة معلّقة';status.textContent='تُستأنف المشاهدة عند الرجوع إلى هذه النافذة.';}else update();};document.addEventListener('visibilitychange',visibility);
      image.onerror=()=>{if(dialog.open){clearFrame();badge.textContent='إعادة اتصال';status.textContent='تعذّر عرض الصورة؛ جارٍ طلب صورة حديثة.';}};
      dialog.addEventListener('close',()=>{enabled=false;clearTimeout(timer);clearFrame();document.removeEventListener('visibilitychange',visibility);});dialog.showModal();update();return dialog;
    }
    async function operatorDialog(job) {
      const epoch=state.epoch,dialog=modal('إكمال التحقق المرئي في جلسة رعد'),body=n('div','vj-dialog-body'),status=n('p','muted','جارٍ تحميل التحقق من الجلسة الحالية…');
      body.append(status);dialog.append(body);dialog.showModal();let objectUrl=null;
      dialog.addEventListener('close',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);form?.reset();});
      let form=null;
      try{
        const result=await request('visa-operator/'+encodeURIComponent(job.id),'GET');
        if(epoch!==state.epoch||!dialog.open)return;
        if(typeof result.image!=='string'||result.image.length>280000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(result.image))throw Error('IMAGE_UNCONFIRMED');
        const bytes=Uint8Array.from(atob(result.image.split(',')[1]),c=>c.charCodeAt(0));objectUrl=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));bytes.fill(0);
        const image=n('img','vj-operator-image');image.alt='صورة التحقق المرئي من جلسة رعد الحالية';image.src=objectUrl;
        form=n('form','vj-operator-form');const label=n('label'),input=n('input');input.required=true;input.maxLength=32;input.pattern='[A-Za-z0-9]+';input.autocomplete='off';input.dir='ltr';label.append(n('span','','اكتب الرمز الظاهر بنفسك'),input);
        const submit=button('إرسال ومتابعة نفس الجلسة',null,true);submit.type='submit';
        status.textContent='أكمل التحقق بنفسك. بيانات الدخول موجودة على الخادم، ولن تبدأ جلسة منفصلة.';
        form.append(image,label,submit);body.append(form);input.focus();
        form.onsubmit=async event=>{event.preventDefault();if(submit.disabled)return;let value=input.value.trim();form.reset();if(!/^[A-Za-z0-9]{1,32}$/.test(value))return;submit.disabled=true;dialog.dataset.busy='true';
          const payload={challengeId:result.challengeId,imageId:result.imageId,value};value='';
          try{const pending=request('visa-operator/'+encodeURIComponent(job.id),'POST',payload);payload.value='';const sent=await pending;if(sent.accepted!==true)throw Error('UNCONFIRMED');status.textContent='أُرسل التحقق لهذه الجلسة. حدّث الملف لمتابعة نتيجة الدخول والتنفيذ.';form.remove();if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}await refresh();}
          catch{status.textContent='لم يتأكد إرسال التحقق. أغلق النافذة وحدّث الملف لمعرفة حالة الجلسة قبل أي محاولة جديدة.';form.remove();}
          finally{payload.value='';delete dialog.dataset.busy;}
        };
      }catch{status.textContent='التحقق غير متاح حاليًا أو انتهت صلاحيته. حدّث الملف لمعرفة حالة رعد.';}
    }
    function preparedDocumentPanel(item,dialog) {
      const section=n('section','vj-prepared-documents'), grid=n('div','vj-prepared-grid'), epoch=state.epoch, urls=new Set();
      section.append(n('h3','','الصور النهائية للتقديم'),n('p','vj-form-intro','معاينة النسخ بعد التحويل والتعديل ودمج صفحات المستند. يوضح كل ملف إن كان من آخر محاولة مسجلة أو من التجهيز الحالي.'));
      dialog.addEventListener('close',()=>{for(const url of urls){URL.revokeObjectURL(url);state.urls.delete(url);}urls.clear();});
      const labels={passport:'الجواز بعد التجهيز والدمج',residence:'الهوية أو الإقامة بعد الدمج',photo:'الصورة الشخصية بعد التجهيز'};
      for(const doc of Array.isArray(item.preparedDocuments)?item.preparedDocuments:[]){
        if(!labels[doc.kind]||typeof doc.mediaId!=='string'||!['image/jpeg','image/png'].includes(doc.mimeType))continue;
        const card=n('article','vj-prepared-card'),status=n('p','vj-form-intro');
        card.append(n('h4','',labels[doc.kind]+' · المتقدم '+((doc.applicantIndex||0)+1)),n('p','vj-form-intro',doc.selection==='last_attempt'?'النسخة المحددة لآخر محاولة رعد':'النسخة المجهزة حاليًا؛ لا يتوفر إثبات استخدامها في المحاولة السابقة'));
        const show=button('عرض الصورة النهائية',async()=>{show.disabled=true;status.textContent='جارٍ تحميل النسخة المحمية…';try{
          const blob=await media(doc.mediaId,item.customer);
          if(epoch!==state.epoch||!dialog.open)return;
          if(!blob||!['image/png','image/jpeg'].includes(blob.type)||blob.size>1000000)throw Error('INVALID_PREVIEW');
          const url=URL.createObjectURL(blob);urls.add(url);state.urls.add(url);
          const image=n('img','vj-prepared-image');image.alt=labels[doc.kind];image.src=url;
          const full=n('a','button subtle','فتح بالحجم الكامل');full.href=url;full.target='_blank';full.rel='noopener';card.append(image,full);status.textContent='';show.remove();
        }catch{if(epoch===state.epoch&&dialog.open){status.textContent='تعذرت معاينة النسخة النهائية. حدّث الملف ثم أعد المحاولة.';show.disabled=false;}}});
        card.append(show,status);grid.append(card);
      }
      if(!grid.children.length)section.append(n('p','vj-form-intro','لم تُجهز نسخة نهائية مرتبطة بهذا الملف بعد.'));else section.append(grid);
      return section;
    }
    async function openCase(id,{caseId:expectedCaseId,jobId:targetJobId}={}) {
      const epoch = state.epoch, dialog = modal('تفاصيل رحلة التأشيرة', 'vj-case-dialog'), body = n('div', 'vj-dialog-body'); body.append(skeleton()); dialog.append(body); dialog.showModal();
      try { const item = await fetchCase(id); if (epoch !== state.epoch || !dialog.open) return; body.replaceChildren();
        if(expectedCaseId&&item.id!==expectedCaseId){body.append(n('h3','','الإشعار يخص ملفًا سابقًا'),n('p','','الملف الحالي لهذا العميل يختلف عن مرجع الإشعار. افتح المحادثة لمراجعة الملف الصحيح.'),button('فتح المحادثة',()=>{dialog.close();openConversation(id);}));return;}
        const flagged=item.applicants.find(a=>targetJobId?a.id===targetJobId:Boolean(a.blockedReason));
        if(flagged?.blockedReason){const guidance=operatorGuidance?.guidanceFor(flagged.blockedReason,{phase:flagged.portalStage,hasReference:Boolean(flagged.applicationReference)}),alert=n('section','vj-intervention-panel');alert.setAttribute('role','status');alert.append(n('h3','','سبب إشعار رعد'),n('strong','',guidance?.summary||blockerText(flagged.blockedReason)),n('p','',guidance?.action||'راجع متطلبات هذه المحاولة في التفاصيل أدناه.'));if(guidance?.referenceNote)alert.append(n('p','',guidance.referenceNote));if(flagged.applicationReference)alert.append(n('p','','رقم الطلب المحفوظ: '+flagged.applicationReference));body.append(alert);}
        const head = n('div', 'vj-detail-heading'); head.append(n('h3', '', item.name), statusBadge(item.stage)); body.append(head, n('p', 'vj-detail-id', 'ملف ' + item.id + ' · ' + (item.applicantCount || item.applicants.length || '—') + ' متقدم'), paymentCards(item));
        const next = n('div', 'vj-detail-next'); next.append(n('span', 'eyebrow', 'الخطوة التالية'), n('strong', '', nextStep(item))); body.append(next);
        if (item.blockers.length) { const blockers = n('section', 'vj-blockers'); blockers.append(n('h3', '', 'ما الذي ينتظر المعالجة؟')); const list = n('ul'); for (const b of item.blockers) list.append(n('li', '', blockerText(b))); blockers.append(list); body.append(blockers); }
        body.append(documentReviewPanel(item, dialog),preparedDocumentPanel(item,dialog));
        body.append(n('h3', 'vj-subheading', 'متابعة المتقدمين')); const applicants = n('div', 'vj-applicants');
        const rows = item.applicants.length ? item.applicants : Array.from({length: item.applicantCount || 1}, (_, index) => ({index}));
        for (const [index, a] of rows.entries()) {
          const wrap = n('article', 'vj-applicant-card'), row = n('div', 'vj-applicant-row'), copy = n('div'); copy.append(n('strong', '', a.name || a.fullName || 'المتقدم ' + ((a.applicantIndex ?? index) + 1)), n('p', '', a.nextAction || a.blocker?.label || a.blocker?.message || 'مستندات · بيانات شخصية · إفصاح صحي')); row.append(n('span', 'vj-applicant-index', String((a.applicantIndex ?? index) + 1).padStart(2, '0')), copy, statusBadge(a.state || a.status || a.stage || item.stage)); wrap.append(row);
          if(typeof a.id==='string'&&/^[a-f0-9-]{36}$/.test(a.id))wrap.append(button('شاشة رعد المباشرة',()=>liveDialog(a),true));
          if(a.manualCompletionAvailable===true){
            const status=n('p','vj-form-intro'),done=button('استكملت الطلب يدويًا',async()=>{
              if(done.disabled)return;done.disabled=true;
              const accepted=await showMessage('تأكيد الاستكمال اليدوي','هل تؤكد استكمال الطلب '+a.applicationReference+' واختيار التأمين وحفظه؟ سيُسجل تأكيدك ويتوقف رعد عن إعادة المحاولة. لن تُرسل رسالة للعميل بهذا الزر.');
              if(!accepted||!dialog.open){done.disabled=false;return;}status.textContent='جارٍ تسجيل تأكيدك…';
              try{const result=await request('visa-operator/'+encodeURIComponent(a.id),'POST',{manualCompletion:{caseId:item.id,applicationReference:a.applicationReference}});if(result.manualCompletionRecorded!==true)throw Error('UNCONFIRMED');status.textContent='تم إبلاغ رعد بأنك استكملت الطلب يدويًا.';await refresh();dialog.close();await openCase(id);}
              catch{status.textContent='لم يتأكد التسجيل. حدّث الملف ثم حاول مجددًا.';done.disabled=false;}
            },true);wrap.append(done,status);
          }
          if(a.manualCompletion)wrap.append(n('p','vj-form-intro','أُبلغ رعد باستكمال الطلب يدويًا · '+stamp(a.manualCompletion.at)+' · رقم الطلب '+a.manualCompletion.applicationReference));
          const verification=n('section','vj-verification-status');verification.setAttribute('aria-label','التحقق المرئي');verification.append(n('strong','','التحقق المرئي'),n('p','vj-form-intro',a.operatorAvailable===true?'جلسة تحقق جاهزة. اضغط إكمال التحقق المرئي لعرض الصورة وإدخال الرمز.':a.operatorRestartAvailable===true?'انتهت جلسة التحقق السابقة. افتح جلسة جديدة عندما تكون جاهزًا لإدخال الرمز.':['OPERATOR_CHALLENGE_EXPIRED','LOGIN_CAPTCHA_TIMEOUT'].includes(a.blockedReason)?'انتهت مهلة التحقق المرئي. إعادة فتح الجلسة تحتاج مراجعة الفريق بعد استنفاد المحاولات المتاحة.':'لا توجد جلسة تحقق مرئي نشطة لهذا المتقدم الآن.'));wrap.append(verification);
          if(a.operatorAvailable===true)verification.append(button('إكمال التحقق المرئي',()=>operatorDialog(a),true));
          else if(a.operatorRestartAvailable===true){const status=n('p','vj-form-intro'),restart=button('فتح جلسة التحقق',async()=>{restart.disabled=true;status.textContent='جارٍ الاتصال بخدمة المتصفح وفتح الجلسة…';try{const result=await request('visa-operator/'+encodeURIComponent(a.id),'POST',{restart:true});if(result.restartQueued!==true)throw Error('UNCONFIRMED');status.textContent='قُبل فتح الجلسة. حدّث الملف بعد لحظات لإكمال التحقق المرئي.';await refresh();}catch{status.textContent='لم يتأكد فتح الجلسة. قد تكون خدمة المتصفح قيد الاستيقاظ، أو تغيّرت حالة الملف. حدّث الملف قبل المحاولة مجددًا.';restart.disabled=false;}},true);status.setAttribute('role','status');verification.append(restart,status);}
          const questions = Object.values(a.questions || {}).filter(question => typeof question.prompt === 'string');
          if (questions.length) { const details = n('details', 'vj-questions'), pending = questions.filter(question => question.state !== 'answered').length; details.append(n('summary', '', pending ? pending + ' أسئلة تنتظر إجابة المتقدم' : 'إجابات المتقدم · ' + questions.length + ' أسئلة')); details.append(n('p', 'vj-questions-note', 'إجابات العميل محفوظة كما وردت؛ تظل غير مؤكدة حتى يراجع المتقدم ملخصها.'));
            for (const question of questions) { const q = n('div', 'vj-question'); q.append(n('strong', '', question.prompt)); if (Array.isArray(question.options)) { const choices = n('div', 'vj-question-options'); for (const option of question.options) { const selected = question.state === 'answered' && (option.value === question.answer || option.id === question.answer); choices.append(n('span', selected ? 'selected' : '', (selected ? '✓ ' : '') + option.label)); } q.append(choices); } else q.append(n('p', '', question.state === 'answered' && typeof question.answer === 'string' ? question.answer : 'بانتظار إجابة المتقدم')); details.append(q); } wrap.append(details); }
          applicants.append(wrap);
        } body.append(applicants);
        const policy = n('p', 'vj-detail-policy', 'مسار التجهيز: مقارنة عروض التأمين المؤهلة واختيار الأقل تكلفة، تحقق صاحب الحساب عبر قناته الآمنة، ثم حفظ الطلب والرجوع من صفحة الدفع دون سداد رسوم البوابة. نسخة الطلب المحفوظ ليست تأشيرة صادرة.'); body.append(policy);
        const timeline = n('section', 'vj-timeline'); timeline.append(n('h3', 'vj-subheading', 'سجل الرحلة')); const events = item.timeline;
        if (!events.length) timeline.append(n('p', 'muted small', 'لم تصل أحداث مسجلة لهذه الرحلة بعد.')); else { const list = n('ol'); for (const event of events) { const li = n('li'); li.append(n('strong', '', event.label || eventLabels[event.action] || stages[stageOf(event.state || event.stage || event.type)][0]), n('time', '', stamp(event.at || event.createdAt))); if (event.description) li.append(n('p', '', event.description)); list.append(li); } timeline.append(list); } body.append(timeline);
        const actions = n('div', 'vj-modal-actions'); actions.append(button('فتح المحادثة والمستندات', () => { dialog.close(); openConversation(id); })); if (!item.payment.verified && (item.payment.status === 'awaiting_accountant' || receiptChoices(item).length)) actions.append(button('مراجعة واعتماد الدفعة', () => { dialog.close(); reviewPayment(id); }, true)); body.append(actions);
      } catch (error) { if (dialog.open && epoch === state.epoch) { body.replaceChildren(n('p', 'error', error.message), button('إعادة المحاولة', () => { dialog.close(); openCase(id); })); } }
    }
    function accountantDialog(after) {
      const dialog = modal('دخول المحاسب', 'vj-auth-dialog'), form = n('form', 'vj-dialog-body'), label = n('label', 'vj-field'), input = n('input'), error = n('p', 'error'); input.type = 'password'; input.autocomplete = 'off'; input.required = true; input.maxLength = 500; input.setAttribute('aria-label', 'مفتاح صلاحية المحاسب'); input.placeholder = 'مفتاح المحاسب'; label.append(n('span', '', 'مفتاح صلاحية المحاسب'), input); error.setAttribute('role', 'alert');
      form.append(n('p', 'vj-form-intro', 'اعتماد الدفعات صلاحية مستقلة. يبقى المفتاح في ذاكرة هذه الصفحة فقط ويُحذف عند الخروج.'), label, error); const actions = n('div', 'vj-modal-actions'), submit = button('تحقق من الصلاحية', null, true); submit.type = 'submit'; actions.append(button('إلغاء', () => dialog.close()), submit); if (state.accountantKey) actions.prepend(button('إنهاء صلاحية المحاسب', () => { state.accountantKey = ''; state.capabilities.accountantReview = false; dialog.close(); render(); toast('انتهت صلاحية المحاسب في هذه الصفحة.'); })); form.append(actions); dialog.append(form);
      form.onsubmit = async event => { event.preventDefault(); if (!form.reportValidity() || dialog.dataset.busy) return; const key = input.value.trim(); if (!key) return; const epoch = state.epoch; submit.disabled = true; input.disabled = true; dialog.dataset.busy = 'true'; error.textContent = ''; const previousKey = state.accountantKey; state.accountantKey = key;
        try { const result = await adapter.list(); if (epoch !== state.epoch || !dialog.open) return; const cap = result.capabilities || {}; if (cap.accountantReview !== true && cap.canConfirmPayment !== true && cap.reviewAllowed !== true) { state.accountantKey = previousKey; error.textContent = cap.accountantConfigured === false ? 'صلاحية المحاسب غير مهيأة في الخدمة حاليًا.' : 'لم تُمنح صلاحية اعتماد الدفعات. تحقق من مفتاح المحاسب.'; return; } state.capabilities = cap; state.items = (result.items || result.cases || []).map(normalize); state.loaded = true; input.value = ''; dialog.close(); render(); toast('تم التحقق من صلاحية المحاسب.'); if (after) after(); }
        catch (failure) { if (epoch === state.epoch) { state.accountantKey = previousKey; error.textContent = failure.message; } }
        finally { submit.disabled = false; input.disabled = false; delete dialog.dataset.busy; }
      }; dialog.addEventListener('close', () => { input.value = ''; }); dialog.showModal(); input.focus();
    }
    async function reviewPayment(id) {
      if (!state.accountantKey) { accountantDialog(() => reviewPayment(id)); return; }
      const epoch = state.epoch, dialog = modal('مراجعة إيصال واعتماد دفعة العميل', 'vj-payment-dialog'), body = n('div', 'vj-dialog-body'); body.append(skeleton()); dialog.append(body); dialog.showModal();
      let previewURL;
      dialog.addEventListener('close', () => { if (previewURL) { URL.revokeObjectURL(previewURL); state.urls.delete(previewURL); } state.review = null; });
      try { const item = await fetchCase(id); if (epoch !== state.epoch || !dialog.open) return; body.replaceChildren(); body.append(n('p', 'vj-form-intro', item.name + ' · ملف ' + item.id), paymentCards(item));
        if (item.payment.verified) { body.append(n('div', 'vj-success-note', 'هذه الدفعة معتمدة بالفعل. حدّثت اللوحة دون تسجيل اعتماد جديد.')); await refresh(); return; }
        const grid = n('div', 'vj-review-grid'), preview = n('section', 'vj-receipt-preview'), form = n('form', 'vj-review-form'); preview.append(n('h3', '', 'الإيصال المحفوظ'), n('p', 'muted small', 'جارٍ تحميل المعاينة المحمية…')); grid.append(preview, form); body.append(grid);
        const choices = receiptChoices(item), receiptLabel = n('label', 'vj-field vj-receipt-picker'), receiptSelect = n('select'), placeholder = n('option', '', 'اختر إيصال التحويل من الملفات'); placeholder.value = ''; receiptSelect.append(placeholder); receiptSelect.required = true; receiptSelect.setAttribute('aria-label', 'إيصال التحويل من ملفات العميل');
        for (const [index, receipt] of choices.entries()) { const option = n('option', '', (receipt.filename || 'ملف محفوظ ' + (index + 1)) + (receipt.registered ? receipt.current ? ' · إيصال مسجل لهذه النسخة' : ' · إيصال لنسخة سابقة' : ' · تحقق من نوع الملف')); option.value = receipt.id; receiptSelect.append(option); }
        let receiptId = choices.find(receipt => receipt.registered && receipt.current && receipt.id === item.payment.receiptMediaId)?.id || '', previewReady = false, previewVersion = 0;
        receiptSelect.value = receiptId; receiptLabel.append(n('span', '', 'إيصال التحويل الذي راجعته'), receiptSelect);
        const amountLabel = n('label', 'vj-field'), amount = n('input'); amount.type = 'number'; amount.min = '0.01'; amount.step = '0.01'; amount.max = '99999999'; amount.required = true; amount.inputMode = 'decimal'; amount.placeholder = '0.00'; amount.dir = 'ltr'; amount.setAttribute('aria-label', 'المبلغ الذي وصل فعليًا بالدرهم'); amountLabel.append(n('span', '', 'المبلغ الذي وصل فعليًا · AED'), amount);
        const refLabel = n('label', 'vj-field'), reference = n('input'); reference.required = true; reference.minLength = 2; reference.maxLength = 150; reference.autocomplete = 'off'; reference.placeholder = 'مرجع الحوالة أو العملية البنكية'; reference.setAttribute('aria-label', 'مرجع التحويل المتحقق منه'); refLabel.append(n('span', '', 'مرجع التحويل المتحقق منه'), reference);
        const checkboxLabel = n('label', 'vj-check'), checked = n('input'); checked.type = 'checkbox'; checked.required = true; checkboxLabel.append(checked, n('span', '', 'راجعت الملف المحدد كإيصال تحويل، وتحققت من وصول هذا المبلغ فعليًا إلى حساب الرمال وطابقت مرجعه. لا أعتمد صورة الإيصال وحدها.'));
        const error = n('p', 'vj-form-error'); error.setAttribute('role', 'alert'); const hint = n('p', 'vj-review-consequence', 'بعد الاعتماد، يتابع إسماعيل تأكيد الاستلام للعميل ثم يبدأ مسار تجهيز رعد عندما تسمح حالة الملف. رسوم بوابة التأشيرات تبقى غير مدفوعة.');
        const actions = n('div', 'vj-modal-actions'), submit = button('اعتماد الدفعة وتسليم المتابعة', null, true); submit.type = 'submit'; submit.disabled = true; actions.append(button('إلغاء', () => dialog.close()), submit); form.append(receiptLabel, amountLabel, refLabel, checkboxLabel, hint, error, actions);
        async function loadReceiptPreview() {
          const version = ++previewVersion, selected = choices.find(receipt => receipt.id === receiptSelect.value); receiptId = selected?.id || ''; previewReady = false; submit.disabled = true; checked.checked = false; error.textContent = '';
          if (previewURL) { URL.revokeObjectURL(previewURL); state.urls.delete(previewURL); previewURL = null; }
          if (!receiptId) { preview.replaceChildren(n('h3', '', 'اختر ملف الإيصال'), n('p', 'muted small', choices.length ? 'اختر إيصال التحويل من القائمة ثم راجع صورته. الملفات غير المصنفة قد تكون جوازًا أو مستندًا آخر.' : 'لا توجد صور أو ملفات PDF أصلية متاحة. راجع مستندات الملف أو انتظر إيصال العميل.')); return; }
          preview.replaceChildren(n('h3', '', 'الإيصال المحدد'), n('p', 'muted small', 'جارٍ تحميل المعاينة المحمية…'));
          try { const blob = await media(receiptId, id); if (epoch !== state.epoch || !dialog.open || version !== previewVersion) return; if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(blob.type)) throw Error('صيغة غير مدعومة');
            preview.replaceChildren(n('h3', '', 'الإيصال المحدد')); previewURL = URL.createObjectURL(blob); state.urls.add(previewURL);
            if (/^image\/(jpeg|png|webp)$/.test(blob.type)) { const image = n('img'); image.alt = 'معاينة ملف إيصال التحويل المحدد'; image.src = previewURL; image.onerror = () => { if (version !== previewVersion || !dialog.open) return; previewReady = false; submit.disabled = true; error.textContent = 'تعذر عرض الصورة المحددة. اختر إيصالًا واضحًا قبل الاعتماد.'; }; preview.append(image); }
            else preview.append(n('div', 'vj-document-icon', 'PDF'), n('p', 'muted small', 'ملف محفوظ · افتح النسخة للفحص قبل الاعتماد'));
            const link = n('a', 'button subtle', 'فتح الملف المحدد ↗'); link.href = previewURL; link.target = '_blank'; link.rel = 'noopener'; preview.append(link, n('p', 'vj-receipt-filename', selected.filename || 'الملف المحدد')); previewReady = true; submit.disabled = false;
          } catch { if (epoch === state.epoch && dialog.open && version === previewVersion) { preview.replaceChildren(n('h3', '', 'تعذرت معاينة الملف المحدد'), n('p', 'muted small', 'أعد اختيار الملف بعد التحقق من اتصال الخدمة.')); previewReady = false; submit.disabled = true; } }
        }
        receiptSelect.onchange = loadReceiptPreview; loadReceiptPreview();
        form.onsubmit = async event => { event.preventDefault(); if (!form.reportValidity() || !receiptId || !previewReady || dialog.dataset.busy) return; const value = Number(amount.value), ref = reference.value.trim(); if (!Number.isFinite(value) || value <= 0 || !ref || !checked.checked) return;
          const fingerprint = JSON.stringify([id, receiptId, value, ref, item.caseSignature, item.revision]); let attempt = state.attempts.get(id);
          if (attempt && attempt.fingerprint !== fingerprint && attempt.uncertain) { error.textContent = 'توجد محاولة اعتماد غير مؤكدة. حدّث الملف للتحقق منها قبل تغيير المبلغ أو المرجع.'; return; }
          if (!attempt || attempt.fingerprint !== fingerprint) { attempt = {fingerprint, idempotencyKey: crypto.randomUUID(), uncertain: false}; state.attempts.set(id, attempt); }
          dialog.dataset.busy = 'true'; for (const control of form.elements) control.disabled = true; submit.textContent = 'جارٍ التحقق والاعتماد…'; error.textContent = '';
          try { await adapter.approve(id, {receiptMediaId: receiptId, amount: value, reference: ref, actualReceived: true, confirm: true, expectedCaseSignature: item.caseSignature, expectedRevision: item.revision, idempotencyKey: attempt.idempotencyKey}); if (epoch !== state.epoch) return; state.attempts.delete(id); dialog.close(); toast('اعتمد المحاسب وصول الدفعة. تتحدث خطوات إسماعيل ورعد حسب حالة الملف.'); await refresh(); if (onChange) onChange(id); }
          catch (failure) { if (epoch !== state.epoch) return; attempt.uncertain = !failure.status || failure.status >= 500; error.textContent = attempt.uncertain ? 'لم تتأكد نتيجة الاعتماد. يمكنك إعادة التحقق بنفس المبلغ والمرجع؛ ستُستخدم المحاولة نفسها دون تكرار.' : failure.message; if (!attempt.uncertain) state.attempts.delete(id); if (failure.status === 409) { submit.disabled = true; error.append(button('تحديث حالة الملف', () => { dialog.close(); reviewPayment(id); })); } }
          finally { delete dialog.dataset.busy; if (dialog.open && epoch === state.epoch) { for (const control of form.elements) control.disabled = false; submit.disabled = !previewReady || Boolean(error.querySelector('button')); submit.textContent = attempt.uncertain ? 'التحقق من الاعتماد نفسه' : 'اعتماد الدفعة وتسليم المتابعة'; } }
        };
      } catch (error) { if (dialog.open && epoch === state.epoch) body.replaceChildren(n('p', 'error', error.message), button('إعادة المحاولة', () => { dialog.close(); reviewPayment(id); })); }
    }
    function reset() { state.epoch++; state.accountantKey = ''; state.items = []; state.loaded = false; state.loading = false; state.error = ''; state.capabilities = {}; state.attempts.clear(); for (const url of state.urls) URL.revokeObjectURL(url); state.urls.clear(); for (const dialog of document.querySelectorAll('.vj-dialog')) dialog.close(); if (container) container.replaceChildren(); }
    render(); return {refresh, openCase, reviewPayment, reset, confirm: showMessage};
  }
  return {create, normalize, stageOf, paymentOf, receiptChoices, applicantStage, documentReviewState, visibleDocumentFields, matches, stages};
});
