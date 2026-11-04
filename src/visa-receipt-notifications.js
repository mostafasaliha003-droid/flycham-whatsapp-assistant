'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {visaCaseSignature}=require('./visa-case-signature');
const {isReceiptPdf}=require('./visa-receipt-pdf');
const {normalize}=require('./saudi-visa-policy');
const OPS='https://flycham-whatsapp-assistant.onrender.com/operations';
const DEFAULT_RECIPIENT='971507993145';
const phone=v=>typeof v==='string'&&/^\+?[1-9]\d{7,14}$/.test(v)?v.replace(/^\+/,''):null;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const transfer=t=>{const n=normalize(t||'');return !/[؟?]|لم احول|ما حولت|لم ادفع|ما دفعت|كيف|اريد التحويل|بدي احول/.test(n)&&/حولت|دفعت|سددت|تم التحويل|تم السداد|ايصال|وصل التحويل|\b(?:paid|transferred|payment receipt|transfer receipt)\b/.test(n);};
class VisaReceiptNotifications{
 constructor({store,fulfilment,journal,send,env=process.env,now=Date.now,report=()=>{}}){Object.assign(this,{store,fulfilment,journal,send,env,now,report});store.data.visaReceiptNotices||={enabledAt:now(),items:{},expected:{}};this.busy=false;let changed=false;for(const item of Object.values(this.data().items))if(item.state==='sending'){item.state='uncertain';changed=true;}if(changed)this.store.save();}
 data(){return this.store.data.visaReceiptNotices;}
 recipient(){return phone(this.env.RAAD_RECEIPT_NOTICE_WHATSAPP||DEFAULT_RECIPIENT);}
 observeMessage(message){const c=this.store.data.visaCases?.[message.from];if(!c||!transfer(message.text)||!Number.isFinite(c.quote?.total)||c.submissionStatus==='submitted')return;this.data().expected[message.from]={caseId:c.id,signature:visaCaseSignature(c),at:this.now()};this.store.save();}
 ingest(customer,message,media){
  const c=this.store.data.visaCases?.[customer];if(/جواز|هويه|اقامه|passport|identity/.test(normalize(message.text||''))&&!/ايصال|receipt/.test(normalize(message.text||'')))return false;if(!c||c.submissionStatus==='submitted'||!['image/jpeg','image/png','image/webp','application/pdf'].includes(media?.mimeType))return false;
  const expected=this.data().expected[customer],lastOut=this.journal?.get?.(customer)?.messages?.filter(m=>m.direction==='out').at(-1),fresh=m=>Number.isFinite(m?.at)&&m.at<=this.now()&&this.now()-m.at<86400000;
  const requested=fresh(lastOut)&&/ابعت.*(?:ايصال|إيصال)|أرسل.*إيصال|ارسل.*ايصال/.test(lastOut.text||'');
  if(!transfer(message.text)&&!transfer(message.media?.filename||media.filename)&&c.paymentStatus!=='awaiting_verification'&&!(expected?.caseId===c.id&&expected.signature===visaCaseSignature(c)&&fresh(expected))&&!requested)return false;
  try{this.fulfilment.receiveReceipt(customer,{receiptId:media.id});this.sync();return true;}catch{return false;}
 }
 async inspectPdf(customer,media){
  const c=this.store.data.visaCases?.[customer],raw=this.store.data.visaMedia?.[media?.id];
  if(!c||c.submissionStatus==='submitted'||!Number.isFinite(c.quote?.total)||media?.mimeType!=='application/pdf'||raw?.customer!==customer||raw.expiresAt<=this.now()||raw.purpose)return false;
  this.data().pdfChecks||={};const signature=visaCaseSignature(c),caseId=c.id,sourceId=raw.id,sourceSha=raw.checksum,key=hash([customer,caseId,signature,sourceSha]);if(this.data().pdfChecks[key]||Object.keys(this.data().pdfChecks).length>=2000)return false;
  this.data().pdfChecks[key]='running';this.store.save();let file;
  const guard=()=>{if(this.store.data.visaCases?.[customer]?.id!==caseId||visaCaseSignature(this.store.data.visaCases[customer])!==signature||this.store.data.visaMedia?.[sourceId]?.customer!==customer||this.store.data.visaMedia?.[sourceId]?.checksum!==sourceSha||this.store.data.visaMedia?.[sourceId]?.expiresAt<=this.now())throw Error('RECEIPT_SOURCE_CHANGED');};
  try{file=await this.fulfilment.mediaStore.read(sourceId,{customer});guard();if(createHash('sha256').update(file.bytes).digest('hex')!==sourceSha)throw Error('RECEIPT_SOURCE_CHANGED');const yes=await isReceiptPdf(file.bytes);guard();if(yes){this.fulfilment.receiveReceipt(customer,{receiptId:sourceId});this.data().pdfChecks[key]='receipt';this.store.save();return true;}this.data().pdfChecks[key]='other';this.store.save();return false;}catch{this.data().pdfChecks[key]='unconfirmed';this.store.save();return false;}finally{file?.bytes?.fill(0);}
 }
 async recoverPdfReceipts(){
  let checked=0;for(const [customer,c]of Object.entries(this.store.data.visaCases||{})){
   const state=this.store.data.visaDocumentIntake?.cases?.[customer];if(!state||state.caseId!==c.id||c.submissionStatus==='submitted'||!state.applicants?.some(a=>['passport','residence','photo'].every(k=>a.documents?.[k])))continue;
   for(const d of state.documents||[]){const media=this.store.data.visaMedia?.[d.mediaId];if(checked>=2)return;if(d.extraction?.kind!=='other'||media?.mimeType!=='application/pdf'||media.receivedAt<c.createdAt||media.receivedAt<this.now()-86400000||this.fulfilment.data().cases?.[customer]?.receipts?.[media.id])continue;const key=hash([customer,c.id,visaCaseSignature(c),media.checksum]);if(this.data().pdfChecks?.[key])continue;checked++;await this.inspectPdf(customer,media);}
  }
 }
 current(item){try{const c=this.store.data.visaCases?.[item.customer],r=this.fulfilment.data().cases?.[item.customer]?.receipts?.[item.receiptId];return Boolean(item.recipient===this.recipient()&&item.expiresAt>this.now()&&c?.id===item.caseId&&visaCaseSignature(c)===item.signature&&r?.state==='awaiting_accountant'&&r.caseId===item.caseId&&r.caseSignature===item.signature&&r.sha256===item.sha256&&this.fulfilment.observeMedia(item.customer,item.receiptId).sha256===item.sha256);}catch{return false;}}
 sync(){
  let changed=false;for(const [id,item]of Object.entries(this.data().items))if(item.expiresAt<=this.now()){delete this.data().items[id];changed=true;}
  for(const [customer,e]of Object.entries(this.data().expected))if(e.at<this.now()-15*60000){delete this.data().expected[customer];changed=true;}
  for(const [customer,record]of Object.entries(this.fulfilment.data().cases||{}))for(const r of Object.values(record.receipts||{})){
   if(r.state!=='awaiting_accountant'||r.receivedAt<this.data().enabledAt||!this.recipient())continue;
   const key=hash([customer,r.caseId,r.caseSignature,r.sha256,this.recipient()]);if(this.data().items[key]||Object.keys(this.data().items).length>=2000)continue;
   const item={id:randomUUID(),key,customer,receiptId:r.mediaId,caseId:r.caseId,signature:r.caseSignature,sha256:r.sha256,recipient:this.recipient(),state:'pending',createdAt:this.now(),expiresAt:Math.min(r.expiresAt||this.now()+30*86400000,this.now()+30*86400000)};
   if(this.current(item)){this.data().items[key]=item;changed=true;}
  }if(changed)this.store.save();
 }
 text(item){return (this.store.data.customerPriority?.[item.customer]?.priority==='urgent'?'⚠️ أولوية: عميل مستعجل/منزعج\n':'')+'وصل إيصال تحويل جديد وبانتظار مراجعتك.\nرقم العميل: +'+item.customer+'\nمرجع الملف: '+item.caseId+'\nافتح الملف لمراجعة الإيصال واعتماد الدفعة بعد التحقق من وصولها للحساب:\n'+OPS;}
 async flush(){if(this.busy)return;this.busy=true;try{await this.recoverPdfReceipts();this.sync();for(const item of Object.values(this.data().items)){
  if(item.state==='paused'&&item.retryAt<=this.now())item.state='pending';
  if(item.state!=='pending')continue;if(!this.current(item)){item.state='cancelled';this.store.save();continue;}
  item.state='sending';try{this.store.save();}catch{item.state='pending';throw Error('RECEIPT_NOTICE_SAVE_FAILED');}
  const guard=()=>{if(!this.current(item))throw Object.assign(Error('RECEIPT_NOTICE_STALE'),{notDispatched:true});};
  try{const result=await this.send({recipient:item.recipient,jobId:item.caseId,noticeId:item.id,text:this.text(item),noticeMessageId:item.noticeMessageId},guard);if(typeof result?.messages?.[0]?.id==='string'){item.state='accepted';item.messageId=result.messages[0].id;}else if(result?.paused){item.state=result.noticeMessageId?'waiting_owner':'paused';if(result.noticeMessageId)item.noticeMessageId=result.noticeMessageId;else item.retryAt=this.now()+60000;}else item.state='uncertain';}catch(error){item.state=error.notDispatched===true?'paused':'uncertain';if(item.state==='paused')item.retryAt=this.now()+60000;}
  item.updatedAt=this.now();this.store.save();this.report({caseHash:hash(item.caseId).slice(0,12),state:item.state});
 }}finally{this.busy=false;}}
 handles(message){return Boolean(message?.visaReceiptAction);}
 async receive(message){if(phone(message.from)!==this.recipient())return {ok:false};const item=Object.values(this.data().items).find(i=>i.id===message.visaReceiptAction?.noticeId&&i.state==='waiting_owner'&&i.noticeMessageId===message.contextId&&this.current(i));if(!item)return {ok:false,reply:'راجع آخر حالة للإيصال من لوحة العمليات:\n'+OPS};item.state='pending';this.store.save();await this.flush();return {ok:true};}
}
module.exports={VisaReceiptNotifications,RECEIPT_NOTICE_RECIPIENT:DEFAULT_RECIPIENT};
