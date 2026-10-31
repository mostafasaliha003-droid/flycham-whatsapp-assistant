'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createVisaMrzConsent}=require('../src/visa-mrz-consent');
const {visaCaseSignature}=require('../src/visa-case-signature');
const {AssistantState}=require('../src/assistant-state');
const customer='971500000001';
function fixture(){
 let clock=1000001;const caseId=crypto.randomUUID(),sessionId=crypto.randomUUID(),id=crypto.randomUUID(),checksum='a'.repeat(64);
 const c={id:caseId,applicantCount:1,applicants:[{nationality:'synthetic'}],documents:[],submissionStatus:'not_submitted'},signature=visaCaseSignature(c);
 const source={id,customer,checksum,uploadRole:'passport',uploadSessionId:sessionId,uploadCaseId:caseId,status:'pending_review',uploadCommittedAt:clock,expiresAt:clock+200000};
 const store={data:{visaCases:{[customer]:c},visaMedia:{[id]:source},visaUpload:{version:1,sessions:{[sessionId]:{id:sessionId,customer,caseId,caseSignature:signature,state:'completed',completedAt:clock,expiresAt:clock+100000,files:[{id,role:'passport'}]}}}},save(){this.saves=(this.saves||0)+1;}};
 const consents=createVisaMrzConsent({store,now:()=>clock}),profile={provider:'openai',readerFingerprint:'b'.repeat(64),inputPolicy:'upright_page_internal_mrz_crop_v1',policySha256:'c'.repeat(64)};
 const input={customer,caseId,caseSignature:signature,source,...profile},grant={...input,sources:[source],sessionId,expiresAt:clock+100000};
 return{store,consents,input,grant,source,c,session:store.data.visaUpload.sessions[sessionId],setNow:value=>clock=value,now:()=>clock};
}
test('construction is inert and cannot migrate historical documents into consent',()=>{
 const store={data:{},save(){throw Error('must not save');}};const consents=createVisaMrzConsent({store});assert.deepEqual(store.data,{});assert.equal(consents.verify({},{}),false);assert.equal(store.data.visaMrzConsent,undefined);
 const f=fixture();delete f.source.uploadSessionId;assert.throws(()=>f.consents.grantUpload(f.grant),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(f.store.data.visaMrzConsent,undefined);
});
test('grant persists opaque source-bound evidence before returning and verify is exact synchronous boolean',()=>{
 const f=fixture(),map=f.consents.grantUpload(f.grant),ref=map[f.source.id];assert.equal(f.store.saves,1);assert.equal(f.consents.verify(ref,f.input),true);assert.equal(typeof f.consents.verify(ref,f.input),'boolean');
 const raw=JSON.stringify(f.store.data.visaMrzConsent);for(const secret of [customer,f.c.id,f.source.id,f.session.id,'Bearer ','documentText','bytes'])assert.equal(raw.includes(secret),false);
 const item=f.store.data.visaMrzConsent.items[ref.consentId];assert.equal(item.expiresAt,f.session.expiresAt);assert.match(ref.consentDigest,/^[a-f0-9]{64}$/);assert.equal(item.sourceSha256,f.source.checksum);assert.equal(item.consentPolicy,'optional_upload_openai_mrz_v1');
 assert.throws(()=>f.consents.grantUpload(f.grant),/MRZ_CONSENT_UNAVAILABLE/);
});
test('expiry cannot extend past upload session and grant only binds currently selected active passport/residence originals',()=>{
 for(const alter of [f=>f.grant.expiresAt++,f=>f.session.state='open',f=>f.session.files[0].withdrawn=true,f=>f.source.purpose='visa_upload_staged',f=>f.source.uploadCaseId=crypto.randomUUID(),f=>f.grant.sources=[{...f.source,checksum:'d'.repeat(64)}]]){
  const f=fixture();alter(f);assert.throws(()=>f.consents.grantUpload(f.grant),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(f.store.data.visaMrzConsent,undefined);
 }
 const f=fixture();f.source.uploadRole='photo';f.session.files[0].role='photo';assert.deepEqual(f.consents.grantUpload(f.grant),{});assert.equal(f.store.data.visaMrzConsent,undefined);
});
test('wrong or tampered case, source, profile, evidence and expiry fail closed',()=>{
 for(const alter of [
  f=>f.input.customer='971500000099',f=>f.input.caseId=crypto.randomUUID(),f=>f.input.caseSignature='d'.repeat(64),f=>f.input.source={...f.source,id:crypto.randomUUID()},f=>f.input.source={...f.source,checksum:'d'.repeat(64)},f=>f.input.provider='other',f=>f.input.readerFingerprint='d'.repeat(64),f=>f.input.policySha256='d'.repeat(64),f=>f.input.inputPolicy='other_policy',f=>f.c.applicantCount++,f=>f.session.files[0].withdrawn=true,f=>f.source.checksum='d'.repeat(64),f=>f.setNow(f.session.expiresAt),
  f=>f.store.data.visaMrzConsent.items[f.ref.consentId].policySha256='d'.repeat(64),f=>f.store.data.visaMrzConsent.items[f.ref.consentId].consentPolicy='other_policy',f=>f.store.data.visaMrzConsent.items[f.ref.consentId].extra='tampered',f=>f.ref.consentDigest='d'.repeat(64),
 ]){const f=fixture();f.ref=f.consents.grantUpload(f.grant)[f.source.id];alter(f);assert.equal(f.consents.verify(f.ref,f.input),false);}
});
test('revoke, revokeSession and ambiguous grant persistence deny authorization',()=>{
 const f=fixture(),ref=f.consents.grantUpload(f.grant)[f.source.id];assert.equal(f.consents.revoke(ref,{customer:'other'}),false);assert.equal(f.consents.revoke(ref,{customer}),true);assert.equal(f.consents.verify(ref,f.input),false);
 const s=fixture(),r=s.consents.grantUpload(s.grant)[s.source.id];assert.equal(s.consents.revokeSession(s.session.id),true);assert.equal(s.consents.verify(r,s.input),false);
 const customerRevoke=fixture(),cr=customerRevoke.consents.grantUpload(customerRevoke.grant)[customerRevoke.source.id];assert.equal(customerRevoke.consents.revokeCustomer(customer),true);assert.equal(customerRevoke.consents.verify(cr,customerRevoke.input),false);
 const failed=fixture();let snapshot;failed.store.save=()=>{snapshot=structuredClone(failed.store.data);throw Error('synthetic fsync ambiguity');};assert.throws(()=>failed.consents.grantUpload(failed.grant),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(failed.store.data.visaMrzConsent,undefined);assert.ok(snapshot.visaMrzConsent);
});
test('AssistantState prunes expired consent and customer deletion removes only matching opaque records',()=>{
 const f=fixture(),ref=f.consents.grantUpload(f.grant)[f.source.id],state=new AssistantState({file:null,now:f.now});state.data={customers:{},handoffs:[],deliveries:[],...f.store.data};state.data.visaMrzConsent.items.other={customerDigest:'f'.repeat(64),expiresAt:f.now()+200000};
 state.delete(customer);assert.equal(state.data.visaMrzConsent.items[ref.consentId],undefined);assert.ok(state.data.visaMrzConsent.items.other);f.setNow(f.now()+200001);state.prune();assert.deepEqual(state.data.visaMrzConsent.items,{});
});

test('a non-synchronous store cannot return an authorized grant',async()=>{const f=fixture();f.store.save=()=>Promise.reject(Error('synthetic async save'));assert.throws(()=>f.consents.grantUpload(f.grant),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(f.store.data.visaMrzConsent,undefined);await Promise.resolve();});

test('any grant or revoke persistence ambiguity poisons verification for the process and rejects further grants',()=>{
 const f=fixture(),ref=f.consents.grantUpload(f.grant)[f.source.id],save=f.store.save;assert.equal(f.consents.healthy,true);f.store.save=()=>{throw Error('synthetic revoke ambiguity');};assert.throws(()=>f.consents.revoke(ref),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(f.consents.healthy,false);assert.equal(f.consents.hasSessionConsent(f.session.id),true);assert.equal(f.consents.verify(ref,f.input),false);f.store.save=save;assert.equal(f.consents.revoke(ref),true);assert.equal(f.consents.hasSessionConsent(f.session.id),false);assert.equal(f.consents.healthy,false);assert.throws(()=>f.consents.grantUpload(f.grant),/MRZ_CONSENT_UNAVAILABLE/);
 const failed=fixture();failed.store.save=()=>{throw Error('synthetic grant ambiguity');};assert.throws(()=>failed.consents.grantUpload(failed.grant),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(failed.consents.healthy,false);
});

test('only undefined or explicit true save acknowledgements can authorize a grant',()=>{
 for(const acknowledged of [false,null,0,1,'saved',{}]){
  const f=fixture();let snapshot;f.store.save=()=>{snapshot=structuredClone(f.store.data);return acknowledged;};
  assert.throws(()=>f.consents.grantUpload(f.grant),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(f.consents.healthy,false);assert.equal(f.store.data.visaMrzConsent,undefined);assert.ok(snapshot.visaMrzConsent);assert.throws(()=>f.consents.grantUpload(f.grant),/MRZ_CONSENT_UNAVAILABLE/);
 }
 for(const acknowledged of [undefined,true]){const f=fixture();f.store.save=()=>acknowledged;const ref=f.consents.grantUpload(f.grant)[f.source.id];assert.equal(f.consents.healthy,true);assert.equal(f.consents.verify(ref,f.input),true);}
});
test('failed synchronous revoke acknowledgements poison verification and remain retryable until confirmed save',()=>{
 for(const acknowledged of [false,null,0,1,'saved',{}]){
  const f=fixture(),ref=f.consents.grantUpload(f.grant)[f.source.id];let attempted=0;f.store.save=()=>{attempted++;return acknowledged;};
  assert.throws(()=>f.consents.revokeSession(f.session.id),/MRZ_CONSENT_UNAVAILABLE/);assert.equal(attempted,1);assert.equal(f.consents.healthy,false);assert.equal(f.consents.verify(ref,f.input),false);assert.equal(f.consents.hasSessionConsent(f.session.id),true);
  f.store.save=()=>{attempted++;return true;};assert.equal(f.consents.revokeSession(f.session.id),true);assert.equal(attempted,2);assert.equal(f.consents.hasSessionConsent(f.session.id),false);assert.equal(f.consents.healthy,false);assert.equal(f.consents.verify(ref,f.input),false);
  assert.equal(f.consents.revokeSession(f.session.id),false);assert.equal(attempted,2);
 }
});
