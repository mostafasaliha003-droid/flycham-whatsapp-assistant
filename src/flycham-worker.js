'use strict';
const {chromium}=require('playwright');
const {PortalSession}=require('./portal-session');
const {startQuotePolling}=require('./quote-poller');
const {submitProbe}=require('./portal-search-probe');
const {validateLiveRequest,expandLiveRequests}=require('./live-quote');
const {readFlyChamFirstPage}=require('./flycham-first-page');
const {waitForFlightResults,readFlightTimes,selectFlightTimes,flightPairs}=require('./portal-flight-times');
const {voucherPromise}=require('./flycham-pricing');
const {flyChamBaggageAllowed}=require('./travel-language');
const {waitForVerificationCode}=require('./operator-verification');
const ORIGIN='https://reservations.flycham.com';
const FLYCHAM_VERIFICATION_FILE='/tmp/flycham-verification-code';
const OTP_INPUT='input[autocomplete="one-time-code"]:visible,input[id="userOtp"]:visible';
const OTP_SUBMIT='button[type="submit"]:visible,input[type="submit"]:visible,button[id="btnSubmit"]:visible,input[id="btnSubmit"]:visible';
const trusted=frame=>{try{return new URL(frame.url()).origin===ORIGIN;}catch{return false;}};
function inspectVerificationForm(){
 if(location.origin!=='https://reservations.flycham.com')return false;
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const inputs=[...document.querySelectorAll('input[autocomplete="one-time-code"],input[id="userOtp"]')].filter(visible);
 const buttons=[...document.querySelectorAll('button[type="submit"],input[type="submit"],button[id="btnSubmit"],input[id="btnSubmit"]')].filter(visible);
 if(inputs.length!==1||buttons.length!==1)return false;
 const input=inputs[0],button=buttons[0],form=input.form;
 if(!form||form!==button.form||input.disabled||input.readOnly||button.disabled||!['text','tel','number'].includes(input.type))return false;
 if(form.querySelector('input[type="password"]')||button.id==='btnBook'||button.closest('#btnBook'))return false;
 try{if(new URL(form.action,location.href).origin!==location.origin)return false;}catch{return false;}
 const label=(button.value||button.textContent||button.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
 return /^(?:verify(?:\s+(?:otp|code))?|submit|confirm|تحقق|تأكيد)$/i.test(label);
}
function formatFlyChamOffers(request,offers,{complete=false,dates=[]}={}){
 if(!offers.length)return 'لم نتأكد من سعر فلاي شام لهذا الطلب بعد. لم يتم حجز أو إصدار أي تذكرة.';
 const sorted=offers.slice().sort((a,b)=>Number(a.price.sellingTotal)-Number(b.price.sellingTotal));
 return '*فلاي شام | مجموعة الرمال*\n'+sorted.map((q,i)=>`\n*الخيار ${q.reference||i+1}*\nالمطارات: من ${q.timing.out.origin} إلى ${q.timing.out.destination}\nالتاريخ: ${q.request.departureDate}\nرقم الرحلة: ${q.timing.out.flight}\nالإقلاع: ${q.timing.out.departure}\nالوصول: ${q.timing.out.arrival}${q.timing.back?`\nالعودة: ${q.request.returnDate}\n${q.timing.back.flight} — الإقلاع ${q.timing.back.departure} — الوصول ${q.timing.back.arrival}`:''}\n*الإجمالي: ${q.price.sellingTotal} درهم*\n${voucherPromise(q.price)}`).join('\n')+'\n\n'+(complete?'تم فحص الخيارات الظاهرة للفترة المطلوبة.':`تأكدت هذه الخيارات فقط؛ لم يكتمل فحص كامل الفترة والتواقيت. التواريخ التي تمت محاولتها: ${dates.join('، ')}.`)+'\nالسعر لشخص بالغ واحد، شامل الرسوم وعمولة الخدمة. الوزن المشمول: 30 كيلو مسجل +10 كيلو حقيبة يد. الفاوجر يصدر بعد تأكيد التذكرة ولا يخصم من السعر الحالي. السعر والتوفر قابلان للتغير حتى الإصدار؛ لم يتم إنشاء حجز.';
}
class FlyChamPortalAdapter{
 constructor(page,{username,password,report=()=>{},verificationProvider=waitForVerificationCode}){this.page=page;this.username=username;this.password=password;this.report=report;this.protectedURL=null;this.verificationProvider=verificationProvider;this.verificationAttempted=false;}
 frames(){return this.page.frames().filter(trusted);}
 async findControl(frame,pattern){
  const candidates=['link','button','img','menuitem'].map(role=>frame.getByRole(role,{name:pattern}));
  if(frame.getByAltText)candidates.push(frame.getByAltText(pattern));if(frame.getByTitle)candidates.push(frame.getByTitle(pattern));if(frame.getByText)candidates.push(frame.getByText(pattern));
  for(const locator of candidates)for(let i=0;i<Math.min(await locator.count(),10);i++){const control=locator.nth(i);if(await control.isVisible()){
   if(await control.getAttribute?.('id')==='btnBook')continue;
   if(control.evaluate&&await control.evaluate(el=>Boolean(el.closest('#btnBook')||el.querySelector?.('#btnBook'))))continue;
   return control;
  }}
  return null;
 }
 async authenticatedFrame(){
  if(await this.hasVerificationChallenge()){this.reservationControl=null;return null;}
  for(const page of this.page.context().pages()){
   if(page.isClosed())continue;let signout=false,reservation=null,password=false,control=null;
   for(const frame of page.frames().filter(trusted)){try{
    signout ||= Boolean(await this.findControl(frame,/^(?:sign|log)\s*out$/i));
    password ||= await frame.locator('input[type="password"]:visible').count()>0;
    const candidate=await this.findControl(frame,/^make\s*reservation$/i);if(candidate){reservation=frame;control=candidate;}
   }catch{}}
   if(signout&&reservation&&!password){this.page=page;this.reservationControl=control;return reservation;}
  }
  return null;
 }
 async loginFailure(){
  for(const page of this.page.context().pages())for(const frame of page.frames().filter(trusted)){try{
   const state=await frame.evaluate(()=>{const text=document.body?.innerText||'';return{invalid:/invalid.{0,30}(password|user)|incorrect.{0,30}(password|user)/i.test(text),change:/change (your )?password|password.{0,20}expir/i.test(text),session:/already logged|active session|another session|concurrent session/i.test(text),verify:/captcha|verify (you|that you) are human|security challenge|one.time.password|verification code/i.test(text),login:Boolean(document.querySelector('input[type="password"]')),signoutText:/(?:sign|log)\s*(?:out|off)/i.test(text),reservationText:/make\s*(?:a\s*)?reservation|new\s*reservation/i.test(text),namedSignout:[...document.querySelectorAll('[alt],[title],[aria-label]')].some(e=>['alt','title','aria-label'].some(k=>/^(?:sign|log)\s*(?:out|off)$/i.test(e.getAttribute(k)||''))),namedReservation:[...document.querySelectorAll('[alt],[title],[aria-label]')].some(e=>['alt','title','aria-label'].some(k=>/^make\s*reservation$/i.test(e.getAttribute(k)||'')))};});
   this.report('FLYCHAM_LOGIN_STATE_'+JSON.stringify(state));
   if(state.invalid)return 'FLYCHAM_LOGIN_BAD_CREDENTIALS';if(state.change)return 'FLYCHAM_PASSWORD_CHANGE_REQUIRED';if(state.session)return 'FLYCHAM_EXISTING_SESSION';if(state.verify)return 'FLYCHAM_MANUAL_VERIFICATION';
  }catch{}}
  return 'FLYCHAM_LOGIN_NOT_CONFIRMED';
 }
 async isAuthenticated(){return Boolean(await this.authenticatedFrame());}
 async visibleChallenge(frame,selector){
  try{const locator=frame.locator(selector);for(let i=0;i<Math.min(await locator.count(),20);i++){const item=locator.nth?locator.nth(i):locator;if(typeof item.isVisible==='function'&&await item.isVisible())return true;}}catch{}
  return false;
 }
 async verificationChallenge(){
  for(const frame of this.searchFrames()){
   if(!trusted(frame))continue;
   if(await this.visibleChallenge(frame,'input[id="captcha_txt"]:visible,iframe[src*="captcha"]:visible'))return {frame,kind:'captcha'};
   const path=new URL(frame.url()).pathname;
   if(await this.visibleChallenge(frame,OTP_INPUT)||/\/(?:sendOTP|verifyOTP|otpForm)(?:\.action)?$/i.test(path))return {frame,kind:'otp'};
  }
  return null;
 }
 async hasVerificationChallenge(){return Boolean(await this.verificationChallenge());}
 async verificationForm(){
  for(const frame of this.searchFrames())try{
   if(!trusted(frame)||await frame.locator(OTP_INPUT).count()!==1||await frame.locator(OTP_SUBMIT).count()!==1)continue;
   if(await frame.evaluate(inspectVerificationForm))return {frame,input:frame.locator(OTP_INPUT),submit:frame.locator(OTP_SUBMIT)};
  }catch{}
  return null;
 }
 async resumeVerification(){
  const challenge=await this.verificationChallenge();
  if(!challenge||challenge.kind!=='otp'||this.verificationAttempted)throw Error('FLYCHAM_MANUAL_VERIFICATION');
  const requestedAt=Date.now();let form;
  for(let attempt=0;attempt<80&&!form;attempt++){form=await this.verificationForm();if(!form)await this.page.waitForTimeout(250);}
  if(!form)throw Error('FLYCHAM_VERIFICATION_FORM_UNAVAILABLE');
  this.verificationAttempted=true;
  this.report('FLYCHAM_VERIFICATION_WAITING_FOR_OPERATOR');
  let code;
  try{
   code=await this.verificationProvider({path:FLYCHAM_VERIFICATION_FILE,requestedAt});
   if(!/^[A-Za-z0-9]{4,12}$/.test(code||''))throw Error('FLYCHAM_MANUAL_VERIFICATION');
   // Recheck the trusted, visible, unique same-form controls after operator wait.
   form=await this.verificationForm();if(!form)throw Error('FLYCHAM_VERIFICATION_FORM_UNAVAILABLE');
   await form.input.fill(code);code=null;await form.submit.click({noWaitAfter:true});
  }catch(error){throw Error(error.code==='VERIFICATION_TIMEOUT'?'FLYCHAM_VERIFICATION_TIMEOUT':/^FLYCHAM_[A-Z0-9_]+$/.test(error.message)?error.message:'FLYCHAM_MANUAL_VERIFICATION');}
  finally{code=null;}
  this.report('FLYCHAM_VERIFICATION_SUBMITTED');
  for(let attempt=0;attempt<30;attempt++){
   if(await this.isAuthenticated()){this.verificationAttempted=false;this.report('FLYCHAM_PORTAL_AUTHENTICATED');return;}
   await this.page.waitForTimeout(1000);
  }
  throw Error('FLYCHAM_VERIFICATION_NOT_CONFIRMED');
 }
 async signIn(){
  this.report('FLYCHAM_LOGIN_STARTED');
  const root=this.page,context=root.context();
  await root.goto(ORIGIN+'/xbe/',{waitUntil:'domcontentloaded',timeout:45000});
  const suitable=p=>!p.isClosed()&&p.frames().some(trusted);
  let popup;
  for(let i=0;i<16;i++){popup=context.pages().find(p=>p!==root&&suitable(p));if(popup)break;await root.waitForTimeout(250);}
  const link=root.getByRole('link',{name:'If pop-up blocked, Click here to login',exact:true});
  if(!popup&&await link.count()===1){
   this.report('FLYCHAM_LOGIN_POPUP_OPENING');
   const opened=root.waitForEvent('popup',{timeout:10000}).catch(()=>null);await link.click();popup=await opened;
   if(!popup)popup=context.pages().find(p=>p!==root&&suitable(p));
   if(!popup)throw Error('FLYCHAM_LOGIN_POPUP_NOT_OPENED');
  }
  if(popup){this.page=popup;await this.page.waitForLoadState('domcontentloaded');}
  for(let i=0;i<20&&!this.frames().length;i++)await this.page.waitForTimeout(250);
  if(!this.frames().length){this.report('FLYCHAM_LOGIN_WINDOW_FRAMES_'+this.page.frames().length);throw Error('FLYCHAM_UNTRUSTED_ORIGIN');}
  if(await this.isAuthenticated()){this.protectedURL=trusted(this.page)?this.page.url():(await this.authenticatedFrame()).url();this.report('FLYCHAM_PORTAL_AUTHENTICATED');return;}
  if(await this.hasVerificationChallenge()){await this.resumeVerification();return;}
  let loginFrame;for(let attempt=0;attempt<40&&!loginFrame;attempt++){for(const frame of this.frames())if(await frame.locator('input[type="password"]:visible').count()===1){if(loginFrame)throw Error('FLYCHAM_LOGIN_FORM_UNCONFIRMED');loginFrame=frame;}if(!loginFrame)await this.page.waitForTimeout(250);}
  if(!loginFrame)throw Error('FLYCHAM_LOGIN_FORM_UNCONFIRMED');
  this.report('FLYCHAM_LOGIN_FORM_READY');
  const password=loginFrame.locator('input[type="password"]:visible');
  const users=loginFrame.locator('input[type="text"]:visible:not([readonly]),input[type="email"]:visible:not([readonly])');
  if(await password.count()!==1||await users.count()!==1){this.report('FLYCHAM_LOGIN_TEXT_FIELDS_'+await users.count());this.report('FLYCHAM_LOGIN_PASSWORD_FIELDS_'+await password.count());throw Error('FLYCHAM_LOGIN_FORM_UNCONFIRMED');}
  if(await this.hasVerificationChallenge())throw Error('FLYCHAM_MANUAL_VERIFICATION');
  await users.fill(this.username);await password.fill(this.password);
  let submit=loginFrame.getByRole('button',{name:/^(?:log\s*in|sign\s*in)$/i});
  if(await submit.count()!==1)submit=loginFrame.locator('input[type="submit"]:visible');
  if(await submit.count()!==1)throw Error('FLYCHAM_LOGIN_FORM_UNCONFIRMED');
  await submit.click();
  for(let attempt=0;attempt<20;attempt++){if(await this.isAuthenticated()){this.verificationAttempted=false;this.protectedURL=trusted(this.page)?this.page.url():(await this.authenticatedFrame()).url();this.report('FLYCHAM_PORTAL_AUTHENTICATED');return;}if(await this.hasVerificationChallenge()){await this.resumeVerification();return;}await this.page.waitForTimeout(1000);}
  throw Error(await this.loginFailure());
 }
 searchFrames(){
  const found=[...this.frames()];
  for(const page of this.page.context?.().pages()||[])if(!page.isClosed())for(const frame of page.frames().filter(trusted))if(!found.includes(frame))found.push(frame);
  return found;
 }
 async inspectSearchState(){
  for(const frame of this.searchFrames())try{const state=await frame.evaluate(()=>{
   if(location.origin!=='https://reservations.flycham.com')return {trusted:false};
   const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
   const names=/^(?:new search|modify search|change search|search|search flights|make reservation)$/i;
   const controls=[...document.querySelectorAll('a,button,input[type="button"],input[type="submit"]')].filter(visible).flatMap(e=>{const label=(e.getAttribute('aria-label')||e.getAttribute('title')||e.value||e.textContent||'').replace(/\s+/g,' ').trim();return names.test(label)?[{tag:e.tagName,label,id:/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(e.id)?e.id:null}]:[];}).slice(0,12);
   return{trusted:true,airportFields:document.querySelectorAll('#fAirport').length,visibleAirportFields:[...document.querySelectorAll('#fAirport')].filter(visible).length,controls};
  });this.report('FLYCHAM_SEARCH_STATE_'+JSON.stringify(state));}catch{this.report('FLYCHAM_SEARCH_STATE_UNAVAILABLE');}
 }
 async openSearchForm(){
  const menu=await this.authenticatedFrame();if(!menu)throw Error('FLYCHAM_SESSION_UNAVAILABLE');
  const link=this.reservationControl||await this.findControl(menu,/^make\s*reservation$/i);if(!link)throw Error('FLYCHAM_SEARCH_CONTROL_UNCONFIRMED');
  if(await link.getAttribute?.('id')==='btnBook'||link.evaluate&&await link.evaluate(el=>Boolean(el.closest('#btnBook')||el.querySelector?.('#btnBook'))))throw Error('FLYCHAM_BOOKING_CONTROL_REFUSED');
  await link.click();
  let recovered=false;
  for(let attempt=0;attempt<60;attempt++){
   for(const f of this.searchFrames())if(await f.locator('#fAirport:visible').count()===1){if(!await this.isAuthenticated())throw Error('FLYCHAM_SESSION_UNAVAILABLE');this.onAuthenticatedActivity?.();return f;}
   if(!recovered){for(const f of this.searchFrames()){
    if(await f.locator('#fAirport').count()!==1)continue;
    const tab=f.getByRole?.('link',{name:'Search Flights',exact:true});
    if(tab&&await tab.count()===1&&await tab.isVisible()){await tab.click();recovered=true;this.report('FLYCHAM_SEARCH_FORM_TAB_OPENED');break;}
   }}
   if(attempt===15&&!recovered){for(const f of this.searchFrames()){const control=await this.findControl(f,/^(?:new|modify|change)\s+search$/i);if(control){await control.click();recovered=true;this.report('FLYCHAM_SEARCH_RESET_NAVIGATION_COMPLETED');break;}}}
   await this.page.waitForTimeout(500);
  }
  await this.inspectSearchState();throw Error('FLYCHAM_SEARCH_FORM_UNCONFIRMED');
 }
 async refreshProtectedPage(){await this.openSearchForm();if(!await this.isAuthenticated())throw Error('FLYCHAM_SESSION_UNAVAILABLE');this.onAuthenticatedActivity?.();this.report('FLYCHAM_HEARTBEAT_NAVIGATION_COMPLETED');}
 async searchFlightsForHeartbeat(){return this.refreshProtectedPage();}
 async assertQuoteSession(coverage){
  if(await this.isAuthenticated())return;
  const challenged=await this.hasVerificationChallenge();
  throw Object.assign(Error('FLYCHAM_SESSION_UNAVAILABLE'),{code:'PORTAL_SESSION_EXPIRED',coverage:coverage.map(day=>({...day,status:challenged?'authentication_required':'unverified'}))});
 }
 async search(request){
  const config=validateLiveRequest(request);if(!flyChamBaggageAllowed(request))throw Error('FLYCHAM_BAGGAGE_NOT_VERIFIED');
  // Legacy popup shell spans several frames; navigating a child/menu URL in
  // the top-level page destroys that shell. Use its authenticated menu only.
  const frame=await this.openSearchForm();
  const prepared=await submitProbe(frame,{...config,requestedReturnDate:config.returnDate,requestTripType:request.tripType,supplier:'flycham',report:this.report});
  if(prepared.tripKind!==(request.tripType==='one_way'?'one-way':'return'))throw Error('FLYCHAM_TRIP_NOT_CONFIRMED');
  // Flight inventory can arrive before any fare is selected. Waiting for the
  // total here prevents reaching the normal selection controls.
  this.report('FLYCHAM_WAITING_FOR_FLIGHT_RESULTS');
  await waitForFlightResults(frame,request.tripType==='one_way',ORIGIN);
  this.report('FLYCHAM_FLIGHT_RESULTS_READY');
  if(!await this.isAuthenticated())throw Error('FLYCHAM_SESSION_UNAVAILABLE');this.onAuthenticatedActivity?.();
  return frame;
 }
 async runCustomerQuote(request,onProgress,isCurrent=async()=>{}){
  const offers=[],attempted=[],coverage=[];const dates=expandLiveRequests(request);
  for(const dated of dates){await isCurrent();attempted.push(dated.departureDate);const day={date:dated.departureDate,status:'unverified',confirmed:0,failed:0};coverage.push(day);try{
   const frame=await this.search(dated);
   // Capture the supplier-confirmed selected itinerary before changing rows.
   // A failure comparing another timing must not discard this verified offer.
   try{const q=await readFlyChamFirstPage(frame,{tripType:dated.tripType,passengerCount:1,request:dated});await this.assertQuoteSession(coverage);this.onAuthenticatedActivity?.();const offer={...q,request:dated,reference:offers.length+1};offers.push(offer);day.confirmed++;if(onProgress)await onProgress('',{offer,coverage});}
   catch(error){if(error.code==='PORTAL_SESSION_EXPIRED')throw error;this.report(/^FLYCHAM_[A-Z0-9_]+$/.test(error.message)?error.message:'FLYCHAM_INITIAL_QUOTE_UNCONFIRMED');}
   const choices=await readFlightTimes(frame,dated.tripType==='one_way',ORIGIN),pairs=flightPairs(choices);
   if(!pairs.length)throw Error('FLYCHAM_TIMINGS_UNCONFIRMED');
   for(const choice of pairs){await isCurrent();try{
    await selectFlightTimes(frame,choice,ORIGIN);
    const q=await readFlyChamFirstPage(frame,{tripType:dated.tripType,passengerCount:1,request:dated});
    if(q.timing.out.flight!==choice.out.flight.replace(/\s/g,''))throw Error('FLYCHAM_TIMING_NOT_MATCHED');
    await this.assertQuoteSession(coverage);this.onAuthenticatedActivity?.();
    if(offers.some(o=>o.request.departureDate===dated.departureDate&&o.request.returnDate===dated.returnDate&&o.timing.out.flight===q.timing.out.flight&&o.timing.out.departure===q.timing.out.departure&&o.timing.back?.flight===q.timing.back?.flight))continue;
    const offer={...q,request:dated,reference:offers.length+1};offers.push(offer);day.confirmed++;
    if(onProgress)await onProgress('',{offer,coverage});
   }catch(error){if(error.message==='QUOTE_SUPERSEDED')throw error;await this.assertQuoteSession(coverage);day.failed++;this.report(/^(?:FLYCHAM|FLIGHT)_[A-Z0-9_]+$/.test(error.message)?error.message:'FLYCHAM_TIMING_UNCONFIRMED');}}
   day.status=day.failed?'partial':'confirmed';
  }catch(error){if(error.message==='QUOTE_SUPERSEDED'||error.code==='PORTAL_SESSION_EXPIRED')throw error;await this.assertQuoteSession(coverage);day.status=error.message==='NO_FLIGHTS_CONFIRMED'?'no_flights':'unverified';day.failed++;this.report(/^(?:FLYCHAM|AIRPORT|SEARCH|ONE_WAY|FLIGHT|NO_FLIGHTS|INVALID_PROBE|UNSUPPORTED_PROBE)_[A-Z0-9_]+$/.test(error.message)?'FLYCHAM_'+error.message:error.name==='TimeoutError'?'FLYCHAM_SEARCH_RESULTS_TIMEOUT':'FLYCHAM_QUOTE_UNCONFIRMED');}}
  const complete=coverage.length===dates.length&&coverage.every(d=>['confirmed','no_flights'].includes(d.status));

  return{reply:formatFlyChamOffers(request,offers,{dates:attempted,complete}),outcome:offers.length?(complete?'done':'partial'):'failed',coverage};
 }
}
async function readFlyChamConfig(env){
 if(typeof env.FLYCHAM_AGENT_USERNAME!=='string'||!env.FLYCHAM_AGENT_USERNAME.trim()||typeof env.FLYCHAM_AGENT_PASSWORD!=='string'||!env.FLYCHAM_AGENT_PASSWORD)throw Error('FLYCHAM_CONFIG_MISSING');
 return {username:env.FLYCHAM_AGENT_USERNAME,password:env.FLYCHAM_AGENT_PASSWORD};
}
async function runFlyCham({env=process.env,launch=o=>chromium.launch(o),log=console}={}){
 if(env.FLYCHAM_PORTAL_ENABLED!=='true')return;
 let browser,session,stop;
 const shutdown=async()=>{if(stop)await stop();if(session)await session.stop();if(browser)await browser.close();};
 try{
  const credentials=await readFlyChamConfig(env);browser=await launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  const adapter=new FlyChamPortalAdapter(page,{...credentials,report:c=>log.log(c)});await adapter.signIn();
  session=new PortalSession(adapter,{report:c=>log.log(c)});await session.initialize();session.start(()=>{log.log('FLYCHAM_SESSION_UNAVAILABLE');shutdown().catch(()=>{});});
  stop=startQuotePolling(session,{env,log,provider:'flycham'});
  await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 }catch(e){log.log(/^FLYCHAM_[A-Z0-9_]+$/.test(e.message)?e.message:e.name==='TimeoutError'?'FLYCHAM_TIMEOUT':e.name==='TypeError'?'FLYCHAM_TYPE_ERROR':'FLYCHAM_PORTAL_UNAVAILABLE');}
 finally{await shutdown().catch(()=>{});}
}
module.exports={FlyChamPortalAdapter,runFlyCham,readFlyChamConfig,formatFlyChamOffers,FLYCHAM_VERIFICATION_FILE,inspectVerificationForm};
