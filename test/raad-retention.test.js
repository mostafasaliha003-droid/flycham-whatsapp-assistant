'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
test('Raad identity and health drafts expire after thirty days without deleting a current draft',()=>{
 const now=Date.parse('2026-10-27T00:00:00Z'),store=new AssistantState({file:null,now:()=>now});
 store.data.raadApplications={old:{applicants:{0:{updatedAt:now-31*86400000,fields:{health:{congenitalCondition:true}}}}},current:{applicants:{0:{updatedAt:now,fields:{passportNumber:'SYNTHETIC'}}}}};store.prune();assert.equal(store.data.raadApplications.old,undefined);assert.equal(store.data.raadApplications.current.applicants[0].fields.passportNumber,'SYNTHETIC');
});
test('visa erasure removes Raad drafts while preserving unrelated flight context',()=>{
 const store=new AssistantState({file:null}),visa=new SaudiVisaEngine({store,privateConfig:{},env:{}});store.set('synthetic',{status:'flight_context'});store.data.raadApplications={synthetic:{applicants:{0:{fields:{passportNumber:'SYNTHETIC'}}}}};visa.delete('synthetic');assert.equal(store.data.raadApplications.synthetic,undefined);assert.equal(store.get('synthetic').status,'flight_context');
});

test('document extraction and unsent notifications expire with their exact case or source',()=>{
 const now=Date.parse('2026-10-28T00:00:00Z'),store=new AssistantState({file:null,now:()=>now});
 store.data.visaCases={current:{id:'current-case'},old:{id:'replaced-case'}};
 store.data.visaMedia={source:{id:'source',customer:'current',expiresAt:now+10000}};
 store.data.visaDocumentIntake={version:1,cases:{current:{caseId:'current-case',updatedAt:now},old:{caseId:'prior-case',updatedAt:now}},jobs:{valid:{customer:'current',caseId:'current-case',mediaId:'source',updatedAt:now},lost:{customer:'current',caseId:'current-case',mediaId:'deleted-source',updatedAt:now}}};
 store.data.visaDocumentNotifications={items:{current:{customer:'current',binding:{caseId:'current-case'},updatedAt:now},old:{customer:'old',binding:{caseId:'prior-case'},updatedAt:now}}};
 store.prune();assert.ok(store.data.visaDocumentIntake.cases.current);assert.equal(store.data.visaDocumentIntake.cases.old,undefined);
 assert.ok(store.data.visaDocumentIntake.jobs.valid);assert.equal(store.data.visaDocumentIntake.jobs.lost,undefined);assert.ok(store.data.visaDocumentNotifications.items.current);assert.equal(store.data.visaDocumentNotifications.items.old,undefined);
});

test('visa-only and complete erasure remove pending extraction and feedback without erasing other customers',()=>{
 for(const complete of [false,true]){
  const store=new AssistantState({file:null}),visa=new SaudiVisaEngine({store,privateConfig:{},env:{}});
  store.set('customer',{status:'flight_context'});store.data.visaCases={customer:{id:'case'},other:{id:'other-case'}};
  store.data.visaMedia={source:{customer:'customer',expiresAt:Date.now()+100000},otherSource:{customer:'other',expiresAt:Date.now()+100000}};
  store.data.visaDocumentIntake={version:1,cases:{customer:{caseId:'case',updatedAt:Date.now()},other:{caseId:'other-case',updatedAt:Date.now()}},jobs:{waiting:{customer:'customer',mediaId:'source',caseId:null,updatedAt:Date.now()},other:{customer:'other',mediaId:'otherSource',caseId:'other-case',updatedAt:Date.now()}}};
  store.data.visaDocumentNotifications={items:{customer:{customer:'customer',caseId:'case',updatedAt:Date.now()},other:{customer:'other',caseId:'other-case',updatedAt:Date.now()}}};
  if(complete)store.delete('customer');else visa.delete('customer');
  assert.equal(store.data.visaDocumentIntake.cases.customer,undefined);assert.equal(store.data.visaDocumentIntake.jobs.waiting,undefined);assert.equal(store.data.visaDocumentNotifications.items.customer,undefined);
  assert.ok(store.data.visaDocumentIntake.cases.other);assert.ok(store.data.visaDocumentNotifications.items.other);if(!complete)assert.equal(store.get('customer').status,'flight_context');
 }
});
