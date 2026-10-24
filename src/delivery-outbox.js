'use strict';
const {createHash}=require('node:crypto');
const STATES=new Set(['pending','sending','sent','uncertain','failed','cancelled']);
const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function failureKind(error){
 const match=String(error?.message||'').match(/^WHATSAPP_GRAPH_HTTP_(\d+)_CODE_\d+_SUBCODE_\d+$/);
 const status=match?Number(match[1]):Number(error?.status||error?.statusCode);
 if(status===429)return {kind:'retry',code:'RATE_LIMITED'};
 if(status===401||status===403)return {kind:'failed',code:'AUTHENTICATION_REQUIRED'};
 if(status>=400&&status<500&&status!==408)return {kind:'failed',code:'REQUEST_REJECTED'};
 // A timeout, transport error, malformed successful response, or supplier 5xx
 // does not prove that Meta rejected the message. Never blindly duplicate it.
 return {kind:'uncertain',code:'DELIVERY_OUTCOME_UNCERTAIN'};
}
class DeliveryOutbox{
 constructor({store,send,now=Date.now,onChunkSent,onComplete,isCurrent,report=()=>{},maxAttempts=5,retentionMs=7*86400000,maxItems=300}={}){
  if(!store?.data||typeof store.save!=='function'||typeof send!=='function')throw Error('OUTBOX_CONFIG_INVALID');
  Object.assign(this,{store,send,now,onChunkSent,onComplete,isCurrent,report,retentionMs,maxItems});
  this.maxAttempts=Math.max(1,Math.min(8,Number(maxAttempts)||5));this.inFlight=new Map();this.recipientLocks=new Map();
  if(!Array.isArray(store.data.outbox))store.data.outbox=[];
  let changed=false;
  for(const item of this.items()){
   if(item.state==='sending'||item.chunks?.some(c=>c.state==='sending')){
    item.state='uncertain';item.failure='DELIVERY_INTERRUPTED';item.updatedAt=this.now();
    for(const chunk of item.chunks||[])if(chunk.state==='sending')chunk.state='uncertain';changed=true;
   }
  }
  this.prune();if(changed)this.persist();
 }
 items(){return this.store.data.outbox;}
 persist(){this.store.save();}
 get(key){return this.items().find(item=>item.key===key);}
 snapshot(item){return item?clone(item):null;}
 prune(){
  const before=this.items().length,cutoff=this.now()-this.retentionMs;
  // Uncertain messages require review. Pending messages and callbacks survive.
  this.store.data.outbox=this.items().filter(item=>!((['failed','cancelled'].includes(item.state)||item.state==='sent'&&item.completionNotified)&&item.updatedAt<cutoff));
  if(this.items().length!==before)this.persist();
 }
 enqueue({key,recipient,chunks,metadata={}}){
  if(typeof key!=='string'||!key.length||key.length>240||typeof recipient!=='string'||!recipient.length||recipient.length>100||!Array.isArray(chunks)||!chunks.length||chunks.length>100||chunks.some(c=>typeof c!=='string'||!c.length||c.length>4096))throw Error('OUTBOX_MESSAGE_INVALID');
  const safeMetadata=clone(metadata);if(JSON.stringify(safeMetadata).length>200000)throw Error('OUTBOX_METADATA_TOO_LARGE');
  const fingerprint=digest({recipient,chunks,metadata:safeMetadata}),existing=this.get(key);
  if(existing){if(existing.fingerprint!==fingerprint)throw Error('OUTBOX_KEY_CONFLICT');return this.snapshot(existing);}
  this.prune();
  while(this.items().length>=this.maxItems){const oldest=this.items().filter(i=>i.state==='sent'&&i.completionNotified).sort((a,b)=>a.updatedAt-b.updatedAt)[0];if(!oldest)throw Error('OUTBOX_CAPACITY_REACHED');this.store.data.outbox=this.items().filter(i=>i.key!==oldest.key);this.persist();}
  const item={key,recipient,metadata:safeMetadata,fingerprint,state:'pending',createdAt:this.now(),updatedAt:this.now(),nextAt:this.now(),completionNotified:false,chunks:chunks.map(text=>({text,state:'pending',attempts:0,messageId:null,notified:false}))};
  this.items().push(item);this.persist();return this.snapshot(item);
 }
 cancel(key){const item=this.get(key);if(!item||item.state==='cancelled')return false;item.state='cancelled';item.updatedAt=this.now();this.persist();return true;}
 due(){return this.items().filter(item=>item.state==='pending'&&item.nextAt<=this.now()||item.state==='sent'&&!item.completionNotified&&item.nextAt<=this.now()).map(item=>item.key);}
 stats(){const counts=Object.fromEntries([...STATES].map(s=>[s,0]));for(const item of this.items())if(STATES.has(item.state))counts[item.state]++;return {...counts,awaitingCompletion:this.items().filter(i=>i.state==='sent'&&!i.completionNotified).length};}
 flush(key,hooks={}){
  if(this.inFlight.has(key))return this.inFlight.get(key);
  const item=this.get(key);if(!item)return Promise.resolve(null);
  const previous=this.recipientLocks.get(item.recipient)||Promise.resolve();
  const task=previous.catch(()=>{}).then(()=>this.perform(key,hooks));this.inFlight.set(key,task);this.recipientLocks.set(item.recipient,task);
  const clean=()=>{if(this.inFlight.get(key)===task)this.inFlight.delete(key);if(this.recipientLocks.get(item.recipient)===task)this.recipientLocks.delete(item.recipient);};task.then(clean,clean);return task;
 }
 async perform(key,hooks){
  const item=this.get(key);if(!item||!['pending','sent'].includes(item.state)||item.nextAt>this.now())return this.snapshot(item);
  const current=hooks.isCurrent||this.isCurrent,onChunkSent=hooks.onChunkSent||this.onChunkSent,onComplete=hooks.onComplete||this.onComplete;
  const fresh=async()=>{
   if(item.state==='cancelled')return false;
   if(current){let valid;try{valid=await current(this.snapshot(item));}catch{item.nextAt=this.now()+5000;this.persist();return false;}if(!valid){this.cancel(key);return false;}}
   return item.state!=='cancelled';
  };
  if(!await fresh())return this.snapshot(item);
  for(let index=0;index<item.chunks.length;index++){
   const chunk=item.chunks[index];if(!await fresh())return this.snapshot(item);
   if(chunk.state==='sent'){
    if(!chunk.notified&&!await this.notifyChunk(item,index,onChunkSent))return this.snapshot(item);
    continue;
   }
   if(chunk.state!=='pending'){item.state=chunk.state==='uncertain'?'uncertain':'failed';this.persist();return this.snapshot(item);}
   chunk.attempts++;chunk.state='sending';item.state='sending';item.updatedAt=this.now();this.persist();
   let delivery;
   try{
    delivery=await this.send(item.recipient,chunk.text);
    const messageId=delivery?.messages?.[0]?.id;
    if(typeof messageId!=='string'||!messageId.length||messageId.length>500){
     if(delivery?.dryRun===true){chunk.messageId=null;chunk.dryRun=true;}else throw Error('OUTBOX_RESPONSE_UNCERTAIN');
    }else chunk.messageId=messageId;
   }catch(error){
    const failure=failureKind(error);chunk.failure=item.failure=failure.code;item.updatedAt=this.now();
    if(failure.kind==='retry'&&chunk.attempts<this.maxAttempts){chunk.state='pending';item.state='pending';item.nextAt=this.now()+Math.min(60000,2000*2**(chunk.attempts-1));this.report('OUTBOX_RETRY_SCHEDULED');}
    else {chunk.state=failure.kind==='uncertain'?'uncertain':'failed';item.state=chunk.state;this.report(item.state==='uncertain'?'OUTBOX_DELIVERY_UNCERTAIN':'OUTBOX_DELIVERY_FAILED');}
    this.persist();return this.snapshot(item);
   }
   // Persist acceptance before callbacks: a callback failure can never trigger
   // another POST for a message already accepted by Meta.
   chunk.state='sent';delete chunk.failure;item.updatedAt=this.now();
   const cancelled=item.state==='cancelled';if(!cancelled)item.state='pending';this.persist();
   if(cancelled)return this.snapshot(item);
   if(!await this.notifyChunk(item,index,onChunkSent))return this.snapshot(item);
  }
  if(!await fresh())return this.snapshot(item);
  item.state='sent';item.updatedAt=this.now();delete item.failure;this.persist();
  if(!item.completionNotified){try{if(onComplete)await onComplete(this.snapshot(item));item.completionNotified=true;item.updatedAt=this.now();this.persist();this.report('OUTBOX_DELIVERY_ACCEPTED');}catch{item.nextAt=this.now()+5000;this.persist();this.report('OUTBOX_COMPLETION_RETRY');}}
  return this.snapshot(item);
 }
 async notifyChunk(item,index,callback){
  try{if(callback)await callback(this.snapshot(item),index,clone(item.chunks[index]));item.chunks[index].notified=true;this.persist();return true;}
  catch{item.state='pending';item.nextAt=this.now()+5000;this.persist();this.report('OUTBOX_CHUNK_CALLBACK_RETRY');return false;}
 }
}
module.exports={DeliveryOutbox,failureKind};
