'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {findVerificationControls,getVerificationDiagnostics}=require('./verification-controls');
const {captureCaptcha}=require('./captcha-image');
const {getAccountSignals}=require('./account-signals');
const {openAccountMenu}=require('./account-menu');
const {credentialConfig,getCredentials}=require('./env-credentials');
const {otpConfig,validAccount,waitForMofaCode,mofaOtpHealth}=require('./mofa-otp-provider');
const {captchaConfig,captchaHealth,readCaptcha}=require('./captcha-provider');
const {inspectPortalPage}=require('./portal-inspection');
const {navigateObservedLink}=require('./portal-navigation');
const {fillPortalFields}=require('./portal-fill');
const {uploadPortalDocuments}=require('./portal-upload');
const {activatePortalButton}=require('./portal-button');
const {solvePortalCaptcha,checkPortalCaptcha}=require('./portal-captcha');
const {setPortalDates,verifyPortalDates}=require('./portal-dates');
const {inspectPortalConfirmation,activatePortalConfirmation}=require('./portal-confirmation');
const {lookupPortalCases}=require('./portal-case-lookup');
const {createNetworkDiagnostics}=require('./portal-network-diagnostics');
const {refreshPortalCaptcha}=require('./portal-captcha-refresh');
const LOGIN='https://visa.mofa.gov.sa/Account/Loginindividuals';
const SEL={username:'#myform #UserName',password:'#myform #Password',captcha:'#myform #Captcha',image:'#myform #imgCaptcha',submit:'#myform #btnSubmit'};
const TTL=12*60*1000;
function createPilot({env=process.env,launch,now=Date.now,otpFetch=fetch,captchaFetch=fetch}={}) {
 const key=env.RAAD_PILOT_KEY||'',origin=env.RAAD_PILOT_ORIGIN||'';
 if(key.length<43||!/^https:\/\/[^/]+$/.test(origin))throw Error('PILOT_CONFIGURATION_REQUIRED');
 let job=null,busy=false,shutting=false,starts=[],lastOutcome=null;
 const captchaAutomationAvailable=()=>credentialConfig(env).configured&&captchaConfig(env).enabled&&captchaConfig(env).configured;
 const automaticCaptcha=j=>captchaAutomationAvailable()&&!j?.automaticCaptchaAttempted;
 const automaticOtp=j=>credentialConfig(env).configured&&validAccount(env.RAAD_MOFA_USERNAME)&&otpConfig(env).enabled&&otpConfig(env).configured&&!j?.automaticOtpAttempted;
 const equal=value=>{const b=Buffer.from(value||''),a=Buffer.from('Bearer '+key);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
 const headers={'Cache-Control':'no-store, private','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"};
 function reply(res,status,value,type='application/json'){res.writeHead(status,{...headers,'Content-Type':type});res.end(type==='application/json'?JSON.stringify(value):value);}
 function applicationResult(j){if(!j?.applicationSubmissionDispatched)return {};try{const m=new URL(j.page.url()).pathname.match(/^\/SmartForm\/(PayFee|EditApplication|PrintApplication)\/([0-9]{1,20})$/i);return m?{applicationReference:m[2],paymentPage:/^PayFee$/i.test(m[1])}:{};}catch{return {};}}
 async function boundedClose(browser){let timer;try{return await Promise.race([browser.close().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);}catch{return false;}finally{clearTimeout(timer);}}
 async function close(){const old=job;if(!old)return true;if(old.stage!=='closing'&&old.stage!=='cleanup_unconfirmed')lastOutcome=old.stage;old.stage='closing';old.controller?.abort();old.networkDiagnostics?.stop();clearTimeout(old.timer);try{if(!await boundedClose(old.browser))throw Error('CLEANUP_UNCONFIRMED');if(job===old)job=null;return true;}catch{old.stage='cleanup_unconfirmed';return false;}}
 function requireJob(id){if(!job||id!==job.id||job.expires<=now())throw Error('SESSION_UNAVAILABLE');return job;}
 async function guard(j){if(j!==job||j.controller?.signal.aborted||j.expires<=now()||!j.browser.isConnected()||j.page.isClosed()||new URL(j.page.url()).origin!=='https://visa.mofa.gov.sa')throw Error('SESSION_UNAVAILABLE');}
 async function body(req,maxBytes=2048){if(req.headers['content-type']!=='application/json')throw Error('INPUT_INVALID');let size=0,parts=[];for await(const p of req){size+=p.length;if(size>maxBytes)throw Error('INPUT_INVALID');parts.push(p);}const value=JSON.parse(Buffer.concat(parts).toString('utf8'));parts=[];return value;}
 async function start(){if(job)throw Error('SESSION_EXISTS');starts=starts.filter(t=>t>now()-600000);if(starts.length>=3)throw Error('START_LIMIT');starts.push(now());
  const browser=await launch({headless:true,args:['--no-sandbox']});
  const j={id:crypto.randomBytes(24).toString('hex'),browser,page:null,controller:new AbortController(),captchaImages:new Set(),stage:'starting',expires:now()+TTL};job=j;
  j.timer=setTimeout(()=>{void close();},TTL);j.timer.unref?.();
  try{const context=await browser.newContext();
   await context.route('**/*',route=>{const request=route.request(),u=new URL(request.url());if((request.isNavigationRequest()||!['GET','HEAD'].includes(request.method()))&&u.origin!=='https://visa.mofa.gov.sa'){j.networkDiagnostics?.recordRouteAbort(request);return route.abort();}return route.continue();});
   j.page=await context.newPage();j.networkDiagnostics=createNetworkDiagnostics(j.page);await j.page.goto(LOGIN,{waitUntil:'domcontentloaded',timeout:45000});await guard(j);
   for(const selector of Object.values(SEL)){const l=j.page.locator(selector);if(await l.count()!==1||!await l.isVisible())throw Error('FORM_UNAVAILABLE');}
   j.stage='awaiting_input';return {sessionId:j.id,stage:j.stage,expiresAt:j.expires,credentialsFromEnvironment:credentialConfig(env).configured,automaticOtp:automaticOtp(j),automaticCaptcha:automaticCaptcha(j),captchaAutomationAvailable:captchaAutomationAvailable()};
  }catch{await close();throw Error('LOGIN_PAGE_UNAVAILABLE');}
 }
 const staticAssets=Object.create(null);for(const [route,file,type] of [['/','index.html','text/html; charset=utf-8'],['/app.js','app.js','text/javascript; charset=utf-8'],['/style.css','style.css','text/css; charset=utf-8']])staticAssets[route]=[fs.readFileSync(path.join(__dirname,file)),type];
 async function classify(j){await guard(j);j.accountSignals=null;if(j.verificationStatus==='unconfirmed')return 'verification_unconfirmed';const verification=await findVerificationControls(j.page);j.canVerify=Boolean(verification)&&!j.verificationAttempted;if(verification)return j.verificationAttempted?'verification_submitted':'verification_required';const loginVisible=await j.page.locator(SEL.password).isVisible().catch(()=>false);if(loginVisible)return 'login_not_completed';const diagnostics=await getVerificationDiagnostics(j.page);const codePresent=Array.isArray(diagnostics.fields)&&diagnostics.fields.some(field=>field.type!=='submit'&&(field.verificationLabel||field.otpAutocomplete));j.accountSignals=await getAccountSignals(j.page,codePresent);if(j.accountSignals.accountUiVerified===true)return 'authenticated';return 'result_unverified';}
 const server=http.createServer(async(req,res)=>{
  let url;try{url=new URL(req.url,'https://pilot.invalid');}catch{reply(res,400,{error:'INVALID_REQUEST'});return;}
  if(url.search||url.hash){reply(res,400,{error:'INVALID_REQUEST'});return;}
  if(req.method==='GET'&&url.pathname==='/health'){reply(res,200,{ready:!shutting});return;}
  if(req.method==='GET'&&staticAssets[url.pathname]){const [content,type]=staticAssets[url.pathname];reply(res,200,content,type);return;}
  const allowed=['/api/start','/api/image','/api/submit','/api/status','/api/close','/api/current','/api/verify','/api/auto-verify','/api/refresh-captcha','/api/inspect-account-menu','/api/otp-health','/api/captcha-health','/api/auto-login','/api/inspect-page','/api/open-page','/api/fill-draft','/api/upload-documents','/api/activate-control','/api/solve-form-captcha','/api/set-dates','/api/refresh-form-captcha','/api/confirm-application','/api/inspect-confirmation','/api/lookup-applications'];
  if(!allowed.includes(url.pathname)){reply(res,404,{error:'NOT_FOUND'});return;}
  if(!equal(req.headers.authorization)){reply(res,401,{error:'UNAUTHORIZED'});return;}
  if(env.RAAD_DIRECT_LOGIN_ENABLED!=='true'||shutting){reply(res,503,{error:'DISABLED'});return;}
  if(req.method!=='POST'||req.headers.origin!==origin){reply(res,403,{error:'FORBIDDEN'});return;}
  // Closing must remain available while a bounded mailbox poll owns the normal operation slot.
  if(url.pathname==='/api/close'){try{const data=await body(req);requireJob(data.sessionId);reply(res,200,{closed:await close()});}catch{reply(res,503,{error:'PILOT_UNAVAILABLE'});}return;}
  if(busy){reply(res,409,{error:'BUSY'});return;}busy=true;
  try{
   if(url.pathname==='/api/captcha-health'){reply(res,200,{credentialsConfigured:credentialConfig(env).configured,...await captchaHealth({env,fetchImpl:captchaFetch})});}
   else if(url.pathname==='/api/otp-health'){const credentials=credentialConfig(env);reply(res,200,{credentialsConfigured:credentials.configured,credentialsIncomplete:credentials.incomplete,...await mofaOtpHealth({env,fetchImpl:otpFetch})});}
   else if(url.pathname==='/api/start'){if(job){reply(res,409,{error:'SESSION_EXISTS'});}else reply(res,200,await start());}
   else if(url.pathname==='/api/current'){if(job&&job.expires<=now()&&!await close()){reply(res,200,{stage:'cleanup_unconfirmed'});}else if(job){if(['submitted_unverified','login_not_completed','verification_required','result_unverified','verification_submitted','verification_unconfirmed','authenticated'].includes(job.stage)){await guard(job);job.stage=await classify(job);}reply(res,200,{sessionId:job.id,stage:job.stage,credentialsFromEnvironment:credentialConfig(env).configured,automaticOtp:automaticOtp(job),automaticCaptcha:automaticCaptcha(job),captchaAutomationAvailable:captchaAutomationAvailable(),canVerify:job.canVerify===true,authenticated:job.stage==='authenticated',expiresAt:job.expires,...(['result_unverified','verification_unconfirmed'].includes(job.stage)?{diagnostics:await getVerificationDiagnostics(job.page)}:{}),...(job.verificationCheck?{interaction:job.verificationCheck}:{}),...(job.otpRead?{otpRead:job.otpRead}:{}),...(job.accountSignals?{accountSignals:job.accountSignals}:{}),...applicationResult(job),networkDiagnostics:job.networkDiagnostics?.snapshot()||{available:false}});}else reply(res,200,{stage:'no_session',lastOutcome});}
   else {const data=await body(req,url.pathname==='/api/upload-documents'?4100000:['/api/fill-draft','/api/activate-control','/api/refresh-form-captcha','/api/confirm-application'].includes(url.pathname)?24000:2048);const j=requireJob(data.sessionId);
    if(url.pathname==='/api/close'){reply(res,200,{closed:await close()});}
    else {await guard(j);
     if(url.pathname==='/api/status'){if(['submitted_unverified','login_not_completed','verification_required','result_unverified','verification_submitted','verification_unconfirmed','authenticated'].includes(j.stage))j.stage=await classify(j);reply(res,200,{stage:j.stage,canVerify:j.canVerify===true,authenticated:j.stage==='authenticated',expiresAt:j.expires});}
     else if(['/api/fill-draft','/api/upload-documents','/api/activate-control','/api/solve-form-captcha','/api/set-dates','/api/refresh-form-captcha','/api/confirm-application'].includes(url.pathname)){
      if(j.verificationStatus!=='submitted'||!['result_unverified','authenticated'].includes(j.stage))throw Error('ACCOUNT_PAGE_UNAVAILABLE');
      const verification=await findVerificationControls(j.page),diagnostics=await getVerificationDiagnostics(j.page);const codePresent=Boolean(verification)||(Array.isArray(diagnostics.fields)&&diagnostics.fields.some(field=>field.type!=='submit'&&(field.verificationLabel||field.otpAutocomplete)));
      const signals=await getAccountSignals(j.page,codePresent);if(signals.loginControlsVisible||signals.otpPresent||signals.loginRoute)throw Error('ACCOUNT_PAGE_UNAVAILABLE');
      if(!j.portalEdits)j.portalEdits=0;if(j.portalEdits>=30)throw Error('EDIT_LIMIT');j.portalEdits++;
      let result;const beforePath=new URL(j.page.url()).pathname;try{
       if(url.pathname==='/api/refresh-form-captcha'){j.portalCaptchaReadyHash=null;result=await refreshPortalCaptcha(j.page,{guard:()=>guard(j),signal:j.controller.signal});}
       else if(url.pathname==='/api/confirm-application'){if(!j.applicationSubmissionDispatched)throw Object.assign(Error('PORTAL_CONFIRM_UNAVAILABLE'),{code:'PORTAL_CONFIRM_UNAVAILABLE'});result=await activatePortalConfirmation(j.page,{label:data.label,confirmationHash:data.confirmationHash,expectedFields:data.expectedFields});}
       else if(url.pathname==='/api/solve-form-captcha'){result=await solvePortalCaptcha({page:j.page,env,fetchImpl:captchaFetch,signal:AbortSignal.any([j.controller.signal,AbortSignal.timeout(45000)]),guard:()=>guard(j),seen:j.captchaImages});j.portalCaptchaReadyHash=result.imageId;}
       else if(url.pathname==='/api/set-dates'){j.portalDatesPending??=new Set();if(Array.isArray(data.dates))for(const date of data.dates)if(['PASSPORT_ISSUE_DATE','PASSPORT_EXPIRY_DATe','BIRTH_DATE','ExpectedEntryDate','TourismEVisaIqamaOrVisaExpiryDate'].includes(date?.id))j.portalDatesPending.add(date.id);result=await setPortalDates(j.page,{dates:data.dates});const merged=new Map((j.portalDates||[]).map(date=>[date.id,date]));for(const date of data.dates){merged.set(date.id,{id:date.id,isoDate:date.isoDate});j.portalDatesPending.delete(date.id);}j.portalDates=Array.from(merged.values());}
       else if(url.pathname==='/api/fill-draft')result=await fillPortalFields(j.page,{fields:data.fields});
       else if(url.pathname==='/api/upload-documents')result=await uploadPortalDocuments(j.page,{documents:data.documents});
       else{if(data.mode==='submit'){if(j.portalDatesPending?.size||j.portalDates&&!await verifyPortalDates(j.page,{dates:j.portalDates}))throw Object.assign(Error('PORTAL_DATES_DATE_UNCONFIRMED'),{code:'PORTAL_DATES_DATE_UNCONFIRMED'});const field=j.page.locator('#myform #Captcha');if(await field.count()===1&&await field.isVisible()){if(!j.portalCaptchaReadyHash)throw Object.assign(Error('PORTAL_CAPTCHA_UNAVAILABLE'),{code:'PORTAL_CAPTCHA_UNAVAILABLE'});await checkPortalCaptcha(j.page,j.portalCaptchaReadyHash);}}result=await activatePortalButton(j.page,{id:data.id,label:data.label,mode:data.mode,expectedFields:data.expectedFields});if(data.mode==='submit'&&result.activationDispatched&&beforePath==='/SmartForm/TraditionalApp')j.applicationSubmissionDispatched=true;}
      }
      catch(error){const reasons=new Set(['PORTAL_CAPTCHA_REFRESH_INPUT_INVALID','PORTAL_CAPTCHA_REFRESH_UNAVAILABLE','PORTAL_CAPTCHA_REFRESH_AMBIGUOUS','PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE','PORTAL_CAPTCHA_REFRESH_ACTIVATION_UNCONFIRMED','PORTAL_CAPTCHA_REFRESH_TIMEOUT','PORTAL_CAPTCHA_REFRESH_CANCELLED','PORTAL_CONFIRM_INPUT_INVALID','PORTAL_CONFIRM_UNAVAILABLE','PORTAL_CONFIRM_CHANGED','PORTAL_CONFIRM_FORBIDDEN','PORTAL_CONFIRM_ALREADY_ATTEMPTED','PORTAL_CONFIRM_READBACK_MISMATCH','PORTAL_CONFIRM_ACTIVATION_UNCONFIRMED','PORTAL_DATES_INPUT_INVALID','PORTAL_DATES_UNTRUSTED_PAGE','PORTAL_DATES_FIELD_UNAVAILABLE','PORTAL_DATES_FORM_UNAVAILABLE','PORTAL_DATES_WIDGET_UNAVAILABLE','PORTAL_DATES_WIDGET_CHANGED','PORTAL_DATES_CALENDAR_UNSUPPORTED','PORTAL_DATES_DATE_UNCONFIRMED','PORTAL_DATES_BUSY','PORTAL_FILL_INPUT_INVALID','PORTAL_FILL_UNTRUSTED_PAGE','PORTAL_FILL_FIELD_UNAVAILABLE','PORTAL_FILL_FIELD_FORBIDDEN','PORTAL_FILL_FORM_UNAVAILABLE','PORTAL_FILL_KIND_MISMATCH','PORTAL_FILL_OPTION_INVALID','PORTAL_FILL_UNCONFIRMED','PORTAL_FILL_BUSY','UPLOAD_INPUT_INVALID','UPLOAD_PAGE_UNAVAILABLE','UPLOAD_FIELD_UNAVAILABLE','UPLOAD_FAILED','PORTAL_BUTTON_INPUT_INVALID','PORTAL_BUTTON_UNAVAILABLE','PORTAL_BUTTON_VALIDATION_FAILED','PORTAL_BUTTON_ALREADY_ATTEMPTED','PORTAL_BUTTON_READBACK_MISMATCH','PORTAL_BUTTON_ACTIVATION_UNCONFIRMED','PORTAL_CAPTCHA_INPUT_INVALID','PORTAL_CAPTCHA_UNAVAILABLE','PORTAL_CAPTCHA_CANCELLED','PORTAL_CAPTCHA_IMAGE_CHANGED','PORTAL_CAPTCHA_ALREADY_ATTEMPTED','PORTAL_CAPTCHA_IMAGE_LIMIT','PORTAL_CAPTCHA_INPUT_UNAVAILABLE','PORTAL_CAPTCHA_UNREADABLE','PORTAL_CAPTCHA_DISABLED','PORTAL_CAPTCHA_PROVIDER_UNAVAILABLE','PORTAL_CAPTCHA_TIMEOUT','PORTAL_CAPTCHA_INVALID_PROVIDER_REPLY']);reply(res,409,{error:'PORTAL_EDIT_UNCONFIRMED',reason:reasons.has(error?.code)?error.code:'UNCONFIRMED',...(Number.isInteger(error?.refreshedCount)?{refreshedCount:error.refreshedCount}:{}),...(Number.isInteger(error?.filledCount)?{filledCount:error.filledCount}:{}),...(Number.isInteger(error?.uploadedCount)?{uploadedCount:error.uploadedCount}:{})});return;}
      finally{if(Array.isArray(data.dates))for(const date of data.dates)if(date&&typeof date==='object')date.isoDate='';if(Array.isArray(data.documents))for(const doc of data.documents)if(doc&&typeof doc==='object')doc.data='';if(Array.isArray(data.fields))for(const field of data.fields)if(field&&typeof field==='object')field.value='';if(Array.isArray(data.expectedFields))for(const field of data.expectedFields)if(field&&typeof field==='object')field.expectedValue='';}
      await guard(j);j.portalDraftTouched=true;const afterPath=new URL(j.page.url()).pathname;const reference=data.mode==='submit'&&beforePath!==afterPath?afterPath.match(/^\/SmartForm\/(PayFee|EditApplication|PrintApplication)\/([0-9]{1,20})$/i):null;reply(res,200,{stage:j.stage,...result,...applicationResult(j),...(reference?{applicationReference:reference[2],paymentPage:/^PayFee$/i.test(reference[1])}:{}),...(url.pathname==='/api/activate-control'?{inspection:await inspectPortalPage(j.page)}:{})});
     }
     else if(url.pathname==='/api/inspect-confirmation'){
      if(j.verificationStatus!=='submitted'||!j.applicationSubmissionDispatched||!['result_unverified','authenticated'].includes(j.stage))throw Error('ACCOUNT_PAGE_UNAVAILABLE');
      try{const confirmation=await inspectPortalConfirmation(j.page);await guard(j);reply(res,200,{stage:j.stage,confirmation});}catch(error){const allowed=new Set(['PORTAL_CONFIRM_UNAVAILABLE','PORTAL_CONFIRM_CHANGED']);reply(res,409,{error:'PORTAL_CONFIRMATION_UNAVAILABLE',reason:allowed.has(error?.code)?error.code:'UNCONFIRMED'});}
     }
     else if(url.pathname==='/api/lookup-applications'){
      if(j.verificationStatus!=='submitted'||!['result_unverified','authenticated'].includes(j.stage))throw Error('ACCOUNT_PAGE_UNAVAILABLE');
      try{const lookup=await lookupPortalCases(j.page,{passportNumber:data.passportNumber});await guard(j);reply(res,200,{stage:j.stage,...lookup});}finally{data.passportNumber='';}
     }
     else if(url.pathname==='/api/inspect-page'){
      const inspection=await inspectPortalPage(j.page);await guard(j);reply(res,200,{stage:j.stage,inspection});
     }
     else if(url.pathname==='/api/open-page'){
      if(!['result_unverified','authenticated'].includes(j.stage))throw Error('ACCOUNT_PAGE_UNAVAILABLE');
      const verification=await findVerificationControls(j.page),diagnostics=await getVerificationDiagnostics(j.page);const codePresent=Boolean(verification)||(Array.isArray(diagnostics.fields)&&diagnostics.fields.some(field=>field.type!=='submit'&&(field.verificationLabel||field.otpAutocomplete)));
      const signals=await getAccountSignals(j.page,codePresent);if(signals.loginControlsVisible||signals.otpPresent||signals.loginRoute)throw Error('ACCOUNT_PAGE_UNAVAILABLE');
      if(!j.portalNavigations)j.portalNavigations=0;if(j.portalNavigations>=12)throw Error('NAVIGATION_LIMIT');j.portalNavigations++;
      const navigation=await navigateObservedLink(j.page,{path:data.path,label:data.label,acceptAgreement:data.acceptAgreement===true});await guard(j);j.stage=await classify(j);reply(res,200,{stage:j.stage,navigation,inspection:await inspectPortalPage(j.page)});
     }
     else if(url.pathname==='/api/inspect-account-menu'){
      if(j.verificationStatus!=='submitted')throw Error('LOGIN_NOT_SUBMITTED');
      const otp=await findVerificationControls(j.page);const structure=await getVerificationDiagnostics(j.page);const codeStillVisible=Array.isArray(structure.fields)&&structure.fields.some(field=>field.type!=='submit'&&(field.verificationLabel||field.otpAutocomplete));const before=await getAccountSignals(j.page,Boolean(otp)||codeStillVisible);
      if(otp||codeStillVisible||before.loginControlsVisible||before.loginRoute||!before.officialHost||!before.mainDocument)throw Error('ACCOUNT_PAGE_UNAVAILABLE');
      let result={opened:false,reason:'ALREADY_INSPECTED',signals:before};
      if(!j.accountMenuInspected&&!before.accountUiVerified){j.accountMenuInspected=true;result=await openAccountMenu(j.page);}
      j.accountSignals=result.signals;j.stage=result.signals.accountUiVerified?'authenticated':'result_unverified';
      reply(res,200,{sessionId:j.id,stage:j.stage,canVerify:false,authenticated:j.stage==='authenticated',expiresAt:j.expires,accountSignals:j.accountSignals,menuInspection:{opened:result.opened===true,reason:result.reason}});
     }
     else if(url.pathname==='/api/image'){if(j.stage!=='awaiting_input')throw Error('INVALID_STAGE');reply(res,200,await captureCaptcha(j.page),'image/png');}
     else if(url.pathname==='/api/refresh-captcha'){
      if(j.stage!=='awaiting_input')throw Error('INVALID_STAGE');
      const previous=await j.page.locator(SEL.image).evaluate(el=>el.currentSrc||el.src);
      const refresh=j.page.locator('#myform #btnRefreshCaptcha');if(await refresh.count()!==1||!await refresh.isVisible())throw Error('REFRESH_UNAVAILABLE');
      await refresh.click({timeout:10000});
      await j.page.waitForFunction(previous=>{const img=document.querySelector('#myform #imgCaptcha');return img&&img.complete&&img.naturalWidth>0&&(img.currentSrc||img.src)!==previous;},previous,{timeout:15000});
      j.automaticCaptchaAttempted=false;reply(res,200,await captureCaptcha(j.page),'image/png');
     }
     else if(['/api/verify','/api/auto-verify'].includes(url.pathname)){
      if(j.verificationAttempted||!['submitted_unverified','verification_required','result_unverified'].includes(j.stage))throw Error('INVALID_STAGE');
      const verification=await findVerificationControls(j.page);if(!verification)throw Error('VERIFICATION_FORM_UNAVAILABLE');
      if(url.pathname==='/api/auto-verify'){data.code='';if(!automaticOtp(j)||j.otpAccount!==env.RAAD_MOFA_USERNAME.trim().toLowerCase())throw Error('AUTO_OTP_UNAVAILABLE');j.automaticOtpAttempted=true;j.otpRead={state:'waiting',reason:'STARTED'};data.code=await waitForMofaCode({onProgress:progress=>{j.otpRead=progress;},env,requestedAt:j.otpRequestedAt,challengeId:j.otpChallengeId,account:j.otpAccount,signal:j.controller.signal,now,fetchImpl:otpFetch});await guard(j);}
      if(typeof data.code!=='string'||!new RegExp('^[0-9]{4,'+verification.maxLength+'}$').test(data.code))throw Error('INPUT_INVALID');
      j.verificationAttempted=true;j.canVerify=false;
      try{
       j.verificationCheck={phase:'locating_original_controls'};
       const input=await j.page.locator(verification.inputSelector).elementHandle(),button=await j.page.locator(verification.buttonSelector).elementHandle();
       if(!input||!button)throw Error('CONTROLS_UNAVAILABLE');
       j.verificationCheck.enabledBeforeTyping=await button.isEnabled();
       j.verificationCheck.phase='typing_code';await input.fill('');await input.type(data.code,{delay:80});data.code='';await guard(j);
       j.verificationCheck.buttonAttached=await button.evaluate(el=>el.isConnected);if(!j.verificationCheck.buttonAttached)throw Error('PAGE_CHANGED');
       j.verificationCheck.enabledAfterTyping=await button.isEnabled();j.verificationCheck.phase='waiting_for_original_submit';
       await button.waitForElementState('enabled',{timeout:10000});await guard(j);j.verificationCheck.phase='focusing_original_submit';await button.focus();
       j.verificationCheck.originalButtonFocused=await button.evaluate(el=>el.isConnected&&!el.disabled&&document.activeElement===el);if(!j.verificationCheck.originalButtonFocused)throw Error('FOCUS_UNCONFIRMED');
       j.verificationCheck.phase='activating_original_submit';await button.press('Enter',{noWaitAfter:true,timeout:10000});j.verificationCheck.phase='submit_activation_dispatched';j.verificationStatus='submitted';j.stage='verification_submitted';reply(res,200,{stage:j.stage,submitted:true,canVerify:false,authenticated:false});
      }catch(error){data.code='';if(j.verificationCheck)j.verificationCheck.failure=error?.name==='TimeoutError'?'timeout':'interaction_failed';j.verificationStatus='unconfirmed';j.stage='verification_unconfirmed';throw Error('VERIFICATION_UNCONFIRMED');}
     }
     else if(['/api/submit','/api/auto-login'].includes(url.pathname)){
      if(j.stage!=='awaiting_input')throw Error('INVALID_STAGE');
      const automatic=url.pathname==='/api/auto-login';let imageId=null,captchaSignal=null;
      const checkCaptcha=async()=>{await guard(j);if(captchaSignal?.aborted)throw Error('CAPTCHA_CANCELLED');};
      const sameImage=async()=>{await checkCaptcha();const bytes=await captureCaptcha(j.page);const id=crypto.createHash('sha256').update(bytes).digest('hex');await checkCaptcha();if(id!==imageId)throw Error('CAPTCHA_IMAGE_CHANGED');};
      const captchaFailure=error=>{const reason=String(error?.message||'').replace(/^CAPTCHA_/,'');return new Set(['DISABLED','READ_ALREADY_ATTEMPTED','IMAGE_CHANGED','CANCELLED','UNREADABLE','BRIDGE_UNAVAILABLE','PROVIDER_UNAVAILABLE','TIMEOUT','INVALID_PROVIDER_REPLY','RATE_LIMITED','BUSY','IMAGE_LIMIT']).has(reason)?reason:'UNAVAILABLE';};
      if(automatic){
       data.captcha='';
       try{
        if(!captchaAutomationAvailable())throw Error('CAPTCHA_DISABLED');if(j.automaticCaptchaAttempted)throw Error('CAPTCHA_READ_ALREADY_ATTEMPTED');j.automaticCaptchaAttempted=true;
        captchaSignal=AbortSignal.any([j.controller.signal,AbortSignal.timeout(45000)]);await checkCaptcha();
        const bytes=await captureCaptcha(j.page);imageId=crypto.createHash('sha256').update(bytes).digest('hex');await checkCaptcha();
        if(j.captchaImages.has(imageId))throw Error('CAPTCHA_READ_ALREADY_ATTEMPTED');if(j.captchaImages.size>=3)throw Error('CAPTCHA_IMAGE_LIMIT');j.captchaImages.add(imageId);
        data.captcha=await readCaptcha({env,image:bytes,imageId,signal:captchaSignal,fetchImpl:captchaFetch});await sameImage();
       }catch(error){data.captcha='';reply(res,200,{stage:j.stage,submitted:false,captcha:{reason:captchaFailure(error)}});return;}
      }
      const credentials=getCredentials(env,data);data.username=credentials.username;data.password=credentials.password;
      if(typeof data.username!=='string'||!data.username.trim()||data.username.length>254||typeof data.password!=='string'||!data.password||data.password.length>256||typeof data.captcha!=='string'||!data.captcha.trim()||data.captcha.length>32)throw Error('INPUT_INVALID');
      j.otpAccount=credentialConfig(env).configured?data.username.trim().toLowerCase():null;
      try{await j.page.locator(SEL.username).fill(data.username,{timeout:5000});await j.page.locator(SEL.password).fill(data.password,{timeout:5000});await j.page.locator(SEL.captcha).fill(data.captcha,{timeout:5000});data.username=data.password=data.captcha='';
       if(automatic){try{await sameImage();}catch(error){await j.page.locator(SEL.captcha).fill('',{timeout:1000}).catch(()=>{});reply(res,200,{stage:j.stage,submitted:false,captcha:{reason:captchaFailure(error)}});return;}}
       await guard(j);j.stage='submitting';j.otpRequestedAt=now();j.otpChallengeId=crypto.randomUUID();await j.page.locator(SEL.submit).click({timeout:10000});j.stage='submitted_unverified';reply(res,200,{stage:j.stage,submitted:true,authenticated:false});}
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
