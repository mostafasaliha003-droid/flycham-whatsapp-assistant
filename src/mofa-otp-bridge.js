'use strict';
// Standalone bridge; shared-service wiring/review required before deployment.
// No mail contents, codes, OAuth data or errors are logged by this module.
const crypto=require('node:crypto');
const ROOT='/internal/gmail/mofa-otp',WINDOW=120000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validEmail(v){return typeof v==='string'&&v.length<=254&&/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v);}
function inspectMofaMessage(message,{recipient,requestedAt,now=Date.now()}={}){
 if(!validEmail(recipient))return {code:null,rejection:'recipient'};
 const at=Number(message?.internalDate);if(!Number.isFinite(at)||at<requestedAt||at>now+5000||now-at>WINDOW)return {code:null,rejection:'freshness'};
 const headers=message.payload?.headers||[],h=name=>headers.filter(x=>String(x.name).toLowerCase()===name).map(x=>String(x.value||''));
 const sender=h('from');if(sender.length!==1||!/^\s*(?:[^<>]*<)?no-reply@mofa\.gov\.sa>?\s*$/i.test(sender[0]))return {code:null,rejection:'sender'};
 const auth=h('authentication-results').find(v=>/^mx\.google\.com;/i.test(v));
 if(!auth||!/(?:dkim=pass[^;]*header\.(?:i|d)=(?:@)?(?:[a-z0-9-]+\.)*mofa\.gov\.sa(?=[\s;]|$)|dmarc=pass[^;]*header\.from=(?:[a-z0-9-]+\.)*mofa\.gov\.sa(?=[\s;]|$))/i.test(auth))return {code:null,rejection:'auth'};
 const recipients=h('to').join(' ').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[];
 if(!recipients.some(v=>v.toLowerCase()===recipient.toLowerCase()))return {code:null,rejection:'recipient'};
 function body(p){return (['text/plain','text/html'].includes(p?.mimeType)&&p.body?.data?Buffer.from(p.body.data,'base64url').toString('utf8'):'')+' '+(p?.parts||[]).map(body).join(' ');}
 const text=body(message.payload).replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ');
 if(!/(?:verification\s*code|one[-\s]time\s*(?:code|password)|رمز\s*(?:التحقق|التأكيد|التفعيل)|كود\s*(?:التحقق|التأكيد|التفعيل))/i.test(text))return {code:null,rejection:'template'};
 const codes=[...new Set([...text.matchAll(/\b[0-9]{6}\b/g)].map(m=>m[0]))];return codes.length===1?{code:codes[0],rejection:null}:{code:null,rejection:'ambiguousCode'};
}
function extractMofaCode(message,options){return inspectMofaMessage(message,options).code;}
const DIAGNOSTIC_REASONS=new Set(['LIST_EMPTY','USED_ONLY','NO_MATCH','AMBIGUOUS','MAIL_UNAVAILABLE','CANCELLED','EXPIRED','DELIVERED']);
const REJECTION_KEYS=['freshness','sender','auth','recipient','template','ambiguousCode'];
const emptyDiagnostic=()=>({reason:'NO_MATCH',checkedCount:0,matchedCount:0,rejections:Object.fromEntries(REJECTION_KEYS.map(key=>[key,0]))});
function createMofaOtpBridge({gmail,env=process.env,now=Date.now}={}){
 if(!gmail)throw Error('GMAIL_REQUIRED');let challenge=null,minNext=0;const seen=new Map();
 const keyConfigured=()=>typeof env.RAAD_MOFA_OTP_BRIDGE_KEY==='string'&&env.RAAD_MOFA_OTP_BRIDGE_KEY.length>=32;
 const configured=()=>env.RAAD_MOFA_OTP_ENABLED==='true'&&validEmail(env.RAAD_MOFA_OTP_RECIPIENT)&&keyConfigured();
 const recipient=()=>String(env.RAAD_MOFA_OTP_RECIPIENT||'').toLowerCase();
 const accountMatches=account=>validEmail(account)&&account.toLowerCase()===recipient();
 function status(){let gmailConfigured=false,gmailConnected=false;try{gmailConfigured=gmail.configured()===true;if(gmailConfigured)gmailConnected=Boolean(gmail.read().refreshToken);}catch{}return {enabled:env.RAAD_MOFA_OTP_ENABLED==='true',recipientConfigured:validEmail(env.RAAD_MOFA_OTP_RECIPIENT),gmailConfigured,gmailConnected};}
 function bind({requestedAt,challengeId,account}){
  if(!configured()||!accountMatches(account)||!Number.isFinite(requestedAt)||!UUID.test(challengeId||'')||requestedAt>now()+5000||now()-requestedAt>WINDOW)throw Error('CHALLENGE_INVALID');
  for(const [id,record]of seen)if(record.expires<now()-5000)seen.delete(id);
  if(seen.has(challengeId)&&seen.get(challengeId)!==challenge){const old=seen.get(challengeId);if(old.requestedAt!==requestedAt)throw Error('CHALLENGE_INVALID');return {...old,terminal:true};}
  if(challenge&&challenge.id===challengeId){if(challenge.requestedAt!==requestedAt)throw Error('CHALLENGE_INVALID');return challenge;}
  if(challenge&&challenge.expires>now()&&!challenge.terminal)throw Error('CHALLENGE_BUSY');
  if(challenge&&challenge.expires<=now())minNext=Math.max(minNext,challenge.expires);
  if(requestedAt<=minNext)throw Error('CHALLENGE_INVALID');
  challenge={id:challengeId,requestedAt,expires:requestedAt+WINDOW,terminal:false,controller:new AbortController(),lastDiagnostic:emptyDiagnostic()};seen.set(challengeId,challenge);return challenge;
 }
 function end(c,reason='MAIL_UNAVAILABLE'){if(!c.terminal)c.lastDiagnostic.reason=DIAGNOSTIC_REASONS.has(reason)?reason:'MAIL_UNAVAILABLE';c.terminal=true;c.controller.abort();minNext=Math.max(minNext,now());}
 function diagnostics(challengeId){const c=UUID.test(challengeId||'')?seen.get(challengeId):null,d=c?.lastDiagnostic||emptyDiagnostic();const expired=!c||c.expires<=now();const reason=d.reason==='DELIVERED'?'DELIVERED':expired?'EXPIRED':DIAGNOSTIC_REASONS.has(d.reason)?d.reason:'NO_MATCH';return {state:reason==='DELIVERED'?'delivered':expired||c.terminal?'stopped':'waiting',reason,checkedCount:Math.max(0,Math.min(3,Math.trunc(d.checkedCount)||0)),matchedCount:Math.max(0,Math.min(3,Math.trunc(d.matchedCount)||0)),rejections:Object.fromEntries(REJECTION_KEYS.map(key=>[key,Math.max(0,Math.min(3,Math.trunc(d.rejections?.[key])||0))]))};}
 function active(c){return c===challenge&&!c.terminal&&c.expires>now();}
 async function poll(data){
  const c=bind(data);if(!active(c))return null;
  const task=Promise.resolve(gmail.lock).catch(()=>{}).then(async()=>{
   if(!active(c))return null;
   c.lastDiagnostic=emptyDiagnostic();
   const deadline=now()+15000,budget=new AbortController();
   const timer=setTimeout(()=>{budget.abort();end(c,'MAIL_UNAVAILABLE');},15000);timer.unref?.();
   const working=()=>{if(!c.terminal){if(c.expires<=now())end(c,'EXPIRED');else if(now()>=deadline)end(c,'MAIL_UNAVAILABLE');}return active(c)&&!budget.signal.aborted;};
   async function readJson(url,headers){
    if(!working())throw Error('POLL_ENDED');
    const ms=Math.max(1,Math.min(5000,deadline-now()));
    const response=await gmail.fetch(url,{headers,redirect:'error',signal:AbortSignal.any([c.controller.signal,budget.signal,AbortSignal.timeout(ms)])});
    if(!working()||!response.ok)throw Error('GMAIL_UNAVAILABLE');
    const value=await response.json();if(!working())throw Error('POLL_ENDED');return value;
   }
   try{
    const state=gmail.read();if(!state.refreshToken)throw Error('GMAIL_UNAVAILABLE');
    const token=await gmail.accessToken();if(!working())return null;
    const headers={Authorization:'Bearer '+token},q='from:(no-reply@mofa.gov.sa) to:('+recipient()+') after:'+Math.floor(c.requestedAt/1000);
    const list=await readJson('https://gmail.googleapis.com/gmail/v1/users/me/messages?'+new URLSearchParams({q,maxResults:'3'}),headers);
    if(list.nextPageToken||(list.messages||[]).length>3){end(c,'AMBIGUOUS');return null;}
    if(!(list.messages||[]).length){c.lastDiagnostic.reason='LIST_EMPTY';return null;}
    const matches=[];let usedCount=0;
    for(const item of list.messages||[]){
     if(!working())return null;if(!item.id)continue;if(state.used?.includes(item.id)){usedCount++;continue;}
     const msg=await readJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(item.id)+'?format=full',headers);
     c.lastDiagnostic.checkedCount=Math.min(3,c.lastDiagnostic.checkedCount+1);const examined=inspectMofaMessage(msg,{recipient:recipient(),requestedAt:c.requestedAt,now:now()});if(examined.code){matches.push({id:item.id,code:examined.code});c.lastDiagnostic.matchedCount=Math.min(3,matches.length);}else if(REJECTION_KEYS.includes(examined.rejection))c.lastDiagnostic.rejections[examined.rejection]=Math.min(3,c.lastDiagnostic.rejections[examined.rejection]+1);
    }
    if(matches.length>1){end(c,'AMBIGUOUS');return null;}if(matches.length!==1){c.lastDiagnostic.reason=usedCount===(list.messages||[]).length?'USED_ONLY':'NO_MATCH';return null;}if(!working())return null;
    state.used=[...new Set([...(state.used||[]),matches[0].id])].slice(-100);gmail.write(state);end(c,'DELIVERED');return matches[0].code;
   }catch{end(c,'MAIL_UNAVAILABLE');return null;}finally{clearTimeout(timer);}
  });
  // Keep the shared write lock until all work has actually settled. The budget
  // aborts network operations; we never race/release the lock over background IO.
  gmail.lock=task.then(()=>{},()=>{});return task;
 }
 function cancel({requestedAt,challengeId,account}){if(!accountMatches(account)||!challenge||challenge.id!==challengeId||challenge.requestedAt!==requestedAt)return false;end(challenge,'CANCELLED');return true;}
 function authorized(value){if(!keyConfigured())return false;const a=Buffer.from('Bearer '+env.RAAD_MOFA_OTP_BRIDGE_KEY),b=Buffer.from(typeof value==='string'?value:'');return a.length===b.length&&crypto.timingSafeEqual(a,b);}
 async function handler(req,res,url,{readBody}={}){
  if(![ROOT,ROOT+'/cancel',ROOT+'/status'].includes(url.pathname))return false;
  const send=(code,obj)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
  if(!authorized(req.headers.authorization)){send(401,{error:'UNAUTHORIZED'});return true;}
  if(url.search||url.hash){send(400,{error:'INVALID_REQUEST'});return true;}
  if(url.pathname===ROOT+'/status'){
   if(req.method==='GET')send(200,status());
   else if(req.method==='POST'){try{const bytes=await readBody(req);if(bytes.length>1024)throw Error();const assertion=JSON.parse(bytes.toString());if(!assertion||Array.isArray(assertion)||Object.keys(assertion).length!==1||typeof assertion.account!=='string')throw Error();send(200,{...status(),accountMatchesRecipient:accountMatches(assertion.account)});}catch{send(400,{error:'INVALID_REQUEST'});}}
   else send(400,{error:'INVALID_REQUEST'});return true;
  }
  if(req.method!=='POST'){send(400,{error:'INVALID_REQUEST'});return true;}
  if(!configured()){send(401,{error:'UNAUTHORIZED'});return true;}
  let data;
  const disconnected=()=>{if(data)cancel(data);};
  const responseClosed=()=>{if(!res.writableEnded)disconnected();};
  req.on?.('aborted',disconnected);res.on?.('close',responseClosed);
  try{const bytes=await readBody(req);if(bytes.length>1024)throw Error();data=JSON.parse(bytes.toString());if(req.aborted||res.destroyed){disconnected();return true;}if(url.pathname===ROOT+'/cancel')send(200,{cancelled:cancel(data)});else {const code=await poll(data);send(200,{code,...diagnostics(data.challengeId)});}}catch{send(503,{error:'MOFA_OTP_UNAVAILABLE',code:null,...diagnostics(data?.challengeId)});}finally{req.removeListener?.('aborted',disconnected);res.removeListener?.('close',responseClosed);}return true;
 }
 return {poll,cancel,handler,status,diagnostics};
}
module.exports={extractMofaCode,createMofaOtpBridge};
