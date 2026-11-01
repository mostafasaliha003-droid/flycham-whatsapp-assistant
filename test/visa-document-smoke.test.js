'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runDocumentSmoke}=require('../src/visa-document-smoke');
const {POLICY_FINGERPRINT}=require('../src/visa-document-vision');
const env={RAAD_DOCUMENT_OCR_SMOKE_ENABLED:'true'};
const fields={visiblePassportNumber:'ZT1234567',latinFirstName:'EXAMPLE',latinFamilyName:'TESTER',birthDate:'1990-04-03',expiryDate:'2035-11-30'};
test('synthetic startup verification persists intent and never replays completed or interrupted checks',async()=>{
 let calls=0,saves=0;const reports=[],store={data:{},save(){saves++;}},vision={ready:()=>true,extract:async()=>{assert.equal(store.data.documentVisionSmoke.state,'running');assert.equal(saves,1);calls++;return{kind:'passport',readable:true,fields:Object.fromEntries(Object.entries(fields).map(([k,value])=>[k,{value,visible:true}]))};}};
 const options={vision,store,env,report:r=>reports.push(r)};
 const result=await runDocumentSmoke(options);assert.equal(result.ok,true);assert.equal(result.fieldsRead,5);assert.equal(calls,1);assert.equal(saves,2);
 await runDocumentSmoke(options);assert.equal(calls,1);assert.equal(reports.at(-1).reused,true);
 store.data.documentVisionSmoke={policy:POLICY_FINGERPRINT,state:'running'};await runDocumentSmoke(options);assert.equal(calls,1);
 assert.equal(JSON.stringify(reports).includes('ZT1234567'),false);
});
test('disabled, unavailable and unsaved diagnostics cannot dispatch a model request',async()=>{
 let calls=0;const vision={ready:()=>true,extract:async()=>{calls++;throw Error('must not call');}},report=()=>{};
 await runDocumentSmoke({vision,store:{data:{},save(){}},env:{},report});
 await runDocumentSmoke({vision:{...vision,ready:()=>false},store:{data:{},save(){}},env,report});
 await runDocumentSmoke({vision,store:{data:{},save(){throw Error('PRIVATE_KEY');}},env,report});
 assert.equal(calls,0);
});

test('an explicit higher diagnostic attempt runs once and cannot be replayed by lowering its number',async()=>{
 let calls=0;const store={data:{documentVisionSmoke:{policy:POLICY_FINGERPRINT,state:'completed',attempt:1}},save(){}},vision={ready:()=>true,extract:async()=>{calls++;return{kind:'other',readable:false,fields:{}};}},options={store,vision,report:()=>{},env:{...env,RAAD_DOCUMENT_OCR_SMOKE_ATTEMPT:'2'}};
 await runDocumentSmoke(options);await runDocumentSmoke(options);await runDocumentSmoke({...options,env});
 assert.equal(calls,1);assert.equal(store.data.documentVisionSmoke.attempt,2);
 await runDocumentSmoke({...options,env:{...env,RAAD_DOCUMENT_OCR_SMOKE_ATTEMPT:'4'}});assert.equal(calls,1);
});
