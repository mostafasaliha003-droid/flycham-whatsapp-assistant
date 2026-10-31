'use strict';
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const {validCustomer}=require('./conversation-journal');
const {visaCaseSignature}=require('./visa-case-signature');
const {MAX_BYTES}=require('./visa-media');
const TOKEN=/^[A-Za-z0-9_-]{43}$/,UUID=/^[a-f0-9-]{36}$/,KEY=/^[A-Za-z0-9_-]{8,100}$/;
const LIMITS=Object.freeze({passport:2,residence:2,photo:1}),TTL=2*3600000;
const RETURN_TEXT='تم رفع المستندات';
const MRZ_CONSENT_DESCRIPTION='اختياري: أوافق على إرسال الجزء الذي يحتوي على سطور القراءة الآلية (MRZ) من صور جواز السفر أو الهوية في هذا الرفع إلى OpenAI لقراءة هذه السطور. يمكنني رفع المستندات دون هذه الموافقة.';
const SHA=/^[a-f0-9]{64}$/,COMPLETE_BODY_MAX=1024;
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
async function readCompletion(request,{revoke=false}={}){
 const maxBytes=revoke?64:COMPLETE_BODY_MAX,declared=request.headers['content-length'];
 if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)>maxBytes))fail(Number(declared)>maxBytes?'UPLOAD_TOO_LARGE':'UPLOAD_INVALID');
 const chunks=[];let size=0,timedOut=false,timer;
 const timeout=new Promise((resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;request.destroy?.();reject(Object.assign(Error('UPLOAD_INVALID'),{code:'UPLOAD_INVALID'}));},5000);timer.unref?.();});
 try{return await Promise.race([timeout,(async()=>{
  for await(const value of request){if(timedOut)fail('UPLOAD_INVALID');const chunk=Buffer.from(value);size+=chunk.length;if(size>maxBytes)fail('UPLOAD_TOO_LARGE');chunks.push(chunk);}if(timedOut||declared!==undefined&&Number(declared)!==size)fail('UPLOAD_INVALID');if(!size)return null;
  if(request.headers['content-type']!=='application/json')fail('UPLOAD_INVALID');let body;try{body=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{fail('UPLOAD_INVALID');}
  if(revoke){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)fail('UPLOAD_INVALID');return null;}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='mrzConsent'))fail('UPLOAD_INVALID');
  if(body.mrzConsent===undefined)return null;const consent=body.mrzConsent;
  if(!consent||typeof consent!=='object'||Array.isArray(consent)||Object.keys(consent).some(key=>!['accepted','policySha256'].includes(key))||typeof consent.accepted!=='boolean'||consent.policySha256!==undefined&&!SHA.test(consent.policySha256))fail('UPLOAD_INVALID');
  return consent;
 })()]);}catch(error){if(STATUS[error?.code])throw error;fail('UPLOAD_INVALID');}finally{clearTimeout(timer);}
}

class VisaUploadService{
 constructor({store,mediaStore,documentIntake,inbox,env=process.env,now=Date.now,onComplete=()=>{},whatsappNumber,mrzConsentOptions,mrzConsents,onConsentRevoked=()=>{}}={}){
  if(!store?.data||typeof store.save!=='function'||!mediaStore||typeof inbox?.isHumanOwned!=='function'||typeof onComplete!=='function'||typeof onConsentRevoked!=='function')throw Error('UPLOAD_CONFIG_INVALID');
  Object.assign(this,{store,mediaStore,documentIntake,inbox,env,now,onComplete,mrzConsentOptions,mrzConsents,onConsentRevoked});this.origin=originFor(env);this.locks=new Map();
  // Open the configured business chat with an ordinary follow-up drafted.
  // The customer still presses Send in WhatsApp; no case data or link token
  // enters the return URL, and this text never supplies application consent.
  const n=whatsappNumber||env.RAAD_DOCUMENT_UPLOAD_WHATSAPP_NUMBER;this.whatsappUrl=typeof n==='string'&&/^\+?[1-9]\d{6,14}$/.test(n)?'https://wa.me/'+n.replace(/^\+/,'')+'?text='+encodeURIComponent(RETURN_TEXT):null;
  store.data.visaUpload||={version:1,sessions:{}};if(store.data.visaUpload.version!==1||!store.data.visaUpload.sessions)throw Error('UPLOAD_CONFIG_INVALID');
 }
 get data(){return this.store.data.visaUpload;}
 currentCase(customer){const c=this.store.data.visaCases?.[customer];if(!validCustomer(customer)||!c||typeof c.id!=='string'||!c.id||c.pendingAmendment||c.submissionStatus==='submitted')fail('UPLOAD_STALE');return c;}
 consentOption(){
  try{const value=typeof this.mrzConsentOptions==='function'?this.mrzConsentOptions():null;
   if(this.mrzConsents?.healthy===false||value?.available!==true||value.provider!=='openai'||!SHA.test(value.readerFingerprint||'')||!SHA.test(value.policySha256||'')||value.inputPolicy!=='upright_page_internal_mrz_crop_v1'||typeof this.mrzConsents?.grantUpload!=='function')return null;
   return{available:true,provider:'openai',readerFingerprint:value.readerFingerprint,inputPolicy:value.inputPolicy,policySha256:value.policySha256,description:MRZ_CONSENT_DESCRIPTION};
  }catch{return null;}
 }
 cancelConsent(session){try{this.mrzConsents?.revokeSession?.(session?.id);}catch{}}
 guard(session,{open=false}={}){
  if(!session||this.data.sessions[session.id]!==session)fail('UPLOAD_UNAUTHORIZED');
  if(session.expiresAt<=this.now()){this.cancelConsent(session);fail('UPLOAD_EXPIRED');}
  let c;try{c=this.currentCase(session.customer);}catch(error){this.cancelConsent(session);throw error;}if(c.id!==session.caseId||visaCaseSignature(c)!==session.caseSignature){this.cancelConsent(session);fail('UPLOAD_STALE');}
  if(this.inbox.isHumanOwned(session.customer)||this.inbox.isBlocked?.(session.customer)){this.cancelConsent(session);fail('UPLOAD_PAUSED');}
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
 hasSessionConsent(s,includeRevoked=false){try{return this.mrzConsents?.hasSessionConsent?.(s.id,{includeRevoked})===true;}catch{return false;}}
 canRevoke(s){return typeof this.mrzConsents?.revokeSession==='function'&&Boolean(this.consentOption()||this.hasSessionConsent(s,true));}
 view(s){const mrzConsent=s.state==='open'?this.consentOption():null;return{ok:true,state:s.state,expiresAt:s.expiresAt,maxBytes:MAX_BYTES,limits:LIMITS,files:s.files.filter(x=>!x.withdrawn).map(({id,role,mimeType,size,clientKey})=>({id,role,mimeType,size,clientKey})),...(this.whatsappUrl?{whatsappUrl:this.whatsappUrl}:{}),...(mrzConsent?{mrzConsent}:{}),...(s.state==='completed'&&this.hasSessionConsent(s)?{mrzConsentRevocable:true}:{})};}
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
 async complete(session,consent=null){
  this.guard(session);if(session.state==='completed')return this.view(session);this.guard(session,{open:true});const mediaIds=session.files.filter(x=>!x.withdrawn).map(x=>x.id);if(!mediaIds.length)fail('UPLOAD_EMPTY');
  const option=this.consentOption();
  const accepted=session.mrzConsentDenied!==true&&consent?.accepted===true&&option&&consent.policySha256===option.policySha256;
  session.state='completed';session.completedAt=this.now();
  // The completed state is persisted with media activation. A retry never adds
  // consent, including after an interrupted or ambiguous consent write.
  try{this.mediaStore.activateUploads(session.customer,{sessionId:session.id,mediaIds,guard:()=>this.guard(session)});}catch(error){session.state='open';delete session.completedAt;if(accepted)session.mrzConsentDenied=true;throw error;}
  // Committing files implies no payment, application consent or government
  // submission. The separate optional MRZ consent is captured below. Intake
  // can recover the originals if the callback or process is interrupted.
  let mrzConsent;
  if(accepted){
   mrzConsent={};
   try{this.guard(session);const sources=mediaIds.map(id=>{this.mediaStore.get(id,{customer:session.customer});return this.mediaStore.records?.[id]||this.store.data.visaMedia?.[id];});
    mrzConsent=this.mrzConsents.grantUpload({customer:session.customer,caseId:session.caseId,caseSignature:session.caseSignature,sources,sessionId:session.id,expiresAt:session.expiresAt,provider:'openai',readerFingerprint:option.readerFingerprint,inputPolicy:option.inputPolicy,policySha256:option.policySha256});
    if(!mrzConsent||typeof mrzConsent!=='object'||typeof mrzConsent.then==='function')throw Error();this.guard(session);
   }catch{this.cancelConsent(session);mrzConsent={};}
  }
  try{this.guard(session);await this.onComplete({customer:session.customer,mediaIds:[...mediaIds],sessionId:session.id,...(mrzConsent?{mrzConsent}:{})});}catch{}
  this.guard(session);return this.view(session);
 }
 async revokeConsent(session,request){
  this.guard(session);await readCompletion(request,{revoke:true});this.guard(session);
  let revoked;try{revoked=this.mrzConsents.revokeSession(session.id);}catch{fail('UPLOAD_STORAGE_UNAVAILABLE');}
  if(revoked)try{await this.onConsentRevoked({customer:session.customer,sessionId:session.id});}catch{}
  this.guard(session);return this.view(session);
 }
 prune(){let changed=false;for(const [id,s]of Object.entries(this.data.sessions)){if(!s||s.expiresAt<=this.now()||!this.store.data.visaCases?.[s.customer]||this.store.data.visaCases[s.customer].id!==s.caseId){this.cancelConsent(s);delete this.data.sessions[id];changed=true;}}if(changed)this.store.save();}
 deleteCustomer(customer){let changed=false;for(const [id,s]of Object.entries(this.data.sessions))if(s.customer===customer){this.cancelConsent(s);delete this.data.sessions[id];changed=true;}if(changed)this.store.save();}
 async handleRequest(request,response,url){
  if(url.pathname!=='/api/visa-upload'&&!url.pathname.startsWith('/api/visa-upload/'))return false;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
  const reply=(status,data)=>response.writeHead(status,headers).end(JSON.stringify(data));
  try{
   const origin=request.headers.origin,site=request.headers['sec-fetch-site'];if(origin&&origin!==this.origin||site==='cross-site')fail('UPLOAD_ORIGIN_INVALID');
   const session=this.authenticate(request);let result;
   if(url.pathname==='/api/visa-upload/session'&&request.method==='GET')result=this.view(session);
   else if(url.pathname==='/api/visa-upload/files'&&request.method==='POST')result=await this.serial(session,()=>this.upload(session,request));
   else if(url.pathname==='/api/visa-upload/complete'&&request.method==='POST')result=await this.serial(session,async()=>{const consent=this.consentOption()?await readCompletion(request):null;this.guard(session);return this.complete(session,consent);});
   else if(url.pathname==='/api/visa-upload/mrz-consent/revoke'&&request.method==='POST'&&this.canRevoke(session))result=await this.serial(session,()=>this.revokeConsent(session,request));
   else if(url.pathname.startsWith('/api/visa-upload/files/')&&request.method==='DELETE'){const id=url.pathname.slice('/api/visa-upload/files/'.length);result=await this.serial(session,()=>this.remove(session,id));}
   else{reply(405,{ok:false,error:'UPLOAD_METHOD_INVALID'});return true;}
   reply(200,result);
  }catch(error){let code=error?.code||error?.message;const mediaErrors={MEDIA_UNSUPPORTED:'UPLOAD_TYPE_INVALID',MEDIA_SIZE_INVALID:'UPLOAD_TOO_LARGE',MEDIA_CONTENT_INVALID:'UPLOAD_CONTENT_INVALID',MEDIA_CAPACITY_REACHED:'UPLOAD_LIMIT',MEDIA_STORAGE_UNAVAILABLE:'UPLOAD_STORAGE_UNAVAILABLE',MEDIA_NOT_FOUND:'UPLOAD_NOT_FOUND',MEDIA_INVALID:'UPLOAD_INVALID',MEDIA_RECEIVE_CANCELLED:'UPLOAD_STALE'};code=mediaErrors[code]||code;if(!Object.hasOwn(STATUS,code))code='UPLOAD_UNAVAILABLE';reply(STATUS[code],{ok:false,error:code});}
  return true;
 }
}
module.exports={VisaUploadService,UPLOAD_TTL_MS:TTL,UPLOAD_LIMITS:LIMITS};
