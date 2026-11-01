'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createDocumentProbe} = require('../src/visa-document-probe');
const {createDocumentVision} = require('../src/visa-document-vision');
const {createVisaSetup} = require('../src/visa-setup-http');
const FIELDS = {visiblePassportNumber:'ZT1234567',latinFirstName:'EXAMPLE',latinFamilyName:'TESTER',birthDate:'1990-04-03',expiryDate:'2035-11-30'};
const extracted = () => ({version:1,kind:'passport',readable:true,rotation:0,mrzLines:[],fields:Object.fromEntries(Object.entries(FIELDS).map(([key,value])=>[key,{value,visible:true,confidence:.999}]))});

test('fixed synthetic probe uses the real guarded adapter without cancelling its own busy request', async () => {
 let calls=0;
 const vision=createDocumentVision({env:{RAAD_DOCUMENT_OCR_ENABLED:'true',CLINE_API_KEY:'synthetic-key'},fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.cline.bot/api/v1/chat/completions');const request=JSON.parse(options.body);
  assert.ok(request.messages[1].content[1].image_url.url.length>1000);
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(extracted())}}]}),{status:200,headers:{'Content-Type':'application/json'}});
 }});
 const probe=createDocumentProbe({vision});const result=await probe();
 assert.equal(result.ok,true);assert.equal(result.fieldsRead,5);assert.equal(calls,1);
 assert.equal(JSON.stringify(result).includes('ZT1234567'),false);
 assert.equal((await probe()).error,'DOCUMENT_PROBE_COOLDOWN');assert.equal(calls,1);
});

test('unavailable and concurrent probes cannot start additional provider calls or leak failures', async () => {
 assert.equal((await createDocumentProbe({vision:{ready:()=>false}})()).error,'DOCUMENT_VISION_NOT_READY');
 let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});
 const probe=createDocumentProbe({vision:{ready:()=>true,extract:async()=>{entered();await new Promise(resolve=>{release=resolve;});throw Error('private fake secret response');}}});
 const first=probe();await waiting;assert.equal((await probe()).error,'DOCUMENT_PROBE_BUSY');release();
 const result=await first;assert.equal(result.error,'DOCUMENT_PROBE_UNAVAILABLE');assert.equal(JSON.stringify(result).includes('private'),false);
});

test('a readable but incorrectly extracted diagnostic is reported as failed rather than successful OCR', async () => {
 const value=extracted();value.fields.birthDate.value='1991-04-03';
 const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>value}})();
 assert.equal(result.ok,false);assert.equal(result.providerResponded,true);assert.equal(result.fieldsRead,4);assert.equal(result.status,422);assert.equal(result.stage,'verify');
});

test('probe exposes only known fixed vision reason codes and never raw provider explanations', async () => {
 for(const code of ['DOCUMENT_VISION_TIMEOUT','DOCUMENT_VISION_RATE_LIMITED','DOCUMENT_VISION_STALE','DOCUMENT_VISION_INVALID_OUTPUT','DOCUMENT_VISION_INCOMPLETE','DOCUMENT_VISION_INVALID_JSON','DOCUMENT_VISION_RESPONSE_TOO_LARGE','DOCUMENT_VISION_SCHEMA_INVALID']){
  const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_EXPLANATION_AND_SECRET'),{code,cause:{secret:'PRIVATE_VALUE'}});}}})();
  assert.deepEqual(result,{ok:false,synthetic:true,error:'DOCUMENT_PROBE_UNAVAILABLE',status:503,stage:'infer',reason:code});
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
 }
 for(const failure of [Error('DOCUMENT_VISION_TIMEOUT'),Object.assign(Error('PRIVATE_ERROR'),{code:'DOCUMENT_VISION_PRIVATE_SECRET'}),Object.assign(Error('PRIVATE_ERROR'),{code:{toString(){assert.fail('must not coerce provider values');}}}),{get code(){throw Error('PRIVATE_GETTER');}}]){
  const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>{throw failure;}}})();
  assert.equal(result.error,'DOCUMENT_PROBE_UNAVAILABLE');assert.equal(result.stage,'infer');assert.equal(Object.hasOwn(result,'reason'),false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
 }
 let reads=0;
 const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>{throw {get code(){return ++reads===1?'DOCUMENT_VISION_TIMEOUT':'PRIVATE_CHANGED_GETTER';}};}}})();
 assert.equal(result.reason,'DOCUMENT_VISION_TIMEOUT');assert.equal(reads,1);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('live-shaped strict schema rejection projects only its known section and field name', async () => {
 const value=extracted();value.fields.birthDate.value='PRIVATE_INVALID_DATE';
 const vision=createDocumentVision({env:{RAAD_DOCUMENT_OCR_ENABLED:'true',CLINE_API_KEY:'synthetic-key'},fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'```json\n'+JSON.stringify(value)+'\n```'}}]}),{status:200,headers:{'Content-Type':'application/json'}})});
 const result=await createDocumentProbe({vision})();
 assert.deepEqual(result,{ok:false,synthetic:true,error:'DOCUMENT_PROBE_UNAVAILABLE',status:503,stage:'infer',reason:'DOCUMENT_VISION_SCHEMA_INVALID',schemaSection:'fields',fieldName:'birthDate',schemaIssue:'value_format'});
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('synthetic five-field probe succeeds when absent father and grandfather fields use nullable provider forms', async () => {
 const value=extracted();value.fields.latinFatherName=null;value.fields.latinGrandfatherName={value:null,confidence:1,visible:true};value.fields.arabicFatherName={value:null,confidence:null,visible:null};
 const vision=createDocumentVision({env:{RAAD_DOCUMENT_OCR_ENABLED:'true',CLINE_API_KEY:'synthetic-key'},fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]}),{status:200,headers:{'Content-Type':'application/json'}})});
 const result=await createDocumentProbe({vision})();
 assert.equal(result.ok,true);assert.equal(result.fieldsRead,5);assert.equal(result.status,200);assert.equal(JSON.stringify(result).includes('ZT1234567'),false);
});

test('probe schema diagnostics discard unknown keys, values, sections and irrelevant fields', async () => {
 for(const diagnostic of [
  {code:'DOCUMENT_VISION_SCHEMA_INVALID',schemaSection:'PRIVATE_SECTION',fieldName:'PRIVATE_FIELD'},
  {code:'DOCUMENT_VISION_SCHEMA_INVALID',schemaSection:'fields',fieldName:'PRIVATE_FIELD',schemaIssue:'PRIVATE_ISSUE'},
  {code:'DOCUMENT_VISION_TIMEOUT',schemaSection:'fields',fieldName:'passportNumber'},
  {code:'DOCUMENT_VISION_SCHEMA_INVALID',get schemaSection(){throw Error('PRIVATE_GETTER');}}
 ]){
  const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>{throw diagnostic;}}})();
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(Object.hasOwn(result,'fieldName'),false);
  if(diagnostic.code==='DOCUMENT_VISION_TIMEOUT')assert.equal(Object.hasOwn(result,'schemaSection'),false);
 }
 let reads=0;
 const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>{throw {code:'DOCUMENT_VISION_SCHEMA_INVALID',schemaSection:'fields',get fieldName(){return ++reads===1?'passportNumber':'PRIVATE_CHANGED_FIELD';}};}}})();
 assert.equal(result.fieldName,'passportNumber');assert.equal(reads,1);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('render and verification failures retain distinct fixed stages without private content', async () => {
 const sharp=require('sharp'),png=sharp.prototype.png;
 try{
  sharp.prototype.png=function(){throw Error('PRIVATE_RENDERER_FAILURE');};
  const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>assert.fail('a rendering failure cannot disclose an image')}})();
  assert.deepEqual(result,{ok:false,synthetic:true,error:'DOCUMENT_PROBE_UNAVAILABLE',status:503,stage:'render'});
 }finally{sharp.prototype.png=png;}
 const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>({get fields(){throw Error('PRIVATE_VERIFY_FAILURE');}})}})();
 assert.deepEqual(result,{ok:false,synthetic:true,error:'DOCUMENT_PROBE_UNAVAILABLE',status:503,stage:'verify'});
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('setup probe requires accountant authority and never accepts a caller-provided document or prompt', async () => {
 let calls=0;const key='synthetic-accountant-key-for-probe-000000000';
 const handle=createVisaSetup({env:{RAAD_ACCOUNTANT_KEY:key},documentVision:{ready:()=>true,extract:async input=>{calls++;assert.equal(input.mimeType,'image/png');assert.ok(input.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));return extracted();}},fetchImpl:async()=>assert.fail('probe must not query or create Meta templates')});
 async function invoke(accountant){let status,data;await handle({method:'POST',headers:{'x-accountant-key':accountant},body:'untrusted customer data'}, {writeHead(code){status=code;return this;},end(value){data=JSON.parse(value);}},new URL('https://example.test/internal/assistant/visa-portal/document-ocr/probe'));return {status,data};}
 assert.equal((await invoke('wrong')).status,403);assert.equal(calls,0);
 const result=await invoke(key);assert.equal(result.status,200);assert.equal(result.data.synthetic,true);assert.equal(calls,1);
});

test('HTTP rejection diagnostics expose only a finite integer status without provider messages',async()=>{
 for(const [providerStatus,expected]of [[500,500],['PRIVATE_SECRET',undefined],[NaN,undefined],[900,undefined]]){
  const result=await createDocumentProbe({vision:{ready:()=>true,extract:async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_MESSAGE'),{code:'DOCUMENT_VISION_PROVIDER_UNAVAILABLE',providerStatus});}}})();
  assert.equal(result.providerStatus,expected);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
 }
});
