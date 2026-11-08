'use strict';
const {randomUUID}=require('node:crypto');
const {redactVisaText}=require('./saudi-visa-nlu');

const TTL_MS=8*60000,MAX_CUSTOMERS=50,MAX_MESSAGES=50,MAX_CHARS=12000,MAX_TEXT=4000;
const REPEAT_ALL='ما قدرت أفهم كل التسجيلات الصوتية 🌷 ممكن تعيد الطلب كامل برسالة واحدة، صوتية أو مكتوبة، حتى آخد كلامك كله مع بعض؟';
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=500&&!/[\x00-\x1f\x7f]/.test(value);
const validRevision=value=>Number.isSafeInteger(value)&&value>=0;
const controls=message=>!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).some(key=>/Choice$|Action$|Answer$|Confirmation$/.test(key))||Object.hasOwn(message,'payload');
const hasMeaning=text=>/[\p{L}\p{N}]/u.test(text.replace(/\[(?:document omitted|credential|bank account|document number|email|number|redacted|name)\]/g,''));
function redactionMayRemoveMeaning(text){
 // Name redaction accepts a whole clause, which can include a correction.
 if(/(?:اسمي|اسم\s*(?:العميل|المتقدم)|my name is)\s*[:：]?\s*[^،,.\n]{1,80}/i.test(text))return true;
 // The shared document-label redactor also permits spaces and letters after
 // the number. Accept it only when that span is plainly an identifier.
 const labels=/(?:رقم\s*(?:الجواز|الهوية|الهويه|الحساب)|passport\s*(?:number|no\.?))\s*[:：]?\s*([A-Za-z\d٠-٩۰-۹ -]{4,40})/gi;
 return [...text.matchAll(labels)].some(match=>!/^[A-Za-z]{0,3}[ -]*[\d٠-٩۰-۹][\d٠-٩۰-۹ -]*$/.test(match[1].trim()));
}

function knownMessage(message){
 if(controls(message)||message.media||typeof message.text!=='string'||!message.text.trim()||message.text.length>MAX_TEXT)return null;
 if(redactionMayRemoveMeaning(message.text))return null;
 const text=redactVisaText(message.text);
 // Never shorten a turn: its last words may negate an earlier instruction.
 if(!text.trim()||!hasMeaning(text)||text==='[مرفق صوتي يحتاج تفريغاً]')return null;
 const result={text};
 if(safeId(message.id))result.id=message.id;
 if(safeId(message.contextId))result.contextId=message.contextId;
 if(Number.isFinite(Number(message.timestamp)))result.timestamp=Number(message.timestamp);
 if(message.voiceTranscript===true)result.voiceTranscript=true;
 return result;
}

function prompt(draft){
 const saved=draft.slots.some(slot=>slot.kind==='known');
 return (saved?'وصلتني بقية رسائلك، ومحتفظ بسياقها مؤقتًا 🌷 ':'')+
  `المقطع الصوتي رقم ${draft.ordinal} ما كان واضح. اعمل «رد» على هذه الرسالة وأعد محتوى هذا المقطع فقط بصوت أو كتابة، حتى أكمل كلامك كله مع بعض.`;
}

// This short-lived buffer never enters AssistantState or the conversation
// journal. It stores only redacted text, not audio, media URLs or credentials.
// The caller must still check ownership and the incoming revision after awaits.
class VoiceTurnRecovery{
 constructor({now=Date.now}={}){this.now=now;this.drafts=new Map();}
 prune(){
  const stamp=this.now();
  for(const [customer,draft]of this.drafts)if(!Number.isFinite(draft.expiresAt)||draft.expiresAt<=stamp||draft.createdAt>stamp)this.drafts.delete(customer);
  while(this.drafts.size>MAX_CUSTOMERS)this.drafts.delete(this.drafts.keys().next().value);
 }
 clear(customer){return this.drafts.delete(customer);}
 hold(customer,{messages,failedIds,revision,contextKey}={}){
  this.prune();this.clear(customer);
  const fail=()=>({ok:false,reply:REPEAT_ALL});
  if(!safeId(customer)||!validRevision(revision)||typeof contextKey!=='string'||!contextKey||contextKey.length>1000||!Array.isArray(messages)||!messages.length||messages.length>MAX_MESSAGES||!Array.isArray(failedIds)||failedIds.length!==1||!safeId(failedIds[0]))return fail();
  const failedId=failedIds[0],slots=[];let failedIndex=-1,ordinal=0,chars=0;
  for(const message of messages){
   if(controls(message))return fail();
   if(message.media?.type==='audio'||message.voiceTranscript===true)ordinal++;
   if(message.id===failedId){
    if(failedIndex!==-1||message.media?.type!=='audio'||message.text&&message.text!=='[مرفق صوتي يحتاج تفريغاً]')return fail();
    failedIndex=slots.length;
    const slot={kind:'missing',ordinal};
    if(Number.isFinite(Number(message.timestamp)))slot.timestamp=Number(message.timestamp);
    slots.push(slot);
   }else{
    const clean=knownMessage(message);if(!clean)return fail();
    chars+=clean.text.length;if(chars>MAX_CHARS)return fail();
    slots.push({kind:'known',message:clean});
   }
  }
  if(failedIndex<0)return fail();
  const stamp=this.now(),draft={token:randomUUID(),createdAt:stamp,expiresAt:stamp+TTL_MS,revision,contextKey,promptId:null,slots,failedIndex,ordinal:slots[failedIndex].ordinal,chars};
  this.drafts.set(customer,draft);this.prune();
  return {ok:true,token:draft.token,reply:prompt(draft),ordinal:draft.ordinal};
 }
 bind(customer,token,messageId){
  this.prune();const draft=this.drafts.get(customer);
  if(!draft||draft.token!==token||!safeId(messageId)||draft.promptId&&draft.promptId!==messageId)return false;
  draft.promptId=messageId;return true;
 }
 isReply(customer,contextId){
  this.prune();const draft=this.drafts.get(customer);
  return Boolean(draft?.promptId&&draft.promptId===contextId);
 }
 resolve(customer,{messages,revision,contextKey}={}){
  this.prune();const draft=this.drafts.get(customer);if(!draft)return {status:'none'};
  // A new turn, even a short answer, cannot implicitly revive older actions.
  if(contextKey!==draft.contextKey||!validRevision(revision)||revision!==draft.revision+1||!Array.isArray(messages)||messages.length!==1||!draft.promptId||messages[0]?.contextId!==draft.promptId){this.clear(customer);return {status:'superseded'};}
  const message=messages[0];
  // Menus, approval buttons and document attachments always belong to their
  // own flows. Never interpret them as replacement speech.
  if(controls(message)||message.media&&message.media.type!=='audio'){this.clear(customer);return {status:'superseded'};}
  const clean=knownMessage(message);
  if(!clean||draft.chars+clean.text.length>MAX_CHARS){
   draft.token=randomUUID();draft.promptId=null;draft.revision=revision;
   return {status:'waiting',token:draft.token,reply:prompt(draft),ordinal:draft.ordinal};
  }
  const missing=draft.slots[draft.failedIndex];
  // The replacement belongs to the original slot, not the end of the turn.
  // Drop its recovery quote so it cannot become an offer/application reference.
  delete clean.contextId;
  if(missing.timestamp!==undefined)clean.timestamp=missing.timestamp;else delete clean.timestamp;
  const complete=draft.slots.map((slot,index)=>index===draft.failedIndex?clean:{...slot.message});
  this.clear(customer);
  return {status:'complete',messages:complete};
 }
}
module.exports={VoiceTurnRecovery,TTL_MS,MAX_CUSTOMERS,MAX_MESSAGES,MAX_CHARS,REPEAT_ALL};
