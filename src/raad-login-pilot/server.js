'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {findVerificationControls}=require('./verification-controls');
const LOGIN='https://visa.mofa.gov.sa/Account/Loginindividuals';
const SEL={username:'#myform #UserName',password:'#myform #Password',captcha:'#myform #Captcha',image:'#myform #imgCaptcha',submit:'#myform #btnSubmit'};
const TTL=12*60*1000;
function createPilot({env=process.env,launch,now=Date.now}={}) {
 const key=env.RAAD_PILOT_KEY||'',origin=env.RAAD_PILOT_ORIGIN||'';
 if(key.length<43||!/^https:\/\/[^/]+$/.test(origin))throw Error('PILOT_CONFIGURATION_REQUIRED');
 let job=null,busy=false,shutting=false,starts=[],lastOutcome=null;
 const equal=value=>{const b=Buffer.from(value||''),a=Buffer.from('Bearer '+key);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
 const headers={'Cache-Control':'no-store, private','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"};
 function reply(res,status,value,type='application/json'){res.writeHead(status,{...headers,'Content-Type':type});res.end(type==='application/json'?JSON.stringify(value):value);}
 async function boundedClose(browser){let timer;try{return await Promise.race([browser.close().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);}catch{return false;}finally{clearTimeout(timer);}}
 async function close(){const old=job;if(!old)return true;if(old.stage!=='closing'&&old.stage!=='cleanup_unconfirmed')lastOutcome=old.stage;old.stage='closing';clearTimeout(old.timer);try{if(!await boundedClose(old.browser))throw Error('CLEANUP_UNCONFIRMED');if(job===old)job=null;return true;}catch{old.stage='cleanup_unconfirmed';return false;}}
 function requireJob(id){if(!job||id!==job.id||job.expires<=now())throw Error('SESSION_UNAVAILABLE');return job;}
 async function guard(j){if(j!==job||j.expires<=now()||!j.browser.isConnected()||j.page.isClosed()||new URL(j.page.url()).origin!=='https://visa.mofa.gov.sa')throw Error('SESSION_UNAVAILABLE');}
 async function body(req){if(req.headers['content-type']!=='application/json')throw Error('INPUT_INVALID');let size=0,parts=[];for await(const p of req){size+=p.length;if(size>2048)throw Error('INPUT_INVALID');parts.push(p);}const value=JSON.parse(Buffer.concat(parts).toString('utf8'));parts=[];return value;}
 async function start(){if(job)throw Error('SESSION_EXISTS');starts=starts.filter(t=>t>now()-600000);if(starts.length>=3)throw Error('START_LIMIT');starts.push(now());
  const browser=await launch({headless:true,args:['--no-sandbox']});
  const j={id:crypto.randomBytes(24).toString('hex'),browser,page:null,stage:'starting',expires:now()+TTL};job=j;
  j.timer=setTimeout(()=>{void close();},TTL);j.timer.unref?.();
  try{const context=await browser.newContext();
   await context.route('**/*',route=>{const request=route.request(),u=new URL(request.url());if((request.isNavigationRequest()||!['GET','HEAD'].includes(request.method()))&&u.origin!=='https://visa.mofa.gov.sa')return route.abort();return route.continue();});
   j.page=await context.newPage();await j.page.goto(LOGIN,{waitUntil:'domcontentloaded',timeout:45000});await guard(j);
   for(const selector of Object.values(SEL)){const l=j.page.locator(selector);if(await l.count()!==1||!await l.isVisible())throw Error('FORM_UNAVAILABLE');}
   j.stage='awaiting_input';return {sessionId:j.id,stage:j.stage,expiresAt:j.expires};
  }catch{await close();throw Error('LOGIN_PAGE_UNAVAILABLE');}
 }
 const staticAssets=Object.create(null);for(const [route,file,type] of [['/','index.html','text/html; charset=utf-8'],['/app.js','app.js','text/javascript; charset=utf-8'],['/style.css','style.css','text/css; charset=utf-8']])staticAssets[route]=[fs.readFileSync(path.join(__dirname,file)),type];
 async function classify(j){await guard(j);const verification=await findVerificationControls(j.page);j.canVerify=Boolean(verification)&&!j.verificationAttempted;if(verification)return j.verificationAttempted?'verification_submitted':'verification_required';const loginVisible=await j.page.locator(SEL.password).isVisible().catch(()=>false);if(loginVisible)return 'login_not_completed';return 'result_unverified';}
 const server=http.createServer(async(req,res)=>{
  let url;try{url=new URL(req.url,'https://pilot.invalid');}catch{reply(res,400,{error:'INVALID_REQUEST'});return;}
  if(url.search||url.hash){reply(res,400,{error:'INVALID_REQUEST'});return;}
  if(req.method==='GET'&&url.pathname==='/health'){reply(res,200,{ready:!shutting});return;}
  if(req.method==='GET'&&staticAssets[url.pathname]){const [content,type]=staticAssets[url.pathname];reply(res,200,content,type);return;}
  const allowed=['/api/start','/api/image','/api/submit','/api/status','/api/close','/api/current','/api/verify'];
  if(!allowed.includes(url.pathname)){reply(res,404,{error:'NOT_FOUND'});return;}
  if(!equal(req.headers.authorization)){reply(res,401,{error:'UNAUTHORIZED'});return;}
  if(env.RAAD_DIRECT_LOGIN_ENABLED!=='true'||shutting){reply(res,503,{error:'DISABLED'});return;}
  if(req.method!=='POST'||req.headers.origin!==origin){reply(res,403,{error:'FORBIDDEN'});return;}
  if(busy){reply(res,409,{error:'BUSY'});return;}busy=true;
  try{
   if(url.pathname==='/api/start'){if(job){reply(res,409,{error:'SESSION_EXISTS'});}else reply(res,200,await start());}
   else if(url.pathname==='/api/current'){if(job&&job.expires<=now()&&!await close()){reply(res,200,{stage:'cleanup_unconfirmed'});}else if(job){if(['submitted_unverified','login_not_completed','verification_required','result_unverified','verification_submitted'].includes(job.stage)){await guard(job);job.stage=await classify(job);}reply(res,200,{sessionId:job.id,stage:job.stage,canVerify:job.canVerify===true,expiresAt:job.expires});}else reply(res,200,{stage:'no_session',lastOutcome});}
   else {const data=await body(req);const j=requireJob(data.sessionId);
    if(url.pathname==='/api/close'){reply(res,200,{closed:await close()});}
    else {await guard(j);
     if(url.pathname==='/api/status'){if(['submitted_unverified','login_not_completed','verification_required','result_unverified','verification_submitted'].includes(j.stage))j.stage=await classify(j);reply(res,200,{stage:j.stage,canVerify:j.canVerify===true,authenticated:false,expiresAt:j.expires});}
     else if(url.pathname==='/api/image'){if(j.stage!=='awaiting_input')throw Error('INVALID_STAGE');reply(res,200,await j.page.locator(SEL.image).screenshot({type:'png',timeout:10000}),'image/png');}
     else if(url.pathname==='/api/verify'){
      if(j.verificationAttempted||!['submitted_unverified','verification_required','result_unverified'].includes(j.stage))throw Error('INVALID_STAGE');
      const verification=await findVerificationControls(j.page);if(!verification)throw Error('VERIFICATION_FORM_UNAVAILABLE');
      if(typeof data.code!=='string'||!new RegExp('^[0-9]{4,'+verification.maxLength+'}$').test(data.code))throw Error('INPUT_INVALID');
      j.verificationAttempted=true;j.canVerify=false;
      try{await j.page.locator(verification.inputSelector).fill(data.code);data.code='';await guard(j);await j.page.locator(verification.buttonSelector).click({timeout:10000});j.stage='verification_submitted';reply(res,200,{stage:j.stage,submitted:true,canVerify:false,authenticated:false});}
      catch{data.code='';j.stage='verification_submitted';throw Error('VERIFICATION_UNCONFIRMED');}
     }
     else if(url.pathname==='/api/submit'){
      if(j.stage!=='awaiting_input')throw Error('INVALID_STAGE');
      if(typeof data.username!=='string'||!data.username.trim()||data.username.length>254||typeof data.password!=='string'||!data.password||data.password.length>256||typeof data.captcha!=='string'||!data.captcha.trim()||data.captcha.length>32)throw Error('INPUT_INVALID');
      j.stage='submitting';
      try{await j.page.locator(SEL.username).fill(data.username);await j.page.locator(SEL.password).fill(data.password);await j.page.locator(SEL.captcha).fill(data.captcha);data.username=data.password=data.captcha='';await guard(j);await j.page.locator(SEL.submit).click({timeout:10000});j.stage='submitted_unverified';reply(res,200,{stage:j.stage,submitted:true,authenticated:false});}
      catch{await close();throw Error('SUBMIT_UNAVAILABLE');}
     }
    }
   }
  }catch{reply(res,503,{error:'PILOT_UNAVAILABLE'});}finally{busy=false;}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 return {server,close,async shutdown(){shutting=true;await close();server.close();}};
}
if(require.main===module){const {chromium}=require('playwright');const pilot=createPilot({launch:options=>chromium.launch(options)});pilot.server.listen(process.env.PORT||10000,'0.0.0.0',async()=>{if(process.env.RAAD_PILOT_STARTUP_CHECK!=='true')return;let id;const outcome={pageReady:false,imageLoaded:false,closed:false};try{const base='http://127.0.0.1:'+pilot.server.address().port;const call=(action,data)=>fetch(base+'/api/'+action,{method:'POST',headers:{Authorization:'Bearer '+process.env.RAAD_PILOT_KEY,Origin:process.env.RAAD_PILOT_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(data||{}),signal:AbortSignal.timeout(60000)});const started=await call('start');if(!started.ok)throw Error();const result=await started.json();id=result.sessionId;outcome.pageReady=result.stage==='awaiting_input';const image=await call('image',{sessionId:id});const bytes=Buffer.from(await image.arrayBuffer());outcome.imageLoaded=image.ok&&image.headers.get('content-type')==='image/png'&&bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const stop=await call('close',{sessionId:id});outcome.closed=stop.ok&&(await stop.json()).closed===true;}catch{await pilot.close();}console.log('RAAD_STARTUP_CHECK '+JSON.stringify(outcome));});process.on('SIGTERM',()=>{void pilot.shutdown();setTimeout(()=>process.exit(0),5000).unref();});}
module.exports={createPilot};
