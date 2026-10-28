'use strict';
const {createHash}=require('node:crypto');
const {ConversationJournal,validCustomer}=require('./conversation-journal');
const {verifiedOffer}=require('./quote-comparison');
const {ComplaintHandoff}=require('./complaint-handoff');
const {visaCaseSignature,currentVisaEvidence}=require('./visa-case-signature');
const ERROR_STATUS={CONVERSATION_NOT_FOUND:404,CLAIM_REQUIRED:409,WINDOW_CLOSED:409,IDEMPOTENCY_CONFLICT:409,INVALID_MESSAGE:400,INVALID_NOTE:400,INVALID_CUSTOMER:400,INVALID_IDEMPOTENCY_KEY:400,DELIVERY_UNCERTAIN:502,DELIVERY_FAILED:502,BLOCK_CONFIRMATION_REQUIRED:400,INVALID_BLOCK_REASON:400,NUMBER_BLOCKED:409,VISA_CASE_NOT_FOUND:404,INVALID_VISA_ACTION:400,VISA_CONFIRMATION_REQUIRED:400,INVALID_PAYMENT:400,REFERENCE_REQUIRED:400,WHATSAPP_BLOCK_UNAVAILABLE:503,WHATSAPP_BLOCK_FAILED:502,WHATSAPP_BLOCK_UNCERTAIN:409,NOTIFICATION_RETRY_UNSAFE:409,COMPLAINT_NOT_FOUND:404,RETRY_CONFIRMATION_REQUIRED:400};
class InboxService{
 constructor({store,assistant,send,onClaim=()=>{},getSearch=()=>null,getMedia=()=>[],now=Date.now,journal,complaints,changeBlock}={}){
  if(!store?.data||!assistant||typeof send!=='function')throw Error('INBOX_CONFIG_INVALID');Object.assign(this,{store,assistant,send,onClaim,getSearch,getMedia,now,changeBlock});this.journal=journal||new ConversationJournal({store,now});this.locks=new Map();this.complaints=complaints||new ComplaintHandoff({store,journal:this.journal,now});
  let changed=false;for(const c of Object.values(this.journal.data.customers)){if(c.whatsappBlockState==='pending'){c.whatsappBlockState='uncertain';changed=true;}}for(const c of Object.values(this.journal.data.customers))for(const a of Object.values(c.sendAttempts||{}))if(a.state==='sending'){a.state='uncertain';a.failure='DELIVERY_INTERRUPTED';changed=true;}if(changed)this.journal.save();
 }
 state(id){return this.assistant.state(id);}
 isOperatorOwned(id){const item=this.journal.get(id);return typeof item?.operatorOwned==='boolean'?item.operatorOwned:this.state(id).humanOwned===true;}
 isBlocked(id){const c=this.journal.get(id);return c?.blocked===true||c?.whatsappBlocked===true;}
 isHumanOwned(id){return this.isOperatorOwned(id)||this.isBlocked(id)||['pending','uncertain'].includes(this.journal.get(id)?.whatsappBlockState)||Boolean(this.complaints.active(id));}
 block(id,{confirm,reason,scope='assistant'}={}){this.requireCustomer(id);if(confirm!==true)throw Error('BLOCK_CONFIRMATION_REQUIRED');if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw Error('INVALID_BLOCK_REASON');if(scope==='whatsapp')return this.changeWhatsAppBlock(id,true,reason);if(scope!=='assistant')throw Error('INVALID_BLOCK_REASON');const item=this.journal.get(id);item.blocked=true;item.blockScope='assistant';item.blockedAt=this.now();this.journal.addNote(id,'إيقاف ردود المساعد عن الرقم: '+reason.trim());this.journal.save();return{ok:true,scope:'assistant',customer:this.summary(id)};}
 unblock(id,{confirm,reason,scope='assistant'}={}){this.requireCustomer(id);if(confirm!==true)throw Error('BLOCK_CONFIRMATION_REQUIRED');if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw Error('INVALID_BLOCK_REASON');if(scope==='whatsapp')return this.changeWhatsAppBlock(id,false,reason);if(scope!=='assistant')throw Error('INVALID_BLOCK_REASON');const item=this.journal.get(id);item.blocked=false;item.unblockedAt=this.now();this.journal.addNote(id,'إلغاء إيقاف ردود المساعد عن الرقم: '+reason.trim());this.journal.save();return{ok:true,scope:'assistant',customer:this.summary(id)};}
 summary(id){const item=this.journal.summary(id);if(!item)return null;const state=this.state(id);return{...item,status:state.status||'idle',humanOwned:this.isHumanOwned(id),staffClaimed:this.isOperatorOwned(id),blocked:this.isBlocked(id),assistantBlocked:this.journal.get(id)?.blocked===true,whatsappBlocked:this.journal.get(id)?.whatsappBlocked===true,whatsappBlockState:this.journal.get(id)?.whatsappBlockState||null,automationPaused:this.isHumanOwned(id),blockScope:'assistant',complaint:this.complaints.status(id),service:this.store.data.serviceSessions?.[id]?.service||(this.store.data.visaCases?.[id]?'saudi_visa':'flight'),request:state.base?.request?structuredClone(state.base.request):null};}
 list(options={}){const all=this.journal.list({...options,limit:1000,cursor:''});let items=Object.values(this.journal.data.customers).map(c=>this.summary(c.id));const q=String(options.q||'').trim().toLowerCase().slice(0,150);if(q)items=items.filter(c=>[c.id,c.name||'',c.preview].some(s=>s.toLowerCase().includes(q)));if(options.status)items=items.filter(c=>options.status==='complaint'?Boolean(this.complaints.active(c.id)):options.status==='blocked'?c.blocked:options.status==='human'?c.staffClaimed:options.status==='unread'?c.unread>0:!c.humanOwned&&c.status===options.status);if(options.service)items=items.filter(c=>c.service===options.service);items.sort((a,b)=>Number(Boolean(this.complaints.active(b.id)))-Number(Boolean(this.complaints.active(a.id)))||b.lastAt-a.lastAt||a.id.localeCompare(b.id));const offset=Math.max(0,Math.min(1000,Number(options.cursor)||0)),limit=Math.max(1,Math.min(100,Number(options.limit)||50));return{items:items.slice(offset,offset+limit),nextCursor:offset+limit<items.length?String(offset+limit):null,activatedAt:all.activatedAt};}
 detail(id,options){
  this.requireCustomer(id);const result=this.journal.read(id,options);result.customer=this.summary(id);const state=this.state(id);
  result.offers=(Array.isArray(state.offers)?state.offers:[]).slice(-80).map(o=>{
   if(!o||typeof o!=='object'||!o.request)return null;
   if(!Number.isFinite(o.checkedAt)&&!Number.isFinite(Date.parse(o.verifiedAt)))return null;
   const provider=o.provider||o.request?.provider,v=verifiedOffer(o,o.request,provider);if(!v)return null;
   const string=x=>typeof x==='string'?x.slice(0,120):null,leg=x=>x?{flight:string(x.flight),departure:string(x.departure),arrival:string(x.arrival)}:null;
   const request=Object.fromEntries(['origin','destination','departureDate','returnDate','tripType'].map(k=>[k,string(v.request[k])]));
   const price={currency:'AED',sellingTotal:v.price.sellingTotal,weights:v.price.weights.map(w=>({kg:w.kg}))};if(v.price.voucherValue)price.voucherValue=v.price.voucherValue;
   return{provider,reference:Number.isInteger(o.reference)&&o.reference>0&&o.reference<=80?o.reference:null,request,timing:{out:leg(v.timing.out),...(v.timing.back?{back:leg(v.timing.back)}:{})},price,checkedAt:v.checkedAt,fresh:v.checkedAt<=this.now()&&this.now()-v.checkedAt<=900000,requiresRecheck:true};
  }).filter(Boolean);
  try{const search=this.getSearch(id);result.search=search&&typeof search==='object'&&JSON.stringify(search).length<=40000?structuredClone(search):null;}catch{result.search=null;}
  result.visaMedia=this.getMedia(id);result.visaCase=this.store.data.visaCases?.[id]?structuredClone(this.store.data.visaCases[id]):null;result.complaint=this.complaints.latest(id)?structuredClone(this.complaints.latest(id)):null;
  return result;
 }
 requireCustomer(id){if(!validCustomer(id)||!this.journal.get(id))throw Error('CONVERSATION_NOT_FOUND');}
 pauseCancelledSearch(state){state.status='paused';state.queueReady=false;state.activeComparisonId=null;}
 async claim(id){
  this.requireCustomer(id);const item=this.journal.get(id),s=this.state(id);item.operatorOwned=true;this.complaints.claim(id);
  // Cancellation survives a model turn that may still hold an older engine
  // snapshot. Releasing staff ownership must never revive that cancelled job.
  if(['queued','searching'].includes(s.status))item.pausedSearch=true;
  this.journal.save();s.humanOwned=true;if(item.pausedSearch)this.pauseCancelledSearch(s);this.store.set(id,s);await this.onClaim(id);
  if(item.pausedSearch){const current=this.state(id);this.pauseCancelledSearch(current);current.humanOwned=true;this.store.set(id,current);}
  return{ok:true,customer:this.summary(id)};
 }
 release(id){this.requireCustomer(id);const item=this.journal.get(id),s=this.state(id);item.operatorOwned=false;this.complaints.resolve(id);if(item.pausedSearch||['queued','searching'].includes(s.status))this.pauseCancelledSearch(s);delete item.pausedSearch;this.journal.save();s.humanOwned=false;this.store.set(id,s);return{ok:true,customer:this.summary(id)};}
 updateVisa(id,{confirm,action,amount,reference,approved,decision}={}){
  this.requireCustomer(id);if(!this.isOperatorOwned(id))throw Error('CLAIM_REQUIRED');if(confirm!==true)throw Error('VISA_CONFIRMATION_REQUIRED');const c=this.store.data.visaCases?.[id];if(!c)throw Error('VISA_CASE_NOT_FOUND');
  if(!['confirm_payment','documents_reviewed','submitted','decision'].includes(action)||c.pendingAmendment)throw Error('INVALID_VISA_ACTION');
  const ref=typeof reference==='string'?reference.trim():'';
  if(action!=='documents_reviewed'&&(!ref||ref.length>150||/[\r\n]/.test(ref)))throw Error('REFERENCE_REQUIRED');
  if(action==='confirm_payment'){
   if(typeof amount!=='number'||!Number.isFinite(amount)||amount<=0||typeof c.quote?.total!=='number'||Math.round(amount*100)!==Math.round(c.quote.total*100))throw Error('INVALID_PAYMENT');
  }
  if(action==='documents_reviewed'&&typeof approved!=='boolean')throw Error('INVALID_VISA_ACTION');
  if(action==='submitted'&&(!currentVisaEvidence(c).payment||!currentVisaEvidence(c).documents))throw Error('INVALID_VISA_ACTION');
  if(action==='decision'&&(!['approved','refused'].includes(decision)||!currentVisaEvidence(c).submission))throw Error('INVALID_VISA_ACTION');
  c.staffVerification||={};const v=c.staffVerification,at=this.now(),caseSignature=visaCaseSignature(c);
  if(action==='confirm_payment'){v.payment={amount,reference:ref,verifiedAt:at,actor:'staff',caseSignature};c.paymentStatus='verified';c.stage='payment_verified';}
  if(action==='documents_reviewed'){v.documentsReviewed=approved;v.documentsReviewedAt=at;v.documentsSignature=caseSignature;c.stage=approved?'documents_verified':'documents_pending_review';}
  if(action==='submitted'){v.submission={reference:ref,submittedAt:at,actor:'staff',caseSignature};c.submissionStatus='submitted';c.stage='submitted';}
  if(action==='decision'){v.decision={value:decision,reference:ref,recordedAt:at,actor:'staff',caseSignature};c.stage=decision;}
  v.audit=[...(v.audit||[]),{action,at,actor:'staff'}].slice(-100);c.revision=(Number(c.revision)||0)+1;c.updatedAt=at;this.store.save();this.journal.addNote(id,'تحديث معاملة التأشيرة بواسطة الموظف: '+({confirm_payment:'تأكيد الدفعة',documents_reviewed:'مراجعة المستندات',submitted:'تسجيل التقديم',decision:'تسجيل القرار'}[action]));return{ok:true,visaCase:structuredClone(c),customer:this.summary(id)};
 }
 async changeWhatsAppBlock(id,blocked,reason){
  if(typeof this.changeBlock!=='function')throw Error('WHATSAPP_BLOCK_UNAVAILABLE');const item=this.journal.get(id);if(['pending','uncertain'].includes(item.whatsappBlockState))throw Error('WHATSAPP_BLOCK_UNCERTAIN');item.whatsappBlockState='pending';this.journal.save();
  try{const result=await this.changeBlock(id,{blocked});if(result?.ok!==true)throw Object.assign(Error('WHATSAPP_BLOCK_FAILED'),{notDispatched:result?.dryRun===true});item.whatsappBlocked=blocked;item.whatsappBlockState='confirmed';item.whatsappBlockAt=this.now();this.journal.addNote(id,(blocked?'حظر الرقم على واتساب: ':'فك الحظر عن الرقم على واتساب: ')+reason.trim());this.journal.save();return{ok:true,scope:'whatsapp',customer:this.summary(id)};}catch(error){const status=Number(error?.status||String(error?.message||'').match(/^WHATSAPP_GRAPH_HTTP_(\d+)_/)?.[1]);const definite=error?.notDispatched===true||(status>=400&&status<500&&status!==408)||['WHATSAPP_CONFIG_REQUIRED','WHATSAPP_DRY_RUN_BLOCKED'].includes(error?.message);item.whatsappBlockState=definite?'failed':'uncertain';this.journal.save();throw Error(definite?'WHATSAPP_BLOCK_FAILED':'WHATSAPP_BLOCK_UNCERTAIN');}
 }
 retryComplaintNotification(id,{confirm}={}){this.requireCustomer(id);if(confirm!==true)throw Error('RETRY_CONFIRMATION_REQUIRED');const c=this.complaints.active(id);if(!c)throw Error('COMPLAINT_NOT_FOUND');this.complaints.requestRetry(c.id);return{ok:true,complaint:structuredClone(c)};}
 note(id,text){this.requireCustomer(id);return{ok:true,note:this.journal.addNote(id,text)};}
 read(id){this.requireCustomer(id);this.journal.markRead(id);return{ok:true};}
 async sendMessage(id,{text,idempotencyKey}={}){
  this.requireCustomer(id);if(typeof text!=='string'||!text.trim()||text.length>4096)throw Error('INVALID_MESSAGE');if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))throw Error('INVALID_IDEMPOTENCY_KEY');
  const prior=this.journal.get(id).sendAttempts[idempotencyKey];if(prior&&prior.fingerprint!==createHash('sha256').update(text.trim()).digest('hex'))throw Error('IDEMPOTENCY_CONFLICT');
  const key=id+':'+idempotencyKey;if(this.locks.has(key))return this.locks.get(key);
  const work=this.performSend(id,text.trim(),idempotencyKey);this.locks.set(key,work);try{return await work;}finally{this.locks.delete(key);}
 }
 async performSend(id,text,key){
  const item=this.journal.get(id),fingerprint=createHash('sha256').update(text).digest('hex'),existing=item.sendAttempts[key];
  if(existing){if(existing.fingerprint!==fingerprint)throw Error('IDEMPOTENCY_CONFLICT');return{ok:existing.state==='sent',attempt:this.publicAttempt(existing),...(existing.state!=='sent'?{error:this.attemptError(existing)}:{})};}
  if(!this.isOperatorOwned(id))throw Error('CLAIM_REQUIRED');if(this.isBlocked(id)||['pending','uncertain'].includes(this.journal.get(id)?.whatsappBlockState))throw Error('NUMBER_BLOCKED');if(!this.journal.summary(id).serviceWindowOpen)throw Error('WINDOW_CLOSED');
  const attempt={key,fingerprint,state:'sending',at:this.now()};item.sendAttempts[key]=attempt;this.journal.save();
  // The sender invokes this immediately before its actual provider call, after
  // waiting for any per-customer delivery queue. A release or expired window
  // while queued therefore cannot dispatch an unauthorized staff message.
  const guard=()=>{const code=!this.journal.hasCustomer(id)?'CONVERSATION_NOT_FOUND':!this.isOperatorOwned(id)?'CLAIM_REQUIRED':(this.isBlocked(id)||['pending','uncertain'].includes(this.journal.get(id)?.whatsappBlockState))?'NUMBER_BLOCKED':!this.journal.summary(id).serviceWindowOpen?'WINDOW_CLOSED':null;if(code)throw Object.assign(Error(code),{code,notDispatched:true});};
  try{const data=await this.send(id,text,guard);const messageId=data?.messages?.[0]?.id;if(typeof messageId!=='string'||!messageId||messageId.length>500)throw Error('DELIVERY_RESPONSE_INVALID');
   attempt.state='sent';attempt.messageId=messageId;attempt.at=this.now();this.journal.recordOutbound(id,{id:messageId,text,actor:'staff',status:'accepted',timestamp:this.now()});this.journal.save();return{ok:true,attempt:this.publicAttempt(attempt)};
  }catch(error){const notDispatched=error?.notDispatched===true&&['CONVERSATION_NOT_FOUND','CLAIM_REQUIRED','WINDOW_CLOSED','NUMBER_BLOCKED'].includes(error?.code),status=Number(error?.status||String(error?.message||'').match(/^WHATSAPP_GRAPH_HTTP_(\d+)_/)?.[1]);attempt.state=notDispatched||status>=400&&status<500&&status!==408?'failed':'uncertain';attempt.failure=notDispatched?error.code:attempt.state==='failed'?'PROVIDER_REJECTED':'DELIVERY_OUTCOME_UNCERTAIN';attempt.at=this.now();this.journal.save();return{ok:false,error:this.attemptError(attempt),attempt:this.publicAttempt(attempt)};}
 }
 attemptError(a){return a.state==='failed'?['CONVERSATION_NOT_FOUND','CLAIM_REQUIRED','WINDOW_CLOSED','NUMBER_BLOCKED'].includes(a.failure)?a.failure:'DELIVERY_FAILED':'DELIVERY_UNCERTAIN';}
 publicAttempt(a){return{key:a.key,state:a.state,at:a.at,...(a.messageId?{messageId:a.messageId}:{}),...(a.failure?{failure:a.failure}:{})};}
}
async function handleInboxRequest(request,response,url,readBody,inbox){
 const base='/internal/assistant/conversations';if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false;
 const reply=(code,data)=>{response.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));};
 try{
  if(url.pathname===base&&request.method==='GET'){reply(200,inbox.list({q:url.searchParams.get('q')||url.searchParams.get('query')||'',status:url.searchParams.get('status')||'',service:url.searchParams.get('service')||'',cursor:url.searchParams.get('cursor')||'',limit:url.searchParams.get('limit')}));return true;}
  const match=url.pathname.slice(base.length).match(/^\/([^/]+)(?:\/(claim|release|send|notes|read|block|unblock|visa|notification-retry))?$/);if(!match){reply(404,{error:'NOT_FOUND'});return true;}let id;try{id=decodeURIComponent(match[1]);}catch{throw Error('INVALID_CUSTOMER');}
  if(!match[2]&&request.method==='GET'){reply(200,inbox.detail(id,{before:url.searchParams.get('before'),limit:url.searchParams.get('limit')}));return true;}
  if(!match[2]||request.method!=='POST'){reply(405,{error:'METHOD_NOT_ALLOWED'});return true;}
  let data={};try{const bytes=await readBody(request);if(bytes.length)data=JSON.parse(bytes.toString('utf8'));}catch{reply(400,{error:'INVALID_BODY'});return true;}
  if(!data||Array.isArray(data)||typeof data!=='object'){reply(400,{error:'INVALID_BODY'});return true;}
  if(match[2]==='visa'&&data.action==='confirm_payment'&&inbox.accountantWorkflowRequired===true){reply(403,{ok:false,error:'ACCOUNTANT_WORKFLOW_REQUIRED'});return true;}
  const action=match[2],result=action==='claim'?await inbox.claim(id):action==='release'?inbox.release(id):action==='notes'?inbox.note(id,data.text):action==='read'?inbox.read(id):action==='block'?await inbox.block(id,data):action==='unblock'?await inbox.unblock(id,data):action==='visa'?inbox.updateVisa(id,data):action==='notification-retry'?inbox.retryComplaintNotification(id,data):await inbox.sendMessage(id,data);
  reply(result.ok===false?(ERROR_STATUS[result.error]||409):200,result);return true;
 }catch(error){const status=ERROR_STATUS[error?.message]||500;reply(status,{ok:false,error:status===500?'INBOX_UNAVAILABLE':error.message});return true;}
}
module.exports={InboxService,handleInboxRequest};

