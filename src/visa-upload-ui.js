(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) api.createUploadPage({window: root, document: root.document}).start();
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const ROLES = ['passport', 'residence', 'photo'];
  const LABELS = {passport: 'جواز السفر', residence: 'الهوية الإماراتية', photo: 'الصورة الشخصية'};
  const DEFAULT_LIMITS = {passport: 2, residence: 2, photo: 1};
  const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  const CLIENT_KEY = /^[a-zA-Z\d_-]{8,100}$/;
  const MAX_BYTES = 10 * 1024 * 1024;
  const ERROR_COPY = {
    UPLOAD_SIZE_INVALID: 'حجم الملف غير مناسب. اختر ملفًا لا يتجاوز 10 ميغابايت.',
    UPLOAD_TOO_LARGE: 'حجم الملف كبير. اختر ملفًا لا يتجاوز 10 ميغابايت.',
    UPLOAD_TYPE_INVALID: 'اختر صورة JPG أو PNG أو WebP، أو ملف PDF للمستندات.',
    UPLOAD_MIME_INVALID: 'اختر صورة JPG أو PNG أو WebP، أو ملف PDF للمستندات.',
    UPLOAD_CONTENT_INVALID: 'لم يفتح هذا الملف بشكل سليم. جرّب الصورة الأصلية أو ملفًا آخر.',
    UPLOAD_FILE_INVALID: 'لم يفتح هذا الملف بشكل سليم. جرّب الصورة الأصلية أو ملفًا آخر.',
    UPLOAD_LIMIT_REACHED: 'وصلت للعدد المتاح لهذا المستند. احذف مرفقًا لاستبداله.',
    UPLOAD_LIMIT: 'وصلت للعدد المتاح لهذا المستند. احذف مرفقًا لاستبداله.',
    UPLOAD_CAPACITY_REACHED: 'ملفك يحتاج متابعة من الفريق قبل إضافة مرفقات أخرى. ارجع إلى إسماعيل على واتساب.',
    UPLOAD_STORAGE_UNAVAILABLE: 'لم يتم تأكيد حفظ الملف حاليًا. جرّب مرة أخرى أو أرسله في محادثة واتساب.',
    UPLOAD_EMPTY: 'أضف مستندًا واحدًا على الأقل، ثم اضغط «تم».',
    UPLOAD_CONFLICT: 'هذا الملف قيد الحفظ. أعد المحاولة لنؤكّد النتيجة.',
    UPLOAD_UNAVAILABLE: 'لم يتم تأكيد الحفظ حاليًا. أعد المحاولة من الزر أدناه.',
    UPLOAD_NETWORK: 'انقطع الاتصال قبل تأكيد الرفع. اضغط «إعادة المحاولة» لنؤكّد حفظ الملف.',
    UPLOAD_RESPONSE_INVALID: 'لم نتمكن من تأكيد نتيجة الرفع. أعد المحاولة لنؤكّد حفظ الملف.'
  };
  function cleanToken(hash) {
    const token = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
    return /^[A-Za-z\d_-]{43}$/.test(token) ? token : '';
  }
  function safeWhatsapp(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.origin !== 'https://wa.me' || url.username || url.password || url.hash || !/^\/[1-9]\d{7,14}$/.test(url.pathname)) return null;
      if ([...url.searchParams.keys()].some(key => key !== 'text') || url.searchParams.getAll('text').length > 1 || (url.searchParams.get('text') || '').length > 300) return null;
      return url.href;
    } catch { return null; }
  }
  function normaliseSession(data) {
    if (!data || data.ok !== true || !['open', 'completed'].includes(data.state) || !Number.isFinite(data.expiresAt) || !Array.isArray(data.files) || data.files.length > 5) throw new Error('UPLOAD_RESPONSE_INVALID');
    const limits = Object.fromEntries(ROLES.map(role => [role, Number.isSafeInteger(data.limits?.[role]) && data.limits[role] >= 1 && data.limits[role] <= DEFAULT_LIMITS[role] ? data.limits[role] : DEFAULT_LIMITS[role]]));
    const seen = new Set();
    const files = data.files.map(file => {
      if (!file || !UUID.test(file.id || '') || seen.has(file.id) || !ROLES.includes(file.role) || !MIME.has(file.mimeType) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BYTES) throw new Error('UPLOAD_RESPONSE_INVALID');
      seen.add(file.id);
      return {id: file.id, role: file.role, mimeType: file.mimeType, size: file.size, ...(CLIENT_KEY.test(file.clientKey || '') ? {clientKey: file.clientKey} : {})};
    });
    for (const role of ROLES) if (files.filter(file => file.role === role).length > limits[role]) throw new Error('UPLOAD_RESPONSE_INVALID');
    return {state: data.state, expiresAt: data.expiresAt, maxBytes: Math.min(MAX_BYTES, Number.isSafeInteger(data.maxBytes) && data.maxBytes > 0 ? data.maxBytes : MAX_BYTES), limits, files, whatsappUrl: safeWhatsapp(data.whatsappUrl)};
  }
  function fileProblem(file, role, maxBytes = MAX_BYTES) {
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxBytes) return 'حجم الملف غير مناسب. اختر ملفًا من 1 بايت إلى 10 ميغابايت.';
    if (!MIME.has(file.type)) return 'اختر صورة JPG أو PNG أو WebP، أو ملف PDF.';
    return null;
  }
  function errorCopy(error) { return ERROR_COPY[error?.code || error?.message] || 'لم يتم تأكيد الحفظ حاليًا. أعد المحاولة أو تابع مع إسماعيل على واتساب.'; }
  function uploadError(status, data) {
    const code = typeof data?.error === 'string' && /^UPLOAD_[A-Z_]{1,60}$/.test(data.error) ? data.error : 'UPLOAD_UNAVAILABLE';
    return Object.assign(new Error(code), {code, status});
  }
  function createUploadPage({window, document, fetchImpl = (...args) => window.fetch(...args), binaryRequest} = {}) {
    const $ = id => document.getElementById(id);
    let token = cleanToken(window.location.hash), session = null, items = [], uploading = false, completing = false, terminal = false, started = false, clock;
    const sizeText = bytes => bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toLocaleString('ar-AE', {maximumFractionDigits: 1}) + ' ميغابايت' : Math.max(1, Math.round(bytes / 1024)).toLocaleString('ar-AE') + ' كيلوبايت';
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const headers = () => ({Authorization: 'Bearer ' + token});
    const revoke = item => { if (item.preview) { window.URL.revokeObjectURL(item.preview); item.preview = null; } };
    const active = () => !terminal && token && session?.state === 'open' && session.expiresAt > Date.now();
    function terminalProblem(error) {
      return [401, 410].includes(error?.status) || ['UPLOAD_STALE', 'UPLOAD_CASE_CHANGED', 'UPLOAD_OWNER_PAUSED', 'UPLOAD_PAUSED', 'UPLOAD_BLOCKED', 'UPLOAD_SESSION_INVALID', 'UPLOAD_TOKEN_INVALID', 'UPLOAD_EXPIRED'].includes(error?.code || error?.message);
    }
    function showTerminal(error) {
      const canRetry = Boolean(token) && !terminalProblem(error) && !['UPLOAD_TOKEN_INVALID', 'UPLOAD_STALE'].includes(error?.code || error?.message);
      terminal = true;
      for (const item of items) revoke(item);
      $('loading').hidden = true; $('upload-view').hidden = true; $('success-view').hidden = true; $('link-error').hidden = false;
      const code = error?.code || error?.message;
      const owned = ['UPLOAD_OWNER_PAUSED', 'UPLOAD_PAUSED', 'UPLOAD_BLOCKED'].includes(code);
      $('error-heading').textContent = owned ? 'الفريق يتابع ملفك الآن' : canRetry ? 'نحاول الاتصال بملفك' : 'نحتاج رابطًا جديدًا';
      $('link-error-copy').textContent = owned ? 'ارجع إلى محادثة إسماعيل على واتساب ليكمل معك رفع المستندات.' : canRetry ? 'لم يكتمل الاتصال الآن. أعد المحاولة من هنا، أو تابع مع إسماعيل على واتساب.' : error?.status === 410 || code === 'UPLOAD_EXPIRED' ? 'انتهت صلاحية هذا الرابط. اطلب من إسماعيل رابطًا جديدًا في محادثة واتساب.' : 'افتح رابط المستندات الأخير الذي أرسله إسماعيل على واتساب. إذا حدّثت هذه الصفحة، افتح الرابط من المحادثة مجددًا.';
      $('retry-session').hidden = !canRetry;
      $('error-heading').focus();
      if (!canRetry) token = '';
      if (clock) window.clearInterval(clock);
    }
    async function request(path, method = 'GET') {
      let response;
      try { response = await fetchImpl('/api/visa-upload/' + path, {method, headers: headers(), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'}); }
      catch { throw Object.assign(new Error('UPLOAD_NETWORK'), {code: 'UPLOAD_NETWORK'}); }
      let data;
      try { const raw = await response.text(); if (raw.length > 100000) throw Error(); data = JSON.parse(raw); } catch { throw uploadError(response.status, {error: 'UPLOAD_RESPONSE_INVALID'}); }
      if (!response.ok || data?.ok !== true) throw uploadError(response.status, data);
      return data;
    }
    const sendBinary = binaryRequest || ((path, {body, headers: requestHeaders, onProgress}) => new Promise((resolve, reject) => {
      const xhr = new window.XMLHttpRequest(); xhr.open('POST', path); xhr.timeout = 90000;
      for (const [key, value] of Object.entries(requestHeaders)) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(Object.assign(new Error('UPLOAD_NETWORK'), {code: 'UPLOAD_NETWORK'}));
      xhr.onload = () => {
        let data;
        try { if (xhr.responseText.length > 100000) throw Error(); data = JSON.parse(xhr.responseText); } catch { reject(uploadError(xhr.status, {error: 'UPLOAD_RESPONSE_INVALID'})); return; }
        if (xhr.status < 200 || xhr.status >= 300 || data?.ok !== true) { reject(uploadError(xhr.status, data)); return; }
        resolve(data);
      };
      xhr.send(body);
    }));
    function applySession(data) {
      const next = normaliseSession(data);
      session = next;
      for (const saved of next.files) {
        let item = items.find(candidate => candidate.id === saved.id || saved.clientKey && candidate.key === saved.clientKey);
        if (!item) { item = {key: saved.clientKey || 'saved-' + saved.id, preview: null}; items.push(item); }
        Object.assign(item, saved, {state: 'saved', progress: 100, error: null, file: null});
      }
      items = items.filter(item => { const retain = !item.id || next.files.some(saved => saved.id === item.id); if (!retain) revoke(item); return retain; });
      if (next.state === 'completed') showSuccess();
    }
    function updateClock() {
      if (!session || terminal || session.state === 'completed') return;
      const minutes = Math.ceil((session.expiresAt - Date.now()) / 60000);
      if (minutes <= 0) { showTerminal(Object.assign(new Error('UPLOAD_EXPIRED'), {status: 410})); return; }
      $('expiry-label').textContent = minutes >= 60 ? 'صالح لمدة ' + Math.floor(minutes / 60).toLocaleString('ar-AE') + ' ساعة' + (minutes % 60 ? ' و' + (minutes % 60).toLocaleString('ar-AE') + ' دقيقة' : '') : 'ينتهي الرابط بعد ' + minutes.toLocaleString('ar-AE') + ' دقيقة';
    }
    function render() {
      if (!session || terminal || session.state === 'completed') return;
      for (const role of ROLES) {
        const list = $(role + '-files'); list.replaceChildren();
        const group = items.filter(item => item.role === role);
        for (const [index, item] of group.entries()) {
          const row = element('div', 'file-row' + (item.state === 'failed' ? ' failed' : ''));
          const preview = element('span', 'file-preview');
          if (item.preview) { const image = element('img'); image.src = item.preview; image.alt = 'معاينة ' + LABELS[role] + ' ' + (index + 1).toLocaleString('ar-AE'); preview.append(image); }
          else preview.textContent = item.mimeType === 'application/pdf' ? 'PDF' : 'صورة';
          const info = element('div', 'file-info');
          const title = item.mimeType === 'application/pdf' ? 'ملف PDF' : 'الصورة ' + (index + 1).toLocaleString('ar-AE');
          info.append(element('p', 'file-title', title));
          const meta = element('p', 'file-meta'); meta.append(element('span', '', sizeText(item.size)));
          const stateLabel = item.state === 'saved' ? 'تم الحفظ' : item.state === 'uploading' ? 'جارٍ الرفع · ' + item.progress.toLocaleString('ar-AE') + '٪' : item.state === 'queued' ? 'في انتظار الرفع' : item.state === 'deleting' ? 'جارٍ الإزالة' : 'يحتاج إعادة المحاولة';
          meta.append(element('span', 'file-state' + (item.state === 'saved' ? '' : item.state === 'failed' ? ' failed' : ' pending'), stateLabel)); info.append(meta);
          if (item.state === 'uploading') { const progress = element('progress', 'upload-progress'); progress.max = 100; progress.value = item.progress; progress.setAttribute('aria-label', 'رفع ' + LABELS[role]); info.append(progress); }
          const actions = element('div', 'file-actions');
          if (item.state === 'failed') { const retry = element('button', 'retry-file', 'إعادة المحاولة'); retry.type = 'button'; retry.disabled = completing; retry.addEventListener('click', () => { item.state = 'queued'; item.error = null; $(role + '-error').textContent = ''; render(); pump(); }); actions.append(retry); }
          const remove = element('button', 'remove-file', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'إزالة ' + title + ' من ' + LABELS[role]);
          // A failed response may hide an accepted server upload. Retrying the
          // same idempotency key confirms its exact ID before removal.
          remove.disabled = completing || ['uploading', 'deleting'].includes(item.state) || item.state === 'failed' && item.uncertain;
          remove.addEventListener('click', () => removeItem(item)); actions.append(remove);
          row.append(preview, info, actions); list.append(row);
        }
        const input = $(role + '-input'); input.disabled = completing || group.length >= session.limits[role];
        input.closest('.drop-zone').classList.toggle('unavailable', input.disabled);
      }
      const saved = items.filter(item => item.state === 'saved').length, busy = items.some(item => item.state !== 'saved');
      $('upload-count').textContent = saved ? 'تم حفظ ' + saved.toLocaleString('ar-AE') + ' من المرفقات' : items.length ? 'جارٍ تجهيز المرفقات' : 'لم تُضف مستندات بعد';
      $('upload-hint').textContent = busy ? 'انتظر تأكيد حفظ المرفقات قبل الضغط على «تم».' : 'أضف ما تبقّى من مستنداتك. ما أرسلته على واتساب يبقى في ملفك.';
      $('complete-button').disabled = completing || busy || !saved;
      $('complete-label').textContent = completing ? 'جارٍ تأكيد الإرسال…' : 'تم وإرسال المستندات';
    }
    async function removeItem(item) {
      if (!active() || completing || ['uploading', 'deleting'].includes(item.state) || item.state === 'failed' && item.uncertain) return;
      $(item.role + '-error').textContent = '';
      if (!item.id) { items = items.filter(value => value !== item); revoke(item); render(); return; }
      item.state = 'deleting'; render();
      try { applySession(await request('files/' + encodeURIComponent(item.id), 'DELETE')); }
      catch (error) { if (terminalProblem(error)) { showTerminal(error); return; } item.state = 'saved'; $(item.role + '-error').textContent = 'لم يتم تأكيد إزالة المرفق. جرّب الإزالة مرة أخرى.'; }
      render();
    }
    async function pump() {
      if (uploading || completing || !active()) return;
      uploading = true;
      try {
        let item;
        while (active() && (item = items.find(value => value.state === 'queued'))) {
          item.state = 'uploading'; item.progress = 0; render();
          try {
            const data = await sendBinary('/api/visa-upload/files', {body: item.file, headers: {...headers(), 'Content-Type': item.mimeType, 'X-Upload-Role': item.role, 'X-Idempotency-Key': item.key}, onProgress: value => { item.progress = value; render(); }});
            // The echoed key is optional for old session responses, so verify
            // the returned exact file as well before claiming it was saved.
            const next = normaliseSession(data), saved = next.files.find(file => file.id === data.file?.id && file.role === item.role && file.size === item.size && file.mimeType === item.mimeType);
            if (!saved) throw new Error('UPLOAD_RESPONSE_INVALID');
            item.id = saved.id; applySession(data);
          } catch (error) {
            if (terminalProblem(error)) { showTerminal(error); return; }
            // Read back once after an uncertain network outcome. The server
            // returns the original client key, never an arrival-order guess.
            if (['UPLOAD_NETWORK', 'UPLOAD_SEALED'].includes(error?.code)) try { applySession(await request('session')); } catch (readError) { if (terminalProblem(readError)) { showTerminal(readError); return; } }
            if (session?.state === 'completed' || terminal) return;
            if (item.state !== 'saved') { item.state = 'failed'; item.uncertain = !error?.status || error.status >= 500 || error.status === 408; item.error = errorCopy(error); $(item.role + '-error').textContent = item.error; }
          }
          render();
        }
      } finally { uploading = false; render(); }
    }
    function addFiles(role, files) {
      if (!active() || completing || !ROLES.includes(role)) return;
      const errors = [], available = session.limits[role] - items.filter(item => item.role === role).length;
      let added = 0;
      for (const file of Array.from(files || [])) {
        const problem = fileProblem(file, role, session.maxBytes);
        if (problem) { errors.push(problem); continue; }
        if (added >= available) { errors.push(role === 'photo' ? 'يمكنك إضافة صورة شخصية واحدة. احذف الحالية إذا أردت استبدالها.' : 'يمكنك إضافة مرفقين لهذا المستند. احذف أحدهما إذا أردت استبداله.'); continue; }
        const item = {key: window.crypto.randomUUID(), role, mimeType: file.type, size: file.size, file, state: 'queued', progress: 0, preview: file.type.startsWith('image/') ? window.URL.createObjectURL(file) : null};
        items.push(item); added++;
      }
      $(role + '-error').textContent = [...new Set(errors)].join(' ');
      $('complete-error').hidden = true;
      render(); pump();
    }
    function showSuccess() {
      $('loading').hidden = true; $('link-error').hidden = true; $('upload-view').hidden = true; $('success-view').hidden = false;
      const summary = $('success-files'); summary.replaceChildren();
      for (const role of ROLES) { const count = session.files.filter(file => file.role === role).length; if (count) summary.append(element('span', '', LABELS[role] + ' · ' + count.toLocaleString('ar-AE'))); }
      const link = $('whatsapp-link'); link.hidden = !session.whatsappUrl;
      if (session.whatsappUrl) { link.href = session.whatsappUrl; $('return-copy').textContent = 'تفتح العودة محادثتك مع رسالة «تم رفع المستندات». أرسلها هناك للمتابعة.'; }
      $('success-heading').focus();
      for (const item of items) revoke(item);
      if (clock) window.clearInterval(clock);
      window.scrollTo?.({top: 0, behavior: 'auto'});
    }
    async function complete(event) {
      event.preventDefault();
      if (!active() || completing || !items.length || items.some(item => item.state !== 'saved')) return;
      completing = true; $('complete-error').hidden = true; render();
      try {
        const data = await request('complete', 'POST');
        if (data.state !== 'completed') throw new Error('UPLOAD_RESPONSE_INVALID');
        applySession(data);
      } catch (error) {
        if (terminalProblem(error)) showTerminal(error);
        else { $('complete-error').textContent = error?.code === 'UPLOAD_NETWORK' ? 'انقطع الاتصال قبل تأكيد الإرسال. اضغط «تم» مرة أخرى لنؤكّد النتيجة؛ لن نكرر مرفقاتك.' : errorCopy(error); $('complete-error').hidden = false; }
      } finally { completing = false; render(); }
    }
    async function loadSession() {
      terminal = false; $('link-error').hidden = true; $('loading').hidden = false;
      try {
        applySession(await request('session'));
        if (session.state === 'completed') return;
        if (session.expiresAt <= Date.now()) { showTerminal(Object.assign(new Error('UPLOAD_EXPIRED'), {status: 410})); return; }
        $('loading').hidden = true; $('upload-view').hidden = false; $('existing-note').hidden = session.files.length === 0;
        render(); updateClock(); clock = window.setInterval(updateClock, 15000);
      } catch (error) { showTerminal(error); }
    }
    async function start() {
      if (started) return; started = true;
      // A bearer link is read once into memory. It never enters an API path,
      // referrer, cookie or browser storage, and refresh requires the chat link.
      window.history.replaceState(null, '', window.location.pathname);
      $('upload-form').addEventListener('submit', complete);
      $('retry-session').addEventListener('click', loadSession);
      for (const role of ROLES) {
        const input = $(role + '-input'), zone = input.closest('.drop-zone');
        input.addEventListener('change', () => { addFiles(role, input.files); input.value = ''; });
        zone.addEventListener('dragover', event => { event.preventDefault(); if (active() && !input.disabled) zone.classList.add('dragging'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
        zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('dragging'); addFiles(role, event.dataTransfer?.files); });
      }
      window.addEventListener('beforeunload', event => { if (!terminal && session?.state === 'open' && items.length) { event.preventDefault(); event.returnValue = ''; } });
      if (!token) { showTerminal(new Error('UPLOAD_TOKEN_INVALID')); return; }
      await loadSession();
    }
    return {start};
  }
  return {createUploadPage, cleanToken, safeWhatsapp, normaliseSession, fileProblem, errorCopy};
});
