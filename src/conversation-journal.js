'use strict';
const {randomUUID,createHash}=require('node:crypto');
const clone=value=>structuredClone(value);
const RESERVED=new Set(['__proto__','prototype','constructor']);
function validCustomer(value){return typeof value==='string'&&/^[A-Za-z0-9+_-]{1,100}$/.test(value)&&!RESERVED.has(value);}
function eventTime(value,now){const number=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;const ms=typeof number==='number'&&number<1e12?number*1000:number;return Number.isFinite(ms)&&ms>=0?Math.min(ms,now):now;}
class ConversationJournal{
 constructor({store,now=Date.now,retentionMs=30*86400000,maxCustomers=1000,maxPerCustomer=1000,maxMessages=20000,maxChars=8000000}={}){
  if(!store?.data||typeof store.save!=='function')throw Error('JOURNAL_STORE_REQUIRED');
  Object.assign(this,{store,now,retentionMs,maxCustomers,maxPerCustomer,maxMessages,maxChars});
  const created=!store.data.conversationJournal||store.data.conversationJournal.version!==1;
  if(created)store.data.conversationJournal={version:1,activatedAt:now(),nextSequence:1,customers:{}};
  this.data.pendingReceipts||={};this.prune();if(created)this.save();
 }
 get data(){return this.store.data.conversationJournal;}
 get(id){return validCustomer(id)&&Object.hasOwn(this.data.customers,id)?this.data.customers[id]:null;}
 hasCustomer(id){return Boolean(this.get(id));}
 importLegacy(id,{history,updatedAt,name}={}){
  if(!validCustomer(id)||this.hasCustomer(id)||!Array.isArray(history))return false;
  const sensitive=/(?:\b(?:api[_ -]?key|access[_ -]?token|password|otp|cookie|authorization)\b|كلم[ةه]\s*(?:السر|سر|المرور|مرور)|رمز\s*(?:التحقق|تفعيل)|جواز|[A-Za-z0-9_-]{40,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;
  const cutoff=this.now()-this.retentionMs;
  if(typeof updatedAt!=='number'||!Number.isFinite(updatedAt)||updatedAt<cutoff||updatedAt>this.now())return false;
  const entries=history.slice(-24).filter(m=>m&&typeof m==='object'&&!Array.isArray(m)&&Object.hasOwn(m,'role')&&Object.hasOwn(m,'text')&&['user','assistant'].includes(m.role)&&typeof m.text==='string'&&m.text.trim()&&m.text.length<=12000&&!sensitive.test(m.text));
  if(!entries.length)return false;const item=this.ensure(id);
  if(typeof name==='string'&&name.trim())item.name=name.trim().slice(0,100);
  item.legacyImported=true;item.legacyCount=entries.length;item.updatedAt=updatedAt;
  item.messages=entries.map((entry,index)=>({id:'legacy-'+createHash('sha256').update(JSON.stringify([id,index,entry.role,entry.text])).digest('hex'),providerMessageId:null,seq:this.data.nextSequence++,direction:entry.role==='user'?'in':'out',actor:entry.role==='user'?'customer':'assistant',text:entry.text,at:updatedAt,status:'historical',source:'legacy',timestampApproximate:true}));
  item.lastReadSequence=item.messages.at(-1)?.seq||0;
  // Historical text has no reliable inbound timestamp or Meta message id.
  // In particular it never opens a new WhatsApp service window.
  item.lastInboundAt=null;this.prune();this.save();return true;
 }
 save(){this.store.save();}
 ensure(id){
  if(!validCustomer(id))throw Error('INVALID_CUSTOMER');let item=this.get(id);if(item)return item;
  this.prune();const all=Object.values(this.data.customers);if(all.length>=this.maxCustomers){const oldest=all.sort((a,b)=>a.updatedAt-b.updatedAt)[0];delete this.data.customers[oldest.id];}
  item={id,name:null,createdAt:this.now(),updatedAt:this.now(),lastInboundAt:null,lastReadSequence:0,prunedCount:0,messages:[],notes:[],sendAttempts:{}};this.data.customers[id]=item;return item;
 }
 prune(){
  const cutoff=this.now()-this.retentionMs,all=Object.values(this.data.customers);let changed=false;
  this.data.pendingReceipts=Object.fromEntries(Object.entries(this.data.pendingReceipts||{}).filter(([,r])=>r.at>=cutoff).sort((a,b)=>b[1].at-a[1].at).slice(0,1000));
  for(const item of all){if(item.updatedAt<cutoff){delete this.data.customers[item.id];changed=true;continue;}
   const before=item.messages.length;item.messages=item.messages.filter(m=>m.at>=cutoff).slice(-this.maxPerCustomer);if(item.messages.length!==before){item.prunedCount=(item.prunedCount||0)+before-item.messages.length;changed=true;}
   item.notes=(item.notes||[]).filter(n=>n.at>=cutoff).slice(-100);item.sendAttempts||={};
   const attempts=Object.values(item.sendAttempts).sort((a,b)=>b.at-a.at).slice(0,100);item.sendAttempts=Object.fromEntries(attempts.filter(a=>a.at>=cutoff).map(a=>[a.key,a]));
  }
  const entries=Object.values(this.data.customers).flatMap(c=>[...c.messages.map(m=>({c,m,kind:'message'})),...(c.notes||[]).map(m=>({c,m,kind:'note'}))]).sort((a,b)=>a.m.at-b.m.at||(a.m.seq||0)-(b.m.seq||0));let count=entries.filter(x=>x.kind==='message').length,chars=entries.reduce((sum,x)=>sum+x.m.text.length,0);
  for(const {c,m,kind}of entries){if(count<=this.maxMessages&&chars<=this.maxChars)break;if(kind==='note'&&chars<=this.maxChars)continue;const list=kind==='message'?c.messages:c.notes,i=list.findIndex(x=>kind==='message'?x.seq===m.seq:x.id===m.id);if(i>=0){list.splice(i,1);if(kind==='message'){c.prunedCount=(c.prunedCount||0)+1;count--;}chars-=m.text.length;changed=true;}}
  if(changed)this.save();
 }
 recordInbound(id,{id:messageId,text,timestamp,name}={}){return this.record(id,{id:messageId,text,timestamp,direction:'in',actor:'customer',status:'received',name});}
 recordOutbound(id,{id:messageId,text,timestamp,actor='assistant',status='accepted',kind=null}={}){
  if(!['assistant','staff'].includes(actor))throw Error('INVALID_ACTOR');if(!['accepted','sent','delivered','read','failed'].includes(status))throw Error('INVALID_STATUS');return this.record(id,{id:messageId,text,timestamp,direction:'out',actor,status,kind});
 }
 record(id,event){
  if(typeof event.id!=='string'||!event.id||event.id.length>500||typeof event.text!=='string'||!event.text.trim()||event.text.length>12000)throw Error('INVALID_JOURNAL_MESSAGE');
  const item=this.ensure(id);if(item.messages.some(m=>m.id===event.id&&m.direction===event.direction))return false;
  const at=eventTime(event.timestamp,this.now()),seq=this.data.nextSequence++;
  const message={id:event.id,seq,direction:event.direction,actor:event.actor,text:event.text,at,status:event.status};
  if(event.direction==='out'&&event.actor==='assistant'&&event.kind==='voice_recovery_prompt')message.kind=event.kind;
  if(event.direction==='out'){const receiptKey=createHash('sha256').update(event.id).digest('hex'),receipt=this.data.pendingReceipts[receiptKey];if(receipt){message.status=receipt.status;message.statusAt=receipt.at;delete this.data.pendingReceipts[receiptKey];}}
  item.messages.push(message);item.updatedAt=this.now();
  if(event.direction==='in'){item.lastInboundAt=Math.max(item.lastInboundAt||0,at);if(typeof event.name==='string'&&event.name.trim())item.name=event.name.trim().slice(0,100);}
  this.prune();this.save();return true;
 }
 applyReceipt({id,status,timestamp}={}){
  const rank={accepted:0,sent:1,failed:2,delivered:3,read:4};if(typeof id!=='string'||!id||id.length>500||!Object.hasOwn(rank,status))return false;
  for(const item of Object.values(this.data.customers)){const m=item.messages.find(m=>m.direction==='out'&&m.id===id);if(!m)continue;if(rank[status]>=rank[m.status||'accepted']){m.status=status;m.statusAt=eventTime(timestamp,this.now());this.save();}return true;}
  const key=createHash('sha256').update(id).digest('hex'),old=this.data.pendingReceipts[key];if(!old||rank[status]>=rank[old.status])this.data.pendingReceipts[key]={status,at:eventTime(timestamp,this.now())};this.prune();this.save();return false;
 }
 summary(id){const item=this.get(id);if(!item)return null;const last=item.messages.at(-1);return{id:item.id,customer:item.id,name:item.name,preview:last?.text.slice(0,180)||'',lastAt:last?.at||item.updatedAt,lastInboundAt:item.lastInboundAt,unread:item.messages.filter(m=>m.direction==='in'&&m.seq>(item.lastReadSequence||0)).length,serviceWindowOpen:item.lastInboundAt!==null&&this.now()-item.lastInboundAt<86400000};}
 list({q='',cursor='',limit=50}={}){
  this.prune();const query=String(q).trim().toLowerCase().slice(0,150),size=Math.max(1,Math.min(100,Number(limit)||50)),offset=Math.max(0,Math.min(this.maxCustomers,Number(cursor)||0));
  const all=Object.values(this.data.customers).filter(c=>!query||[c.id,c.name||'',c.messages.at(-1)?.text||''].some(x=>x.toLowerCase().includes(query))).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
  return{items:all.slice(offset,offset+size).map(c=>this.summary(c.id)),nextCursor:offset+size<all.length?String(offset+size):null,activatedAt:this.data.activatedAt};
 }
 read(id,{before,limit=100}={}){
  this.prune();const item=this.get(id);if(!item)return null;const size=Math.max(1,Math.min(200,Number(limit)||100)),bound=Number(before),all=item.messages.filter(m=>!Number.isFinite(bound)||bound<=0||m.seq<bound),messages=all.slice(-size);
  return{customer:this.summary(id),messages:clone(messages),notes:clone(item.notes||[]),nextBefore:all.length>size?messages[0].seq:null,archive:{activatedAt:this.data.activatedAt,prunedCount:item.prunedCount||0,legacyImported:item.legacyImported===true,legacyCount:item.legacyCount||0,timestampsApproximate:item.legacyImported===true},sendAttempts:Object.values(item.sendAttempts||{}).map(a=>({key:a.key,state:a.state,at:a.at,...(a.messageId?{messageId:a.messageId}:{}),...(a.failure?{failure:a.failure}:{})}))};
 }
 markRead(id){const item=this.get(id);if(!item)return false;item.lastReadSequence=Math.max(item.lastReadSequence||0,...item.messages.map(m=>m.seq));this.save();return true;}
 addNote(id,text){const item=this.get(id);if(!item)return null;if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('INVALID_NOTE');const note={id:randomUUID(),text:text.trim(),at:this.now()};item.notes=[...(item.notes||[]),note].slice(-100);this.prune();this.save();return clone(note);}
 deleteCustomer(id){if(!this.get(id))return false;delete this.data.customers[id];this.save();return true;}
}
module.exports={ConversationJournal,validCustomer,eventTime};
