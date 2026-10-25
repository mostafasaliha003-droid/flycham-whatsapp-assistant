'use strict';
const {stageFromCode,safeJob}=require('./portal-monitor');
const ORIGINS=new Set(['https://agents.airarabia.com','https://reservations.flycham.com']);
const PREVIEW_STAGES=new Set(['search_form','flights','seats','meals','baggage','pricing']);
const SENSITIVE='input[type="password"]:visible, #userOtp:visible, #captcha_txt:visible, #username_txt:visible, input[id*="FirstName" i]:visible, input[id*="LastName" i]:visible, input[name*="surname" i]:visible, input[name*="FOID" i]:visible, input[id*="DOB" i]:visible, input[name*="passport" i]:visible, input[autocomplete="one-time-code"]:visible, input[autocomplete^="cc-"]:visible, input[id*="cardNumber" i]:visible, input[name*="creditCard" i]:visible, input[name*="cvv" i]:visible';
const MARKERS='#fAirport:visible, #tblOutboundFlights:visible, #tblInboundFlights:visible, [id^="tdSeat_"]:visible, #imgTab_2:visible, [id^="tdAnciSeg_"]:visible, #divFQTxnCurr:visible';
const PII=/@|\+?\d[\d ()-]{8,}|passport|password|\bPNR\b|\bTEST\b|\bQUOTE\b|passenger\s*(?:name|details)|first\s*name|last\s*name|sur\s*name|date\s*of\s*birth|رقم الجواز|كلمة المرور|رمز التحقق|اسم المسافر/i;
function trustedURL(target,origin){try{const u=new URL(target.url());return ORIGINS.has(u.origin)&&(!origin||u.origin===origin)&&u.pathname.startsWith('/xbe/')&&!/showLogin|sendOTP|verification|j_security_check/i.test(u.pathname);}catch{return false;}}

// Only the body of an identified trusted search/results frame is captured.
// A full-page screenshot could include account headers or unrelated frames.
// Nested documents, every input and identifier-like visible text are masked.
async function captureRedactedPreview(adapter,stage){
 if(!PREVIEW_STAGES.has(stage)||typeof adapter?.isAuthenticated!=='function')return null;
 try{
  if(!await adapter.isAuthenticated())return null;
  const page=adapter.page;if(!page||page.isClosed?.()||!trustedURL(page))return null;
  const origin=new URL(page.url()).origin;
  const offered=[adapter.searchFrame,...(typeof adapter.searchFrames==='function'?adapter.searchFrames():[]),...(page.frames?.()||[])].filter(Boolean);
  const candidates=[...new Set(offered)];
  for(const frame of candidates){
   if(frame.isDetached?.()||!trustedURL(frame,origin))continue;
   const owner=typeof frame.page==='function'?frame.page():page;
   if(owner!==page||owner.isClosed?.()||!trustedURL(owner,origin))continue;
   // A retained results frame must never be used as a fallback for an active
   // passenger or verification screen in the adapter's selected document.
   if(await frame.locator(SENSITIVE).count()){if(frame===adapter.searchFrame)return null;continue;}
   if(!await frame.locator(MARKERS).count())continue;
   const body=frame.locator('body');if(!await body.isVisible())continue;
   const mask=[frame.locator('input,textarea,select,[contenteditable],iframe,frame,object,embed'),frame.getByText(PII)];
   const bytes=await body.screenshot({type:'jpeg',quality:45,scale:'css',mask,maskColor:'#142536',timeout:1800,animations:'disabled',caret:'hide'});
   // Recheck after capture in case a navigation or a challenge replaced it.
   if(adapter.page!==page||page.isClosed?.()||!trustedURL(page,origin)||!trustedURL(frame,origin)||await frame.locator(SENSITIVE).count())return null;
   if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>500000||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return null;
   return {jpeg:bytes.toString('base64'),redacted:true};
  }
 }catch{}
 return null;
}

function installPortalObserver(session,{provider,publish,now=Date.now,capture=captureRedactedPreview,intervalMs=3000}={}){
 const adapter=session?.adapter;
 if(!adapter||!['airarabia','flycham'].includes(provider)||typeof publish!=='function')return {job(){},event(){},async finish(){},async flush(){},async stop(){}};
 let stage='idle',activeJob=null,lastAt=-Infinity,busy=false,stopped=false,version=0,dirty=false,work=Promise.resolve(),metadataConfirmed=false,previewConfirmed=false;
 const original=adapter.report;
 const proof=code=>{try{if(typeof original==='function')original.call(adapter,(provider==='flycham'?'FLYCHAM_':'')+code);}catch{}};
 const interval=Math.max(3000,Math.min(30000,Number(intervalMs)||3000));
 const health=()=>session.healthStatus?.()||{state:session.isReady?.()?'ready':'unavailable'};
 const isReady=()=>!session.closed&&!session.authBlocked&&session.isReady?.()===true;
 const snapshot=()=>({provider,state:health().state,ready:isReady(),stage,activeJob:activeJob?structuredClone(activeJob):null});
 const flush=(force=false)=>{
  if(stopped)return Promise.resolve();
  if(busy){dirty=true;return force?work.then(()=>flush(true)):work;}
  if(!force&&now()-lastAt<interval)return Promise.resolve();
  busy=true;lastAt=now();dirty=false;const revision=version,view=snapshot();
  work=(async()=>{
   try{
    let preview=view.ready&&view.activeJob&&PREVIEW_STAGES.has(view.stage)?await capture(adapter,view.stage):null;
    if(stopped)return;
    // A late capture must not be paired with a different job or leak the last
    // search screen while authentication/passenger preparation is underway.
    const current=snapshot();
    if(revision!==version||!current.ready||!current.activeJob||!PREVIEW_STAGES.has(current.stage))preview=null;
    const result=await publish({...current,preview,previewWithheld:!preview});
    if(result?.accepted===true){
     if(!metadataConfirmed){metadataConfirmed=true;proof('PORTAL_MONITOR_PUBLISH_CONFIRMED');}
     if(preview&&!previewConfirmed){previewConfirmed=true;proof('PORTAL_MONITOR_PREVIEW_PUBLISHED');}
    }
   }catch{}finally{busy=false;}
  })();
  return work;
 };
 const event=code=>{const next=stageFromCode(code);if(next&&next!==stage){stage=next;version++;dirty=true;}return next;};
 const wrapped=code=>{try{if(typeof original==='function')original.call(adapter,code);}catch{}const next=event(code);flush(next==='authentication'||next==='unavailable'||next==='passengers').catch(()=>{});};
 adapter.report=wrapped;
 const timer=setInterval(()=>{if(dirty||now()-lastAt>=interval)flush().catch(()=>{});},interval);timer.unref?.();
 return {
  job(job){activeJob=safeJob(job);stage=activeJob?'search_form':'idle';version++;dirty=true;return flush(true);},
  event,
  async finish({authentication=false}={}){activeJob=null;stage=authentication?'authentication':'completed';version++;dirty=true;await flush(true);},
  flush,
  async stop(){if(stopped)return;stopped=true;version++;clearInterval(timer);if(adapter.report===wrapped)adapter.report=original;await work.catch(()=>{});try{await publish({provider,state:'closed',ready:false,stage:'unavailable',activeJob:null,preview:null,previewWithheld:true});}catch{}}
 };
}
module.exports={captureRedactedPreview,installPortalObserver};
