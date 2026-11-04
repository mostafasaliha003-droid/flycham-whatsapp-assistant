'use strict';
const {randomUUID,createHash}=require('node:crypto');
const OPS='https://flycham-whatsapp-assistant.onrender.com/operations';
const phone=value=>typeof value==='string'&&/^\+?[1-9]\d{7,14}$/.test(value)?value.replace(/^\+/,''):null;
const accepted=result=>typeof result?.messages?.[0]?.id==='string'&&result.messages[0].id.length>0&&result.messages[0].id.length<=500;
class VisaOperatorNotifications{
 constructor({store,fulfilment,dispatcher,send,env=process.env,now=Date.now,report=()=>{}}){Object.assign(this,{store,fulfilment,dispatcher,send,env,now,report});store.data.visaOperatorNotices||={};this.busy=false;}
 recipient(){return phone(this.env.RAAD_OPERATOR_NOTICE_WHATSAPP);}
 current(item){
  if(!item||item.recipient!==this.recipient()||item.expiresAt<=this.now())return false;
  try{const job=this.fulfilment.job(item.jobId),run=this.store.data.visaPortalRuns?.[item.jobId];if(job.caseId!==item.caseId||job.caseSignature!==item.caseSignature||run?.phase!=='waiting_operator'||run.operatorChallenge?.id!==item.challengeId||run.operatorChallenge.expiresAt!==item.expiresAt)return false;this.fulfilment.guardLease(job.id,run.leaseToken);return this.dispatcher.currentDossier(job,run).ready===true;}catch{return false;}
 }
 observe(job){
  const recipient=this.recipient(),run=this.store.data.visaPortalRuns?.[job.id],challenge=run?.operatorChallenge;
  if(!recipient||run?.phase!=='waiting_operator'||!challenge)return;
  const records=this.store.data.visaOperatorNotices;
  if(Object.values(records).some(item=>item.jobId===job.id&&item.challengeId===challenge.id&&item.recipient===recipient))return;
  for(const [id,item]of Object.entries(records))if(item.expiresAt<=this.now()-86400000)delete records[id];
  if(Object.keys(records).length>=2000)return;
  const item={id:randomUUID(),jobId:job.id,caseId:job.caseId,caseSignature:job.caseSignature,challengeId:challenge.id,recipient,expiresAt:challenge.expiresAt,state:'pending',createdAt:this.now()};
  if(!this.current(item))return;records[item.id]=item;
  try{this.store.save();}catch{delete records[item.id];throw Error('OPERATOR_NOTICE_SAVE_FAILED');}
 }
 text(item){const customer=item&&this.fulfilment.job(item.jobId)?.customer;return (this.store.data.customerPriority?.[customer]?.priority==='urgent'?'⚠️ أولوية: عميل مستعجل/منزعج\n':'')+'تنبيه من رعد: مطلوب إكمال التحقق المرئي لمتابعة طلب التأشيرة.\nافتح مركز المحادثات، ثم قسم التأشيرات وملف الطلب، واضغط «إكمال التحقق المرئي».\n'+OPS+'\nلا ترسل رمز الصورة على واتساب؛ أدخله في صفحة التحقق المرتبطة بالجلسة.';}
 async flush(){
  if(this.busy||!this.recipient())return;this.busy=true;
  try{for(const item of Object.values(this.store.data.visaOperatorNotices)){
   if(item.state!=='pending')continue;
   if(!this.current(item)){item.state='cancelled';this.store.save();continue;}
   item.state='sending';try{this.store.save();}catch{item.state='pending';throw Error('OPERATOR_NOTICE_SAVE_FAILED');}
   const guard=()=>{if(!this.current(item))throw Error('OPERATOR_NOTICE_STALE');};
   try{
    const result=await this.send({recipient:item.recipient,jobId:item.jobId,noticeId:item.id,text:this.text(item),noticeMessageId:item.noticeMessageId},guard);
    if(accepted(result)){item.state='accepted';item.messageId=result.messages[0].id;}
    else if(result?.paused===true){item.state=typeof result.noticeMessageId==='string'?'waiting_owner':'paused';if(result.noticeMessageId)item.noticeMessageId=result.noticeMessageId;}
    else item.state='uncertain';
   }catch(error){item.state=error?.notDispatched===true?'paused':'uncertain';}
   item.updatedAt=this.now();this.store.save();this.report({caseHash:createHash('sha256').update(item.caseId).digest('hex').slice(0,12),state:item.state});
  }}finally{this.busy=false;}
 }
 handles(message){return Boolean(message.visaOperatorAction||!message.media&&phone(message.from)===this.recipient()&&Object.values(this.store.data.visaOperatorNotices).some(item=>['waiting_owner','paused'].includes(item.state)&&this.current(item)));}
 async receive(message){
  if(phone(message.from)!==this.recipient())return{ok:false};
  const records=Object.values(this.store.data.visaOperatorNotices),explicit=message.visaOperatorAction?.noticeId;
  const candidates=records.filter(item=>['waiting_owner','paused'].includes(item.state)&&this.current(item)&&(!explicit||item.id===explicit&&message.contextId===item.noticeMessageId));
  if(!candidates.length)return{ok:false,reply:'انتهت صلاحية إشعار التحقق السابق. راجع حالة الطلب في مركز المحادثات:\n'+OPS};
  for(const item of candidates){item.state='pending';item.updatedAt=this.now();}this.store.save();await this.flush();return{ok:true};
 }
}
module.exports={VisaOperatorNotifications};
