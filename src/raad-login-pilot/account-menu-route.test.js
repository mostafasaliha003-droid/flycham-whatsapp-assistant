'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPilot}=require('./server');

// Exercise the authenticated HTTP route using the actual classifier and menu
// adapters. All page controls and credentials are test doubles.
async function setup({toggleInitiallyMissing=true,menuOpens=true,otpRemains=false}={}){
 const key='r'.repeat(43),origin='https://example.test';
 let phase='password',focused=false,opened=false,discoveries=0,presses=0;
 const input={fill:async()=>{},type:async()=>{}};
 const otpButton={isEnabled:async()=>true,waitForElementState:async()=>{},focus:async()=>{focused=true;},evaluate:async()=>true,press:async key=>{assert.equal(key,'Enter');phase=otpRemains?'otp':'account';}};
 const menuHandle={focus:async()=>{focused=true;},evaluate:async fn=>fn.toString().includes('aria-expanded')?opened:focused,press:async key=>{assert.equal(key,'Enter');presses++;opened=menuOpens;},dispose:async()=>{}};
 const signals=()=>({officialHost:true,mainDocument:true,loginRoute:false,logoutPresent:true,myApplicationsPresent:true,logoutVisible:opened,applicationsVisible:opened,loginControlsVisible:false,otpPresent:false,accountUiVerified:opened});
 const page={
  url:()=> 'https://visa.mofa.gov.sa/'+(phase==='account'?'Home/Index':'Account/Loginindividuals'),
  isClosed:()=>false,goto:async()=>{},
  evaluate:async fn=>{
   if(fn.name==='inspectVerificationControls')return phase==='otp'?{inputSelector:'#EmailVerificationCode',buttonSelector:'#Confirm',maxLength:6}:null;
   if(fn.name==='inspectVerificationStructure')return {fields:phase==='otp'?[{type:'text',verificationLabel:true}]:[],buttons:[],frameCount:0};
   if(fn.name==='inspectAccountSignals')return signals();
   if(fn.name==='findAccountMenuToggle'){discoveries++;return toggleInitiallyMissing&&discoveries===1?null:{selector:'#test-account-toggle:visible',alreadyExpanded:opened};}
   throw Error('Unexpected page inspection: '+fn.name);
  },
  locator:selector=>({count:async()=>1,isVisible:async()=>selector==='#myform #Password'?phase==='password':true,isEnabled:async()=>true,fill:async()=>{},click:async()=>{assert.equal(selector,'#myform #btnSubmit');phase='otp';},elementHandle:async()=>selector.startsWith('#EmailVerificationCode')?input:selector.startsWith('#Confirm')?otpButton:menuHandle})
 };
 const pilot=createPilot({env:{RAAD_PILOT_KEY:key,RAAD_PILOT_ORIGIN:origin,RAAD_DIRECT_LOGIN_ENABLED:'true'},launch:async()=>({newContext:async()=>({route:async()=>{},newPage:async()=>page}),isConnected:()=>true,close:async()=>{}})});
 await new Promise(resolve=>pilot.server.listen(0,'127.0.0.1',resolve));
 const call=(action,data={},headers={})=>fetch('http://127.0.0.1:'+pilot.server.address().port+'/api/'+action,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 const started=await(await call('start')).json(),id=started.sessionId;
 const submit=async()=>{assert.equal((await call('submit',{sessionId:id,username:'fake@example.test',password:'test-password',captcha:'12'})).status,200);assert.equal((await(await call('current')).json()).stage,'verification_required');};
 const verify=async()=>{await submit();assert.equal((await call('verify',{sessionId:id,code:'123456'})).status,200);};
 return {pilot,call,id,submit,verify,discoveries:()=>discoveries,presses:()=>presses};
}

test('account route can rediscover a late menu while preserving one original activation',async()=>{
 const t=await setup();try{
  await t.verify();
  const first=await(await t.call('inspect-account-menu',{sessionId:t.id})).json();
  assert.equal(first.menuInspection.reason,'TOGGLE_UNAVAILABLE');assert.equal(first.authenticated,false);assert.equal(t.presses(),0);
  const second=await(await t.call('inspect-account-menu',{sessionId:t.id})).json();
  assert.equal(second.menuInspection.reason,'EXPANDED');assert.equal(second.authenticated,true);assert.equal(t.discoveries(),2);assert.equal(t.presses(),1);
  assert.equal((await(await t.call('inspect-account-menu',{sessionId:t.id})).json()).authenticated,true);assert.equal(t.presses(),1);
 }finally{await t.pilot.shutdown();}
});

test('account route never activates again after an actual unconfirmed menu activation',async()=>{
 const t=await setup({toggleInitiallyMissing:false,menuOpens:false});try{
  await t.verify();
  const first=await(await t.call('inspect-account-menu',{sessionId:t.id})).json();
  assert.equal(first.menuInspection.reason,'ACTIVATION_DISPATCHED');assert.equal(first.authenticated,false);assert.equal(t.presses(),1);
  const second=await(await t.call('inspect-account-menu',{sessionId:t.id})).json();
  assert.equal(second.menuInspection.reason,'ALREADY_INSPECTED');assert.equal(second.authenticated,false);assert.equal(t.discoveries(),1);assert.equal(t.presses(),1);
 }finally{await t.pilot.shutdown();}
});

test('account route retains owner, origin and OTP completion gates',async()=>{
 const t=await setup({otpRemains:true});try{
  assert.equal((await t.call('inspect-account-menu',{sessionId:t.id},{Authorization:'wrong'})).status,401);
  assert.equal((await t.call('inspect-account-menu',{sessionId:t.id},{Origin:'https://other.test'})).status,403);
  await t.submit();assert.equal((await t.call('inspect-account-menu',{sessionId:t.id})).status,503);
  assert.equal((await t.call('verify',{sessionId:t.id,code:'123456'})).status,200);
  assert.equal((await t.call('inspect-account-menu',{sessionId:t.id})).status,503);
  assert.equal(t.discoveries(),0);assert.equal(t.presses(),0);
 }finally{await t.pilot.shutdown();}
});
