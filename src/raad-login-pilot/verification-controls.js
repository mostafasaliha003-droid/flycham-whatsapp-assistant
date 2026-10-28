'use strict';
// Browser-side structural inspection only. Never reads input values or returns
// page text, email addresses, verification codes, cookies, or URLs.
function inspectVerificationControls(){
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 const path=el=>{const parts=[];for(let n=el;n&&n.nodeType===1;n=n.parentElement){if(n.id){parts.unshift('#'+CSS.escape(n.id));break;}let i=1;for(let s=n.previousElementSibling;s;s=s.previousElementSibling)if(s.tagName===n.tagName)i++;parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+i+')');}return parts.join(' > ');};
 const label=el=>[el.id,el.name,el.getAttribute('autocomplete'),el.getAttribute('aria-label'),el.getAttribute('placeholder'),...Array.from(el.labels||[],l=>l.textContent)].filter(Boolean).join(' ');
 const candidates=Array.from(document.querySelectorAll('input')).filter(el=>{
  if(!visible(el)||el.disabled||el.readOnly||!['text','password','tel','number'].includes(el.type))return false;
  const text=label(el);if(/captcha|رمز\s*الصورة|UserName|NafathID/i.test(text))return false;
  const strong=/one-time-code|one.?time.?password|\botp\b|otpcode|verification.?code|verify.?code|activation.?code|رمز\s*(التحقق|التأكيد|التفعيل)|كود\s*(التحقق|التأكيد|التفعيل)/i.test(text)||el.type==='text'&&el.maxLength===6&&/otp|verification|one.?time|رمز\s*(التحقق|التأكيد|التفعيل)|كود\s*(التحقق|التأكيد)/i.test(text);
  if(/Password/i.test(text)&&!strong)return false;if(strong)return true;
  const form=el.closest('form');return /^(code|pin|token|validationcode|checkcode)$/i.test(el.id||el.name||'')&&form&&/رمز\s*(التحقق|التأكيد)|verification\s*code|one.time\s*(code|password)/i.test(form.textContent||'');
 });
 if(candidates.length!==1)return null;
 const input=candidates[0],form=input.closest('form');if(!form)return null;
 const buttons=Array.from(form.querySelectorAll('button,input[type=submit],input[type=button],a[role=button]')).filter(el=>{
  if(!visible(el)||el.disabled||el.closest('form')!==form)return false;
  // Button captions are public control labels, not editable values.
  const text=(el.tagName==='INPUT'?el.getAttribute('value'):el.textContent)||'';
  const metadata=[text,el.id,el.name,el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('formaction')].filter(Boolean).join(' ');
  return !/resend|إعادة|اعادة|جديد|إرسال.*رمز|ارسال.*رمز/i.test(metadata)&&(/^(\s*)(تحقق|التحقق|تأكيد|تاكيد|دخول|تسجيل الدخول|متابعة|إرسال|ارسال|verify|confirm|continue|submit|login|sign in)(\s*)$/i.test(text)||el.tagName==='INPUT'&&el.type==='submit'&&el.id==='btnSubmit'&&input.type==='text'&&input.maxLength===6);
 });
 if(buttons.length!==1)return null;
 const inputSelector=path(input),buttonSelector=path(buttons[0]);if(inputSelector.length>2048||buttonSelector.length>2048)return null;
 return {inputSelector,buttonSelector,maxLength:Math.min(8,input.maxLength>0?input.maxLength:8)};
}
async function findVerificationControls(page){try{if(typeof page.evaluate!=='function')return null;const out=await page.evaluate(inspectVerificationControls);if(!out||typeof out.inputSelector!=='string'||typeof out.buttonSelector!=='string'||!Number.isInteger(out.maxLength)||out.maxLength<4)return null;for(const selector of [out.inputSelector,out.buttonSelector]){const item=page.locator(selector);if(await item.count()!==1||!await item.isVisible()||!await item.isEnabled())return null;}return out;}catch{return null;}}
module.exports={findVerificationControls,inspectVerificationControls};

// Protected support metadata only. Never reads editable values or returns body
// text, labels, links, image content, email addresses, cookies, or codes.
function inspectVerificationStructure(){
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 const known=new Set(['username','password','captcha','code','otp','pin','verificationcode','verifycode','emailcode','confirmationcode','activationcode','onetimepassword','btnsubmit','btnverify','btnconfirm','verify','confirm','submit','login','btnresend','resendcode','text','tel','number','email','button']);
 const safe=value=>typeof value==='string'&&known.has(value.toLowerCase())?value:null;
 const fields=Array.from(document.querySelectorAll('input')).filter(visible).slice(0,16).map(el=>{
  const description=[el.id,el.name,el.getAttribute('aria-label'),el.getAttribute('placeholder'),...Array.from(el.labels||[],l=>l.textContent)].filter(Boolean).join(' ');
  const form=el.closest('form');return {id:safe(el.id),name:safe(el.name),type:safe(el.type),hasForm:!!form,formHasBox:form?visible(form):false,maxLength:el.maxLength>0&&el.maxLength<=32?el.maxLength:null,otpAutocomplete:el.getAttribute('autocomplete')==='one-time-code',verificationLabel:/otp|verification|one.?time|رمز\s*(التحقق|التأكيد|التفعيل)|كود\s*(التحقق|التأكيد)/i.test(description),imageCodeLabel:/captcha|رمز\s*الصورة/i.test(description)};
 });
 const buttons=Array.from(document.querySelectorAll('button,input[type=submit],input[type=button],a[role=button]')).filter(visible).slice(0,16).map(el=>{const label=(el.tagName==='INPUT'?el.getAttribute('value'):el.textContent)||'';const identity=[label,el.id,el.name,el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' ');return {id:safe(el.id),name:safe(el.name),type:safe(el.getAttribute('type')),hasForm:!!el.closest('form'),kind:/resend|إعادة|اعادة/i.test(identity)?'resend':/verify|confirm|تحقق|تأكيد|تاكيد/i.test(label)?'verify':/login|دخول/i.test(label)?'login':/submit|إرسال|ارسال|متابعة|continue/i.test(label)?'submit':'other'};});
 return {fields,buttons,frameCount:Math.min(document.querySelectorAll('iframe').length,16)};
}
async function getVerificationDiagnostics(page){try{return await page.evaluate(inspectVerificationStructure);}catch{return {unavailable:true};}}
module.exports.getVerificationDiagnostics=getVerificationDiagnostics;
module.exports.inspectVerificationStructure=inspectVerificationStructure;
