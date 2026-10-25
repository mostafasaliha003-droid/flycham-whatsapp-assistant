'use strict';
const {createHash}=require('node:crypto');
const {ConversationJournal,validCustomer}=require('./conversation-journal');
const {verifiedOffer}=require('./quote-comparison');
const ERROR_STATUS={CONVERSATION_NOT_FOUND:404,CLAIM_REQUIRED:409,WINDOW_CLOSED:409,IDEMPOTENCY_CONFLICT:409,INVALID_MESSAGE:400,INVALID_NOTE:400,INVALID_CUSTOMER:400,INVALID_IDEMPOTENCY_KEY:400,DELIVERY_UNCERTAIN:502,DELIVERY_FAILED:502};
class InboxService{
 constructor({store,assistant,send,onClaim=()=>{},getSearch=()=>null,now=Date.now,journal}={}){
  if(!store?.data||!assistant||typeof send!=='function')throw Error('INBOX_CONFIG_INVALID');Object.assign(this,{store,assistant,send,onClaim,getSearch,now});this.journal=journal||new ConversationJournal({store,now});this.locks=new Map();
  let changed=false;for(const c of Object.values(this.journal.data.customers))for(const a of Object.values(c.sendAttempts||{}))if(a.state==='sending'){a.state='uncertain';a.failure='DELIVERY_INTERRUPTED';changed=true;}if(changed)this.journal.save();
 }
 state(id){return this.assistant.state(id);}
 isHumanOwned(id){const item=this.journal.get(id);return typeof item?.operatorOwned==='boolean'?item.operatorOwned:this.state(id).humanOwned===true;}
 summary(id){const item=this.journal.summary(id);if(!item)return null;const state=this.state(id);return{...item,status:state.status||'idle',humanOwned:this.isHumanOwned(id),request:state.base?.request?structuredClone(state.base.request):null};}
 list(options={}){const all=this.journal.list({...options,limit:1000,cursor:''});let items=Object.values(this.journal.data.customers).map(c=>this.summary(c.id));const q=String(options.q||'').trim().toLowerCase().slice(0,150);if(q)items=items.filter(c=>[c.id,c.name||'',c.preview].some(s=>s.toLowerCase().includes(q)));if(options.status)items=items.filter(c=>options.status==='human'?c.humanOwned:options.status==='unread'?c.unread>0:!c.humanOwned&&c.status===options.status);items.sort((a,b)=>b.lastAt-a.lastAt||a.id.localeCompare(b.id));const offset=Math.max(0,Math.min(1000,Number(options.cursor)||0)),limit=Math.max(1,Math.min(100,Number(options.limit)||50));return{items:items.slice(offset,offset+limit),nextCursor:offset+limit<items.length?String(offset+limit):null,activatedAt:all.activatedAt};}
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
  return result;
 }
 requireCustomer(id){if(!validCustomer(id)||!this.journal.get(id))throw Error('CONVERSATION_NOT_FOUND');}
 pauseCancelledSearch(state){state.status='paused';state.queueReady=false;state.activeComparisonId=null;}
 async claim(id){
  this.requireCustomer(id);const item=this.journal.get(id),s=this.state(id);item.operatorOwned=true;
  // Cancellation survives a model turn that may still hold an older engine
  // snapshot. Releasing staff ownership must never revive that cancelled job.
  if(['queued','searching'].includes(s.status))item.pausedSearch=true;
  this.journal.save();s.humanOwned=true;if(item.pausedSearch)this.pauseCancelledSearch(s);this.store.set(id,s);await this.onClaim(id);
  if(item.pausedSearch){const current=this.state(id);this.pauseCancelledSearch(current);current.humanOwned=true;this.store.set(id,current);}
  return{ok:true,customer:this.summary(id)};
 }
 release(id){this.requireCustomer(id);const item=this.journal.get(id),s=this.state(id);item.operatorOwned=false;if(item.pausedSearch||['queued','searching'].includes(s.status))this.pauseCancelledSearch(s);delete item.pausedSearch;this.journal.save();s.humanOwned=false;this.store.set(id,s);return{ok:true,customer:this.summary(id)};}
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
  if(!this.isHumanOwned(id))throw Error('CLAIM_REQUIRED');if(!this.journal.summary(id).serviceWindowOpen)throw Error('WINDOW_CLOSED');
  const attempt={key,fingerprint,state:'sending',at:this.now()};item.sendAttempts[key]=attempt;this.journal.save();
  // The sender invokes this immediately before its actual provider call, after
  // waiting for any per-customer delivery queue. A release or expired window
  // while queued therefore cannot dispatch an unauthorized staff message.
  const guard=()=>{const code=!this.journal.hasCustomer(id)?'CONVERSATION_NOT_FOUND':!this.isHumanOwned(id)?'CLAIM_REQUIRED':!this.journal.summary(id).serviceWindowOpen?'WINDOW_CLOSED':null;if(code)throw Object.assign(Error(code),{code,notDispatched:true});};
  try{const data=await this.send(id,text,guard);const messageId=data?.messages?.[0]?.id;if(typeof messageId!=='string'||!messageId||messageId.length>500)throw Error('DELIVERY_RESPONSE_INVALID');
   attempt.state='sent';attempt.messageId=messageId;attempt.at=this.now();this.journal.recordOutbound(id,{id:messageId,text,actor:'staff',status:'accepted',timestamp:this.now()});this.journal.save();return{ok:true,attempt:this.publicAttempt(attempt)};
  }catch(error){const notDispatched=error?.notDispatched===true&&['CONVERSATION_NOT_FOUND','CLAIM_REQUIRED','WINDOW_CLOSED'].includes(error?.code),status=Number(error?.status||String(error?.message||'').match(/^WHATSAPP_GRAPH_HTTP_(\d+)_/)?.[1]);attempt.state=notDispatched||status>=400&&status<500&&status!==408?'failed':'uncertain';attempt.failure=notDispatched?error.code:attempt.state==='failed'?'PROVIDER_REJECTED':'DELIVERY_OUTCOME_UNCERTAIN';attempt.at=this.now();this.journal.save();return{ok:false,error:this.attemptError(attempt),attempt:this.publicAttempt(attempt)};}
 }
 attemptError(a){return a.state==='failed'?['CONVERSATION_NOT_FOUND','CLAIM_REQUIRED','WINDOW_CLOSED'].includes(a.failure)?a.failure:'DELIVERY_FAILED':'DELIVERY_UNCERTAIN';}
 publicAttempt(a){return{key:a.key,state:a.state,at:a.at,...(a.messageId?{messageId:a.messageId}:{}),...(a.failure?{failure:a.failure}:{})};}
}
async function handleInboxRequest(request,response,url,readBody,inbox){
 const base='/internal/assistant/conversations';if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false;
 const reply=(code,data)=>{response.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));};
 try{
  if(url.pathname===base&&request.method==='GET'){reply(200,inbox.list({q:url.searchParams.get('q')||url.searchParams.get('query')||'',status:url.searchParams.get('status')||'',cursor:url.searchParams.get('cursor')||'',limit:url.searchParams.get('limit')}));return true;}
  const match=url.pathname.slice(base.length).match(/^\/([^/]+)(?:\/(claim|release|send|notes|read))?$/);if(!match){reply(404,{error:'NOT_FOUND'});return true;}let id;try{id=decodeURIComponent(match[1]);}catch{throw Error('INVALID_CUSTOMER');}
  if(!match[2]&&request.method==='GET'){reply(200,inbox.detail(id,{before:url.searchParams.get('before'),limit:url.searchParams.get('limit')}));return true;}
  if(!match[2]||request.method!=='POST'){reply(405,{error:'METHOD_NOT_ALLOWED'});return true;}
  let data={};try{const bytes=await readBody(request);if(bytes.length)data=JSON.parse(bytes.toString('utf8'));}catch{reply(400,{error:'INVALID_BODY'});return true;}
  if(!data||Array.isArray(data)||typeof data!=='object'){reply(400,{error:'INVALID_BODY'});return true;}
  const action=match[2],result=action==='claim'?await inbox.claim(id):action==='release'?inbox.release(id):action==='notes'?inbox.note(id,data.text):action==='read'?inbox.read(id):await inbox.sendMessage(id,data);
  reply(result.ok===false?(ERROR_STATUS[result.error]||409):200,result);return true;
 }catch(error){const status=ERROR_STATUS[error?.message]||500;reply(status,{ok:false,error:status===500?'INBOX_UNAVAILABLE':error.message});return true;}
}
module.exports={InboxService,handleInboxRequest};
