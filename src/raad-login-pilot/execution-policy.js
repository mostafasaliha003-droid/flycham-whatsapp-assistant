'use strict';
// Service configuration, captured once. Request payloads cannot change it.
// This is a bounded no-submission test fence, not a portal sandbox or a proof
// that arbitrary third-party scripts/server GET handlers have no side effects.
const ORIGIN='https://visa.mofa.gov.sa';
const PRODUCTION_MAIN_ORIGIN='https://flycham-whatsapp-assistant.onrender.com';
const MODE='non_submitting_test';
const VIEWS=new Set(['/Account/Loginindividuals','/SmartForm','/SmartForm/Agreement','/SmartForm/ElectronicAgreement','/SmartForm/TraditionalApp']);
const DOCUMENT_ACTIONS=new Set(['inspect-page','inspect-confirmation','lookup-applications','inspect-application-sms','request-application-sms','enter-application-sms','fill-draft','upload-documents','set-dates','refresh-form-captcha','solve-form-captcha']);
const ACTIONS=new Set(['start','close','current','status','image','refresh-captcha','submit','auto-login','verify','auto-verify','inspect-account-menu','otp-health','captcha-health','open-page','activate-control','confirm-application',...DOCUMENT_ACTIONS]);
const OVERRIDES=new Set(['executionMode','execution_mode','RAAD_EXECUTION_MODE','nonSubmittingTest','allowSubmission','allowSubmit','testMode','dryRun','RAAD_TEST_MAIN_URL','RAAD_TEST_APPROVED_MAIN_ORIGIN','RAAD_TEST_JOB_BRIDGE_KEY','RAAD_MAIN_URL','RAAD_JOB_BRIDGE_KEY','testMainUrl','testBridgeKey']);
const policies=new WeakSet(),pagePolicies=new WeakMap();
function refuse(code='RAAD_TEST_SUBMISSION_BLOCKED'){throw Object.assign(new Error(code),{code,notDispatched:true,testStopped:true});}
// Never log/serialize the returned internal config: it contains the test bridge
// credential. Readiness helpers must use testAdmissionStatus instead.
function createTestBridgeConfig(env={}){
 try{
  const raw=env.RAAD_TEST_MAIN_URL,key=env.RAAD_TEST_JOB_BRIDGE_KEY;
  if(typeof raw!=='string'||raw!==raw.trim()||typeof key!=='string'||!/^[\x21-\x7e]{32,512}$/.test(key)||key===env.RAAD_JOB_BRIDGE_KEY)return null;
  const u=new URL(raw);
  if(u.origin===PRODUCTION_MAIN_ORIGIN||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return null;
  if(u.protocol==='http:'){
   if(!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(raw)||u.hostname!=='127.0.0.1'||!/^\d{1,5}$/.test(u.port)||Number(u.port)<1||Number(u.port)>65535)return null;
  }else if(u.protocol==='https:'){
   if(typeof env.RAAD_TEST_APPROVED_MAIN_ORIGIN!=='string'||env.RAAD_TEST_APPROVED_MAIN_ORIGIN!==u.origin)return null;
  }else return null;
  if(env.RAAD_MAIN_URL!==undefined&&env.RAAD_MAIN_URL!==''){
   const carried=new URL(env.RAAD_MAIN_URL);
   if(carried.origin===PRODUCTION_MAIN_ORIGIN||carried.href!==u.href||carried.username||carried.password||carried.pathname!=='/'||carried.search||carried.hash)return null;
  }
  return Object.freeze({mainUrl:u.href,bridgeKey:key});
 }catch{return null;}
}
function testAdmissionStatus(env={}){if(env.RAAD_EXECUTION_MODE!==MODE)return {configured:false,blocker:'RAAD_TEST_MODE_REQUIRED'};const configured=Boolean(createTestBridgeConfig(env));return {configured,blocker:configured?null:'RAAD_TEST_ISOLATED_MAIN_REQUIRED'};}
function createExecutionPolicy(env={}){
 const selected=env.RAAD_EXECUTION_MODE;
 if(selected!==undefined&&selected!=='production'&&selected!==MODE)throw Object.assign(new Error('RAAD_EXECUTION_MODE_INVALID'),{code:'RAAD_EXECUTION_MODE_INVALID',notDispatched:true});
 const isTest=selected===MODE,mode=isTest?MODE:'production';
 function assertInput(value){
  if(!isTest)return;
  const seen=new WeakSet(),pending=[value];let count=0;
  while(pending.length){const item=pending.pop();if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);if(++count>10000)refuse('RAAD_TEST_INPUT_INVALID');for(const key of Object.keys(item)){if(OVERRIDES.has(key))refuse('RAAD_TEST_MODE_OVERRIDE_FORBIDDEN');pending.push(item[key]);}}
 }
 function assertAction(action,data={},currentUrl){
  if(!isTest)return;
  assertInput(data);
  if(!ACTIONS.has(action))refuse('RAAD_TEST_ACTION_BLOCKED');
  let currentPath;
  if(currentUrl!==undefined){let u;try{u=new URL(currentUrl);}catch{refuse('RAAD_TEST_PAGE_BLOCKED');}if(u.origin!==ORIGIN||u.username||u.password||u.search||u.hash||!VIEWS.has(u.pathname))refuse('RAAD_TEST_PAGE_BLOCKED');currentPath=u.pathname;}
  if(action==='confirm-application')refuse();
  if(action==='activate-control'){
   if(data.mode!=='agreement'||currentPath!==undefined&&currentPath!=='/SmartForm/Agreement'||!/^(?:موافق|أوافق|اوافق|Agree|I Agree)$/i.test(data.label||''))refuse();
  }
  if(action==='open-page'){
   if(!VIEWS.has(data.path)||data.path==='/Account/Loginindividuals'||data.viewPaymentDetails===true)refuse();
  }
  if(['submit','auto-login'].includes(action)&&currentPath!==undefined&&currentPath!=='/Account/Loginindividuals')refuse();
  if(['verify','auto-verify'].includes(action)&&currentPath!==undefined&&currentPath!=='/Account/Loginindividuals')refuse();
  if(DOCUMENT_ACTIONS.has(action)&&!['inspect-page','inspect-confirmation'].includes(action)&&currentPath!==undefined){
   if(action==='lookup-applications'?currentPath!=='/SmartForm':action==='fill-draft'? !['/SmartForm/Agreement','/SmartForm/ElectronicAgreement','/SmartForm/TraditionalApp'].includes(currentPath):currentPath!=='/SmartForm/TraditionalApp')refuse('RAAD_TEST_PAGE_BLOCKED');
  }
 }
 function assertPage(currentUrl){if(isTest)assertAction('inspect-page',{},currentUrl);}
 function assertManifest(input){if(!isTest)return;assertInput(input);if(input?.existingApplicationReference||input?.submissionUncertain===true)refuse('RAAD_TEST_EXISTING_APPLICATION_FORBIDDEN');}
 function requestAllowed(request){
  if(!isTest)return true;
  try{
   const raw=request.url(),u=new URL(raw),method=request.method(),type=request.resourceType();
   if(u.origin!==ORIGIN||u.username||u.password||u.hash||u.pathname.includes('%')||!['GET','HEAD','POST'].includes(method))return false;
   // Query strings are not accepted for document/actions; even an innocuous
   // alias can select a server action. Static cache versions are also refused.
   if(u.search)return false;
   if(method==='POST')return request.redirectedFrom()===null&&['/Account/Loginindividuals','/SmartForm/SendOtpSms'].includes(u.pathname)&&['document','xhr','fetch'].includes(type);
   if(type==='document')return VIEWS.has(u.pathname);
   const extensions={script:/\.js$/i,stylesheet:/\.css$/i,image:/\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/i,font:/\.(?:woff2?|ttf|otf)$/i};
   return Object.hasOwn(extensions,type)&&extensions[type].test(u.pathname)&&!/(?:^|\/)(?:save|submit|confirm|pay|payment|delete|cancel|logout|logoff)[^/]*(?:\/|$)/i.test(u.pathname);
  }catch{return false;}
 }
 const policy=Object.freeze({mode,isTest,assertInput,assertAction,assertPage,assertManifest,requestAllowed,
  assertSubmissionAllowed(){if(isTest)refuse();},
  assertRawPageAllowed(){if(isTest)refuse('RAAD_TEST_RAW_PAGE_BLOCKED');},
  health(){return isTest?{executionMode:mode,nonSubmittingTest:true,submissionEnabled:false,paymentEnabled:false}:{}}});
 policies.add(policy);return policy;
}
function bindPageExecutionPolicy(page,policy){if(!page||!policies.has(policy)||pagePolicies.has(page)&&pagePolicies.get(page)!==policy)throw Object.assign(Error('RAAD_EXECUTION_POLICY_BINDING_INVALID'),{code:'RAAD_EXECUTION_POLICY_BINDING_INVALID'});pagePolicies.set(page,policy);}
function assertPageAction(page,action,data){const policy=pagePolicies.get(page);if(policy)policy.assertAction(action,data,page.url());}
function assertPageDestination(page,url){const policy=pagePolicies.get(page);if(policy)policy.assertPage(url);}
module.exports={createExecutionPolicy,bindPageExecutionPolicy,assertPageAction,assertPageDestination,createTestBridgeConfig,testAdmissionStatus};
