'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const {VisaUploadService}=require('../src/visa-upload');
const {createVisaMrzConsent}=require('../src/visa-mrz-consent');
const base='https://upload.example.test',customer='971500000001';
const option={available:true,provider:'openai',readerFingerprint:'b'.repeat(64),inputPolicy:'upright_page_internal_mrz_crop_v1',policySha256:'c'.repeat(64)};
function fixture({enabled=true}={}){
 let clock=1000001,owned=false,blocked=false;const complete=[],revoked=[];
 const store={data:{visaCases:{[customer]:{id:crypto.randomUUID(),applicantCount:1,applicants:[{nationality:'synthetic'}],documents:[],submissionStatus:'not_submitted'}},visaMedia:{}},save(){this.saves=(this.saves||0)+1;}};
 const media={durable:true,records:store.data.visaMedia,get(id,{customer}){const r=this.records[id];if(!r||r.customer!==customer)throw Error('MEDIA_NOT_FOUND');return r;},activateUploads(customer,{sessionId,mediaIds,guard}){guard();const original=structuredClone(this.records);for(const id of mediaIds){const r=this.records[id];assert.equal(r.purpose,'visa_upload_staged');assert.equal(r.uploadSessionId,sessionId);delete r.purpose;r.status='pending_review';r.uploadCommittedAt=clock;}try{store.save();}catch(e){for(const id of mediaIds)this.records[id]=original[id];throw e;}}};
 const consents=createVisaMrzConsent({store,now:()=>clock}),inbox={isHumanOwned:()=>owned,isBlocked:()=>blocked},service=new VisaUploadService({store,mediaStore:media,inbox,env:{RENDER_EXTERNAL_URL:base},now:()=>clock,mrzConsentOptions:()=>enabled?option:null,mrzConsents:consents,onComplete:input=>complete.push({input,persisted:structuredClone(store.data)}),onConsentRevoked:input=>revoked.push({input,persisted:structuredClone(store.data)})});
 const link=service.createLink(customer),token=new URL(link.url).hash.slice(1),session=Object.values(store.data.visaUpload.sessions)[0];
 function add(role='passport',{withdrawn=false}={}){const id=crypto.randomUUID(),r={id,customer,checksum:'a'.repeat(64),uploadRole:role,uploadSessionId:session.id,uploadCaseId:session.caseId,purpose:'visa_upload_staged',status:'upload_staged',expiresAt:clock+200000,size:200,mimeType:'image/png'};media.records[id]=r;session.files.push({id,role,size:200,mimeType:'image/png',...(withdrawn?{withdrawn:true}:{})});return r;}
 return{store,media,consents,service,session,token,complete,revoked,add,setOwned:value=>owned=value,setBlocked:value=>blocked=value,setNow:value=>clock=value};
}
async function request(f,{method='POST',route='complete',body,raw,headers={},stream}={}){
 const bytes=raw===undefined?body===undefined?null:Buffer.from(JSON.stringify(body)):Buffer.from(raw),req=stream||Readable.from(bytes?[bytes]:[]);req.method=method;req.headers={authorization:'Bearer '+f.token,...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{}),...headers};let status,result;
 await f.service.handleRequest(req,{writeHead(value){status=value;return this;},end(value){result=JSON.parse(value);}},new URL(base+'/api/visa-upload/'+route));return{status,body:result};
}
const yes=()=>({mrzConsent:{accepted:true,policySha256:option.policySha256}});
test('default disabled upload response and completion stay unchanged and never write consent state',async()=>{
 const f=fixture({enabled:false});f.add();assert.equal((await request(f,{route:'session',method:'GET'})).body.mrzConsent,undefined);assert.equal((await request(f,{body:yes()})).status,200);assert.equal(f.complete.length,1);assert.equal(Object.hasOwn(f.complete[0].input,'mrzConsent'),false);assert.equal(f.store.data.visaMrzConsent,undefined);
});
test('advertised option is bounded static and only an exact affirmative matching policy completion grants',async()=>{
 for(const body of [undefined,{}, {mrzConsent:{accepted:false}}, {mrzConsent:{accepted:true}}, {mrzConsent:{accepted:true,policySha256:'d'.repeat(64)}}]){const f=fixture();f.add();assert.equal((await request(f,{body})).status,200);assert.equal(f.store.data.visaMrzConsent,undefined);assert.equal(f.complete[0].input.mrzConsent,undefined);}
 const f=fixture(),passport=f.add(),residence=f.add('residence'),photo=f.add('photo'),withdrawn=f.add('passport',{withdrawn:true});
 const view=(await request(f,{route:'session',method:'GET'})).body;assert.deepEqual(Object.keys(view.mrzConsent).sort(),['available','description','inputPolicy','policySha256','provider','readerFingerprint']);assert.match(view.mrzConsent.description,/اختياري/);assert.match(view.mrzConsent.description,/OpenAI/);
 const done=await request(f,{body:yes()});assert.equal(done.status,200);assert.equal(done.body.mrzConsent,undefined);const {input,persisted}=f.complete[0];assert.deepEqual(Object.keys(input.mrzConsent).sort(),[passport.id,residence.id].sort());assert.equal(input.mrzConsent[photo.id],undefined);assert.equal(input.mrzConsent[withdrawn.id],undefined);assert.equal(input.sessionId,f.session.id);
 for(const id of [passport.id,residence.id]){const ref=input.mrzConsent[id];assert.ok(persisted.visaMrzConsent.items[ref.consentId]);assert.equal(f.consents.verify(ref,{customer,caseId:f.session.caseId,caseSignature:f.session.caseSignature,source:f.media.records[id],...option}),true);}
});
test('old completed sessions and completion retries cannot acquire or redeliver consent',async()=>{
 for(const first of [undefined,yes()]){const f=fixture();f.add();await request(f,{body:first});const before=JSON.stringify(f.store.data.visaMrzConsent);await request(f,{body:yes()});assert.equal(f.complete.length,1);assert.equal(JSON.stringify(f.store.data.visaMrzConsent),before);}
});
test('unknown client scope/profile, malformed, oversized, length-mismatched and cross-origin bodies cannot grant',async()=>{
 for(const args of [
  {body:{...yes(),mediaIds:[crypto.randomUUID()]}},{body:{mrzConsent:{...yes().mrzConsent,provider:'openai'}}},{body:{mrzConsent:{...yes().mrzConsent,readerFingerprint:'d'.repeat(64)}}},{raw:'{'},{raw:'[]'},{raw:' '.repeat(1025)},{raw:'{}',headers:{'content-type':'text/plain'}},{raw:'{}',headers:{'content-length':'3'}},{body:yes(),headers:{origin:'https://evil.test'}},{body:yes(),headers:{'sec-fetch-site':'cross-site'}}
 ]){const f=fixture();f.add();const result=await request(f,args);assert.ok(result.status>=400);assert.equal(f.session.state,'open');assert.equal(f.complete.length,0);assert.equal(f.store.data.visaMrzConsent,undefined);}
});
test('case, claim or block changing while completion arrives cancels all consent and completion',async()=>{
 for(const change of [f=>f.setOwned(true),f=>f.setBlocked(true),f=>f.store.data.visaCases[customer].applicantCount++]){const f=fixture();f.add();const raw=JSON.stringify(yes()),stream=Readable.from((async function*(){yield raw.slice(0,10);change(f);yield raw.slice(10);})());const result=await request(f,{stream,headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(raw))}});assert.equal(result.status,409);assert.equal(f.complete.length,0);assert.equal(f.store.data.visaMrzConsent,undefined);}
});
test('consent save ambiguity completes upload locally and never grants on retry',async()=>{
 const f=fixture();f.add();const save=f.store.save;let ambiguous;
 f.store.save=function(){if(this.data.visaMrzConsent){ambiguous=structuredClone(this.data);throw Error('synthetic ambiguous write');}return save.call(this);};
 assert.equal((await request(f,{body:yes()})).status,200);assert.ok(ambiguous.visaMrzConsent);assert.deepEqual(f.complete[0].input.mrzConsent,{});assert.equal(f.store.data.visaMrzConsent,undefined);f.store.save=save;await request(f,{body:yes()});assert.equal(f.complete.length,1);assert.equal(f.store.data.visaMrzConsent,undefined);
});
test('activation save ambiguity prevents a later opt-in retry from granting',async()=>{
 const f=fixture();f.add();const save=f.store.save;f.store.save=()=>{throw Error('synthetic fsync ambiguity');};assert.equal((await request(f,{body:yes()})).status,503);assert.equal(f.session.state,'open');assert.equal(f.session.mrzConsentDenied,true);f.store.save=save;assert.equal((await request(f,{body:yes()})).status,200);assert.equal(f.store.data.visaMrzConsent,undefined);assert.equal(f.complete[0].input.mrzConsent,undefined);
});
test('observed staff ownership invalidates an existing grant even after ownership release',async()=>{
 const f=fixture(),source=f.add();await request(f,{body:yes()});const ref=f.complete[0].input.mrzConsent[source.id];f.setOwned(true);assert.equal((await request(f,{route:'session',method:'GET'})).status,409);f.setOwned(false);assert.equal(f.consents.verify(ref,{customer,caseId:f.session.caseId,caseSignature:f.session.caseSignature,source,...option}),false);
});

test('current authenticated completed session can revoke only its own consent before callback without deleting files',async()=>{
 const f=fixture(),source=f.add();const done=await request(f,{body:yes()});assert.equal(done.body.mrzConsentRevocable,true);const ref=f.complete[0].input.mrzConsent[source.id],beforeCase=structuredClone(f.store.data.visaCases[customer]),beforeMedia=structuredClone(f.store.data.visaMedia);
 const result=await request(f,{route:'mrz-consent/revoke'});assert.equal(result.status,200);assert.equal(result.body.state,'completed');assert.equal(result.body.mrzConsentRevocable,undefined);assert.equal(f.revoked.length,1);assert.deepEqual(f.revoked[0].input,{customer,sessionId:f.session.id});assert.ok(Number.isFinite(f.revoked[0].persisted.visaMrzConsent.items[ref.consentId].revokedAt));assert.equal(f.consents.verify(ref,{customer,caseId:f.session.caseId,caseSignature:f.session.caseSignature,source,...option}),false);assert.deepEqual(f.store.data.visaCases[customer],beforeCase);assert.deepEqual(f.store.data.visaMedia,beforeMedia);assert.equal(f.complete.length,1);
 const saves=f.store.saves;assert.equal((await request(f,{route:'mrz-consent/revoke'})).status,200);assert.equal(f.complete.length,1);assert.equal(f.revoked.length,1);assert.equal(f.store.saves,saves);
});
test('revocation has bounded empty scope, same origin and bearer authorization, with default disabled route unchanged',async()=>{
 const off=fixture({enabled:false});off.add();assert.equal((await request(off,{route:'mrz-consent/revoke'})).status,405);assert.equal(off.store.data.visaMrzConsent,undefined);
 for(const args of [{body:{sessionId:crypto.randomUUID()}},{body:{mediaId:crypto.randomUUID()}},{body:{mrzConsent:{accepted:false}}},{raw:' '.repeat(65)},{raw:'[]'},{raw:'{}',headers:{origin:'https://evil.test'}},{headers:{authorization:'Bearer '+'x'.repeat(43)}}]){
  const f=fixture(),source=f.add();await request(f,{body:yes()});const ref=f.complete[0].input.mrzConsent[source.id],result=await request(f,{route:'mrz-consent/revoke',...args});assert.ok(result.status>=400);assert.equal(f.revoked.length,0);assert.equal(f.consents.verify(ref,{customer,caseId:f.session.caseId,caseSignature:f.session.caseSignature,source,...option}),true);
 }
});
test('ambiguous revoke reports failure, poisons verification and remains retryable until revocation is durably saved',async()=>{
 const f=fixture(),source=f.add();await request(f,{body:yes()});const ref=f.complete[0].input.mrzConsent[source.id],save=f.store.save;f.store.save=()=>{throw Error('synthetic revoke fsync ambiguity');};
 assert.equal((await request(f,{route:'mrz-consent/revoke'})).status,503);assert.equal(f.consents.healthy,false);assert.equal(f.revoked.length,0);assert.equal((await request(f,{route:'session',method:'GET'})).body.mrzConsentRevocable,true);assert.equal(f.consents.verify(ref,{customer,caseId:f.session.caseId,caseSignature:f.session.caseSignature,source,...option}),false);
 f.store.save=save;assert.equal((await request(f,{route:'mrz-consent/revoke',body:{}})).status,200);assert.equal(f.revoked.length,1);assert.equal(f.consents.healthy,false);assert.equal((await request(f,{route:'session',method:'GET'})).body.mrzConsentRevocable,undefined);
});
