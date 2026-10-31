'use strict';
// LOCAL SYNTHETIC LAB ONLY. There is deliberately no credential loader or Meta sender.
const crypto=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const EXPECTED_FREEZE_SHA256='dc33bc9ce880ae446729cda9a6232f34b19a9045f9497206cf7c2c1e838536da';
function verifyApprovedSource({source,freeze}={}){
 if(typeof source!=='string'||!path.isAbsolute(source)||typeof freeze!=='string'||!path.isAbsolute(freeze))fail('LAB_EXPLICIT_SOURCE_AND_FREEZE_REQUIRED');
 let canonical,manifest,raw;
 try{canonical=fs.realpathSync(source);freeze=fs.realpathSync(freeze);if(!fs.statSync(canonical).isDirectory())fail('LAB_SOURCE_FREEZE_INVALID');raw=fs.readFileSync(freeze);manifest=JSON.parse(raw);}catch{fail('LAB_SOURCE_FREEZE_INVALID');}
 if(crypto.createHash('sha256').update(raw).digest('hex')!==EXPECTED_FREEZE_SHA256||manifest.candidateTree!=='036355159f736467891c29ec6383b928ae4b6d2d'||Object.keys(manifest.files||{}).length!==445)fail('LAB_SOURCE_FREEZE_INVALID');
 for(const [name,record]of Object.entries(manifest.files)){
  if(path.isAbsolute(name)||name.split('/').includes('..'))fail('LAB_SOURCE_FREEZE_INVALID');
  const file=path.join(canonical,name);let stat,bytes;try{stat=fs.lstatSync(file);bytes=fs.readFileSync(file);}catch{fail('LAB_SOURCE_FREEZE_CHANGED');}
  if(!stat.isFile()||stat.isSymbolicLink()||bytes.length!==record.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==record.sha256||(stat.mode&0o111?'100755':'100644')!==record.mode)fail('LAB_SOURCE_FREEZE_CHANGED');
 }
 return Object.freeze({source:canonical,freeze,manifest});
}
function contracts(source,freeze){const approved=verifyApprovedSource({source,freeze});return {...require(path.join(approved.source,'src/whatsapp.js')),...require(path.join(approved.source,'src/visa-sms-challenge.js'))};}
const OWNER='971507993145',MODE='local_synthetic',REAL_META_ENABLED=false;
const FORBIDDEN_ENV=/^(?:WHATSAPP_|OPENAI_|GEMINI_|CLINE_|BRAVE_|TINYFISH_|RAAD_(?:MAIN_URL|JOB_BRIDGE_KEY|MOFA_|BROWSER_WORKER_URL)|ASSISTANT_STATE_(?:PATH|KEY))/;
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const fail=code=>{throw Object.assign(Error(code),{code,notDispatched:true});};
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(v);
const ALLOWED_ENV=new Set(['PATH','TMPDIR','LANG','TZ','NODE_ENV']);
function rejectContamination(env={}){if(!plain(env)||Object.keys(env).some(key=>!ALLOWED_ENV.has(key)||FORBIDDEN_ENV.test(key)))fail('LAB_CREDENTIAL_OR_PRODUCTION_CONFIG_FORBIDDEN');}
function createSessionGate({source,freeze,config={},environment={},now=Date.now}={}){
 rejectContamination(environment);
 if(!plain(config))fail('LAB_CONFIG_INVALID');
 const allowed=new Set(['enabled','mode','owner','dedicatedMetaTestSender','phoneNumberId','wabaId','syntheticSigningSecret','restoreState']);
 if(Object.keys(config).some(key=>!allowed.has(key)))fail('LAB_CONFIG_INVALID');
 if(own(config,'restoreState'))fail('LAB_RESTART_REQUIRES_NEW_SESSION');
 const enabled=config.enabled===true&&config.mode===MODE;
 if(config.enabled===true&&config.mode!==MODE)fail('LAB_MODE_INVALID');
 const {verifySignature,validateSmsChallenge,sameSmsChallenge}=enabled?contracts(source,freeze):{};
 let session=null,opened=false,status=enabled?'idle':'disabled';const messages=new Set();
 const meta=enabled?Object.freeze({owner:config.owner,phoneNumberId:config.phoneNumberId,wabaId:config.wabaId}):null;
 const secret=enabled?config.syntheticSigningSecret:null;
 if(enabled&&(config.owner!==OWNER||config.dedicatedMetaTestSender!==true||!/^\d{5,30}$/.test(config.phoneNumberId||'')||!/^\d{5,30}$/.test(config.wabaId||'')||typeof secret!=='string'||!secret.startsWith('synthetic-')||secret.length<24||secret.length>200))fail('LAB_DEDICATED_SYNTHETIC_CONFIG_REQUIRED');
 function scrub(){session?.code?.fill(0);}
 function binding(){if(!session)fail('LAB_NO_SESSION');return Object.freeze({sessionId:session.sessionId,jobId:session.jobId,caseSignature:session.caseSignature,applicantIndex:session.applicantIndex,...session.challenge});}
 function active(input){
  if(!enabled)fail('LAB_DISABLED');if(!session)fail('LAB_NO_SESSION');
  if(status!=='pending')fail(status==='expired'?'LAB_EXPIRED':'LAB_SINGLE_USE_OR_REPLAY');
  if(now()>=session.challenge.challengeExpiresAt){status='expired';scrub();fail('LAB_EXPIRED');}
  const expected=binding();if(!plain(input)||Object.keys(expected).some(key=>input[key]!==expected[key]))fail('LAB_SESSION_JOB_OR_CHALLENGE_MISMATCH');
 }
 function openSession(input={}){
  if(!enabled)fail('LAB_DISABLED');if(opened)fail('LAB_SINGLE_SESSION_ONLY');
  const {sessionId,jobId,caseSignature,applicantIndex,promptMessageId,code,...challenge}=input;
  if(!identifier(sessionId)||!identifier(jobId)||!/^[a-f0-9]{64}$/.test(caseSignature||'')||applicantIndex!==0||!identifier(promptMessageId)||typeof code!=='string'||!/^\d{4,8}$/.test(code))fail('LAB_SESSION_INVALID');
  const checked=validateSmsChallenge(challenge,now());
  session={sessionId,jobId,caseSignature,applicantIndex,promptMessageId,challenge:checked,code:Buffer.from(code)};opened=true;status='pending';return binding();
 }
 async function acceptWebhook({rawBody,signature,context}={},relay){
  active(context);
  if(typeof relay!=='function')fail('LAB_SYNTHETIC_RELAY_REQUIRED');
  if(!Buffer.isBuffer(rawBody)||rawBody.length<2||rawBody.length>24000||!verifySignature(rawBody,signature,secret))fail('LAB_SIGNATURE_INVALID');
  let payload;try{payload=JSON.parse(rawBody.toString());}catch{fail('LAB_WEBHOOK_INVALID');}
  const entry=payload?.entry,changes=entry?.[0]?.changes,value=changes?.[0]?.value,items=value?.messages;
  if(payload?.object!=='whatsapp_business_account'||!Array.isArray(entry)||entry.length!==1||entry[0].id!==meta.wabaId||!Array.isArray(changes)||changes.length!==1||changes[0].field!=='messages'||value?.messaging_product!=='whatsapp'||value?.metadata?.phone_number_id!==meta.phoneNumberId||!Array.isArray(items)||items.length!==1)fail('LAB_TEST_SENDER_METADATA_INVALID');
  const message=items[0];if(message.from!==meta.owner)fail('LAB_SENDER_INVALID');
  if(message.type!=='text'||!identifier(message.id)||message.context?.id!==session.promptMessageId||typeof message.text?.body!=='string')fail('LAB_REPLY_CONTEXT_INVALID');
  const stamp=Number(message.timestamp)*1000;if(!/^\d{1,12}$/.test(message.timestamp||'')||!Number.isSafeInteger(stamp)||stamp<session.challenge.challengeRequestedAt-1000||stamp>now()+1000)fail('LAB_MESSAGE_TIME_INVALID');
  if(messages.has(message.id))fail('LAB_SINGLE_USE_OR_REPLAY');messages.add(message.id);
  const supplied=Buffer.from(message.text.body);let accepted=false;
  try{accepted=/^\d{4,8}$/.test(message.text.body)&&equal(supplied,session.code);}finally{supplied.fill(0);message.text.body='';}
  if(!accepted){status='rejected';scrub();fail('LAB_CODE_INVALID');}
  status='consuming';scrub();
  const relayBody=Buffer.from(rawBody);try{
   const receipt=await relay({rawBody:relayBody,signature,binding:binding()});
   if(receipt?.accepted!==true||receipt.jobId!==session.jobId||!sameSmsChallenge(receipt,session.challenge))fail('LAB_RELAY_RECEIPT_UNCONFIRMED');
   status='consumed';return Object.freeze({accepted:true,jobId:session.jobId,challengeId:session.challenge.challengeId,syntheticOnly:true});
  }catch{status='uncertain';fail('LAB_RELAY_UNCONFIRMED_NO_RETRY');}finally{relayBody.fill(0);}
 }
 return Object.freeze({openSession,acceptWebhook,binding,restore(){fail('LAB_RESTART_REQUIRES_NEW_SESSION');},close(){scrub();status='closed';},snapshot:()=>Object.freeze({version:1,status,ephemeral:true,restorable:false,realMetaWired:false,governmentWired:false}),sendRealMeta(){if(!REAL_META_ENABLED)fail('LAB_REAL_META_NOT_AUTHORIZED');}});
}
function origin(value){try{const u=new URL(value);if(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&/^\d{1,5}$/.test(u.port)&&Number(u.port)>0&&Number(u.port)<=65535)return u.origin;}catch{}fail('LAB_ISOLATED_LOOPBACK_REQUIRED');}
function createLoopbackTransport({source,freeze,enabled=false,mainOrigin,workerOrigin,binding,fetchImpl,environment={},now=Date.now}={}){
 rejectContamination(environment);if(enabled!==true)return Object.freeze({request:async()=>fail('LAB_DISABLED'),status:()=>({enabled:false,realMetaWired:false,governmentWired:false})});
 const {validateSmsChallenge,sameSmsChallenge}=contracts(source,freeze);
 const main=origin(mainOrigin),worker=origin(workerOrigin);if(main===worker||!plain(binding)||!identifier(binding.jobId)||typeof fetchImpl!=='function')fail('LAB_TRANSPORT_CONFIG_INVALID');
 const fixed=Object.freeze({...binding});let otpUsed=false,startUsed=false;
 async function request(raw,options={}){
  let url;try{url=new URL(raw);}catch{fail('LAB_TRANSPORT_FORBIDDEN');}
  if(url.username||url.password||url.search||url.hash||url.pathname.includes('%')||![main,worker].includes(url.origin))fail('LAB_TRANSPORT_FORBIDDEN');
  const method=options.method||'GET',job='/internal/raad/jobs/'+fixed.jobId;
  const allowed=url.origin===main?(method==='GET'&&[ '/health','/internal/assistant/visa-portal/jobs/'+fixed.jobId+'/lease'].includes(url.pathname)||method==='POST'&&url.pathname==='/webhooks/whatsapp'):(method==='GET'&&['/health',job].includes(url.pathname)||method==='POST'&&['/internal/raad/jobs',job+'/otp',job+'/cancel'].includes(url.pathname));
  if(!allowed)fail('LAB_TRANSPORT_FORBIDDEN');
  if(options.headers&&(!plain(options.headers)||Object.entries(options.headers).some(([key,value])=>/^(?:cookie|proxy-authorization|x-api-key)$/i.test(key)||/^authorization$/i.test(key)&&!(typeof value==='string'&&value.startsWith('Bearer synthetic-')))))fail('LAB_CREDENTIAL_OR_PRODUCTION_CONFIG_FORBIDDEN');
  if(options.redirect!==undefined&&options.redirect!=='error')fail('LAB_REDIRECT_FORBIDDEN');
  if(method==='POST'&&url.origin===worker&&url.pathname!==job+'/cancel'){
   validateSmsChallenge(fixed,now());
   if(typeof options.body!=='string'||Buffer.byteLength(options.body)>4200000)fail('LAB_TRANSPORT_BODY_INVALID');
   let body;try{body=JSON.parse(options.body);}catch{fail('LAB_TRANSPORT_BODY_INVALID');}
   if(url.pathname==='/internal/raad/jobs'){
    if(startUsed)fail('LAB_SINGLE_USE_OR_REPLAY');
    if(body.jobId!==fixed.jobId||body.caseSignature!==fixed.caseSignature||body.applicantIndex!==fixed.applicantIndex)fail('LAB_SESSION_JOB_OR_CHALLENGE_MISMATCH');
    startUsed=true;
   }
   if(url.pathname===job+'/otp'){
    if(otpUsed)fail('LAB_SINGLE_USE_OR_REPLAY');
    if(!sameSmsChallenge(body,fixed)||typeof body.code!=='string'||!/^\d{4,8}$/.test(body.code))fail('LAB_SESSION_JOB_OR_CHALLENGE_MISMATCH');
    otpUsed=true;
   }
  }
  return fetchImpl(url.href,{...options,redirect:'error'});
 }
 return Object.freeze({request,status:()=>Object.freeze({enabled:true,syntheticOnly:true,realMetaWired:false,governmentWired:false})});
}
module.exports={verifyApprovedSource,createSessionGate,createLoopbackTransport,rejectContamination,OWNER,MODE,REAL_META_ENABLED};
