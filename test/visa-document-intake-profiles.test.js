'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const sharp=require('sharp');
const {VisaDocumentIntake}=require('../src/visa-document-intake');
const {POLICY_FINGERPRINT,COMPATIBLE_PREVIOUS_POLICIES}=require('../src/visa-document-vision');
const CUSTOMER='15550001991',NOW=Date.parse('2026-10-31T08:00:00Z');
const INPUT_POLICY='upright_page_internal_mrz_crop_v1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=n=>'45000000-0000-4000-8000-'+String(n).padStart(12,'0');
const digit=value=>String([...value].reduce((sum,c,i)=>sum+(c==='<'?0:/\d/.test(c)?Number(c):c.charCodeAt(0)-55)*[7,3,1][i%3],0)%10);
function td3(){const first='P<UTOEXAMPLE<<SYNTHETIC'.padEnd(44,'<'),number='L898902C3',birth='740812',expiry='310101',optional='<'.repeat(14),body=number+digit(number)+'UTO'+birth+digit(birth)+'F'+expiry+digit(expiry)+optional+digit(optional);return[first,body+digit(body.slice(0,10)+body.slice(13,20)+body.slice(21,43))];}
function td1(){const first='I<UTO'+'D23145890'+digit('D23145890')+'<'.repeat(15),body='740812'+digit('740812')+'F'+'310101'+digit('310101')+'UTO'+'<'.repeat(11);return[first,body+digit(first.slice(5)+body.slice(0,7)+body.slice(8,15)+body.slice(18,29)),'EXAMPLE<<SYNTHETIC'.padEnd(30,'<')];}
const extracted=(kind,rotation=0,lines=[])=>({version:1,kind,readable:true,rotation,fields:kind==='passport'?Object.fromEntries([['birthDate','1974-08-12'],['latinFirstName','Synthetic'],['latinFamilyName','Example']].map(([name,value])=>[name,{value,visible:true,confidence:0.999}])):{},mrzLines:lines,portraitBox:null});
function remoteReader(extract,overrides={}){return{policyFingerprint:'a'.repeat(64),supports:format=>['TD1','TD3'].includes(format),status:()=>({configured:true,local:false,inputPolicy:INPUT_POLICY}),ready:()=>true,extract,...overrides};}
async function fixture({reader,profiles=null,kind='uae_id_back',rotation=0,caseId='synthetic-provider-case',customer=CUSTOMER}={}){
 const raw=Buffer.alloc(1200*800*3);for(let y=0;y<800;y++)for(let x=0;x<1200;x++){const at=(y*1200+x)*3;raw[at]=y<400?230:20;raw[at+1]=70;raw[at+2]=y<400?20:230;}
 const image=await sharp(raw,{raw:{width:1200,height:800,channels:3}}).png().toBuffer();
 const c={id:caseId,createdAt:NOW-10000,policyVersion:'synthetic-only',applicantCount:1,applicants:[{}],quote:{total:0},documents:[],paymentStatus:'unverified',submissionStatus:'not_submitted'};
 let visionCalls=0,saves=0;const records={},images=new Map(),epochs=new Map();
 const store={data:{visaCases:{[customer]:c},visaMedia:records},save(){saves++;}};
 const media={records,epochs,read(key,{customer:who}){const record=records[key];assert(record&&record.customer===who);return{metadata:structuredClone(record),bytes:Buffer.from(images.get(key))};}};
 const vision={ready:()=>true,status:()=>({configured:true}),extract:async({guard})=>{visionCalls++;guard();return extracted(kind,rotation);}};
 let held=false;const lock={tryAcquire(){if(held)return false;held=true;return true;},release(){held=false;}};
 const args={store,mediaStore:media,vision,mrzVision:reader,mrzProfiles:profiles,env:{RAAD_DOCUMENT_OCR_ENABLED:'true'},now:()=>NOW,lock,reconcile:()=>({issues:[],applicants:[],unassigned:[]})};
 const worker=new VisaDocumentIntake(args);
 function add(n){const mediaId=id(n);images.set(mediaId,Buffer.from(image));records[mediaId]={id:mediaId,customer,type:'image',mimeType:'image/png',size:image.length,checksum:hash(image),receivedAt:NOW-5000+n,expiresAt:NOW+60000};return mediaId;}
 const process=async(instance=worker)=>{for(let i=0;i<8;i++){await instance.tick();if(!Object.values(instance.data().jobs).some(job=>['queued','running'].includes(job.status)))break;}};
 const state=()=>worker.data().cases[customer];const job=()=>Object.values(worker.data().jobs)[0];
 return{worker,args,store,media,c,customer,records,images,image,add,process,state,job,counts:()=>({visionCalls,saves})};
}
function profilesFor(reader){
 const calls={bind:[],resolve:0,guard:0},state={approved:true};
 const profiles={
  bindNewJob(input){calls.bind.push(input);return {version:1,provider:'openai',readerFingerprint:reader.policyFingerprint,inputPolicy:INPUT_POLICY,consentId:input.mrzConsent.consentId,sourceId:input.source.id};},
  resolve(){calls.resolve++;return reader;},
  guard(){calls.guard++;if(!state.approved)throw Object.assign(Error('MRZ_PROFILE_APPROVAL_INVALID'),{code:'MRZ_PROFILE_APPROVAL_INVALID'});return true;}
 };
 return{profiles,calls,state};
}
function localReader(counter){return{supports:()=>true,status:()=>({configured:true,local:true}),ready:()=>true,extract:async()=>{counter.local++;return{version:1,mrzLines:td1()};}};}
const consent=n=>({consentId:'grant-'+n,consentDigest:String(n).repeat(64)});
test('default enqueue and backfill keep local reader and the unchanged global policy',async()=>{
 const count={local:0,remote:0},remote=remoteReader(async()=>{count.remote++;return{version:1,mrzLines:td1()};}),p=profilesFor(remote),f=await fixture({reader:localReader(count),profiles:p.profiles});f.add(1);await f.process();
 assert.equal(count.local,1);assert.equal(count.remote,0);assert.equal(p.calls.bind.length,0);assert.equal(p.calls.resolve,0);assert.equal(Object.hasOwn(f.job(),'mrzProfile'),false);assert.equal(f.state().policy,POLICY_FINGERPRINT);
});
test('only a newly enqueued explicit upload grant selects the per-job remote reader',async()=>{
 const count={local:0,remote:0},remote=remoteReader(async request=>{count.remote++;assert.equal(await request.guard(),true);assert.match(request.billingAttemptKey,/^[a-f0-9]{64}$/);return{version:1,mrzLines:td1()};}),p=profilesFor(remote),f=await fixture({reader:localReader(count),profiles:p.profiles}),first=f.add(1);
 assert.equal(f.worker.enqueue(f.customer,first,{mrzConsent:consent(1)}),true);const second=f.add(2);await f.process();
 const jobs=Object.values(f.worker.data().jobs);assert.equal(p.calls.bind.length,1);assert.equal(p.calls.bind[0].source,f.records[first]);assert.equal(p.calls.bind[0].source.purpose,undefined);assert.equal(count.remote,1);assert.equal(count.local,1);assert.equal(f.counts().visionCalls,2);
 const paid=jobs.find(job=>job.mediaId===first),local=jobs.find(job=>job.mediaId===second);assert(paid.mrzProfile);assert.equal(Object.hasOwn(local,'mrzProfile'),false);assert.equal(paid.pages[1].mrzProfileKey,f.worker.mrzProfileKey(paid));assert.equal(local.pages[1].mrzProfileKey,undefined);
 const restored=new VisaDocumentIntake(f.args);await f.process(restored);assert.equal(count.remote,1);assert.equal(p.calls.bind.length,1);
});
test('an existing local or waiting-first-case job never upgrades when a consent option appears later',async()=>{
 const count={local:0},p=profilesFor(remoteReader(async()=>{assert.fail('remote reader must not run');})),f=await fixture({reader:localReader(count),profiles:p.profiles}),first=f.add(1);
 f.worker.backfill();assert.equal(f.worker.enqueue(f.customer,first,{mrzConsent:consent(1)}),false);assert.equal(Object.hasOwn(f.job(),'mrzProfile'),false);assert.equal(p.calls.bind.length,0);
 const waiting=await fixture({reader:localReader(count),profiles:p.profiles}),second=waiting.add(2);delete waiting.store.data.visaCases[waiting.customer];waiting.worker.enqueue(waiting.customer,second,{mrzConsent:consent(2)});assert.equal(waiting.job().status,'waiting_case');assert.equal(Object.hasOwn(waiting.job(),'mrzProfile'),false);waiting.store.data.visaCases[waiting.customer]=waiting.c;await waiting.process();assert.equal(p.calls.bind.length,0);assert.equal(Object.hasOwn(waiting.job(),'mrzProfile'),false);
});
test('a profiled job fails closed without a resolver and never falls back to local or VIZ',async()=>{
 const count={local:0},reader=remoteReader(async()=>{assert.fail('remote extract');}),p=profilesFor(reader),f=await fixture({reader:localReader(count),profiles:p.profiles}),source=f.add(1);f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)});delete p.profiles.resolve;await f.process();assert.equal(f.job().status,'failed');assert.equal(count.local,0);assert.equal(f.counts().visionCalls,0);
});
test('snapshot binding detects in-place mutation and a removed profile',async()=>{
 for(const remove of [false,true]){const p=profilesFor(remoteReader(async()=>({version:1,mrzLines:td1()}))),f=await fixture({profiles:p.profiles}),source=f.add(1);f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)});const snapshot=f.worker.snapshot(f.job());if(remove)delete f.job().mrzProfile;else f.job().mrzProfile.consentId='changed-grant';assert.throws(()=>f.worker.guard(snapshot),{code:'DOCUMENT_INTAKE_STALE'});}
});
test('different immutable bindings cannot share source/page/VIZ or MRZ checkpoints',async()=>{
 let calls=0;const p=profilesFor(remoteReader(async()=>{calls++;return{version:1,mrzLines:td1()};})),f=await fixture({profiles:p.profiles});for(let n=1;n<=2;n++)f.worker.enqueue(f.customer,f.add(n),{mrzConsent:consent(n)});await f.process();assert.equal(calls,2);assert.equal(f.counts().visionCalls,2);assert.equal(Object.keys(f.state().mrzFocusReads).length,2);assert.equal(new Set(Object.values(f.worker.data().jobs).map(job=>job.pages[1].mrzProfileKey)).size,2);
});
test('revocation while a response is in flight cannot accept the response or repeat it on recovery',async()=>{
 let calls=0;let p;const reader=remoteReader(async({guard})=>{calls++;assert.equal(await guard(),true);p.state.approved=false;return{version:1,mrzLines:td1()};});p=profilesFor(reader);const f=await fixture({profiles:p.profiles}),source=f.add(1);f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)});await f.process();assert.equal(calls,1);assert.deepEqual(f.job().pages[1].extraction.mrzLines,[]);assert.equal(f.job().status,'failed');const restored=new VisaDocumentIntake(f.args);await f.process(restored);assert.equal(calls,1);assert.equal((await restored.refresh(f.customer)).readyForQuestions,false);
});
test('revoked ready checkpoints are quarantined before refresh, staff shortcut and preparation',async()=>{
 const p=profilesFor(remoteReader(async()=>({version:1,mrzLines:td1()}))),f=await fixture({profiles:p.profiles}),source=f.add(1);f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)});await f.process();const bytes=JSON.stringify(f.job().pages);f.state().status='ready';f.state().applicants=[{id:id(90),applicantIndex:0,status:'ready',identityReady:true,applied:true,fields:{},documents:{},issues:[]}];f.state().inputFingerprint='old';f.state().resultFingerprint='old';f.worker.raad={get:()=>({review:{complete:true},caseId:f.c.id,caseSignature:f.state().caseSignature})};p.state.approved=false;
 const result=await f.worker.prepareJob({id:'queued',customer:f.customer,applicantIndex:0});assert.equal(result.readyForQuestions,false);assert.equal(f.state().status,'needs_review');assert.equal(f.state().applicants[0].status,'needs_review');assert.equal(f.state().applicants[0].applied,false);assert.equal(f.state().inputFingerprint,undefined);assert.equal(f.state().resultFingerprint,undefined);assert.equal(JSON.stringify(f.job().pages),bytes);assert.equal(f.job().status,'ready');
 let prepared=0;f.worker.prepareDossier=async()=>{prepared++;assert.fail('revoked images cannot be prepared');};await f.worker.reconcileCase(f.customer,{force:true});assert.equal(prepared,0);assert.equal(f.state().status,'needs_review');
});
test('missing or changed remote page markers are not accepted from cached evidence',async()=>{
 for(const marker of [undefined,'f'.repeat(64)]){const p=profilesFor(remoteReader(async()=>({version:1,mrzLines:td1()}))),f=await fixture({profiles:p.profiles}),source=f.add(1);f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)});await f.process();if(marker===undefined)delete f.job().pages[1].mrzProfileKey;else f.job().pages[1].mrzProfileKey=marker;assert.equal(f.worker.caseMrzApproval(f.customer,f.c.id).rejected.length,1);assert.equal((await f.worker.refresh(f.customer)).readyForQuestions,false);}
});
test('billing identity stays fixed across upload aliases, grants and generations while cache identity changes',async()=>{
 const attempts=[];for(let n=1;n<=3;n++){const p=profilesFor(remoteReader(async request=>{attempts.push({attempt:request.attemptKey,billing:request.billingAttemptKey});return{version:1,mrzLines:td1()};})),f=await fixture({profiles:p.profiles}),source=f.add(n);f.worker.enqueue(f.customer,source,{mrzConsent:consent(n)});if(n===3){f.state().generation++;f.job().generation++;f.job().manualRereadKey='manual-cycle';}await f.process();}assert.equal(attempts.length,3);assert.equal(new Set(attempts.map(item=>item.billing)).size,1);assert.equal(new Set(attempts.map(item=>item.attempt)).size,3);
});
test('an asynchronous or invalid new-job binding rolls back instead of silently becoming local',async()=>{
 for(const binding of [Promise.resolve({version:1}),[],true]){const f=await fixture({profiles:{bindNewJob:()=>binding}}),source=f.add(1);assert.throws(()=>f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)}),{code:'DOCUMENT_INTAKE_STATE_FAILED'});assert.equal(Object.keys(f.worker.data().jobs).length,0);}
});
test('an approval change across asynchronous dossier preparation cannot publish a ready applicant',async()=>{
 const p=profilesFor(remoteReader(async()=>({version:1,mrzLines:td1()}))),f=await fixture({profiles:p.profiles}),source=f.add(1);f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)});await f.process();const ref={mediaId:source,page:1,sha256:f.job().pages[1].sha256};let applies=0;
 f.worker.reconcile=()=>({issues:[],unassigned:[],applicants:[{applicantIndex:0,status:'ready',identityReady:true,fields:{},documents:{passport:ref,residence:[ref],photo:ref},evidence:{},issues:[]}]});f.worker.prepareDossier=async()=>{await Promise.resolve();p.state.approved=false;return{documents:{},preparedManifest:[]};};f.worker.raad={get:()=>({revision:0}),applyMachineDossier:()=>{applies++;}};
 await assert.rejects(f.worker.reconcileCase(f.customer,{force:true}),{code:'DOCUMENT_INTAKE_STALE'});assert.equal(applies,0);assert.equal(f.state().status,'needs_review');assert.equal(f.state().applicants.some(app=>app.status==='ready'),false);
});
test('billing identity changes for another customer, case, source page or reader policy',async()=>{
 const keys=[];for(const variant of ['base','customer','case','policy','source']){const reader=remoteReader(async request=>{keys.push(request.billingAttemptKey);return{version:1,mrzLines:td1()};},variant==='policy'?{policyFingerprint:'b'.repeat(64)}:{}),p=profilesFor(reader),f=await fixture({profiles:p.profiles,customer:variant==='customer'?'15550001992':CUSTOMER,caseId:variant==='case'?'another-case':'synthetic-provider-case'}),source=f.add(1);if(variant==='source'){const bytes=Buffer.from(f.images.get(source));bytes[bytes.length-1]^=1;f.images.set(source,bytes);f.records[source].checksum=hash(bytes);f.worker.prepare=async()=>({bytes:Buffer.from(f.image),mimeType:'image/png'});}f.worker.enqueue(f.customer,source,{mrzConsent:consent(1)});await f.process();}assert.equal(keys.length,5);assert.equal(new Set(keys).size,5);
});
