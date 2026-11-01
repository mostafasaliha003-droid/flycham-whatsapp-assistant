'use strict';
const {assertPageAction}=require('./execution-policy');
const ORIGIN='https://visa.mofa.gov.sa';
const attemptContexts=new WeakMap();
const CODES=new Set(['APPLICATION_SMS_CHALLENGE_STALE','PORTAL_BUTTON_INPUT_INVALID','PORTAL_BUTTON_UNAVAILABLE','PORTAL_BUTTON_VALIDATION_FAILED','PORTAL_BUTTON_ALREADY_ATTEMPTED','PORTAL_BUTTON_READBACK_MISMATCH','PORTAL_BUTTON_ACTIVATION_UNCONFIRMED']);
function finite(code){return Object.assign(new Error(CODES.has(code)?code:'PORTAL_BUTTON_UNAVAILABLE'),{code:CODES.has(code)?code:'PORTAL_BUTTON_UNAVAILABLE'});}
function inspectPortalButton(args){
 try{
  if(location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self)return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  const safe=text=>String(text||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/[0-9\u0660-\u0669\u06f0-\u06f9]{6,}/g,'[number]').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,'[id]').replace(/[A-Za-z0-9_-]{40,}/g,'[id]').replace(/[<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
  const visible=el=>{if(el.hidden||el.getAttribute('aria-hidden')==='true'||el.closest('[hidden],[aria-hidden="true"]'))return false;const s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&el.getClientRects().length>0;};
  const captionOf=el=>{let raw;if(el.tagName==='INPUT')raw=el.getAttribute('value');else{const copy=el.cloneNode(true);for(const child of copy.querySelectorAll('input,textarea,select,button,script,style'))child.remove();raw=copy.textContent;}return safe(raw);};
  const all=args.id?Array.from(document.querySelectorAll('[id]')).filter(el=>el.id===args.id):Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]')).filter(el=>['BUTTON','INPUT'].includes(el.tagName)&&['button','submit'].includes(el.type)&&el.isConnected&&visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&captionOf(el)===args.label);if(all.length!==1)return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  const button=all[0];if(args.button&&button!==args.button)return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  if(!button.isConnected||!visible(button)||button.disabled||button.getAttribute('aria-disabled')==='true'||!(['BUTTON','INPUT'].includes(button.tagName)&&['button','submit'].includes(button.type)))return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  const caption=captionOf(button);if(caption!==args.label)return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  const agreement=args.mode==='agreement';if(agreement&&location.pathname!=='/SmartForm/Agreement')return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  const form=button.form||null;if(!form&&!agreement||Object.prototype.hasOwnProperty.call(args,'form')&&form!==args.form||!form&&button.getAttribute('formaction'))return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  const target=new URL(button.getAttribute('formaction')||(form&&form.getAttribute('action'))||location.href,location.href);
  if(target.origin!==location.origin||target.username||target.password||/logout|logoff|signout|delete|cancel|payment|card|pay|خروج|حذف|إلغاء|الغاء|دفع|سداد|بطاق/i.test(caption+' '+target.pathname))return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  for(const [key,value]of target.searchParams)if(/logout|logoff|signout|delete|cancel|payment|card|pay|خروج|حذف|الغاء|إلغاء|دفع|سداد/i.test(key+' '+value))return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  if(agreement?!/^(?:أوافق|موافق|التالي|agree|i agree)$/i.test(caption):args.mode==='next'?!/^(?:next|continue|التالي|متابعة)$/i.test(caption):!/^(?:save|submit|حفظ|إرسال|ارسال|تقديم|حفظ الطلب|تقديم الطلب)$/i.test(caption))return {error:'PORTAL_BUTTON_UNAVAILABLE'};
  for(const field of args.expectedFields){
   const matches=field.kind==='radio'?Array.from(document.querySelectorAll('input[type="radio"]')).filter(el=>el.tagName==='INPUT'&&el.type==='radio'&&el.name===field.name&&el.getAttribute('value')===field.optionValue):Array.from(document.querySelectorAll('[id]')).filter(el=>el.id===field.id);if(matches.length!==1)return {error:'PORTAL_BUTTON_READBACK_MISMATCH'};const el=matches[0];if(!el.isConnected||(el.form||null)!==form||!form&&el.ownerDocument!==document)return {error:'PORTAL_BUTTON_READBACK_MISMATCH'};
   if(field.kind==='radio'){if(field.id&&el.id!==field.id||el.ownerDocument!==document||!visible(el)||el.disabled||typeof el.matches==='function'&&el.matches(':disabled')||el.getAttribute('aria-disabled')==='true'||el.checked!==true)return {error:'PORTAL_BUTTON_READBACK_MISMATCH'};}
   else if(field.kind==='check'){if(el.tagName!=='INPUT'||!['checkbox','radio'].includes(el.type)||el.checked!==field.expectedValue)return {error:'PORTAL_BUTTON_READBACK_MISMATCH'};}
   else if(field.kind==='select'){if(el.tagName!=='SELECT'||el.value!==field.expectedValue)return {error:'PORTAL_BUTTON_READBACK_MISMATCH'};}
   else if(!((el.tagName==='INPUT'&&['text','email','tel','number','date','datetime-local','month','week','time','url'].includes(el.type))||el.tagName==='TEXTAREA')||el.value!==field.expectedValue)return {error:'PORTAL_BUTTON_READBACK_MISMATCH'};
  }
  if(args.mode==='submit'&&button.type==='submit'&&(typeof form.checkValidity!=='function'||!form.checkValidity()))return {error:'PORTAL_BUTTON_VALIDATION_FAILED'};
  if(!args.attempts||typeof args.attempts.has!=='function')return {error:'PORTAL_BUTTON_UNAVAILABLE'};if(args.attempts.has(button)&&!args.owned)return {error:'PORTAL_BUTTON_ALREADY_ATTEMPTED'};
  if(args.requireFocus&&document.activeElement!==button)return {error:'PORTAL_BUTTON_ACTIVATION_UNCONFIRMED'};
  if(args.mark){args.attempts.add(button);return {ok:true};}return {button,form};
 }catch{return {error:'PORTAL_BUTTON_UNAVAILABLE'};}
}
async function attemptsFor(page){
 const documentHandle=await page.evaluateHandle(()=>document);const previous=attemptContexts.get(page);
 if(previous){let same=false;try{same=await documentHandle.evaluate((doc,old)=>doc===old,previous.document);}catch{}if(same){await documentHandle.dispose();return previous.attempts;}await previous.document.dispose().catch(()=>{});await previous.attempts.dispose().catch(()=>{});}
 const attempts=await page.evaluateHandle(()=>new WeakSet());attemptContexts.set(page,{document:documentHandle,attempts});return attempts;
}
async function activatePortalButton(page,{id,label,mode,expectedFields=[],guard:externalGuard,signal,expiresAt,now=Date.now}={}){
 assertPageAction(page,'activate-control',{id,label,mode,expectedFields});
 if(externalGuard!==undefined&&typeof externalGuard!=='function'||expiresAt!==undefined&&!Number.isSafeInteger(expiresAt)||typeof now!=='function')throw finite('PORTAL_BUTTON_INPUT_INVALID');
 if(id!==undefined&&id!==''&&(typeof id!=='string'||!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(id))||typeof label!=='string'||!label||label.length>120||!['next','submit','agreement'].includes(mode)||!Array.isArray(expectedFields)||expectedFields.length>40||mode==='submit'&&!expectedFields.length)throw finite('PORTAL_BUTTON_INPUT_INVALID');
 const seen=new Map(),radioNames=new Set();for(const field of expectedFields){
  if(!field||typeof field!=='object'||Array.isArray(field))throw finite('PORTAL_BUTTON_INPUT_INVALID');
  if(field.kind==='radio'){
   const keys=Object.keys(field).sort().join(','),hasId=Object.prototype.hasOwnProperty.call(field,'id');
   if(!['expectedValue,kind,name,optionValue','expectedValue,id,kind,name,optionValue'].includes(keys)||field.expectedValue!==true||typeof field.name!=='string'||!field.name.trim()||field.name.length>200||/[\u0000-\u001f\u007f]/.test(field.name)||radioNames.has(field.name)||typeof field.optionValue!=='string'||!/^(?:true|false|yes|no|[0-9]{1,3}|M|F)$/i.test(field.optionValue)||hasId&&(typeof field.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(field.id)||seen.has(field.id)&&seen.get(field.id)!=='radio')||mode==='agreement')throw finite('PORTAL_BUTTON_INPUT_INVALID');
   radioNames.add(field.name);if(hasId)seen.set(field.id,'radio');
  }else{
   if(Object.keys(field).sort().join(',')!=='expectedValue,id,kind'||typeof field.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(field.id)||seen.has(field.id)||!['text','select','check'].includes(field.kind)||mode==='agreement'&&field.kind!=='check'||(field.kind==='check'?typeof field.expectedValue!=='boolean':typeof field.expectedValue!=='string'||field.expectedValue.length>4096))throw finite('PORTAL_BUTTON_INPUT_INVALID');seen.set(field.id,field.kind);
  }
 }
 let raw,button,form,started=false;
 const guard=async(before=true)=>{assertPageAction(page,'activate-control',{id,label,mode,expectedFields});if(signal?.aborted)throw finite('PORTAL_BUTTON_UNAVAILABLE');if(before&&expiresAt!==undefined&&now()>=expiresAt)throw finite('APPLICATION_SMS_CHALLENGE_STALE');if(before&&externalGuard)await externalGuard();assertPageAction(page,'activate-control',{id,label,mode,expectedFields});if(signal?.aborted)throw finite('PORTAL_BUTTON_UNAVAILABLE');if(before&&expiresAt!==undefined&&now()>=expiresAt)throw finite('APPLICATION_SMS_CHALLENGE_STALE');const u=new URL(page.url()),main=page.mainFrame();if(u.origin!==ORIGIN||u.username||u.password||!main||main.url()!==page.url())throw finite('PORTAL_BUTTON_UNAVAILABLE');};
 try{
  await guard();const attempts=await attemptsFor(page);raw=await page.evaluateHandle(inspectPortalButton,{id,label,mode,expectedFields,attempts});const error=await raw.evaluate(result=>result.error||null);if(error)throw finite(error);
  const handle=await raw.getProperty('button');button=handle.asElement();form=await raw.getProperty('form');if(!button)throw finite('PORTAL_BUTTON_UNAVAILABLE');
  await guard();const checked=await page.evaluate(inspectPortalButton,{id,label,mode,expectedFields,button,form,attempts,mark:true});if(checked.error)throw finite(checked.error);if(checked.ok!==true)throw finite('PORTAL_BUTTON_UNAVAILABLE');
  started=true;await button.focus();if(await button.evaluate(el=>el.isConnected&&!el.disabled&&document.activeElement===el)!==true)throw finite('PORTAL_BUTTON_ACTIVATION_UNCONFIRMED');await guard();const finalReadback=await page.evaluate(inspectPortalButton,{id,label,mode,expectedFields,button,form,attempts,mark:true,owned:true,requireFocus:true});if(finalReadback.error||finalReadback.ok!==true)throw finite(finalReadback.error);if(signal?.aborted)throw finite('PORTAL_BUTTON_UNAVAILABLE');await button.press('Enter',{timeout:expiresAt===undefined?10000:(()=>{const remaining=expiresAt-now();if(remaining<=0)throw finite('APPLICATION_SMS_CHALLENGE_STALE');return Math.min(10000,remaining);})(),noWaitAfter:true});await guard(false);return {activationDispatched:true,mode};
 }catch(error){if(started)throw finite('PORTAL_BUTTON_ACTIVATION_UNCONFIRMED');throw finite(error?.code);}finally{if(form)await form.dispose().catch(()=>{});if(button)await button.dispose().catch(()=>{});if(raw)await raw.dispose().catch(()=>{});}
}
module.exports={activatePortalButton,inspectPortalButton};
