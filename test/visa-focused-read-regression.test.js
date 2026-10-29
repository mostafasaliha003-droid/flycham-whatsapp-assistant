'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const sharp=require('sharp');
const {createDocumentVision}=require('../src/visa-document-vision');
const {createOpticalMrz,OPTICAL_POLICY_FINGERPRINT}=require('../src/visa-mrz-optical');
const {VisaDocumentIntake}=require('../src/visa-document-intake');
const {RaadVisaWorkflow}=require('../src/raad-visa-workflow');
const {visaCaseSignature}=require('../src/visa-case-signature');
const P=require('../src/saudi-visa-policy');

const CUSTOMER='15550004801',NOW=Date.parse('2026-10-29T14:00:00Z');
const id=n=>'48000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const NUMBER='N01234567',NATIONAL='00123456789',CHECKS=['documentNumber','birthDate','expiryDate','optionalData','composite'];
const field=value=>({value,visible:true,confidence:0.991});
function digit(value){return String([...value].reduce((sum,char,index)=>sum+(char==='<'?0:/\d/.test(char)?Number(char):char.charCodeAt(0)-55)*[7,3,1][index%3],0)%10);}
function td3(){const first='P<SYRTESTER<<EXAMPLE'.padEnd(44,'<'),birth='920617',expiry='310911',optional=NATIONAL.padEnd(14,'<'),body=NUMBER+digit(NUMBER)+'SYR'+birth+digit(birth)+'M'+expiry+digit(expiry)+optional+digit(optional);return[first,body+digit(body.slice(0,10)+body.slice(13,20)+body.slice(21,43))];}
function extraction(kind,values={},extra={}){return{version:1,kind,readable:true,rotation:0,fields:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,field(value)])),mrzLines:[],portraitBox:null,...extra};}

async function setup({fullMrz=[],visibleNumber=NUMBER,badFocused=false,localUnknown=false,localBusy=false,duplicate=true}={}){
 const upright=await sharp({create:{width:1400,height:1000,channels:3,background:'#e7d5bf'}}).composite([{input:await sharp({create:{width:1400,height:450,channels:3,background:'#a5bde1'}}).png().toBuffer(),left:0,top:550}]).png().toBuffer();
 const main=await sharp(upright).rotate(270).png().toBuffer(),supplement=await sharp({create:{width:1400,height:900,channels:3,background:'#ccddee'}}).png().toBuffer(),front=await sharp({create:{width:1300,height:850,channels:3,background:'#badabe'}}).png().toBuffer(),portrait=await sharp({create:{width:600,height:800,channels:3,background:'#f4d4d4'}}).png().toBuffer();
 const images=[main,supplement,front,portrait,...(duplicate?[main]:[])],pixels=new Map(),records={},saves=[];
 const visaCase={id:'synthetic-focused-read-case',createdAt:NOW-10000,policyVersion:P.POLICY_VERSION,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],quote:null,paymentStatus:'unverified',submissionStatus:'not_submitted',documents:[],history:[{role:'user',text:'PRIVATE_CONVERSATION_MUST_NOT_LEAVE'}]};visaCase.quote=P.calculateQuote(visaCase);
 const store={data:{visaCases:{[CUSTOMER]:visaCase},visaMedia:records,visaFulfilment:{cases:{},jobs:{},challenges:{},outbox:{}}},save(){if(this.data.visaDocumentIntake)saves.push(structuredClone(this.data.visaDocumentIntake));}};
 images.forEach((bytes,index)=>{pixels.set(id(index+1),bytes);records[id(index+1)]={id:id(index+1),customer:CUSTOMER,type:'image',mimeType:'image/png',size:bytes.length,checksum:sha(bytes),receivedAt:NOW-5000+index,expiresAt:NOW+86400000};});
 const media={records,epochs:new Map(),get(key,{customer}){const record=records[key];if(!record||record.customer!==customer||record.expiresAt<=NOW)throw Error('MEDIA_NOT_FOUND');return structuredClone(record);},read(key,options){return{metadata:this.get(key,options),bytes:Buffer.from(pixels.get(key))};},storeDerived(customer,{sourceIds,bytes,mimeType,kind}){
  sourceIds.forEach(key=>this.get(key,{customer}));const checksum=sha(bytes),previous=Object.values(records).find(record=>record.customer===customer&&record.purpose==='raad_portal_upload'&&record.kind===kind&&record.checksum===checksum&&JSON.stringify(record.sourceIds)===JSON.stringify(sourceIds));if(previous)return this.get(previous.id,{customer});
  const key=crypto.randomUUID();pixels.set(key,Buffer.from(bytes));records[key]={id:key,customer,type:'image',mimeType,size:bytes.length,checksum,purpose:'raad_portal_upload',kind,sourceIds:[...sourceIds],receivedAt:NOW,expiresAt:NOW+86400000};return this.get(key,{customer});
 }};
 const observed={full:0,focused:0,focusedGemma:0,recognitions:0,parameters:[],workers:0,terminated:0,applies:0,stages:0,requests:[],cropSha:null},env={RAAD_DOCUMENT_OCR_ENABLED:'true',GEMINI_API_KEY:'synthetic-focused-read-key',RAAD_APPLICATION_PHONE:'+'+CUSTOMER,RAAD_CONTACT_EMAIL:'synthetic@example.test',RAAD_INSURANCE_PHONE:'+'+CUSTOMER,RAAD_POSTAL_CODE:'00000'};
 const fullMain=extraction('passport',{latinFirstName:'EXAMPLE',latinFatherName:'PARENT',latinFamilyName:'TESTER',birthDate:'1992-06-17',birthPlace:'SYNTHETIC CITY',nationalityCode:'SYR',issuingCountryCode:'SYR',sex:'M',...(visibleNumber===null?{}:{visiblePassportNumber:visibleNumber})},{rotation:90,mrzLines:fullMrz});
 const vision=createDocumentVision({env,now:()=>NOW,fetchImpl:async(url,options)=>{
  assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');assert.equal(new URL(url).pathname,'/v1beta/models/gemma-4-26b-a4b-it:generateContent');assert.equal(options.headers['x-goog-api-key'],env.GEMINI_API_KEY);assert.equal(options.redirect,'error');assert.equal(options.body.includes('PRIVATE_CONVERSATION_MUST_NOT_LEAVE'),false);assert.equal(options.body.includes(CUSTOMER),false);
  const request=JSON.parse(options.body),bytes=Buffer.from(request.contents[0].parts[0].inlineData.data,'base64'),meta=await sharp(bytes).metadata();observed.requests.push({tokens:request.generationConfig.maxOutputTokens,width:meta.width,height:meta.height});let output;
  if(request.generationConfig.maxOutputTokens===512){observed.focusedGemma++;throw Error('FOCUSED_DOCUMENT_MUST_NOT_LEAVE_FOR_GEMMA');}
  observed.full++;
  output=meta.width===1000&&meta.height===1400?fullMain:meta.width===1400&&meta.height===900?extraction('passport',{passportNationalNumber:NATIONAL,printedPassportExpiry:'11/09/2031'}):meta.width===1300&&meta.height===850?extraction('uae_id_front',{latinFullName:'EXAMPLE PARENT TESTER',birthDate:'1992-06-17',nationalityCode:'SYR',sex:'M',emiratesId:'784199212345671',residenceExpiry:'2029-07-04'}):meta.width===600&&meta.height===800?extraction('portrait'):null;assert.ok(output,'Only the four known synthetic pages may be sent');
  return Response.json({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:JSON.stringify(output)}]}}]});
 }});
 const optical=createOpticalMrz({now:()=>NOW,verifyModelImpl:()=>true,createWorkerImpl:async(language,engine,options)=>{
  assert.equal(language,'mrz');assert.equal(engine,1);assert.equal(JSON.stringify(options).includes('PRIVATE_CONVERSATION_MUST_NOT_LEAVE'),false);observed.workers++;
  return{async setParameters(parameters){observed.parameters.push(parameters);},async recognize(bytes,_parameters,output){observed.recognitions++;assert.ok(Buffer.isBuffer(bytes));assert.ok(bytes.length>32);assert.deepEqual(output,{text:true});const lines=td3();if(badFocused)lines[1]=lines[1].slice(0,43)+(lines[1][43]==='0'?'1':'0');return{data:{text:localUnknown?'':lines.join('\n')}};},async terminate(){observed.terminated++;}};
 }});
 const mrzVision={policyFingerprint:optical.policyFingerprint,ready:()=>!localBusy&&optical.ready(),status:()=>localBusy?{configured:true,busy:true,retryAfterMs:2000}:optical.status(),async extract({bytes,mimeType,guard}){
   observed.focused++;guard();const meta=await sharp(bytes).metadata();assert.equal(meta.width,1400);assert.equal(meta.height,450);assert.ok(meta.width*meta.height<=4*1024*1024);assert.ok(bytes.length<=2*1024*1024);
   const pixel=await sharp(bytes).extract({left:0,top:0,width:1,height:1}).removeAlpha().raw().toBuffer();assert.deepEqual([...pixel],[165,189,225],'Rotation must precede the bottom-45-percent crop');observed.cropSha=sha(bytes);
   // Exact-SHA duplicates may be claimed first when their jobs share a clock
   // tick. Either physical-source UUID must persist the same evidence before I/O.
   const durable=saves.at(-1),mainSha=records[id(1)].checksum,job=Object.values(durable.jobs).find(item=>item.status==='running'&&item.sourceSha256===mainSha&&item.pages?.[1]?.mrzFocusPending),ledger=Object.values(durable.cases[CUSTOMER].mrzFocusReads||{});assert.ok(job,'The active identical-source page must have a saved pending checkpoint');assert.ok([id(1),...(duplicate?[id(5)]:[])].includes(job.mediaId));assert.equal(job.pages[1].sourceSha256,mainSha);assert.equal(job.pages[1].mrzFocusPending,true);assert.equal(job.pages[1].extraction.fields.passportNumber,undefined);assert.deepEqual(job.pages[1].extraction.mrzLines,[]);assert.equal(ledger.length,1);assert.equal(ledger[0].sourceSha256,mainSha);assert.equal(ledger[0].mrzPolicy,OPTICAL_POLICY_FINGERPRINT);assert.equal(ledger[0].status,'running','Checkpoint and outgoing-attempt ledger must be saved before local recognition');
   return optical.extract({bytes,mimeType,guard});
 }};
 let locked=false;const lock={tryAcquire(){if(locked)return false;locked=true;return true;},release(){locked=false;},onRelease(){return()=>{};}},realRaad=new RaadVisaWorkflow({store,mediaStore:media,env,now:()=>NOW,canAutomate:()=>true}),raad={get:(...args)=>realRaad.get(...args),applyMachineDossier(){observed.applies++;throw Error('UNPAID_APPLY_FORBIDDEN');}},fulfilment={blocked:()=>null,data:()=>store.data.visaFulfilment,stageDocumentFacts(){observed.stages++;throw Error('NO_CONSENT_OR_PAID_JOB');}},options={store,mediaStore:media,vision,mrzVision,raad,fulfilment,env,now:()=>NOW,lock};
 const worker=new VisaDocumentIntake(options),before=structuredClone(visaCase),signature=visaCaseSignature(visaCase);
 for(let index=0;index<images.length;index++)assert.equal(worker.enqueue(CUSTOMER,id(index+1)),true);
 const settle=async(instance=worker)=>{for(let index=0;index<12;index++){await instance.tick();if(Object.values(instance.data().jobs).every(job=>!['queued','running','retry'].includes(job.status)))break;}};
 await settle();return{worker,options,settle,store,media,records,pixels,observed,before,signature,visaCase,fullMain};
}
function assertNoGovernmentAction(f){assert.deepEqual(f.visaCase,f.before);assert.equal(visaCaseSignature(f.visaCase),f.signature);assert.equal(f.visaCase.paymentStatus,'unverified');assert.equal(f.visaCase.submissionStatus,'not_submitted');assert.equal(f.visaCase.staffVerification,undefined);assert.equal(f.store.data.raadApplications?.[CUSTOMER],undefined);assert.deepEqual(f.store.data.visaFulfilment,{cases:{},jobs:{},challenges:{},outbox:{}});assert.equal(f.observed.applies,0);assert.equal(f.observed.stages,0);assert.equal(f.observed.focusedGemma,0);assert.ok(f.observed.requests.every(request=>request.tokens!==512));}

for(const variant of [{name:'empty full-page MRZ and separately typed VIZ number',fullMrz:[],visibleNumber:NUMBER},{name:'bounded failed full-page MRZ and omitted VIZ number',fullMrz:['PN SYR PRIVATE TRANSCRIPTION','not-a-valid-line'],visibleNumber:null}]){
 test('local optical and full-page factory regression recovers '+variant.name+' once per source without guessed confidence',async()=>{
  const f=await setup(variant),summary=f.worker.summary(CUSTOMER),person=summary.applicants[0],state=f.worker.data().cases[CUSTOMER];assert.equal(summary.status,'needs_confirmation',JSON.stringify({issues:summary.issues,applicants:summary.applicants.map(item=>({status:item.status,issues:item.issues}))}));assert.equal(summary.awaitingPayment,true);assert.equal(person.identityReady,true);assert.deepEqual(person.clientFieldsRequired,['passportType','issueDate']);assert.equal(person.fields.passportNumber,NUMBER);assert.equal(person.fields.passportNumber.length,9);assert.equal(person.fields.expiryDate,'2031-09-11');assert.equal(person.fields.latinFatherName,'PARENT');
  for(const key of ['visiblePassportNumber','passportNationalNumber','printedPassportExpiry','mrzLines','latinGrandfatherName'])assert.equal(Object.hasOwn(person.fields,key),false,key);
  const provenance=person.evidence.fieldSources.passportNumber;assert.ok(provenance.length>0);assert.ok(provenance.every(source=>source.method==='td3_document_number_checked'&&source.evidenceField==='mrzLines'&&!Object.hasOwn(source,'confidence')));assert.deepEqual(new Set(provenance[0].checks),new Set(CHECKS));
  const jobs=Object.values(f.worker.data().jobs),primary=jobs.find(job=>job.mediaId===id(1)).pages[1],copy=jobs.find(job=>job.mediaId===id(5)).pages[1];assert.equal(primary.mrzFocusStatus,'checked');assert.deepEqual(primary.extraction.mrzLines,td3());assert.equal(primary.extraction.fields.passportNumber,undefined);assert.deepEqual(copy.extraction,primary.extraction);if(variant.visibleNumber!==null)assert.deepEqual(primary.extraction.fields.visiblePassportNumber,field(NUMBER));
  const ledger=Object.values(state.mrzFocusReads);assert.equal(ledger.length,1);assert.equal(ledger[0].status,'ready');assert.equal(ledger[0].sourceSha256,f.records[id(1)].checksum);assert.equal(ledger[0].cropSha256,f.observed.cropSha);assert.equal(ledger[0].mrzPolicy,OPTICAL_POLICY_FINGERPRINT);assert.deepEqual(ledger[0].mrzLines,td3());assert.equal(f.observed.full,4);assert.equal(f.observed.focused,1);assert.equal(f.observed.workers,1);assert.equal(f.observed.terminated,1);assert.equal(f.observed.recognitions,2);assert.deepEqual(f.observed.parameters.map(parameters=>Number(parameters.tessedit_pageseg_mode)),[6,11]);
  const raw=state.applicants[0];assert.equal(raw.applied,false);assert.equal(raw.preparedManifest.length,3);for(const item of raw.preparedManifest){const file=f.media.read(item.mediaId,{customer:CUSTOMER});assert.ok(file.bytes.length<=1000000);assert.equal(sha(file.bytes),item.sha256);}assert.deepEqual(f.records[person.documents.passport].sourceIds,[id(1),id(2)]);
  await f.worker.tick();const restarted=new VisaDocumentIntake(f.options);await f.settle(restarted);assert.equal(f.observed.full,4);assert.equal(f.observed.focused,1,'Unchanged ticks, duplicate original SHA and restart must not repeat focused I/O');assertNoGovernmentAction(f);
 });
}

test('genuine ten-character VIZ observation remains a blocking contradiction after a fully checked focused MRZ',async()=>{
 const shown=NUMBER+digit(NUMBER),f=await setup({visibleNumber:shown,duplicate:false}),summary=f.worker.summary(CUSTOMER),person=summary.applicants[0],primary=Object.values(f.worker.data().jobs).find(job=>job.mediaId===id(1)).pages[1];assert.equal(shown.length,10);assert.equal(summary.status,'needs_review');assert.equal(person.identityReady,false);assert.ok(person.issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='passportNumber'));assert.deepEqual(primary.extraction.fields.visiblePassportNumber,field(shown));assert.equal(primary.extraction.fields.passportNumber,undefined);assert.deepEqual(primary.extraction.mrzLines,td3());assert.equal(f.observed.focused,1);await f.worker.tick();assert.equal(f.observed.focused,1);assertNoGovernmentAction(f);
});

for(const variant of [{name:'failed optical checks',badFocused:true},{name:'unknown optical text',localUnknown:true}]){
 test(variant.name+' preserve visual facts without automatic replay or a Gemma focused fallback',async()=>{
  const f=await setup({...variant,duplicate:false}),summary=f.worker.summary(CUSTOMER),primary=Object.values(f.worker.data().jobs).find(job=>job.mediaId===id(1)).pages[1],ledger=Object.values(f.worker.data().cases[CUSTOMER].mrzFocusReads);assert.equal(summary.status,'needs_review');assert.equal(summary.applicants[0].identityReady,false);assert.deepEqual(primary.extraction.fields.visiblePassportNumber,field(NUMBER));assert.deepEqual(primary.extraction.mrzLines,[]);assert.equal(primary.mrzFocusStatus,'needs_review');assert.equal(ledger.length,1);assert.equal(ledger[0].status,'failed');assert.equal(ledger[0].issue.code,'DOCUMENT_MRZ_READ_FAILED');assert.equal(ledger[0].issue.failureCode,'MRZ_OPTICAL_READ_FAILED');assert.equal(f.observed.focused,1);assert.equal(f.observed.recognitions,2);assert.equal(f.observed.workers,1);assert.equal(f.observed.terminated,1);await f.worker.tick();const restarted=new VisaDocumentIntake(f.options);await f.settle(restarted);assert.equal(f.observed.focused,1);assert.equal(f.observed.recognitions,2);assert.equal(f.observed.full,4);assertNoGovernmentAction(f);
 });
}

test('a busy local reader defers the saved visual checkpoint without another full-page or focused model request',async()=>{
 const f=await setup({localBusy:true,duplicate:false}),mainJob=Object.values(f.worker.data().jobs).find(job=>job.mediaId===id(1));assert.equal(mainJob.status,'retry');assert.equal(mainJob.pages[1].mrzFocusPending,true);assert.deepEqual(mainJob.pages[1].extraction.fields.visiblePassportNumber,field(NUMBER));assert.equal(f.observed.focused,0);assert.equal(f.observed.workers,0);assert.equal(f.observed.recognitions,0);assert.equal(Object.keys(f.worker.data().cases[CUSTOMER].mrzFocusReads||{}).length,0);await f.worker.tick();assert.equal(f.observed.full,4);assert.equal(f.observed.focused,0);assertNoGovernmentAction(f);
});
