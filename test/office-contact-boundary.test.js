'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{readFileSync}=require('node:fs');
const {SUPERVISOR_SMS_NUMBER,assertSupervisorSmsDestination}=require('../src/visa-supervisor-route');
const {createSmsRequestProof,smsFailureDetails,confirmSmsRequest}=require('../src/raad-login-pilot/sms-request-proof');
const source=readFileSync(require.resolve('../src/raad-login-pilot/server'),'utf8'),start=source.indexOf('      const routeGuard='),end=source.indexOf("     else if(url.pathname==='/api/inspect-confirmation')",start),body=source.slice(start,end).replace(/\s*}\s*$/,'');assert.ok(start>0&&end>start);
const crypto=require('node:crypto');
const {WINDOW_MS,assertSmsWindow,sameSmsWindow}=require('../src/raad-login-pilot/sms-challenge-window');
const {createExecutionPolicy}=require('../src/raad-login-pilot/execution-policy');
const nativeFunctions=source.slice(source.indexOf(' function nativeSmsWindow('),source.indexOf(' async function body(req'));
const NOW=1793354400000;
const generic=()=>({origin:'https://visa.mofa.gov.sa',path:'/SmartForm/TraditionalApp',mobileFieldId:'MobileInfo_Mobile',prefixFieldId:'MobileInfo_MobilePrefix',sourceUrl:'https://visa.mofa.gov.sa/SmartForm/TraditionalApp',evidenceSha256:'a'.repeat(64),verifiedAt:NOW-1000,expiresAt:NOW+86400000,role:'office_verification_contact',basis:'user_authorization_and_observed_generic_field',officialRepresentativeStatus:'not_established',authorization:{source:'explicit_user_instruction',declaredRole:'office_license_owner',scope:'saudi_visa_sms',number:SUPERVISOR_SMS_NUMBER},observation:{fieldLabel:'رقم الجوال',actionLabel:'إرسال رمز التحقق',ownership:'not_specified_in_observed_ui',nearbyInstructionText:''}});
async function invoke({contract=generic(),phone=SUPERVISOR_SMS_NUMBER.slice(3),syntheticVerifier=false,data={},pathname='/api/request-application-sms',dispatchState,dispatched=false,proofDelay=0,sessionRemaining=600000,priorChallenge,acceptance='accepted'}={}){
 let at=NOW,nativeCalls=0,listeners=0,returned,options;
 const page={on(){listeners++;},off(){},url:()=> 'https://visa.mofa.gov.sa/SmartForm/TraditionalApp',mainFrame:()=>({url:()=> 'https://visa.mofa.gov.sa/SmartForm/TraditionalApp'})};
 const j={id:'session_fake',expires:NOW+sessionRemaining,smsAccountBinding:'b'.repeat(64),page,controller:new AbortController(),applicationSmsPhone:phone,applicationSmsPrefixLabel:'Saudi (00966)',applicationSmsDispatchState:dispatchState,applicationSmsChallenge:priorChallenge};
 const context={j,data,url:{pathname},res:{},now:()=>at,crypto,WINDOW_MS,assertSmsWindow,sameSmsWindow,confirmSmsRequest,supervisorSmsContract:contract,assertSupervisorSmsDestination,guard:async()=>{},smsResponseVerifier:undefined,
 createSmsRequestProof:syntheticVerifier?()=>({arm:()=>true,stop(){},destination:null,wait:async()=>{at+=proofDelay;return {requestObserved:true,destinationMatch:'matched',responseObserved:true,responseClass:'2xx',acceptance};}}):createSmsRequestProof,smsFailureDetails,
 inspectApplicationSms:async()=>({verification:{buttons:[]}}),enterApplicationSms:async(page,opts)=>{options=opts;await opts.guard();nativeCalls++;return {codeEntered:true};},
 requestApplicationSms:async(page,opts)=>{options=opts;await opts.guard();nativeCalls++;return {activationDispatched:dispatched};},classify:async()=> 'authenticated',reply:(res,status,value)=>{returned={status,value};}};
 await vm.runInNewContext(nativeFunctions+';(async()=>{'+body+'})()',context);return {nativeCalls,listeners,returned,options,j};
}
test('real private route accepts office-contact interpretation but still refuses an unconfigured response verifier pre-dispatch',async()=>{
 const t=await invoke();assert.equal(t.returned.status,409);assert.equal(t.returned.value.reason,'APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED');assert.equal(t.returned.value.smsDispatchState,'not_dispatched');assert.equal(t.nativeCalls,0);assert.equal(t.listeners,0);
});
test('private route supplies current generic-label guard to native helper using trusted policy, not request data',async()=>{
 const t=await invoke({syntheticVerifier:true,data:{officeContactLabel:'Applicant phone',supervisorSmsContract:{role:'anything'}}});assert.equal(t.returned.status,200);assert.equal(t.options.officeContactLabel,'رقم الجوال');assert.equal(t.options.rejectApplicantOwnership,true);assert.equal(t.nativeCalls,1);
});
test('request body cannot create office authorization, change the number, or override applicant-specific evidence',async()=>{
 for(const settings of [{contract:null,data:{supervisorSmsContract:generic()}},{phone:'500000000'},{contract:{...generic(),observation:{...generic().observation,fieldLabel:'رقم جوال مقدم الطلب'}}}]){const t=await invoke({...settings,syntheticVerifier:true});assert.equal(t.returned.status,409);assert.equal(t.nativeCalls,0);assert.match(t.returned.value.reason,/^SUPERVISOR_SMS_/);}
});
test('refused request/entry preserves earlier dispatched or uncertain SMS outcome and still clears input',async()=>{
 for(const pathname of ['/api/request-application-sms','/api/enter-application-sms'])for(const dispatchState of ['dispatched','uncertain']){
  const data={code:'123456'},t=await invoke({contract:null,pathname,dispatchState,data,syntheticVerifier:true});
  assert.equal(t.returned.status,409);assert.equal(t.returned.value.smsDispatchState,dispatchState);assert.equal(t.nativeCalls,0);assert.equal(data.code,'');
 }
});

test('native route originates exact challenge window before proof wait, ignores caller TTL and caps session expiry',async()=>{
 for(const sessionRemaining of [600000,100000]){const t=await invoke({syntheticVerifier:true,dispatched:true,proofDelay:50000,sessionRemaining,data:{challengeExpiresAt:NOW+9999999,accountBinding:'c'.repeat(64)}});assert.equal(t.returned.status,200);const result=t.returned.value;assert.equal(result.challengeRequestedAt,NOW);assert.equal(result.challengeExpiresAt,NOW+Math.min(300000,sessionRemaining));assert.equal(result.accountBinding,'b'.repeat(64));assert.match(result.challengeId,/^[a-f0-9-]{36}$/);assert.equal(t.j.applicationSmsChallenge.accepted,true);}
});
test('proof completing at expiry cannot publish a fresh or extended OTP challenge',async()=>{const t=await invoke({syntheticVerifier:true,dispatched:true,proofDelay:300000});assert.equal(t.nativeCalls,1);assert.equal(t.returned.status,409);assert.equal(t.returned.value.smsDispatchState,'dispatched');assert.equal(t.returned.value.reason,'APPLICATION_SMS_CHALLENGE_STALE');assert.equal(t.returned.value.challengeId,undefined);});
test('unknown SMS response cannot authorize native OTP entry',async()=>{const t=await invoke({syntheticVerifier:true,dispatched:true,acceptance:'unknown'});assert.equal(t.returned.status,409);assert.equal(t.returned.value.reason,'APPLICATION_SMS_ACCEPTANCE_UNCONFIRMED');assert.notEqual(t.j.applicationSmsChallenge.accepted,true);const data={...t.j.applicationSmsChallenge,code:'123456'},entered=await invoke({syntheticVerifier:true,pathname:'/api/enter-application-sms',priorChallenge:t.j.applicationSmsChallenge,data});assert.equal(entered.nativeCalls,0);assert.equal(entered.returned.status,409);assert.equal(data.code,'');});
test('native entry is bound to account/session/challenge/original timestamps and consumed once',async()=>{
 const first=await invoke({syntheticVerifier:true,dispatched:true}),challenge=first.j.applicationSmsChallenge;
 for(const patch of [{accountBinding:'c'.repeat(64)},{challengeId:'other'},{challengeRequestedAt:NOW-1},{challengeExpiresAt:NOW+299999}]){const input={...challenge,...patch,code:'123456'},t=await invoke({pathname:'/api/enter-application-sms',priorChallenge:{...challenge},data:input});assert.equal(t.returned.status,409);assert.equal(t.nativeCalls,0);assert.equal(input.code,'');}
 const input={...challenge,code:'123456'},entered=await invoke({pathname:'/api/enter-application-sms',priorChallenge:challenge,data:input});assert.equal(entered.returned.status,200);assert.equal(entered.nativeCalls,1);assert.equal(input.code,'');
 const duplicate=await invoke({pathname:'/api/enter-application-sms',priorChallenge:challenge,data:{...challenge,code:'123456'}});assert.equal(duplicate.returned.status,409);assert.equal(duplicate.nativeCalls,0);
});
test('actual native Save guard rechecks original deadline after session await',async()=>{
 let at=NOW,advance=false;const metadata={challengeId:'native-bound',challengeRequestedAt:NOW,challengeExpiresAt:NOW+300000,accountBinding:'b'.repeat(64)};
 const j={controller:new AbortController(),id:'session_fake',smsAccountBinding:metadata.accountBinding,applicationSmsPhone:SUPERVISOR_SMS_NUMBER.slice(3),applicationSmsPrefixLabel:'Saudi (00966)',applicationSmsCodeEntered:true};j.applicationSmsChallenge={...metadata,sessionId:j.id,phone:j.applicationSmsPhone,prefixLabel:j.applicationSmsPrefixLabel,accepted:true};
 const context={now:()=>at,guard:async()=>{if(advance)at=NOW+300000;},sameSmsWindow,j,input:metadata,assertSupervisorSmsDestination,supervisorSmsContract:generic(),assertApplicationSmsContact:async()=>({matched:true})};
 await vm.runInNewContext(nativeFunctions+';smsSaveGuard(j,input)',context);advance=true;await assert.rejects(vm.runInNewContext(nativeFunctions+';smsSaveGuard(j,input)',context),e=>e.code==='APPLICATION_SMS_CHALLENGE_STALE');
});

test('actual production session guard binds a trusted reservation lease callback and rechecks after await',async()=>{
 const guardSource=source.slice(source.indexOf(' async function guard(j){'),source.indexOf(' function nativeSmsWindow('));
 const j={id:'native-session',productionOwner:'private-reservation',expires:NOW+10000,controller:new AbortController(),browser:{isConnected:()=>true},page:{isClosed:()=>false,url:()=> 'https://visa.mofa.gov.sa/SmartForm/TraditionalApp'}};let calls=0;
 const owner={token:j.productionOwner,cancelled:false,leaseGuard:async()=>{calls++;}},context={URL,executionPolicy:createExecutionPolicy({}),job:j,productionReservation:owner,now:()=>NOW,j};
 await vm.runInNewContext(guardSource+';guard(j)',context);assert.equal(calls,1);
 owner.leaseGuard=async()=>{throw Object.assign(Error('LEASE_REVOKED'),{code:'LEASE_REVOKED'});};await assert.rejects(vm.runInNewContext(guardSource+';guard(j)',context),e=>e.code==='LEASE_REVOKED');
 owner.leaseGuard=async()=>{j.controller.abort();};await assert.rejects(vm.runInNewContext(guardSource+';guard(j)',context),/SESSION_UNAVAILABLE/);
});
