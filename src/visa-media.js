'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validCustomer}=require('./conversation-journal');
const {persistentMount}=require('./state-storage');
const MAX_BYTES=10*1024*1024,RETENTION_MS=30*86400000;
const MIME=new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['application/pdf','pdf'],['audio/ogg','ogg'],['audio/mpeg','mp3'],['audio/mp4','m4a'],['audio/wav','wav'],['audio/x-wav','wav']]);
const cleanMime=value=>typeof value==='string'?value.toLowerCase().split(';')[0].trim():'';
function mediaURL(value){
 let u;try{u=new URL(value);}catch{throw Error('MEDIA_SOURCE_REJECTED');}
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!['lookaside.fbsbx.com','platform-lookaside.fbsbx.com'].includes(u.hostname))throw Error('MEDIA_SOURCE_REJECTED');
 return u.href;
}
function validateBytes(bytes,mime){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw Error('MEDIA_SIZE_INVALID');
 if(mime==='application/pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('MEDIA_CONTENT_INVALID');
 if(mime==='image/jpeg'&&!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw Error('MEDIA_CONTENT_INVALID');
 if(mime==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('MEDIA_CONTENT_INVALID');
 if(mime==='image/webp'&&!(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'))throw Error('MEDIA_CONTENT_INVALID');
 if(mime==='audio/ogg'&&bytes.subarray(0,4).toString()!=='OggS')throw Error('MEDIA_CONTENT_INVALID');
 if(['audio/wav','audio/x-wav'].includes(mime)&&!(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE'))throw Error('MEDIA_CONTENT_INVALID');
 if(mime==='audio/mp4'&&bytes.subarray(4,8).toString()!=='ftyp')throw Error('MEDIA_CONTENT_INVALID');
 if(mime==='audio/mpeg'&&!(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224))throw Error('MEDIA_CONTENT_INVALID');
}
async function boundedBody(response){
 const declared=Number(response.headers?.get?.('content-length'));
 if(Number.isFinite(declared)&&declared>MAX_BYTES)throw Error('MEDIA_SIZE_INVALID');
 // Reject rather than buffer an unbounded response if streaming is unavailable.
 if(!response.body||typeof response.body[Symbol.asyncIterator]!=='function')throw Error('MEDIA_STREAM_UNAVAILABLE');
 const parts=[];let size=0;
 try{for await(const value of response.body){const chunk=Buffer.from(value);size+=chunk.length;if(size>MAX_BYTES)throw Error('MEDIA_SIZE_INVALID');parts.push(chunk);}}catch(error){try{await response.body.cancel?.();}catch{}throw error;}
 return Buffer.concat(parts,size);
}
class VisaMediaStore{
 constructor({store,env=process.env,fetchImpl=global.fetch,now=Date.now}={}){
  if(!store?.data||typeof store.save!=='function')throw Error('MEDIA_STORE_INVALID');
  Object.assign(this,{store,env,fetchImpl,now});this.records=store.data.visaMedia||={};
  this.directory=store.file?path.join(path.dirname(path.resolve(store.file)),'visa-media'):null;
  this.key=Buffer.isBuffer(store.key)&&store.key.length===32?store.key:null;
  this.durable=Boolean(this.directory&&this.key&&(env.NODE_ENV!=='production'||persistentMount(store.file)));
  this.locks=new Map();this.epochs=new Map();
 }
 public(record){if(!record)return null;const prep=record.pdfPreparation;const safePrep=prep&&['queued','running','ready','failed','unsupported'].includes(prep.status)?{status:prep.status,...(typeof prep.reason==='string'&&/^[A-Z_]{1,60}$/.test(prep.reason)?{reason:prep.reason}:{})}:null;return{id:record.id,customer:record.customer,type:record.type,mimeType:record.mimeType,filename:record.filename,size:record.size,status:record.status,receivedAt:record.receivedAt,expiresAt:record.expiresAt,...(safePrep?{pdfPreparation:safePrep}:{}),...(record.purpose==='raad_portal_upload'?{purpose:record.purpose,needsVisualReview:true}:record.purpose==='raad_pdf_preview'?{purpose:record.purpose,page:record.page,needsVisualReview:true}:{})};}
 list(customer){if(!validCustomer(customer))return[];return Object.values(this.records).filter(x=>x.customer===customer&&x.expiresAt>this.now()).sort((a,b)=>b.receivedAt-a.receivedAt).slice(0,50).map(x=>this.public(x));}
 get(id,{customer}={}){const r=this.records[id];if(typeof id!=='string'||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(id)||typeof customer!=='string'||!validCustomer(customer)||!r||r.customer!==customer||r.expiresAt<=this.now())throw Error('MEDIA_NOT_FOUND');return this.public(r);}
 read(id,{customer}={}){
  const metadata=this.get(id,{customer});if(!this.durable)throw Error('MEDIA_STORAGE_UNAVAILABLE');
  const input=fs.readFileSync(path.join(this.directory,id+'.enc'));
  const d=crypto.createDecipheriv('aes-256-gcm',this.key,input.subarray(0,12));d.setAAD(Buffer.from(id+':'+customer));d.setAuthTag(input.subarray(12,28));
  const bytes=Buffer.concat([d.update(input.subarray(28)),d.final()]);if(crypto.createHash('sha256').update(bytes).digest('hex')!==this.records[id].checksum)throw Error('MEDIA_CONTENT_INVALID');
  return{metadata,bytes};
 }
 storeDerived(customer,{sourceIds,bytes,mimeType,kind}={}){
  if(!validCustomer(customer)||!this.durable)throw Error('MEDIA_STORAGE_UNAVAILABLE');
  if(!Array.isArray(sourceIds)||sourceIds.length<1||sourceIds.length>2||new Set(sourceIds).size!==sourceIds.length||!['passport','residence','photo'].includes(kind))throw Error('MEDIA_INVALID');
  const sources=sourceIds.map(id=>this.get(id,{customer}));
  if(!['image/jpeg','image/png'].includes(mimeType)||!Buffer.isBuffer(bytes)||bytes.length>1000000)throw Error('MEDIA_CONTENT_INVALID');
  validateBytes(bytes,mimeType);const checksum=crypto.createHash('sha256').update(bytes).digest('hex');
  const duplicate=Object.values(this.records).find(r=>r.customer===customer&&r.purpose==='raad_portal_upload'&&r.kind===kind&&r.checksum===checksum&&r.expiresAt>this.now()&&JSON.stringify(r.sourceIds)===JSON.stringify(sourceIds));if(duplicate)return this.public(duplicate);
  if(this.list(customer).length>=50||Object.keys(this.records).length>=500)throw Error('MEDIA_CAPACITY_REACHED');
  const id=crypto.randomUUID(),receivedAt=this.now(),record={id,customer,type:'image',mimeType,filename:'raad-'+kind+'.'+MIME.get(mimeType),size:bytes.length,checksum,status:'pending_review',purpose:'raad_portal_upload',kind,sourceIds:[...sourceIds],receivedAt,expiresAt:Math.min(receivedAt+RETENTION_MS,...sources.map(s=>s.expiresAt))};
  fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(id+':'+customer));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]),target=path.join(this.directory,id+'.enc');
  fs.writeFileSync(target,Buffer.concat([iv,cipher.getAuthTag(),encrypted]),{mode:0o600,flag:'wx',flush:true});this.records[id]=record;
  try{this.store.save();}catch{delete this.records[id];try{fs.unlinkSync(target);}catch{}throw Error('MEDIA_STORAGE_UNAVAILABLE');}return this.public(record);
 }
 storeApplicationPdf(customer,{bytes,applicationReference,jobId}={}){
  if(!validCustomer(customer)||!this.durable)throw Error('MEDIA_STORAGE_UNAVAILABLE');
  if(!/^[A-Z]{0,3}[0-9]{3,20}$/.test(applicationReference||'')||!/^[-a-f0-9]{36}$/i.test(jobId||''))throw Error('MEDIA_INVALID');
  validateBytes(bytes,'application/pdf');
  const checksum=crypto.createHash('sha256').update(bytes).digest('hex');
  const duplicate=Object.values(this.records).find(r=>r.customer===customer&&r.purpose==='raad_application_copy'&&r.jobId===jobId&&r.checksum===checksum&&r.expiresAt>this.now());if(duplicate)return this.public(duplicate);
  if(this.list(customer).length>=50||Object.keys(this.records).length>=500)throw Error('MEDIA_CAPACITY_REACHED');
  const id=crypto.randomUUID(),receivedAt=this.now(),record={id,customer,type:'document',mimeType:'application/pdf',filename:'saudi-application-'+applicationReference+'.pdf',size:bytes.length,checksum,status:'application_copy',purpose:'raad_application_copy',applicationReference,jobId,receivedAt,expiresAt:receivedAt+RETENTION_MS};
  fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(id+':'+customer));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]),target=path.join(this.directory,id+'.enc');
  fs.writeFileSync(target,Buffer.concat([iv,cipher.getAuthTag(),encrypted]),{mode:0o600,flag:'wx',flush:true});this.records[id]=record;
  try{this.store.save();}catch{delete this.records[id];try{fs.unlinkSync(target);}catch{}throw Error('MEDIA_STORAGE_UNAVAILABLE');}return this.public(record);
 }
 storePdfPreview(customer,{sourceId,page,bytes,mimeType}={}){
  if(!validCustomer(customer)||!this.durable)throw Error('MEDIA_STORAGE_UNAVAILABLE');
  if(!Number.isInteger(page)||page<1||page>2)throw Error('MEDIA_INVALID');
  const source=this.get(sourceId,{customer});
  if(source.mimeType!=='application/pdf'||source.type!=='document'||source.purpose)throw Error('MEDIA_INVALID');
  if(!['image/jpeg','image/png'].includes(mimeType)||!Buffer.isBuffer(bytes)||bytes.length>1000000)throw Error('MEDIA_CONTENT_INVALID');
  validateBytes(bytes,mimeType);const checksum=crypto.createHash('sha256').update(bytes).digest('hex');
  const duplicate=Object.values(this.records).find(r=>r.customer===customer&&r.purpose==='raad_pdf_preview'&&r.sourceIds?.length===1&&r.sourceIds[0]===sourceId&&r.page===page&&r.checksum===checksum&&r.expiresAt>this.now());if(duplicate){try{this.read(duplicate.id,{customer});}catch{throw Error('MEDIA_CONTENT_INVALID');}return this.public(duplicate);}
  if(this.list(customer).length>=50||Object.keys(this.records).length>=500)throw Error('MEDIA_CAPACITY_REACHED');
  const id=crypto.randomUUID(),receivedAt=this.now(),record={id,customer,type:'image',mimeType,filename:'raad-pdf-page-'+page+'.'+MIME.get(mimeType),size:bytes.length,checksum,status:'pending_review',purpose:'raad_pdf_preview',page,sourceIds:[sourceId],receivedAt,expiresAt:Math.min(receivedAt+RETENTION_MS,source.expiresAt)};
  fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(id+':'+customer));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]),target=path.join(this.directory,id+'.enc');
  fs.writeFileSync(target,Buffer.concat([iv,cipher.getAuthTag(),encrypted]),{mode:0o600,flag:'wx',flush:true});this.records[id]=record;
  try{this.store.save();}catch{delete this.records[id];try{fs.unlinkSync(target);}catch{}throw Error('MEDIA_STORAGE_UNAVAILABLE');}return this.public(record);
 }
 async receive(customer,message){
  if(!validCustomer(customer))return{ok:false,error:'INVALID_CUSTOMER',reply:'تعذر ربط المرفق بالمحادثة. يرجى إعادة الإرسال من رقم التقديم نفسه.'};
  const media=message?.media;
  if(!media||typeof media.id!=='string'||!/^\d{1,100}$/.test(media.id)||!['image','document','audio'].includes(media.type))return{ok:false,error:'MEDIA_INVALID',reply:'لم نستلم مرفقاً مدعوماً. يرجى إرسال صورة واضحة أو ملف PDF.'};
  const existing=Object.values(this.records).find(r=>r.customer===customer&&r.sourceId===media.id&&r.expiresAt>this.now());
  if(existing)return{ok:true,media:this.public(existing),duplicate:true,reply:this.ack(existing)};
  const lock=customer+':'+media.id;if(this.locks.has(lock))return this.locks.get(lock);
  const work=this.performReceive(customer,media,this.epochs.get(customer)||0);this.locks.set(lock,work);try{return await work;}finally{this.locks.delete(lock);}
 }
 ack(record){return record.type==='audio'?'وصل التسجيل الصوتي وحُفظ للمراجعة. لم يتم تفريغه بعد؛ إذا ممكن اكتب طلبك برسالة حتى نساعدك بسرعة.':'وصل المرفق وحُفظ للمراجعة، شكراً إلك. لم يتم تأكيد وضوحه أو اكتمال بياناته بعد.';}
 async performReceive(customer,media,epoch){
  if(!this.durable)return{ok:false,error:'MEDIA_STORAGE_UNAVAILABLE',reply:'وصل إشعار المرفق، لكن تعذر حفظه بشكل آمن حالياً. لم تتم مراجعة المستند؛ يرجى انتظار تأكيد القسم قبل إرسال بيانات إضافية.'};
  this.prune();if(this.list(customer).length>=50||Object.keys(this.records).length>=500)return{ok:false,error:'MEDIA_CAPACITY_REACHED',reply:'وصل إشعار المرفق، لكن مساحة استقبال المستندات تحتاج مراجعة القسم. لم يُحفظ هذا المرفق؛ يرجى انتظار تأكيد الموظف.'};
  const token=this.env.WHATSAPP_ACCESS_TOKEN,version=this.env.WHATSAPP_GRAPH_API_VERSION||'v23.0';
  if(!token||!/^v\d{1,2}\.\d{1,2}$/.test(version))return{ok:false,error:'MEDIA_PROVIDER_UNAVAILABLE',reply:'وصل إشعار المرفق، لكن لم نتمكن من تنزيله للمراجعة حالياً. يرجى إعادة المحاولة لاحقاً.'};
  let savedPath;
  try{
   const headers={Authorization:'Bearer '+token},signal=AbortSignal.timeout(20000);
   const infoResponse=await this.fetchImpl('https://graph.facebook.com/'+version+'/'+media.id,{headers,redirect:'error',signal});
   if(!infoResponse.ok)throw Error('MEDIA_DOWNLOAD_FAILED');
   const info=await infoResponse.json();if(info.id&&String(info.id)!==media.id)throw Error('MEDIA_SOURCE_REJECTED');
   const mime=cleanMime(info.mime_type);if(!MIME.has(mime)||media.type==='document'&&mime!=='application/pdf'||media.type==='image'&&!mime.startsWith('image/')||media.type==='audio'&&!mime.startsWith('audio/'))throw Error('MEDIA_UNSUPPORTED');
   if(media.mimeType&&cleanMime(media.mimeType)!==mime)throw Error('MEDIA_CONTENT_INVALID');
   if(!Number.isSafeInteger(info.file_size)||info.file_size<=0||info.file_size>MAX_BYTES)throw Error('MEDIA_SIZE_INVALID');
   const response=await this.fetchImpl(mediaURL(info.url),{headers,redirect:'error',signal});if(!response.ok)throw Error('MEDIA_DOWNLOAD_FAILED');
   const contentType=cleanMime(response.headers?.get?.('content-type'));if(contentType&&contentType!==mime&&contentType!=='application/octet-stream')throw Error('MEDIA_CONTENT_INVALID');
   const bytes=await boundedBody(response);validateBytes(bytes,mime);if(bytes.length!==info.file_size)throw Error('MEDIA_SIZE_INVALID');
   const checksum=crypto.createHash('sha256').update(bytes).digest('hex');
   if(typeof info.sha256==='string'&&info.sha256!==checksum&&info.sha256!==Buffer.from(checksum,'hex').toString('base64'))throw Error('MEDIA_CONTENT_INVALID');
   if((this.epochs.get(customer)||0)!==epoch)throw Error('MEDIA_RECEIVE_CANCELLED');
   const id=crypto.randomUUID(),receivedAt=this.now(),filename=(media.type==='audio'?'voice-message':'visa-document')+'.'+MIME.get(mime);
   const record={id,customer,sourceId:media.id,type:media.type,mimeType:mime,filename,size:bytes.length,checksum,status:media.type==='audio'?'pending_transcription':'pending_review',receivedAt,expiresAt:receivedAt+RETENTION_MS};
   fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(id+':'+customer));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);savedPath=path.join(this.directory,id+'.enc');
   fs.writeFileSync(savedPath,Buffer.concat([iv,cipher.getAuthTag(),encrypted]),{mode:0o600,flag:'wx',flush:true});this.records[id]=record;
   try{this.store.save();}catch(error){delete this.records[id];throw error;}
   return{ok:true,media:this.public(record),reply:this.ack(record)};
  }catch(error){if(savedPath)try{fs.unlinkSync(savedPath);}catch{}const allowed=new Set(['MEDIA_UNSUPPORTED','MEDIA_SIZE_INVALID','MEDIA_CONTENT_INVALID','MEDIA_SOURCE_REJECTED']);const code=allowed.has(error?.message)?error.message:'MEDIA_DOWNLOAD_FAILED';
   return{ok:false,error:code,reply:code==='MEDIA_UNSUPPORTED'?'هذا النوع من الملفات غير مدعوم. ابعت صورة JPG أو PNG أو ملف PDF واضح.':code==='MEDIA_SIZE_INVALID'?'تعذر حفظ المرفق بسبب حجمه. يرجى إرسال ملف لا يتجاوز 10 ميغابايت.':'وصل إشعار المرفق، لكن تعذر تنزيله وحفظه بأمان. لم تتم مراجعته؛ يرجى إعادة إرساله.'};}
 }
 deleteCustomer(customer){if(!validCustomer(customer))return;this.epochs.set(customer,(this.epochs.get(customer)||0)+1);for(const [id,r]of Object.entries(this.records))if(r.customer===customer){if(this.directory)try{fs.unlinkSync(path.join(this.directory,id+'.enc'));}catch{}delete this.records[id];}this.store.save();}
 prune(){let changed=false;for(const [id,r]of Object.entries(this.records))if(r.expiresAt<=this.now()){if(this.directory)try{fs.unlinkSync(path.join(this.directory,id+'.enc'));}catch{}delete this.records[id];changed=true;}if(changed)this.store.save();}
 status(){return{configured:this.durable,reviewMode:'staff',transcriptionConfigured:false};}
}
async function handleVisaMediaRequest(request,response,url,mediaStore){
 const match=url.pathname.match(/^\/internal\/assistant\/visa-media\/([a-f0-9-]{36})$/);if(!match)return false;
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox; frame-ancestors 'none'"};
 if(request.method!=='GET'){response.writeHead(405,headers).end();return true;}
 try{const{bytes,metadata}=mediaStore.read(match[1],{customer:url.searchParams.get('customer')});response.writeHead(200,{...headers,'Content-Type':metadata.mimeType,'Content-Length':bytes.length,'Content-Disposition':'attachment; filename="'+metadata.filename+'"'}).end(bytes);}
 catch{response.writeHead(404,{...headers,'Content-Type':'application/json'}).end('{"error":"MEDIA_NOT_FOUND"}');}return true;
}
module.exports={VisaMediaStore,handleVisaMediaRequest,MAX_BYTES,mediaURL};

