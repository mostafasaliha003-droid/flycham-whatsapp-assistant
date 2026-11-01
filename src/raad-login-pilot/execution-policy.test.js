'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createExecutionPolicy,bindPageExecutionPolicy,testAdmissionStatus}=require('./execution-policy');
const {activatePortalButton}=require('./portal-button');
const {activatePortalConfirmation}=require('./portal-confirmation');
const {navigateObservedLink}=require('./portal-navigation');
const URL_BASE='https://visa.mofa.gov.sa',MODE='non_submitting_test';
const policy=()=>createExecutionPolicy({RAAD_EXECUTION_MODE:MODE});
function request(path,{method='GET',type='document',redirected=false}={}){return {url:()=>URL_BASE+path,method:()=>method,resourceType:()=>type,redirectedFrom:()=>redirected?{}:null};}
const rejects=(fn,code)=>assert.throws(fn,error=>error.code===code&&error.notDispatched===true);

test('only absent mode or explicit production retain default production policy',()=>{
 for(const env of [{},{RAAD_EXECUTION_MODE:'production'}]){const p=createExecutionPolicy(env);assert.equal(p.isTest,false);assert.deepEqual(p.health(),{});p.assertAction('arbitrary-existing-production-hook');p.assertSubmissionAllowed();p.assertRawPageAllowed();assert.equal(p.requestAllowed({}),true);}
});
test('invalid configured modes fail closed at construction, including empty or misspelled values',()=>{
 for(const value of ['',null,false,0,'false','non-submitting-test','NON_SUBMITTING_TEST','non_submitting_test ',' test '])rejects(()=>createExecutionPolicy({RAAD_EXECUTION_MODE:value}),'RAAD_EXECUTION_MODE_INVALID');
});
test('test mode is immutable and cannot be downgraded by mutating the source environment',()=>{
 const env={RAAD_EXECUTION_MODE:MODE},p=createExecutionPolicy(env);env.RAAD_EXECUTION_MODE='production';assert.equal(p.mode,MODE);assert.equal(Object.isFrozen(p),true);rejects(()=>p.assertSubmissionAllowed(),'RAAD_TEST_SUBMISSION_BLOCKED');assert.equal(p.health().submissionEnabled,false);
});
test('test request payloads cannot override execution policy at any depth',()=>{
 const p=policy();for(const key of ['executionMode','execution_mode','RAAD_EXECUTION_MODE','nonSubmittingTest','allowSubmission','allowSubmit','testMode','dryRun','RAAD_TEST_MAIN_URL','RAAD_TEST_APPROVED_MAIN_ORIGIN','RAAD_TEST_JOB_BRIDGE_KEY','RAAD_MAIN_URL','RAAD_JOB_BRIDGE_KEY','testMainUrl','testBridgeKey'])for(const data of [{[key]:'production'},{fields:{[key]:false}}])rejects(()=>p.assertInput(data),'RAAD_TEST_MODE_OVERRIDE_FORBIDDEN');
});
test('submit, next and unknown activation modes are denied independently of labels/readback fields',()=>{
 const p=policy();for(const mode of ['submit','next','agreement ',undefined,'production'])rejects(()=>p.assertAction('activate-control',{mode,label:'Save',expectedFields:[{id:'PASSPORTnumber',kind:'text',expectedValue:'TEST001'}]},URL_BASE+'/SmartForm/TraditionalApp'),'RAAD_TEST_SUBMISSION_BLOCKED');
});
test('agreement activation is limited to the fixed agreement page and original consent wording',()=>{
 const p=policy();p.assertAction('activate-control',{mode:'agreement',label:'Agree'},URL_BASE+'/SmartForm/Agreement');
 for(const [path,label]of [['/SmartForm/TraditionalApp','Agree'],['/SmartForm/Agreement','Save'],['/SmartForm/ElectronicAgreement','Agree']])rejects(()=>p.assertAction('activate-control',{mode:'agreement',label},URL_BASE+path),'RAAD_TEST_SUBMISSION_BLOCKED');
});
test('confirmation and all unknown native actions are denied before dispatch',()=>{
 const p=policy();rejects(()=>p.assertAction('confirm-application',{label:'استمرار'}),'RAAD_TEST_SUBMISSION_BLOCKED');for(const a of ['save','payment','pay','confirm','evaluate','execute-script','activate-control/../submit',''])rejects(()=>p.assertAction(a,{}),'RAAD_TEST_ACTION_BLOCKED');
});
test('saved insurance, payment continuations and unknown navigation are denied',()=>{
 const p=policy();for(const path of ['/Payment/Summary','/SmartForm/PayFee/123','/SmartForm/HealthInsurance/123','/SmartForm/HealthInsuranceInfo/123','/SmartForm/PrintApplication/123','/SmartForm/Save','/unexpected'])rejects(()=>p.assertAction('open-page',{path}),'RAAD_TEST_SUBMISSION_BLOCKED');
 rejects(()=>p.assertAction('open-page',{path:'/SmartForm',viewPaymentDetails:true}),'RAAD_TEST_SUBMISSION_BLOCKED');
 p.assertAction('open-page',{path:'/SmartForm'});p.assertAction('open-page',{path:'/SmartForm/TraditionalApp',acceptAgreement:true});
});
test('existing application manifests and uncertain prior submissions cannot enter test execution',()=>{
 const p=policy();for(const input of [{existingApplicationReference:'E123456'},{submissionUncertain:true}])rejects(()=>p.assertManifest(input),'RAAD_TEST_EXISTING_APPLICATION_FORBIDDEN');p.assertManifest({fields:{passportNumber:'TEST001'}});
});
test('raw page callbacks are denied in test mode',()=>rejects(()=>policy().assertRawPageAllowed(),'RAAD_TEST_RAW_PAGE_BLOCKED'));
test('browser fence allows only fixed official document GET views',()=>{
 const p=policy();for(const path of ['/Account/Loginindividuals','/SmartForm','/SmartForm/Agreement','/SmartForm/ElectronicAgreement','/SmartForm/TraditionalApp'])assert.equal(p.requestAllowed(request(path)),true);
 for(const path of ['/SmartForm/Save','/Payment/Summary','/SmartForm?save=true','/SmartForm/%54raditionalApp','//SmartForm','/SmartForm/TraditionalApp/','/Account/Unexpected'])assert.equal(p.requestAllowed(request(path)),false,path);
});
test('browser fence denies every unapproved mutation endpoint and HTTP method',()=>{
 const p=policy();for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','post'])for(const path of ['/SmartForm/TraditionalApp','/SmartForm/Save','/SmartForm/HealthInsuranceInfo/123','/Payment/Summary','/unexpected'])assert.equal(p.requestAllowed(request(path,{method,type:'xhr'})),false);
});
test('only exact existing login and observed SMS POST contracts are allowlisted, without redirect or query',()=>{
 const p=policy();for(const path of ['/Account/Loginindividuals','/SmartForm/SendOtpSms']){assert.equal(p.requestAllowed(request(path,{method:'POST',type:'xhr'})),true);assert.equal(p.requestAllowed(request(path,{method:'POST',type:'xhr',redirected:true})),false);assert.equal(p.requestAllowed(request(path+'?action=save',{method:'POST',type:'xhr'})),false);assert.equal(p.requestAllowed(request(path,{method:'POST',type:'image'})),false);}
});
test('known static extension/resource-type pairs are allowed; unknown fetch and external assets are denied',()=>{
 const p=policy();for(const [path,type]of [['/Content/site.css','stylesheet'],['/Scripts/site.js','script'],['/Content/logo.png','image'],['/fonts/font.woff2','font']])assert.equal(p.requestAllowed(request(path,{type})),true);
 for(const [path,type]of [['/SmartForm/GetUnknown','xhr'],['/Content/site.css?v=1','stylesheet'],['/SmartForm/Save.png','image'],['/Content/site.js','fetch']])assert.equal(p.requestAllowed(request(path,{type})),false);
 const external=request('/Content/site.js',{type:'script'});external.url=()=> 'https://external.example/Content/site.js';assert.equal(p.requestAllowed(external),false);
});
test('native button/confirmation/navigation functions enforce a bound test policy before any DOM operation',async()=>{
 let touches=0;const page={url:()=>URL_BASE+'/SmartForm/TraditionalApp',evaluate:()=>{touches++;},evaluateHandle:()=>{touches++;},goto:()=>{touches++;}};bindPageExecutionPolicy(page,policy());
 await assert.rejects(()=>activatePortalButton(page,{mode:'submit',label:'Save'}),e=>e.code==='RAAD_TEST_SUBMISSION_BLOCKED');
 await assert.rejects(()=>activatePortalButton(page,{mode:'next',label:'Continue'}),e=>e.code==='RAAD_TEST_SUBMISSION_BLOCKED');
 await assert.rejects(()=>activatePortalConfirmation(page,{label:'استمرار'}),e=>e.code==='RAAD_TEST_SUBMISSION_BLOCKED');
 await assert.rejects(()=>navigateObservedLink(page,{path:'/SmartForm/PayFee/123',label:'بيانات الدفع',viewPaymentDetails:true}),e=>e.code==='RAAD_TEST_SUBMISSION_BLOCKED');assert.equal(touches,0);
});
test('a bound page cannot be rebound to a production policy or arbitrary lookalike',()=>{
 const page={url:()=>URL_BASE+'/SmartForm/TraditionalApp'},p=policy();bindPageExecutionPolicy(page,p);bindPageExecutionPolicy(page,p);assert.throws(()=>bindPageExecutionPolicy(page,createExecutionPolicy({})),e=>e.code==='RAAD_EXECUTION_POLICY_BINDING_INVALID');assert.throws(()=>bindPageExecutionPolicy({},Object.freeze({mode:MODE,isTest:true})),e=>e.code==='RAAD_EXECUTION_POLICY_BINDING_INVALID');
});

test('test admission requires a separate explicit callback and test bridge credential, with no production fallback',()=>{
 const base={RAAD_EXECUTION_MODE:MODE,RAAD_TEST_MAIN_URL:'http://127.0.0.1:19091/',RAAD_TEST_JOB_BRIDGE_KEY:'t'.repeat(43),RAAD_JOB_BRIDGE_KEY:'p'.repeat(43)};
 assert.equal(testAdmissionStatus(base).configured,true);
 for(const patch of [{RAAD_TEST_MAIN_URL:undefined},{RAAD_TEST_JOB_BRIDGE_KEY:undefined},{RAAD_TEST_JOB_BRIDGE_KEY:base.RAAD_JOB_BRIDGE_KEY},{RAAD_TEST_JOB_BRIDGE_KEY:'short'},{RAAD_TEST_JOB_BRIDGE_KEY:'x'.repeat(32)+'\n'},{RAAD_TEST_MAIN_URL:'https://flycham-whatsapp-assistant.onrender.com/'},{RAAD_MAIN_URL:'https://flycham-whatsapp-assistant.onrender.com/'},{RAAD_MAIN_URL:'https://different.example.test/'}])assert.equal(testAdmissionStatus({...base,...patch}).configured,false);
 const safe=testAdmissionStatus(base);assert.deepEqual(Object.keys(safe).sort(),['blocker','configured']);assert.doesNotMatch(JSON.stringify(safe),/http|tttt|pppp/);
});

test('test admission permits explicit numeric local HTTP only and refuses aliases, credentials, nonroot paths and query/hash',()=>{
 const base={RAAD_EXECUTION_MODE:MODE,RAAD_TEST_JOB_BRIDGE_KEY:'t'.repeat(43)};
 for(const url of ['http://localhost:19091/','http://2130706433:19091/','http://0x7f000001:19091/','http://127.0.0.1/','http://127.0.0.1:0/','http://0.0.0.0:19091/','http://127.0.0.2:19091/','http://127.0.0.1:19091/path','http://127.0.0.1:19091/?callback=prod','http://127.0.0.1:19091/#x','http://user:password@127.0.0.1:19091/','http://stage.example.test/'])assert.equal(testAdmissionStatus({...base,RAAD_TEST_MAIN_URL:url}).configured,false,url);
 assert.equal(testAdmissionStatus({...base,RAAD_TEST_MAIN_URL:'http://127.0.0.1:19091/'}).configured,true);
});

test('HTTPS test callback requires exact separate approved origin and matching carried main URL',()=>{
 const base={RAAD_EXECUTION_MODE:MODE,RAAD_TEST_JOB_BRIDGE_KEY:'t'.repeat(43),RAAD_TEST_MAIN_URL:'https://stage.example.test/'};
 assert.equal(testAdmissionStatus(base).configured,false);
 for(const origin of ['https://stage.example.test/','https://other.example.test','https://flycham-whatsapp-assistant.onrender.com','http://stage.example.test'])assert.equal(testAdmissionStatus({...base,RAAD_TEST_APPROVED_MAIN_ORIGIN:origin}).configured,false);
 const good={...base,RAAD_TEST_APPROVED_MAIN_ORIGIN:'https://stage.example.test'};assert.equal(testAdmissionStatus(good).configured,true);assert.equal(testAdmissionStatus({...good,RAAD_MAIN_URL:good.RAAD_TEST_MAIN_URL}).configured,true);
});
