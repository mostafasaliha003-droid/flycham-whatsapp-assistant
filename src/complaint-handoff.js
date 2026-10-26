'use strict';
const {randomUUID}=require('node:crypto');
const {validCustomer}=require('./conversation-journal');
const RECIPIENT=process.env.SAUDI_VISA_COMPLAINT_RECIPIENT||'';
const activeState=x=>x&&['pending','claimed'].includes(x.state);
/** Durable staff handoff; receipt acceptance is never treated as staff ownership. */
class ComplaintHandoff{
 constructor({store,journal,now=Date.now,sendNotification,recipient=RECIPIENT}={}){
  if(!store?.data||typeof store.save!=='function')throw Error('COMPLAINT_STORE_REQUIRED');Object.assign(this,{store,journal,now,sendNotification,recipient});store.data.complaints||=[];this.locks=new Map();let changed=false;
  for(const c of this.records)if(c.notification?.state==='sending'){c.notification.state='uncertain';c.notification.error='DELIVERY_INTERRUPTED';changed=true;}
  if(changed)store.save();
 }
 get records(){return this.store.data.complaints;}
 active(customer){return this.records.find(c=>c.customer===customer&&activeState(c))||null;}
 latest(customer){return this.records.filter(c=>c.customer===customer).at(-1)||null;}
 create(customer,{caseId=null,summary}={}){
  if(!validCustomer(customer))throw Error('INVALID_CUSTOMER');const existing=this.active(customer);if(existing)return structuredClone(existing);
  // Keep free-form complaint/identity text in the protected conversation, not in notifications.
  const record={id:randomUUID(),customer,caseId:typeof caseId==='string'?caseId.slice(0,100):null,category:'visa_financial_complaint',summary:'شكوى عن معاملة تأشيرة أو استرداد رسوم تحتاج مراجعة الإدارة',state:'pending',createdAt:this.now(),updatedAt:this.now(),notification:{recipient:this.recipient,state:'pending',attempts:0}};
  this.records.push(record);const cutoff=this.now()-30*86400000;this.store.data.complaints=this.records.filter(c=>activeState(c)||c.updatedAt>=cutoff).slice(-1000);const item=this.journal?.get(customer);if(item)item.complaintPending=record.id;this.store.save();return structuredClone(record);
 }
 claim(customer){const c=this.active(customer);if(c){c.state='claimed';c.claimedAt=this.now();c.updatedAt=this.now();this.store.save();}return c?structuredClone(c):null;}
 resolve(customer){const c=this.active(customer);if(c){c.state='resolved';c.resolvedAt=this.now();c.updatedAt=this.now();if(c.notification?.state==='pending')c.notification.state='cancelled';}const item=this.journal?.get(customer);if(item)delete item.complaintPending;this.store.save();return c?structuredClone(c):null;}
 status(customer){const c=this.latest(customer);return c?{id:c.id,state:c.state,createdAt:c.createdAt,notificationState:c.notification.state}:null;}
 handleReceipt({id,status,timestamp,recipient_id}={}){
  if(typeof id!=='string'||!['sent','delivered','read','failed'].includes(status))return false;
  const c=this.records.find(x=>x.notification?.messageId===id);if(!c)return false;
  if(recipient_id!==undefined&&String(recipient_id).replace(/^\+/,'')!==c.notification.recipient)return false;
  const n=c.notification,rank={accepted:0,sent:1,failed:2,delivered:3,read:4};
  if((rank[status]??-1)<(rank[n.state]??-1))return false;
  n.state=status;const raw=Number(timestamp),at=Number.isFinite(raw)&&raw>0?(raw<1e12?raw*1000:raw):this.now();n.statusAt=Math.min(this.now(),at);
  if(status==='failed')n.error='PROVIDER_DELIVERY_FAILED';else delete n.error;
  this.store.save();return true;
 }
 requestRetry(id){
  const c=this.records.find(x=>x.id===id);if(!c)throw Error('COMPLAINT_NOT_FOUND');
  if(!activeState(c)||!['pending','failed'].includes(c.notification.state))throw Error('NOTIFICATION_RETRY_UNSAFE');
  if(c.notification.state==='failed'&&!['NOTIFICATION_REJECTED','PROVIDER_DELIVERY_FAILED'].includes(c.notification.error))throw Error('NOTIFICATION_RETRY_UNSAFE');
  if(c.notification.messageId){c.notification.previousAttempts=[...(c.notification.previousAttempts||[]),{messageId:c.notification.messageId,state:c.notification.state,at:c.notification.statusAt||c.notification.acceptedAt||c.notification.lastAttemptAt}].slice(-10);delete c.notification.messageId;delete c.notification.acceptedAt;delete c.notification.statusAt;}c.notification.state='pending';delete c.notification.error;c.notification.retryRequestedAt=this.now();this.store.save();return structuredClone(c);
 }
 async flush(id,{serviceWindowOpen=false,templateConfigured=false}={}){
  if(this.locks.has(id))return this.locks.get(id);const work=this.performFlush(id,{serviceWindowOpen,templateConfigured});this.locks.set(id,work);try{return await work;}finally{this.locks.delete(id);}
 }
 async performFlush(id,{serviceWindowOpen,templateConfigured}){
  const c=this.records.find(x=>x.id===id);if(!c)return{ok:false,error:'COMPLAINT_NOT_FOUND'};
  if(!activeState(c)||c.notification.state!=='pending')return{ok:['accepted','sent','delivered','read'].includes(c.notification.state),state:c.notification.state};
  if(typeof this.sendNotification!=='function')return{ok:false,state:'pending',error:'NOTIFICATION_NOT_CONFIGURED'};
  if(!serviceWindowOpen&&!templateConfigured){c.notification.error='TEMPLATE_OR_SERVICE_WINDOW_REQUIRED';this.store.save();return{ok:false,state:'pending',error:c.notification.error};}
  c.notification.state='sending';c.notification.attempts++;c.notification.lastAttemptAt=this.now();delete c.notification.error;this.store.save();
  try{
   const result=await this.sendNotification({recipient:this.recipient,customer:c.customer,complaintId:c.id,caseId:c.caseId,requiresTemplate:!serviceWindowOpen,text:`تنبيه إدارة: شكوى تأشيرة تحتاج استلام المحادثة من اللوحة.\nرقم العميل: ${c.customer}\nمرجع الشكوى: ${c.id}`});
   const messageId=result?.messages?.[0]?.id;if(typeof messageId!=='string'||!messageId||messageId.length>500)throw Error('INVALID_PROVIDER_RESPONSE');
   c.notification.state='accepted';c.notification.messageId=messageId;c.notification.acceptedAt=this.now();this.store.save();return{ok:true,state:'accepted'};
  }catch(error){
   const status=Number(error?.status||String(error?.message||'').match(/^WHATSAPP_GRAPH_HTTP_(\d+)_/)?.[1]);
   const definite=error?.notDispatched===true||(status>=400&&status<500&&status!==408);
   c.notification.state=definite?'failed':'uncertain';c.notification.error=definite?'NOTIFICATION_REJECTED':'DELIVERY_OUTCOME_UNCERTAIN';this.store.save();return{ok:false,state:c.notification.state,error:c.notification.error};
  }
 }
}
module.exports={ComplaintHandoff,COMPLAINT_RECIPIENT:RECIPIENT};
