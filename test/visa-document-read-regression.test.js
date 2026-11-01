'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const sharp=require('sharp');
const {validateDocumentExtraction,createDocumentVision}=require('../src/visa-document-vision');
const {reconcileDocumentEvidence}=require('../src/visa-document-matching');
const {parseTD3MRZ}=require('../src/raad-document-validation');
const {parseTD1MRZ,matchesPrintedEmiratesId}=require('../src/visa-id-mrz');
const {VisaDocumentIntake}=require('../src/visa-document-intake');
const {RaadVisaWorkflow}=require('../src/raad-visa-workflow');
const {visaCaseSignature}=require('../src/visa-case-signature');
const P=require('../src/saudi-visa-policy');

const CUSTOMER='15550004701',NOW=Date.parse('2026-10-29T10:00:00Z'),DAY='2026-10-29';
const IDS={main:'47000000-0000-4000-8000-000000000001',supplement:'47000000-0000-4000-8000-000000000002',front:'47000000-0000-4000-8000-000000000003',back:'47000000-0000-4000-8000-000000000004',portrait:'47000000-0000-4000-8000-000000000005',duplicateMain:'47000000-0000-4000-8000-000000000006',duplicateBack:'47000000-0000-4000-8000-000000000007'};
const FACTS={latinFirstName:'EXAMPLE',latinFatherName:'PARENT',latinFamilyName:'TESTER',passportNumber:'N01234567',nationalityCode:'SYR',issuingCountryCode:'SYR',birthDate:'1992-06-17',birthPlace:'SYNTHETIC CITY',sex:'M'};
const NATIONAL_NUMBER='00123456789',EID='784199212345671',PASSPORT_EXPIRY='2031-09-11',RESIDENCE_EXPIRY='2029-07-04';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const field=(value,confidence=0.999)=>({value,confidence,visible:true});
function digit(value){return String([...value].reduce((sum,character,index)=>sum+(character==='<'?0:/\d/.test(character)?Number(character):character.charCodeAt(0)-55)*[7,3,1][index%3],0)%10);}
function td3({optional=NATIONAL_NUMBER,expiry='310911'}={}){
 const first='P<SYRTESTER<<EXAMPLE'.padEnd(44,'<'),number=FACTS.passportNumber.padEnd(9,'<'),birth='920617',data=optional.padEnd(14,'<');
 const second=number+digit(number)+'SYR'+birth+digit(birth)+'M'+expiry+digit(expiry)+data+digit(data);
 return[first,second+digit(second.slice(0,10)+second.slice(13,20)+second.slice(21,43))];
}
function td1({emiratesId=EID,expiry='290704'}={}){
 const number='X01234567',birth='920617',first='I<ARE'+number+digit(number)+emiratesId;
 const second=birth+digit(birth)+'M'+expiry+digit(expiry)+'SYR'+'<'.repeat(11);
 return[first,second+digit(first.slice(5)+second.slice(0,7)+second.slice(8,15)+second.slice(18,29)),'TESTER<<EXAMPLE<PARENT'.padEnd(30,'<')];
}
function extraction(kind,fields={},mrzLines=[]){return{version:1,kind,readable:true,rotation:0,fields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,field(value)])),mrzLines,portraitBox:null};}
function doc(role,kind,fields,mrzLines=[]){const id=IDS[role];return{mediaId:id,page:1,sha256:sha('synthetic-page-'+role),sourceSha256:sha('synthetic-source-'+role),extraction:extraction(kind,fields,mrzLines)};}
function dossier(){return[
 doc('main','passport',FACTS,td3()),
 doc('supplement','passport',{passportNationalNumber:'0012 3456 789',printedPassportExpiry:'11/09/2031'}),
 doc('front','uae_id_front',{latinFullName:'EXAMPLE PARENT TESTER',birthDate:FACTS.birthDate,nationalityCode:'SYR',sex:'M',emiratesId:'784-1992-1234567-1',printedResidenceExpiry:'04/07/2029'}),
 doc('back','uae_id_back',{emiratesId:EID},td1()),
 doc('portrait','portrait',{})
];}
function match(documents=dossier()){return reconcileDocumentEvidence({documents,applicants:[{nationality:'سوريا',documentType:'passport'}],referenceDate:DAY});}
function assertOnlyGovernmentFacts(person){
 for(const key of ['passportNationalNumber','printedPassportExpiry','printedResidenceExpiry','latinFullName','arabicFullName','optionalDataRaw','mrzLines','latinGrandfatherName'])assert.equal(Object.hasOwn(person.fields,key),false,key+' must not become a government applicant fact');
 assert.equal(person.fields.passportType,undefined);assert.equal(person.fields.issueDate,undefined);assert.equal(person.fields.latinFatherName,'PARENT');
}

test('synthetic fixtures preserve labelled father and leading-zero anchor and independently valid TD3/TD1 checks',()=>{
 for(const document of dossier())assert.doesNotThrow(()=>validateDocumentExtraction(document.extraction));
 const passport=parseTD3MRZ(td3(),{referenceDate:DAY,confirmedBirthDate:FACTS.birthDate,confirmedExpiryDate:PASSPORT_EXPIRY});assert.equal(passport.ok,true);assert.equal(passport.fields.optionalDataRaw,NATIONAL_NUMBER+'<<<');assert.ok(Object.values(passport.checks).every(check=>check.ok));assert.equal(passport.fields.latinNames.givenNames,'EXAMPLE');
 const identity=parseTD1MRZ(td1());assert.equal(identity.ok,true,JSON.stringify(identity.issues));assert.equal(matchesPrintedEmiratesId(identity,EID),true);assert.ok(Object.values(identity.checks).every(check=>check.ok));
});

test('separate father label, exactly anchored passport date and explicit-ID TD1 date produce identity-ready client gaps only',()=>{
 const documents=dossier(),before=structuredClone(documents),result=match(documents),person=result.applicants[0];
 assert.equal(person.identityReady,true,JSON.stringify({issues:result.issues,applicantIssues:person.issues}));assert.equal(person.status,'needs_confirmation');assert.deepEqual(person.clientFieldsRequired,['passportType','issueDate']);assert.equal(person.evidence.passportMrzChecked,true);assert.equal(person.evidence.matchedResidence,true);
 assert.equal(person.fields.latinFirstName,'EXAMPLE');assert.equal(person.fields.latinFatherName,'PARENT');assert.equal(person.fields.latinFamilyName,'TESTER');assert.equal(person.fields.birthDate,FACTS.birthDate);assert.equal(person.fields.expiryDate,PASSPORT_EXPIRY);assert.equal(person.fields.residenceExpiry,RESIDENCE_EXPIRY);assert.equal(person.fields.emiratesId,EID);
 assert.deepEqual(person.documents.passportParts.map(part=>part.mediaId),[IDS.main,IDS.supplement]);assert.deepEqual(new Set(person.documents.residence.map(part=>part.mediaId)),new Set([IDS.front,IDS.back]));assert.equal(person.documents.photo.mediaId,IDS.portrait);assert.equal(result.unassigned.length,0);assertOnlyGovernmentFacts(person);assert.deepEqual(documents,before);
 const duplicates=match([...documents,{...structuredClone(documents[0]),mediaId:IDS.duplicateMain},{...structuredClone(documents[3]),mediaId:IDS.duplicateBack}]);assert.equal(duplicates.applicants[0].identityReady,true);assert.equal(duplicates.applicants[0].documents.passportParts.length,2);assert.equal(duplicates.applicants[0].documents.residence.length,2);assert.deepEqual(duplicates.applicants[0].fields,person.fields);
});

test('missing, altered or low-confidence national evidence never assigns a dates-only passport page',()=>{
 for(const mutation of [document=>delete document.extraction.fields.passportNationalNumber,document=>document.extraction.fields.passportNationalNumber=field('0123456789'),document=>document.extraction.fields.passportNationalNumber=field('00123456780'),document=>document.extraction.fields.passportNationalNumber.confidence=0.3]){
  const documents=dossier();mutation(documents[1]);const result=match(documents),person=result.applicants[0];assert.equal(person.identityReady,false);assert.equal(person.fields.expiryDate,undefined);assert.ok(result.unassigned.some(item=>item.mediaId===IDS.supplement));assertOnlyGovernmentFacts(person);
 }
 const wrongOptional=dossier();wrongOptional[0].extraction.mrzLines=td3({optional:'00123456780'});const wrongOptionalPerson=match(wrongOptional).applicants[0];assert.equal(wrongOptionalPerson.identityReady,false);assert.equal(wrongOptionalPerson.fields.expiryDate,undefined);
 const brokenChecksum=dossier();const line=brokenChecksum[0].extraction.mrzLines[1];brokenChecksum[0].extraction.mrzLines[1]=line.slice(0,42)+(line[42]==='0'?'1':'0')+line.slice(43);const brokenChecksumPerson=match(brokenChecksum).applicants[0];assert.equal(brokenChecksumPerson.identityReady,false);assert.equal(brokenChecksumPerson.fields.expiryDate,undefined);
});

test('printed-date disagreements and invalid or foreign-ID TD1 data remain review blockers',()=>{
 const wrongPassport=dossier();wrongPassport[1].extraction.fields.printedPassportExpiry=field('12/08/2031');assert.equal(match(wrongPassport).applicants[0].identityReady,false);assert.equal(match(wrongPassport).applicants[0].fields.expiryDate,undefined);
 const wrongResidence=dossier();wrongResidence[2].extraction.fields.printedResidenceExpiry=field('05/08/2029');const r=match(wrongResidence);assert.equal(r.applicants[0].identityReady,false);assert.equal(r.applicants[0].fields.residenceExpiry,undefined);
 const wrongBirth=dossier();wrongBirth[2].extraction.fields.birthDate=field('1992-06-18');assert.equal(match(wrongBirth).applicants[0].identityReady,false);
 const wrongId=dossier();wrongId[3].extraction.fields.emiratesId=field('784199212345672');const wrongIdPerson=match(wrongId).applicants[0];assert.equal(wrongIdPerson.identityReady,false);assert.equal(wrongIdPerson.fields.residenceExpiry,undefined);
 const wrongTd1=dossier();wrongTd1[3].extraction.mrzLines=td1({emiratesId:'784199212345672'});const wrongTd1Person=match(wrongTd1).applicants[0];assert.equal(wrongTd1Person.identityReady,false);assert.equal(wrongTd1Person.fields.residenceExpiry,undefined);
 const brokenTd1=dossier();const second=brokenTd1[3].extraction.mrzLines[1];brokenTd1[3].extraction.mrzLines[1]=second.slice(0,29)+(second[29]==='0'?'1':'0');const brokenTd1Person=match(brokenTd1).applicants[0];assert.equal(brokenTd1Person.identityReady,false);assert.equal(brokenTd1Person.fields.residenceExpiry,undefined);
 const incompleteId=dossier();incompleteId[2].extraction.fields.emiratesId=field(EID.slice(0,-1));incompleteId[3].extraction.fields.emiratesId=field(EID.slice(0,-1));incompleteId[3].extraction.mrzLines[0]=incompleteId[3].extraction.mrzLines[0].slice(0,-1);const incomplete=match(incompleteId).applicants[0];assert.equal(incomplete.identityReady,false);assert.notEqual(incomplete.fields.emiratesId,EID,'A missing ID digit or 29-character TD1 line must never be silently repaired');
 const noFullYear=dossier();noFullYear[1].extraction.fields.printedPassportExpiry=field('11/09/31');assert.throws(()=>validateDocumentExtraction(noFullYear[1].extraction),/DOCUMENT_VISION_SCHEMA_INVALID/);
});

test('actual vision adapter, matching and pixel preparation keep an unpaid dossier ready for client gaps without government or consent mutation',async()=>{
 const documents=dossier(),pixels=new Map(),records={},rgbById=new Map(),colors=[[235,205,180],[190,215,240],[180,230,195],[205,185,230],[245,220,220]];
 for(let index=0;index<documents.length;index++){
  const document=documents[index],color=colors[index],bytes=await sharp({create:{width:index===4?600:1400,height:index===4?800:1000,channels:3,background:{r:color[0],g:color[1],b:color[2]}}}).png().toBuffer();
  pixels.set(document.mediaId,bytes);rgbById.set(document.mediaId,color);records[document.mediaId]={id:document.mediaId,customer:CUSTOMER,type:'image',mimeType:'image/png',size:bytes.length,checksum:sha(bytes),receivedAt:NOW-5000+index,expiresAt:NOW+86400000};
 }
 const visaCase={id:'synthetic-read-regression',policyVersion:P.POLICY_VERSION,createdAt:NOW-10000,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],paymentStatus:'unverified',submissionStatus:'not_submitted',documents:[]};visaCase.quote=P.calculateQuote(visaCase);
 const store={data:{visaCases:{[CUSTOMER]:visaCase},visaMedia:records,visaFulfilment:{cases:{},jobs:{},challenges:{},outbox:{}}},save(){}};
 const before=structuredClone(visaCase),signature=visaCaseSignature(visaCase);let calls=0,applies=0,stages=0,locked=false;
 const media={records,epochs:new Map(),get(id,{customer}){const record=records[id];if(!record||record.customer!==customer||record.expiresAt<=NOW)throw Error('MEDIA_NOT_FOUND');return structuredClone(record);},read(id,options){return{metadata:this.get(id,options),bytes:Buffer.from(pixels.get(id))};},storeDerived(customer,{sourceIds,bytes,mimeType,kind,purpose='raad_portal_upload'}){
  sourceIds.forEach(id=>this.get(id,{customer}));const checksum=sha(bytes),prior=Object.values(records).find(record=>record.customer===customer&&record.purpose===purpose&&record.kind===kind&&record.checksum===checksum&&JSON.stringify(record.sourceIds)===JSON.stringify(sourceIds));if(prior)return this.get(prior.id,{customer});
  const id=crypto.randomUUID();pixels.set(id,Buffer.from(bytes));records[id]={id,customer,type:'image',mimeType,size:bytes.length,checksum,purpose,kind,sourceIds:[...sourceIds],receivedAt:NOW,expiresAt:NOW+86400000};return this.get(id,{customer});
 }};
 const env={RAAD_DOCUMENT_OCR_ENABLED:'true',CLINE_API_KEY:'synthetic-read-regression-google-key',RAAD_APPLICATION_PHONE:'+'+CUSTOMER,RAAD_CONTACT_EMAIL:'synthetic@example.test',RAAD_INSURANCE_PHONE:'+'+CUSTOMER,RAAD_POSTAL_CODE:'00000'};
 const vision=createDocumentVision({env,now:()=>NOW,fetchImpl:async(url,options)=>{
  assert.equal(new URL(url).hostname,'api.cline.bot');assert.equal(options.headers.Authorization,'Bearer '+env.CLINE_API_KEY);const request=JSON.parse(options.body),bytes=Buffer.from(request.messages[1].content[1].image_url.url.split(',')[1],'base64'),pixel=await sharp(bytes).extract({left:0,top:0,width:1,height:1}).removeAlpha().raw().toBuffer(),document=documents.find(item=>rgbById.get(item.mediaId).every((value,index)=>value===pixel[index]));assert.ok(document);calls++;
  // Exercise the real adapter's discard-only projection too: an ambiguous
  // printed full-year slash date is private evidence, never a guessed ISO fact.
  const wire=structuredClone(document.extraction);
  for(const [printed,target]of [['printedPassportExpiry','expiryDate'],['printedResidenceExpiry','residenceExpiry']])if(wire.fields[printed]){wire.fields[target]=wire.fields[printed];delete wire.fields[printed];}
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(wire)}}]});
 }});
 const realRaad=new RaadVisaWorkflow({store,mediaStore:media,env,now:()=>NOW,canAutomate:()=>true}),raad={get:(...args)=>realRaad.get(...args),applyMachineDossier(){applies++;throw Error('UNPAID_DOSSIER_MUST_NOT_APPLY');}},fulfilment={blocked:()=>null,data:()=>store.data.visaFulfilment,stageDocumentFacts(){stages++;throw Error('NO_CUSTOMER_JOB_MUST_NOT_STAGE_ANSWERS');}},lock={tryAcquire(){if(locked)return false;locked=true;return true;},release(){locked=false;},onRelease(){return()=>{};}};
 const intake=new VisaDocumentIntake({store,mediaStore:media,vision,raad,fulfilment,env,now:()=>NOW,lock});
 for(const document of documents)assert.equal(intake.enqueue(CUSTOMER,document.mediaId),true);
 for(let index=0;index<10;index++){await intake.tick();if(Object.values(intake.data().jobs).every(job=>!['queued','running'].includes(job.status)))break;}
 const summary=intake.summary(CUSTOMER),person=summary.applicants[0];assert.equal(summary.status,'needs_confirmation',JSON.stringify({status:summary.status,issues:summary.issues,applicants:summary.applicants.map(item=>({status:item.status,issues:item.issues}))}));assert.equal(summary.awaitingPayment,true);assert.equal(person.identityReady,true);assert.deepEqual(person.clientFieldsRequired,['passportType','issueDate']);assert.equal(person.fields.expiryDate,PASSPORT_EXPIRY);assert.equal(person.fields.residenceExpiry,RESIDENCE_EXPIRY);assertOnlyGovernmentFacts(person);
 const raw=intake.data().cases[CUSTOMER].applicants[0];assert.equal(raw.applied,false);assert.equal(raw.preparedManifest.length,3);assert.equal(calls,5);assert.equal(applies,0);assert.equal(stages,0);
 assert.deepEqual(records[person.documents.passport].sourceIds,[IDS.main,IDS.supplement]);assert.deepEqual(records[person.documents.residence].sourceIds,[IDS.front,IDS.back]);assert.deepEqual(records[person.documents.photo].sourceIds,[IDS.portrait]);
 for(const item of raw.preparedManifest){const prepared=media.read(item.mediaId,{customer:CUSTOMER});assert.ok(prepared.bytes.length<=1000000);assert.equal(sha(prepared.bytes),item.sha256);assert.equal(prepared.metadata.purpose,'raad_portal_upload');}
 await intake.tick();assert.equal(calls,5,'Unchanged evidence must not trigger another Google read');assert.deepEqual(visaCase,before);assert.equal(visaCaseSignature(visaCase),signature);assert.equal(store.data.raadApplications?.[CUSTOMER],undefined);assert.deepEqual(store.data.visaFulfilment,{cases:{},jobs:{},challenges:{},outbox:{}});assert.equal(visaCase.paymentStatus,'unverified');assert.equal(visaCase.submissionStatus,'not_submitted');assert.equal(visaCase.staffVerification,undefined);
});
