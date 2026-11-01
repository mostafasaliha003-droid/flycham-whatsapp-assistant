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
async function fixture({reader,kind='uae_id_back',rotation=0,caseId='synthetic-provider-case',customer=CUSTOMER}={}){
 const raw=Buffer.alloc(1200*800*3);for(let y=0;y<800;y++)for(let x=0;x<1200;x++){const at=(y*1200+x)*3;raw[at]=y<400?230:20;raw[at+1]=70;raw[at+2]=y<400?20:230;}
 const image=await sharp(raw,{raw:{width:1200,height:800,channels:3}}).png().toBuffer();
 const c={id:caseId,createdAt:NOW-10000,policyVersion:'synthetic-only',applicantCount:1,applicants:[{}],quote:{total:0},documents:[],paymentStatus:'unverified',submissionStatus:'not_submitted'};
 let visionCalls=0,saves=0;const records={},images=new Map(),epochs=new Map();
 const store={data:{visaCases:{[customer]:c},visaMedia:records},save(){saves++;}};
 const media={records,epochs,read(key,{customer:who}){const record=records[key];assert(record&&record.customer===who);return{metadata:structuredClone(record),bytes:Buffer.from(images.get(key))};}};
 const vision={ready:()=>true,status:()=>({configured:true}),extract:async({guard})=>{visionCalls++;guard();return extracted(kind,rotation);}};
 let held=false;const lock={tryAcquire(){if(held)return false;held=true;return true;},release(){held=false;}};
 const args={store,mediaStore:media,vision,mrzVision:reader,env:{RAAD_DOCUMENT_OCR_ENABLED:'true'},now:()=>NOW,lock,reconcile:()=>({issues:[],applicants:[],unassigned:[]})};
 const worker=new VisaDocumentIntake(args);
 function add(n){const mediaId=id(n);images.set(mediaId,Buffer.from(image));records[mediaId]={id:mediaId,customer,type:'image',mimeType:'image/png',size:image.length,checksum:hash(image),receivedAt:NOW-5000+n,expiresAt:NOW+60000};return mediaId;}
 const process=async(instance=worker)=>{for(let i=0;i<8;i++){await instance.tick();if(!Object.values(instance.data().jobs).some(job=>['queued','running'].includes(job.status)))break;}};
 const state=()=>worker.data().cases[customer];const job=()=>Object.values(worker.data().jobs)[0];
 return{worker,args,store,media,c,customer,records,images,image,add,process,state,job,counts:()=>({visionCalls,saves})};
}
test('explicit remote internal-crop TD1 receives one upright whole page and a source/page/case bound attempt key',async()=>{
 let input,calls=0;const reader=remoteReader(async request=>{calls++;request.guard();input={...request,copy:Buffer.from(request.bytes)};const metadata=await sharp(request.bytes).metadata();assert.deepEqual([metadata.width,metadata.height],[800,1200]);return{version:1,mrzLines:td1()};});
 const f=await fixture({reader,rotation:90}),source=f.add(1);await f.process();
 assert.equal(calls,1);assert.equal(f.counts().visionCalls,1);assert.equal(reader.status().local,false);assert.equal(input.format,'TD1');assert.match(input.attemptKey,/^[a-f0-9]{64}$/);
 const entries=Object.entries(f.state().mrzFocusReads);assert.equal(entries.length,1);const [key,record]=entries[0];assert.equal(key,input.attemptKey);assert.equal(record.inputPolicy,INPUT_POLICY);assert.equal(record.mrzPolicy,reader.policyFingerprint);assert.equal(record.sourceSha256,f.records[source].checksum);assert.equal(record.pageSha256,f.job().pages[1].sha256);assert.equal(record.cropSha256,hash(input.copy));assert.match(record.caseBinding,/^[a-f0-9]{64}$/);assert.equal(record.status,'ready');assert.deepEqual(f.job().pages[1].extraction.mrzLines,td1());
 const expected=await sharp(f.image).autoOrient().rotate(90).raw().toBuffer();const actual=await sharp(input.copy).raw().toBuffer();assert.deepEqual(actual,expected);assert(input.bytes.every(byte=>byte===0));assert.deepEqual(f.images.get(source),f.image);
});
test('explicit remote internal-crop TD3 receives the whole page while legacy remote TD3 retains its prior crop and arguments',async()=>{
 for(const modern of [false,true]){let input,calls=0;const extract=async request=>{calls++;input={...request,copy:Buffer.from(request.bytes)};return{version:1,mrzLines:td3()};};const reader=modern?remoteReader(extract):{ready:()=>true,extract};const f=await fixture({reader,kind:'passport'});f.add(1);await f.process();const meta=await sharp(input.copy).metadata();assert.deepEqual([meta.width,meta.height],[1200,modern?800:360]);assert.equal(Object.hasOwn(input,'attemptKey'),modern);const record=Object.values(f.state().mrzFocusReads)[0];assert.equal(record.inputPolicy,modern?INPUT_POLICY:undefined);assert.equal(record.caseBinding===undefined,!modern);assert.equal(calls,1);}
});
test('the legacy local contract keeps its previous input marker and never receives a provider attempt key',async()=>{
 let input;const reader={supports:()=>true,status:()=>({configured:true,local:true}),ready:()=>true,extract:async request=>{input={...request,copy:Buffer.from(request.bytes)};return{version:1,mrzLines:td1()};}};
 const f=await fixture({reader});f.add(1);await f.process();const meta=await sharp(input.copy).metadata();assert.deepEqual([meta.width,meta.height],[1200,800]);assert.equal(Object.hasOwn(input,'attemptKey'),false);const record=Object.values(f.state().mrzFocusReads)[0];assert.equal(record.inputPolicy,'oriented-full-page-to-local-format-crop-v1');assert.equal(Object.hasOwn(record,'caseBinding'),false);
});
test('unknown input policies, missing policy fingerprints and unsupported formats cannot claim the whole-page capability',async()=>{
 for(const variant of ['unknown-policy','missing-fingerprint','unsupported-format']){let calls=0;const reader=remoteReader(async()=>{calls++;throw Error('must not extract');},variant==='unknown-policy'?{status:()=>({local:false,configured:true,inputPolicy:'unreviewed_policy'})}:variant==='missing-fingerprint'?{policyFingerprint:undefined}:{supports:()=>false});
  const f=await fixture({reader,kind:'passport'});f.add(1);await f.process();assert.equal(calls,0,variant);assert.deepEqual(f.job().pages[1].extraction.mrzLines,[]);assert.equal(f.job().pages[1].mrzIssue.failureCode,'MRZ_VISION_INVALID_IMAGE');assert.equal(f.worker.td1FocusCapable(),false);
 }
});
test('provider attempt identities differ across reader fingerprints and cases without changing the document policy',async()=>{
 const keys=[];for(const [policy,caseId]of [['a','case-a'],['b','case-a'],['a','case-b']]){const reader=remoteReader(async({attemptKey})=>{keys.push(attemptKey);return{version:1,mrzLines:td1()};},{policyFingerprint:policy.repeat(64)}),f=await fixture({reader,caseId});f.add(1);await f.process();assert.equal(f.state().policy,POLICY_FINGERPRINT);assert.equal(Object.values(f.state().mrzFocusReads)[0].mrzPolicy,policy.repeat(64));}assert.equal(new Set(keys).size,3);
});
test('duplicate source aliases and normal reconstruction reuse completed remote evidence without another request',async()=>{
 let calls=0;const reader=remoteReader(async()=>{calls++;return{version:1,mrzLines:td1()};}),f=await fixture({reader});f.add(1);f.add(2);await f.process();assert.equal(calls,1);assert.equal(f.counts().visionCalls,1);assert(Object.values(f.worker.data().jobs).every(job=>JSON.stringify(job.pages[1].extraction.mrzLines)===JSON.stringify(td1())));
 const restored=new VisaDocumentIntake(f.args);await f.process(restored);assert.equal(calls,1);assert.equal(f.counts().visionCalls,1);assert.equal(Object.keys(f.state().mrzFocusReads).length,1);
});
test('a stale provider response is not accepted and an interrupted durable attempt is not repeated on recovery',async()=>{
 let enter,resume,calls=0;const entered=new Promise(resolve=>{enter=resolve;}),waiting=new Promise(resolve=>{resume=resolve;});const reader=remoteReader(async({guard})=>{calls++;guard();enter();await waiting;return{version:1,mrzLines:td1()};}),f=await fixture({reader});f.add(1);
 const work=f.worker.tick();await entered;f.worker.stop();resume();await work;assert.deepEqual(f.job().pages[1].extraction.mrzLines,[]);const restored=new VisaDocumentIntake(f.args);await f.process(restored);assert.equal(calls,1);assert.equal(f.counts().visionCalls,1);assert.deepEqual(f.job().pages[1].extraction.mrzLines,[]);assert.equal(f.job().pages[1].mrzIssue.code,'DOCUMENT_MRZ_INTERRUPTED');
});
test('remote augmentation rejects checked conflicting names and invalid protected digits without replacing VIZ facts',async()=>{
 for(const conflict of [false,true]){const reader=remoteReader(async()=>{const lines=td1();if(!conflict)lines[1]=lines[1].slice(0,29)+(lines[1][29]==='0'?'1':'0');return{version:1,mrzLines:lines};}),f=await fixture({reader}),source=f.add(1);f.worker.enqueue(f.customer,source);const job=f.job(),state=f.state();job.sourceSha256=f.records[source].checksum;job.pages[1]={mediaId:source,page:1,sha256:hash(f.image),sourceSha256:job.sourceSha256,extraction:extracted('uae_id_back'),mrzFocusPending:true};
  if(conflict){const other=td1();other[2]='A'+other[2].slice(1);state.mrzFocusReads={['f'.repeat(64)]:{sourceSha256:job.sourceSha256,page:1,format:'TD1',policy:POLICY_FINGERPRINT,mrzPolicy:reader.policyFingerprint,status:'ready',mrzLines:other,rereadKey:'old-cycle'}};}
  await f.process();assert.deepEqual(job.pages[1].extraction.mrzLines,[]);assert.equal(job.pages[1].mrzIssue.code,conflict?'SOURCE_CONFLICT':'DOCUMENT_MRZ_READ_FAILED');if(!conflict)assert.equal(job.pages[1].mrzIssue.failureCode,'MRZ_VISION_CHECKS_FAILED');
 }
});
test('remote capability injection does not reopen completed compatible legacy TD1 pages during policy recovery',async()=>{
 let calls=0;const reader=remoteReader(async()=>{calls++;throw Error('legacy evidence must not trigger API');}),f=await fixture({reader}),source=f.add(1);f.worker.enqueue(f.customer,source);const job=f.job(),state=f.state(),oldPolicy=COMPATIBLE_PREVIOUS_POLICIES[0];assert(oldPolicy);job.sourceSha256=f.records[source].checksum;job.pages[1]={mediaId:source,page:1,sha256:hash(f.image),sourceSha256:job.sourceSha256,extraction:extracted('uae_id_back')};job.status='ready';job.policy=oldPolicy;state.policy=oldPolicy;
 const restored=new VisaDocumentIntake(f.args);await f.process(restored);assert.equal(calls,0);assert.equal(f.counts().visionCalls,0);assert.equal(job.status,'ready');assert.equal(job.pages[1].mrzFocusPending,undefined);assert.equal(restored.localTd1Capable(),false);assert.equal(restored.td1FocusCapable(),true);
});
