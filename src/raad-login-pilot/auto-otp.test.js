'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createPilot}=require('./server');
const KEY='k'.repeat(43),BRIDGE_KEY='b'.repeat(40),ORIGIN='https://auto-test.example',ACCOUNT='bound@example.test',PASSWORD='private-test-password',CODE='246810';
async function setup(options={}){
 let otp=false,closed=false,focused=false,launches=0,typed=[],activations=0,pollCalls=[],cancelCalls=[],healthCalls=[];
 let entered;const polling=new Promise(r=>{entered=r;});
 const input={fill:async()=>{},type:async code=>{typed.push(code);}};
 const button={isEnabled:async()=>true,evaluate:async fn=>fn.toString().includes('activeElement')?focused:true,waitForElementState:async()=>{},focus:async()=>{focused=true;},press:async key=>{assert.equal(key,'Enter');activations++;}};
 const signals={officialHost:true,mainDocument:true,loginRoute:false,logoutPresent:true,myApplicationsPresent:true,logoutVisible:true,applicationsVisible:true,loginControlsVisible:false,otpPresent:false,accountUiVerified:true};
 const page={url:()=>otp?'https://visa.mofa.gov.sa/Account/EmailVerification':'https://visa.mofa.gov.sa/Account/Loginindividuals',isClosed:()=>closed,goto:async()=>{},evaluate:async(fn,arg)=>{
  if(fn.name==='inspectVerificationControls')return otp&&!options.genericOtp?{inputSelector:'#EmailVerificationCode',buttonSelector:'#Confirm',maxLength:6}:null;
  if(fn.name==='inspectVerificationStructure')return {fields:otp?[{type:'text',verificationLabel:true,otpAutocomplete:false}]:[],buttons:[],frameCount:0};
  if(fn.name==='inspectAccountSignals')return {...signals,otpPresent:arg===true,accountUiVerified:arg!==true};
  throw Error('Unexpected evaluator');
 },locator:selector=>({count:async()=>1,isVisible:async()=>selector==='#myform #Password'?!otp:true,isEnabled:async()=>true,fill:async()=>{},elementHandle:async()=>selector.startsWith('#EmailVerificationCode')?input:button,click:async()=>{if(selector==='#myform #btnSubmit')otp=true;else throw Error('Only initial login click allowed');}})};
 const otpFetch=async(url,request)=>{
  assert.equal(request.headers.Authorization,'Bearer '+BRIDGE_KEY);assert.equal(request.redirect,'error');const data=JSON.parse(request.body||'{}'),path=new URL(url).pathname;
  if(path.endsWith('/status')){healthCalls.push(data);return {ok:true,json:async()=>({enabled:true,recipientConfigured:true,gmailConfigured:true,gmailConnected:true,accountMatchesRecipient:data.account===ACCOUNT})};}
  if(path.endsWith('/cancel')){cancelCalls.push(data);return {ok:true,json:async()=>({cancelled:true})};}
  pollCalls.push(data);entered();
  if(options.pending)return new Promise((resolve,reject)=>{if(request.signal.aborted)reject(Error('aborted'));else request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
  if(options.bridgeFailure)return {ok:false,json:async()=>({})};
  return {ok:true,json:async()=>({code:CODE})};
 };
 const env={RAAD_PILOT_KEY:KEY,RAAD_PILOT_ORIGIN:ORIGIN,RAAD_DIRECT_LOGIN_ENABLED:'true',RAAD_MOFA_USERNAME:ACCOUNT,RAAD_MOFA_PASSWORD:PASSWORD,RAAD_MOFA_OTP_ENABLED:options.disabled?'false':'true',RAAD_MOFA_OTP_BRIDGE_URL:'https://flycham-whatsapp-assistant.onrender.com/',RAAD_MOFA_OTP_BRIDGE_KEY:BRIDGE_KEY};
 const pilot=createPilot({env,otpFetch,launch:async()=>{launches++;closed=false;return {newContext:async()=>({route:async()=>{},newPage:async()=>page}),isConnected:()=>!closed,close:async()=>{closed=true;}};}});
 await new Promise(r=>pilot.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+pilot.server.address().port;
 const call=(action,data={},headers={})=>fetch(base+'/api/'+action,{method:'POST',headers:{Authorization:'Bearer '+KEY,Origin:ORIGIN,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 let id;if(options.start!==false)id=(await(await call('start')).json()).sessionId;
 return {pilot,call,id,typed,pollCalls,cancelCalls,healthCalls,polling,launches:()=>launches,activations:()=>activations};
}
async function login(t){const r=await t.call('submit',{sessionId:t.id,username:'ignored@example.test',password:'ignored-value',captcha:'12'});assert.equal(r.status,200);}
function noSecrets(result){const s=JSON.stringify(result);for(const secret of [CODE,PASSWORD,ACCOUNT,BRIDGE_KEY])assert.equal(s.includes(secret),false);}
test('automatic OTP binds server account, types once, never exposes code, rejects duplicate',async()=>{const t=await setup();try{await login(t);const before=await(await t.call('current')).json();assert.equal(before.automaticOtp,true);const r=await t.call('auto-verify',{sessionId:t.id,code:'999999',account:'arbitrary@example.test'});assert.equal(r.status,200);const result=await r.json();assert.equal(result.stage,'verification_submitted');assert.equal(result.authenticated,false);noSecrets(result);assert.deepEqual(t.typed,[CODE]);assert.equal(t.activations(),1);assert.equal(t.pollCalls.length,1);assert.equal(t.pollCalls[0].account,ACCOUNT);assert.ok(Number.isFinite(t.pollCalls[0].requestedAt));assert.match(t.pollCalls[0].challengeId,/^[a-f0-9-]{36}$/i);assert.equal((await t.call('auto-verify',{sessionId:t.id})).status,503);assert.equal(t.pollCalls.length,1);assert.equal(t.typed.length,1);noSecrets(await(await t.call('current')).json());}finally{await t.pilot.shutdown();}});
test('disabled automatic mode does not poll bridge or type',async()=>{const t=await setup({disabled:true});try{await login(t);assert.equal((await(await t.call('current')).json()).automaticOtp,false);assert.equal((await t.call('auto-verify',{sessionId:t.id})).status,503);assert.equal(t.pollCalls.length,0);assert.equal(t.typed.length,0);}finally{await t.pilot.shutdown();}});
test('bridge failure preserves manual verification but forbids automatic retry',async()=>{const t=await setup({bridgeFailure:true});try{await login(t);assert.equal((await t.call('auto-verify',{sessionId:t.id})).status,503);assert.equal(t.pollCalls.length,1);assert.equal(t.cancelCalls.length,1);const state=await(await t.call('current')).json();assert.equal(state.canVerify,true);assert.equal(state.automaticOtp,false);assert.equal(state.stage,'verification_required');assert.equal((await t.call('auto-verify',{sessionId:t.id})).status,503);assert.equal(t.pollCalls.length,1);assert.equal((await t.call('verify',{sessionId:t.id,code:'135790'})).status,200);assert.deepEqual(t.typed,['135790']);assert.equal(t.activations(),1);}finally{await t.pilot.shutdown();}});
test('explicit close during pending poll aborts and cancels without typing',async()=>{const t=await setup({pending:true});try{await login(t);const pending=t.call('auto-verify',{sessionId:t.id});await t.polling;const close=await t.call('close',{sessionId:t.id});assert.equal(close.status,200);assert.equal((await close.json()).closed,true);assert.equal((await pending).status,503);assert.equal(t.cancelCalls.length,1);assert.equal(t.cancelCalls[0].account,ACCOUNT);assert.equal(t.typed.length,0);assert.equal(t.activations(),0);}finally{await t.pilot.shutdown();}});
test('OTP health is admin/origin protected, boolean-only, no browser launch',async()=>{const t=await setup({start:false});try{assert.equal((await t.call('otp-health',{}, {Authorization:'wrong'})).status,401);assert.equal((await t.call('otp-health',{}, {Origin:'https://external.test'})).status,403);assert.equal(t.healthCalls.length,0);const r=await t.call('otp-health');assert.equal(r.status,200);const data=await r.json();for(const v of Object.values(data))assert.equal(typeof v,'boolean');assert.equal(data.accountMatchesRecipient,true);noSecrets(data);assert.deepEqual(t.healthCalls,[{account:ACCOUNT}]);assert.equal(t.launches(),0);assert.equal(t.pollCalls.length,0);}finally{await t.pilot.shutdown();}});
test('generic OTP diagnostics block account authentication when full detector cannot select controls',async()=>{const t=await setup({genericOtp:true});try{await login(t);const state=await(await t.call('current')).json();assert.equal(state.stage,'result_unverified');assert.equal(state.authenticated,false);assert.equal(state.accountSignals.otpPresent,true);assert.equal(state.accountSignals.accountUiVerified,false);noSecrets(state);}finally{await t.pilot.shutdown();}});
