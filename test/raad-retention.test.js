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
