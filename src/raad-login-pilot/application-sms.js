'use strict';
const {inspectPortalPage}=require('./portal-inspection');
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm/TraditionalApp';
// The owner route must enforce its authenticated application session. Optional
// guard is re-run throughout native interaction; this module never logs in.
const contexts=new WeakMap();
const CODES=new Set(['APPLICATION_SMS_INPUT_INVALID','APPLICATION_SMS_UNAVAILABLE','APPLICATION_SMS_PHONE_MISMATCH','APPLICATION_SMS_CHALLENGE_UNAVAILABLE','APPLICATION_SMS_ALREADY_ATTEMPTED','APPLICATION_SMS_CANCELLED','APPLICATION_SMS_ACTIVATION_UNCONFIRMED']);
const finite=code=>Object.assign(new Error(CODES.has(code)?code:'APPLICATION_SMS_UNAVAILABLE'),{code:CODES.has(code)?code:'APPLICATION_SMS_UNAVAILABLE'});

// This callback returns DOM references only to the private caller. It never
// returns telephone values, selected opaque values, OTP values or handler text.
function inspectSmsControls(args){
 try{
  const fail=error=>({error});
  if(location.origin!=='https://visa.mofa.gov.sa'||location.pathname!=='/SmartForm/TraditionalApp'||window.top!==window.self)return fail('APPLICATION_SMS_UNAVAILABLE');
  const normal=value=>String(value||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/g,' ').replace(/\s+/g,' ').trim();
  const publicText=value=>normal(String(value||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/[0-9٠-٩۰-۹]{6,}/g,'[number]').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,'[id]').replace(/[A-Za-z0-9_-]{40,}/g,'[id]')).slice(0,120);
  const visible=el=>{if(!el||!el.isConnected)return false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse')return false;}return el.getClientRects().length>0;};
  const visibleText=root=>{const parts=[];let count=0,length=0;const visit=node=>{if(!node||++count>2000||length>=4000)return;if(node.nodeType===3){const t=String(node.textContent||'').slice(0,4000-length);parts.push(t);length+=t.length;return;}if(node.nodeType!==1||['INPUT','SELECT','TEXTAREA','SCRIPT','STYLE','NOSCRIPT'].includes(node.tagName)||!visible(node))return;for(const child of Array.from(node.childNodes||[]))visit(child);parts.push(' ');};visit(root);return normal(parts.join(''));};
  const caption=el=>{if(el.tagName==='INPUT')return publicText(el.getAttribute('value'));const copy=el.cloneNode(true);for(const child of copy.querySelectorAll('input,textarea,select,button,script,style'))child.remove();return publicText(copy.textContent);};
  const label=el=>publicText(el.labels?Array.from(el.labels).map(caption).join(' '):'')||publicText(el.getAttribute('aria-label'));
  const meta=el=>[el.getAttribute('id'),el.getAttribute('name'),label(el),el.getAttribute('autocomplete')].filter(Boolean).join(' ');
  const smsText=text=>/\bsms\b|رسال[ةه]\s*نصي[ةه]|(?:mobile|phone).*(?:verification|verify|code)|(?:verification|verify|code).*(?:mobile|phone)|(?:تحقق|تأكيد).*رقم\s*(?:الجوال|الهاتف)|(?:رمز|كود).*(?:الجوال|الهاتف)|(?:الجوال|الهاتف).*(?:رمز|كود)/i.test(text);
  const codeText=text=>/\botp\b|(?:^|[_\W])otp(?:$|[_\W0-9])|otp.?code|verification.?code|one.?time|sms.?code|security.?code|validation.?code|رمز\s*(?:التحقق|التأكيد|التفعيل)/i.test(text);
  const blocked=text=>/captcha|recaptcha|password|passwd|login|sign.?in|log.?out|logoff|signout|auth|nafath|save|submit|payment|payfees?|\bpay\b|card|debit|delete|cancel|حفظ|تقديم|دفع|سداد|بطاق|حذف|إلغاء|الغاء|تسجيل\s*الدخول|خروج/i.test(text);
  const findId=id=>Array.from(document.querySelectorAll('[id]')).filter(el=>el.getAttribute('id')===id);
  const phones=findId('MobileInfo_Mobile'),prefixes=findId('MobileInfo_MobilePrefix');
  if(phones.length!==1||prefixes.length!==1)return fail('APPLICATION_SMS_PHONE_MISMATCH');
  const phone=phones[0],prefix=prefixes[0];
  if(phone.tagName!=='INPUT'||!['text','tel','number'].includes(phone.type)||!visible(phone)||phone.disabled||prefix.tagName!=='SELECT'||prefix.disabled||!phone.form||prefix.form!==phone.form)return fail('APPLICATION_SMS_PHONE_MISMATCH');
  let prefixVisible=visible(prefix);if(!prefixVisible&&/(?:^|\s)select2-hidden-accessible(?:\s|$)/.test(prefix.getAttribute('class')||'')){const container=document.getElementById('select2-MobileInfo_MobilePrefix-container');prefixVisible=Boolean(container&&visible(container)&&container.closest('form')===phone.form);}
  const selected=Array.from(prefix.selectedOptions||[]);
  if(!prefixVisible||phone.value!==args.expectedPhone||selected.length!==1||selected[0].disabled||selected[0].hidden||!String(selected[0].value||'').trim()||selected[0].hasAttribute('placeholder')||selected[0].getAttribute('data-placeholder')==='true'||normal(selected[0].textContent)!==args.expectedPrefixLabel)return fail('APPLICATION_SMS_PHONE_MISMATCH');
  if(args.phone&&args.phone!==phone||args.prefix&&args.prefix!==prefix)return fail('APPLICATION_SMS_PHONE_MISMATCH');
  const formTarget=(form,control)=>{try{const u=new URL(control?.getAttribute('formaction')||form?.getAttribute('action')||location.href,location.href);if(u.origin!==location.origin||u.username||u.password||blocked(u.pathname))return null;for(const [k,v]of u.searchParams)if(blocked(k+' '+v))return null;return u;}catch{return null;}};
  if(!formTarget(phone.form))return fail('APPLICATION_SMS_UNAVAILABLE');
  const rootsFor=el=>{const roots=[];let root=el.closest('.form-group')||el.parentElement;for(let depth=0;root&&depth<3&&!['FORM','BODY','HTML'].includes(root.tagName);depth++,root=root.parentElement){if(visible(root)&&Array.from(root.querySelectorAll('input,select,textarea')).filter(visible).length<=16)roots.push(root);}return roots;};
  const phoneRoots=rootsFor(phone),inPhoneComponent=el=>phoneRoots.some(root=>root.contains(el));
  if(!phoneRoots.length)return fail('APPLICATION_SMS_CHALLENGE_UNAVAILABLE');
  let code=null,roots=phoneRoots;
  if(args.action==='verify'||args.action==='enter'){
   const modals=Array.from(document.querySelectorAll('.modal.in,.modal.show,[role="dialog"],dialog[open],.swal-modal,.sweet-alert,.swal2-popup')).filter(visible);
   const smsModals=modals.filter(root=>smsText(visibleText(root))),smsPhoneRoots=phoneRoots.filter(root=>smsText(visibleText(root)));
   const candidates=Array.from(document.querySelectorAll('input')).filter(el=>{
    if(!visible(el)||el.disabled||el.readOnly||el.hasAttribute('readonly')||!['text','tel','number','search'].includes(el.type))return false;
    const identity=meta(el);if(blocked(identity)||/token|secret|csrf|nonce/i.test(identity))return false;
    const length=el.getAttribute('maxlength');if(length!==null&&(!/^\d{1,2}$/.test(length)||Number(length)<4||Number(length)>8||Number(length)<args.codeLength))return false;
    const explicit=el.getAttribute('autocomplete')==='one-time-code'||codeText(identity)||/otp/i.test((el.getAttribute('id')||'')+' '+(el.getAttribute('name')||'')),generic=/^(?:txt)?code$/i.test(el.getAttribute('id')||'')||/^(?:txt)?code$/i.test(el.getAttribute('name')||'');
    return explicit&&(inPhoneComponent(el)||smsModals.some(root=>root.contains(el)))||generic&&[...smsModals,...smsPhoneRoots].some(root=>root.contains(el));
   });
   if(candidates.length!==1)return fail('APPLICATION_SMS_CHALLENGE_UNAVAILABLE');code=candidates[0];
   if(args.codeField&&args.codeField!==code)return fail('APPLICATION_SMS_CHALLENGE_UNAVAILABLE');
   const containing=smsModals.filter(root=>root.contains(code));
   roots=containing.length?containing:rootsFor(code).filter(root=>inPhoneComponent(root)||phoneRoots.some(parent=>parent.contains(root)));
   if(!roots.length)return fail('APPLICATION_SMS_CHALLENGE_UNAVAILABLE');
  }
  if(args.action==='enter'){
   if(!args.attempts||typeof args.attempts.codeFields?.has!=='function')return fail('APPLICATION_SMS_UNAVAILABLE');
   if(args.attempts.codeFields.has(code)&&!args.owned)return fail('APPLICATION_SMS_ALREADY_ATTEMPTED');
   if(args.phase==='consume'){args.attempts.codeFields.add(code);return {ok:true};}
   if(args.phase==='activate')return {ok:true};
   return {control:null,codeField:code,phone,prefix};
  }
  const controls=[];for(const root of roots)for(const el of root.querySelectorAll('button,input,a,span,i'))if(!controls.includes(el))controls.push(el);
  const matches=controls.filter(el=>{
   if(!visible(el)||args.id&&el.getAttribute('id')!==args.id||caption(el)!==args.label)return false;
   const tag=el.tagName,type=String(el.type||el.getAttribute('type')||'').toLowerCase(),href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'',js=href.match(/^\s*javascript:\s*(?:return\s+)?([A-Za-z_$][A-Za-z0-9_$]{0,63})\(\s*\)\s*;?\s*$/i),jsFunction=js&&/^(?:(?:send|request|receive|get|generate)(?:(?:sms|otp|mobile|phone|verification|verify|code)){1,4}|(?:verify|confirm|validate|check)(?:(?:sms|otp|mobile|phone|verification|code)){1,4})$/i.test(js[1])?js[1]:null;
   const classes=String(el.getAttribute('class')||'').split(/\s+/),delegatedButton=['SPAN','I'].includes(tag)&&classes.some(name=>/^btn(?:-|$)/.test(name))&&!classes.some(name=>/^(?:select2(?:-|$)|status(?:-|$)|field-validation|help-block|alert(?:-|$))/.test(name))&&el.getAttribute('role')!=='status'&&!['polite','assertive'].includes(el.getAttribute('aria-live'))&&!el.closest('label,.select2-container,.select2-selection,[role="status"],[aria-live="polite"],[aria-live="assertive"]');
   const native=['BUTTON','INPUT'].includes(tag)&&['button','submit'].includes(type),nonNative=['SPAN','I','A'].includes(tag)&&(el.getAttribute('role')==='button'||el.hasAttribute('onclick')||typeof el.onclick==='function'||tag==='A'&&jsFunction||delegatedButton);
   if(!native&&!nonNative||args.action==='request'&&(el.disabled||el.getAttribute('aria-disabled')==='true')||args.phase==='activate'&&(el.disabled||el.getAttribute('aria-disabled')==='true'))return false;
   const actionMeta=[el.getAttribute('id'),el.getAttribute('name'),caption(el),el.getAttribute('title'),el.getAttribute('aria-label'),jsFunction].filter(Boolean).join(' ');
   if(delegatedButton&&!/sms|otp|(?:mobile|phone).*(?:verif|confirm|code)|(?:verif|confirm|code).*(?:mobile|phone)|(?:تأكيد|تحقق|إرسال|ارسال).*(?:رمز|جوال|هاتف)|(?:رمز|جوال|هاتف).*(?:تحقق|تأكيد)/i.test(actionMeta))return false;
   if(blocked(actionMeta+' '+href+' '+onclick)||/resend|re.?send|send.?again|إعادة|اعادة|مجددا|مرة\s*أخرى/i.test(actionMeta+' '+href+' '+onclick))return false;
   const requestSemantic=/sms|otp|(?:mobile|phone).*(?:verif|confirm|code)|(?:verif|confirm|code).*(?:mobile|phone)|(?:send|request|receive|get).*(?:verification.?code|sms.?code|otp)|(?:إرسال|ارسال|طلب).*(?:رمز|تحقق)|(?:تحقق|تأكيد).*رقم\s*(?:الجوال|الهاتف)/i.test(actionMeta);
   const confirmSemantic=/verify|confirm|validate|check|تحقق|تأكيد|تفعيل/i.test(actionMeta);
   if(args.action==='request'?!requestSemantic:!confirmSemantic)return false;
   if(tag==='A'&&!jsFunction&&!/^(?:\s*|#(?:[A-Za-z0-9_.:-]*)|javascript:\s*(?:;|void\(0\);?))$/i.test(href))return false;
   const form=el.form||el.closest('form'),target=formTarget(form,el);if(!target)return false;
   if(native&&type==='submit'){
    // A general application submit must never be mistaken for SMS confirmation.
    if(!form||form===phone.form||!smsText(target.pathname)||Array.from(form.querySelectorAll('input,select,textarea')).filter(n=>visible(n)&&!['button','submit','hidden'].includes(n.type)).some(n=>n!==code&&n!==phone&&n!==prefix))return false;
   }
   return true;
  });
  if(args.id&&findId(args.id).length!==1||matches.length!==1)return fail('APPLICATION_SMS_UNAVAILABLE');
  const control=matches[0];if(args.control&&args.control!==control)return fail('APPLICATION_SMS_UNAVAILABLE');
  if(!args.attempts||typeof args.attempts.requested?.has!=='function')return fail('APPLICATION_SMS_UNAVAILABLE');
  const attempted=args.action==='request'?args.attempts.requested.has(control):args.attempts.verified.has(control)||args.attempts.codeFields.has(code);
  if(attempted&&!args.owned)return fail('APPLICATION_SMS_ALREADY_ATTEMPTED');
  if(args.phase==='consume'){if(args.action==='request')args.attempts.requested.add(control);else{args.attempts.verified.add(control);args.attempts.codeFields.add(code);}return {ok:true};}
  if(args.phase==='activate')return {ok:true};
  return {control,codeField:code,phone,prefix};
 }catch{return {error:'APPLICATION_SMS_UNAVAILABLE'};}
}
async function attemptsFor(page){
 const document=await page.evaluateHandle(()=>globalThis.document),old=contexts.get(page);
 if(old){let same=false;try{same=await document.evaluate((node,previous)=>node===previous,old.document);}catch{}if(same){await document.dispose();return old.attempts;}await old.document.dispose().catch(()=>{});await old.attempts.dispose().catch(()=>{});}
 const attempts=await page.evaluateHandle(()=>({requested:new WeakSet(),verified:new WeakSet(),codeFields:new WeakSet()}));contexts.set(page,{document,attempts});return attempts;
}
function validate(options,action){
 if(!options||typeof options!=='object'||Array.isArray(options)||options.id!==undefined&&options.id!==''&&(typeof options.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(options.id))||action!=='enter'&&(typeof options.label!=='string'||options.label.length>120||!options.label&&!options.id)||typeof options.expectedPhone!=='string'||!/^\+?[0-9]{7,20}$/.test(options.expectedPhone)||typeof options.expectedPrefixLabel!=='string'||!options.expectedPrefixLabel||options.expectedPrefixLabel.length>120||options.guard!==undefined&&typeof options.guard!=='function')throw finite('APPLICATION_SMS_INPUT_INVALID');
}
async function act(page,options,action){
 let raw,control,codeField,phone,prefix,started=false,code=action!=='request'?options?.code:undefined;
 const guard=async()=>{if(options.signal?.aborted)throw finite('APPLICATION_SMS_CANCELLED');const u=new URL(page.url()),main=page.mainFrame();if(u.origin!==ORIGIN||u.pathname!==PATH||u.username||u.password||!main||main.url()!==page.url())throw finite('APPLICATION_SMS_UNAVAILABLE');if(options.guard)await options.guard();if(options.signal?.aborted)throw finite('APPLICATION_SMS_CANCELLED');};
 try{
  validate(options,action);if(action!=='request'&&(typeof code!=='string'||!/^\d{4,8}$/.test(code)))throw finite('APPLICATION_SMS_INPUT_INVALID');
  await guard();const attempts=await attemptsFor(page),args={action,id:options.id,label:options.label,expectedPhone:options.expectedPhone,expectedPrefixLabel:options.expectedPrefixLabel,codeLength:code?.length,attempts};
  raw=await page.evaluateHandle(inspectSmsControls,args);let error=await raw.evaluate(result=>result.error||null);if(error)throw finite(error);
  for(const key of ['control','codeField','phone','prefix']){const handle=await raw.getProperty(key),element=handle.asElement();if(key==='control')control=element;else if(key==='codeField')codeField=element;else if(key==='phone')phone=element;else prefix=element;if(!element)await handle.dispose();}
  if(action!=='enter'&&!control||!phone||!prefix||action!=='request'&&!codeField)throw finite('APPLICATION_SMS_UNAVAILABLE');
  await guard();const retained={...args,control,codeField,phone,prefix};let checked=await page.evaluate(inspectSmsControls,{...retained,phase:'consume'});if(checked.error)throw finite(checked.error);if(checked.ok!==true)throw finite('APPLICATION_SMS_UNAVAILABLE');started=true;
  if(action!=='request'){
   await codeField.fill('',{timeout:5000});await guard();
   await codeField.type(code,{delay:80,timeout:5000});await guard();
   if(await codeField.evaluate((el,expected)=>el.isConnected&&el.value===expected,code)!==true)throw finite('APPLICATION_SMS_ACTIVATION_UNCONFIRMED');
   try{options.code='';}catch{}
   if(action==='enter'){await guard();checked=await page.evaluate(inspectSmsControls,{...retained,phase:'activate',owned:true});if(checked.error||checked.ok!==true)throw finite(checked.error);if(await codeField.evaluate((el,expected)=>el.isConnected&&el.value===expected,code)!==true)throw finite('APPLICATION_SMS_ACTIVATION_UNCONFIRMED');return {codeEntered:true};}
   await control.waitForElementState('enabled',{timeout:5000});
  }
  await guard();checked=await page.evaluate(inspectSmsControls,{...retained,phase:'activate',owned:true});if(checked.error||checked.ok!==true)throw finite(checked.error);
  const native=await control.evaluate(el=>['BUTTON','INPUT'].includes(el.tagName));
  if(native){await control.focus();await guard();checked=await page.evaluate(inspectSmsControls,{...retained,phase:'activate',owned:true});if(checked.error||checked.ok!==true)throw finite(checked.error);if(await control.evaluate(el=>el.isConnected&&!el.disabled&&document.activeElement===el)!==true)throw finite('APPLICATION_SMS_ACTIVATION_UNCONFIRMED');if(action==='verify'&&await codeField.evaluate((el,expected)=>el.isConnected&&el.value===expected,code)!==true)throw finite('APPLICATION_SMS_ACTIVATION_UNCONFIRMED');await control.press('Enter',{timeout:10000,noWaitAfter:true});}
  else{if(action==='verify'&&await codeField.evaluate((el,expected)=>el.isConnected&&el.value===expected,code)!==true)throw finite('APPLICATION_SMS_ACTIVATION_UNCONFIRMED');await control.click({timeout:10000,noWaitAfter:true});}
  await guard();return {activationDispatched:true,action};
 }catch(error){if(started&&error?.code!=='APPLICATION_SMS_CANCELLED'&&error?.code!=='APPLICATION_SMS_PHONE_MISMATCH')throw finite('APPLICATION_SMS_ACTIVATION_UNCONFIRMED');throw finite(error?.code);}
 finally{code='';if(action!=='request'&&options&&typeof options==='object')try{options.code='';}catch{}for(const handle of [prefix,phone,codeField,control,raw])if(handle)await handle.dispose().catch(()=>{});}
}
async function inspectApplicationSms(page){
 try{
  const u=new URL(page.url());if(u.origin!==ORIGIN||u.pathname!==PATH||u.username||u.password)throw finite('APPLICATION_SMS_UNAVAILABLE');
  const inspected=await inspectPortalPage(page),verification=inspected.applicationVerification;
  if(!verification)return {available:false,challengeVisible:false,verification:null};
  const explicit=verification.evidence.includes('explicit_sms_caption');
  return {available:true,challengeVisible:explicit&&verification.controls.length===1,verification};
 }catch{throw finite('APPLICATION_SMS_UNAVAILABLE');}
}
const requestApplicationSms=(page,options)=>act(page,options,'request');
const verifyApplicationSms=(page,options)=>act(page,options,'verify');
const enterApplicationSms=(page,options)=>act(page,options,'enter');
module.exports={inspectApplicationSms,requestApplicationSms,verifyApplicationSms,enterApplicationSms};
