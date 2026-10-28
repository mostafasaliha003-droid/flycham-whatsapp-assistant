'use strict';
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const {validCustomer}=require('./conversation-journal');
const {visaCaseSignature}=require('./visa-case-signature');
const {MAX_BYTES}=require('./visa-media');
const TOKEN=/^[A-Za-z0-9_-]{43}$/,UUID=/^[a-f0-9-]{36}$/,KEY=/^[A-Za-z0-9_-]{8,100}$/;
const LIMITS=Object.freeze({passport:2,residence:2,photo:1}),TTL=2*3600000;
const MIME=new Set(['image/jpeg','image/png','image/webp','application/pdf']);
const STATUS={UPLOAD_UNAUTHORIZED:401,UPLOAD_EXPIRED:410,UPLOAD_STALE:409,UPLOAD_PAUSED:409,UPLOAD_SEALED:409,UPLOAD_LIMIT:409,UPLOAD_CONFLICT:409,UPLOAD_EMPTY:409,UPLOAD_NOT_FOUND:404,UPLOAD_INVALID:400,UPLOAD_TYPE_INVALID:400,UPLOAD_CONTENT_INVALID:400,UPLOAD_TOO_LARGE:413,UPLOAD_BUSY:429,UPLOAD_STORAGE_UNAVAILABLE:503,UPLOAD_UNAVAILABLE:503,UPLOAD_ORIGIN_INVALID:403};
const hash=value=>createHash('sha256').update(value).digest('hex');
function fail(code){throw Object.assign(Error(code),{code});}
function originFor(env){
 const raw=env.RENDER_EXTERNAL_URL||'https://flycham-whatsapp-assistant.onrender.com';
 try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.search||u.hash||!['','/'].includes(u.pathname))throw Error();return u.origin;}catch{fail('UPLOAD_UNAVAILABLE');}
}
async function readUpload(request){
 const declared=request.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)<1))fail('UPLOAD_INVALID');if(Number(declared)>MAX_BYTES)fail('UPLOAD_TOO_LARGE');
 const chunks=[];let size=0;const timer=setTimeout(()=>request.destroy?.(),30000);timer.unref?.();
 try{for await(const value of request){const chunk=Buffer.from(value);size+=chunk.length;if(size>MAX_BYTES)fail('UPLOAD_TOO_LARGE');chunks.push(chunk);}if(!size||declared!==undefined&&Number(declared)!==size)fail('UPLOAD_INVALID');return Buffer.concat(chunks,size);}catch(error){if(STATUS[error?.code])throw error;fail('UPLOAD_INVALID');}finally{clearTimeout(timer);}
}
class VisaUploadService{
 constructor({store,mediaStore,documentIntake,inbox,env=process.env,now=Date.now,onComplete=()=>{},whatsappNumber}={}){
  if(!store?.data||typeof store.save!=='function'||!mediaStore||typeof inbox?.isHumanOwned!=='function'||typeof onComplete!=='function')throw Error('UPLOAD_CONFIG_INVALID');
  Object.assign(this,{store,mediaStore,documentIntake,inbox,env,now,onComplete});this.origin=originFor(env);this.locks=new Map();
  const n=whatsappNumber||env.RAAD_DOCUMENT_UPLOAD_WHATSAPP_NUMBER;this.whatsappUrl=typeof n==='string'&&/^\+?[1-9]\d{6,14}$/.test(n)?'https://wa.me/'+n.replace(/^\+/,''):null;
  store.data.visaUpload||={version:1,sessions:{}};if(store.data.visaUpload.version!==1||!store.data.visaUpload.sessions)throw Error('UPLOAD_CONFIG_INVALID');
 }
 get data(){return this.store.data.visaUpload;}
 currentCase(customer){const c=this.store.data.visaCases?.[customer];if(!validCustomer(customer)||!c||typeof c.id!=='string'||!c.id||c.pendingAmendment||c.submissionStatus==='submitted')fail('UPLOAD_STALE');return c;}
 guard(session,{open=false}={}){
  if(!session||this.data.sessions[session.id]!==session)fail('UPLOAD_UNAUTHORIZED');
  if(session.expiresAt<=this.now())fail('UPLOAD_EXPIRED');
  const c=this.currentCase(session.customer);if(c.id!==session.caseId||visaCaseSignature(c)!==session.caseSignature)fail('UPLOAD_STALE');
  if(this.inbox.isHumanOwned(session.customer)||this.inbox.isBlocked?.(session.customer))fail('UPLOAD_PAUSED');
  if(open&&session.state!=='open')fail('UPLOAD_SEALED');
  if(!this.mediaStore.durable)fail('UPLOAD_STORAGE_UNAVAILABLE');return c;
 }
 createLink(customer){
  const c=this.currentCase(customer);if(this.inbox.isHumanOwned(customer)||this.inbox.isBlocked?.(customer))fail('UPLOAD_PAUSED');if(!this.mediaStore.durable)fail('UPLOAD_STORAGE_UNAVAILABLE');
  this.prune();const token=randomBytes(32).toString('base64url'),caseSignature=visaCaseSignature(c);
  // A new link rotates the credential while preserving the customer's current
  // unsubmitted selections. The raw credential is returned once, never stored.
  let s=Object.values(this.data.sessions).find(x=>x.customer===customer&&x.caseId===c.id&&x.caseSignature===caseSignature&&x.state==='open'&&x.expiresAt>this.now());
  if(!s){if(Object.keys(this.data.sessions).length>=1000)fail('UPLOAD_BUSY');s={id:randomUUID(),customer,caseId:c.id,caseSignature,state:'open',createdAt:this.now(),expiresAt:this.now()+TTL,files:[],attempts:{},requestCount:0};this.data.sessions[s.id]=s;}
  if(this.locks.has(s.id))fail('UPLOAD_BUSY');
  const previous=s.tokenHash;s.tokenHash=hash(token);try{this.store.save();}catch{if(previous)s.tokenHash=previous;else delete this.data.sessions[s.id];fail('UPLOAD_STORAGE_UNAVAILABLE');}
  return{url:this.origin+'/documents#'+token,expiresAt:s.expiresAt};
 }
 authenticate(request){
  const a=request.headers.authorization;if(typeof a!=='string'||!a.startsWith('Bearer ')||!TOKEN.test(a.slice(7)))fail('UPLOAD_UNAUTHORIZED');
  const tokenHash=hash(a.slice(7)),s=Object.values(this.data.sessions).find(x=>x.tokenHash===tokenHash);if(!s)fail('UPLOAD_UNAUTHORIZED');this.guard(s);return s;
 }
 view(s){return{ok:true,state:s.state,expiresAt:s.expiresAt,maxBytes:MAX_BYTES,limits:LIMITS,files:s.files.filter(x=>!x.withdrawn).map(({id,role,mimeType,size,clientKey})=>({id,role,mimeType,size,clientKey})),...(this.whatsappUrl?{whatsappUrl:this.whatsappUrl}:{})};}
 async serial(session,work){
  // Never accumulate attacker-controlled file buffers while a previous decode
  // is running. The client retries the same idempotency key after HTTP429.
  if(this.locks.has(session.id))fail('UPLOAD_BUSY');const lock=Promise.resolve().then(work);this.locks.set(session.id,lock);try{return await lock;}finally{if(this.locks.get(session.id)===lock)this.locks.delete(session.id);}
 }
 async upload(session,request){
  this.guard(session,{open:true});if(++session.requestCount>50)fail('UPLOAD_LIMIT');
  const role=request.headers['x-upload-role'],key=request.headers['x-idempotency-key'],mimeType=request.headers['content-type'];
  if(!Object.hasOwn(LIMITS,role)||typeof key!=='string'||!KEY.test(key))fail('UPLOAD_INVALID');if(!MIME.has(mimeType))fail('UPLOAD_TYPE_INVALID');
  let bytes;try{
   bytes=await readUpload(request);this.guard(session,{open:true});const checksum=hash(bytes),fingerprint=hash(JSON.stringify([role,mimeType,checksum])),prior=session.attempts[key];
   if(prior){if(prior.fingerprint!==fingerprint)fail('UPLOAD_CONFLICT');const file=session.files.find(x=>x.id===prior.mediaId&&!x.withdrawn);if(!file)fail('UPLOAD_CONFLICT');this.mediaStore.get(file.id,{customer:session.customer});return{...this.view(session),file:((({id,role,mimeType,size,clientKey})=>({id,role,mimeType,size,clientKey}))(file))};}
   if(session.files.filter(x=>!x.withdrawn&&x.role===role).length>=LIMITS[role]||(session.bytesReceived||0)+bytes.length>64*1024*1024)fail('UPLOAD_LIMIT');
   const metadata=await this.mediaStore.storeUpload(session.customer,{bytes,mimeType,role,sessionId:session.id,caseId:session.caseId,guard:()=>this.guard(session,{open:true})});
   this.guard(session,{open:true});const file={id:metadata.id,role,mimeType,size:metadata.size,clientKey:key};session.files.push(file);session.attempts[key]={fingerprint,mediaId:metadata.id};session.bytesReceived=(session.bytesReceived||0)+metadata.size;
   try{this.store.save();}catch{session.files.pop();delete session.attempts[key];session.bytesReceived-=metadata.size;try{this.mediaStore.withdrawUpload(session.customer,{sessionId:session.id,mediaId:metadata.id});}catch{}fail('UPLOAD_STORAGE_UNAVAILABLE');}
   return{...this.view(session),file:{...file}};
  }finally{bytes?.fill(0);}
 }
 remove(session,id){
  this.guard(session,{open:true});if(!UUID.test(id))fail('UPLOAD_NOT_FOUND');const file=session.files.find(x=>x.id===id&&!x.withdrawn);if(!file)fail('UPLOAD_NOT_FOUND');
  file.withdrawn=true;try{this.mediaStore.withdrawUpload(session.customer,{sessionId:session.id,mediaId:id,guard:()=>this.guard(session,{open:true})});}catch(error){delete file.withdrawn;throw error;}return this.view(session);
 }
 async complete(session){
  this.guard(session);if(session.state==='completed')return this.view(session);this.guard(session,{open:true});const mediaIds=session.files.filter(x=>!x.withdrawn).map(x=>x.id);if(!mediaIds.length)fail('UPLOAD_EMPTY');
  session.state='completed';session.completedAt=this.now();
  try{this.mediaStore.activateUploads(session.customer,{sessionId:session.id,mediaIds,guard:()=>this.guard(session)});}catch(error){session.state='open';delete session.completedAt;throw error;}
  // Committing files is the only durable action. No payment, visa consent or
  // government submission is implied. Intake can recover these originals even
  // if the wake-up callback is interrupted or the process restarts here.
  try{await this.onComplete({customer:session.customer,mediaIds:[...mediaIds],sessionId:session.id});}catch{}
  this.guard(session);return this.view(session);
 }
 prune(){let changed=false;for(const [id,s]of Object.entries(this.data.sessions)){if(!s||s.expiresAt<=this.now()||!this.store.data.visaCases?.[s.customer]||this.store.data.visaCases[s.customer].id!==s.caseId){delete this.data.sessions[id];changed=true;}}if(changed)this.store.save();}
 deleteCustomer(customer){let changed=false;for(const [id,s]of Object.entries(this.data.sessions))if(s.customer===customer){delete this.data.sessions[id];changed=true;}if(changed)this.store.save();}
 async handleRequest(request,response,url){
  if(url.pathname!=='/api/visa-upload'&&!url.pathname.startsWith('/api/visa-upload/'))return false;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
  const reply=(status,data)=>response.writeHead(status,headers).end(JSON.stringify(data));
  try{
   const origin=request.headers.origin,site=request.headers['sec-fetch-site'];if(origin&&origin!==this.origin||site==='cross-site')fail('UPLOAD_ORIGIN_INVALID');
   const session=this.authenticate(request);let result;
   if(url.pathname==='/api/visa-upload/session'&&request.method==='GET')result=this.view(session);
   else if(url.pathname==='/api/visa-upload/files'&&request.method==='POST')result=await this.serial(session,()=>this.upload(session,request));
   else if(url.pathname==='/api/visa-upload/complete'&&request.method==='POST')result=await this.serial(session,()=>this.complete(session));
   else if(url.pathname.startsWith('/api/visa-upload/files/')&&request.method==='DELETE'){const id=url.pathname.slice('/api/visa-upload/files/'.length);result=await this.serial(session,()=>this.remove(session,id));}
   else{reply(405,{ok:false,error:'UPLOAD_METHOD_INVALID'});return true;}
   reply(200,result);
  }catch(error){let code=error?.code||error?.message;const mediaErrors={MEDIA_UNSUPPORTED:'UPLOAD_TYPE_INVALID',MEDIA_SIZE_INVALID:'UPLOAD_TOO_LARGE',MEDIA_CONTENT_INVALID:'UPLOAD_CONTENT_INVALID',MEDIA_CAPACITY_REACHED:'UPLOAD_LIMIT',MEDIA_STORAGE_UNAVAILABLE:'UPLOAD_STORAGE_UNAVAILABLE',MEDIA_NOT_FOUND:'UPLOAD_NOT_FOUND',MEDIA_INVALID:'UPLOAD_INVALID',MEDIA_RECEIVE_CANCELLED:'UPLOAD_STALE'};code=mediaErrors[code]||code;if(!Object.hasOwn(STATUS,code))code='UPLOAD_UNAVAILABLE';reply(STATUS[code],{ok:false,error:code});}
  return true;
 }
}
module.exports={VisaUploadService,UPLOAD_TTL_MS:TTL,UPLOAD_LIMITS:LIMITS};
