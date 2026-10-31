'use strict';
// Consent is evidence for one current upload only. Constructing the service does
// not create state, migrate historical documents, or authorize any provider call.
const {createHash,randomUUID}=require('node:crypto');
const {validCustomer}=require('./conversation-journal');
const {visaCaseSignature}=require('./visa-case-signature');
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INPUT_POLICY='upright_page_internal_mrz_crop_v1',CONSENT_POLICY='optional_upload_openai_mrz_v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const opaque=(kind,value)=>hash('visa-mrz-consent-v1:'+kind+':'+value);
const failure=()=>Object.assign(Error('MRZ_CONSENT_UNAVAILABLE'),{code:'MRZ_CONSENT_UNAVAILABLE'});
function consentDigest(record){return hash(JSON.stringify(['visa-mrz-consent-v1',record.id,record.customerDigest,record.caseDigest,record.caseSignature,record.sourceDigest,record.sourceSha256,record.sessionDigest,record.role,record.provider,record.readerFingerprint,record.inputPolicy,record.policySha256,record.consentPolicy,record.grantedAt,record.expiresAt]));}
function profile(value){return value?.provider==='openai'&&SHA.test(value.readerFingerprint||'')&&value.inputPolicy===INPUT_POLICY&&SHA.test(value.policySha256||'');}
function createVisaMrzConsent({store,now=Date.now}={}){
 if(!store?.data||typeof store.save!=='function'||typeof now!=='function')throw failure();
 let fault=false;const pendingRevocations=new Set();
 const persist=()=>{try{const result=store.save();if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw failure();}if(result!==undefined&&result!==true)throw failure();}catch{fault=true;throw failure();}};
 const data=()=>{const value=store.data.visaMrzConsent;return value?.version===1&&value.items&&typeof value.items==='object'&&!Array.isArray(value.items)?value:null;};
 const active=({customer,caseId,caseSignature,source,sessionId})=>{
  if(!validCustomer(customer)||typeof caseId!=='string'||!caseId||caseId.length>100||!SHA.test(caseSignature||'')||!source||!UUID.test(source.id||''))return null;
  const c=store.data.visaCases?.[customer],record=store.data.visaMedia?.[source.id];
  if(!c||c.id!==caseId||c.pendingAmendment||c.submissionStatus==='submitted'||visaCaseSignature(c)!==caseSignature||!record||record.customer!==customer||record.purpose||record.status!=='pending_review'||record.uploadCaseId!==caseId||!['passport','residence'].includes(record.uploadRole)||!SHA.test(record.checksum||'')||!Number.isFinite(record.expiresAt)||record.expiresAt<=now()||!Number.isFinite(record.uploadCommittedAt))return null;
  if((source.checksum||source.sourceSha256)!==record.checksum||source.uploadRole!==undefined&&source.uploadRole!==record.uploadRole||source.role!==undefined&&source.role!==record.uploadRole)return null;
  const session=store.data.visaUpload?.sessions?.[record.uploadSessionId];
  if(!session||session.id!==record.uploadSessionId||sessionId!==undefined&&session.id!==sessionId||session.state!=='completed'||session.customer!==customer||session.caseId!==caseId||session.caseSignature!==caseSignature||!Number.isFinite(session.expiresAt)||session.expiresAt<=now()||!Number.isFinite(session.completedAt)||!session.files?.some(file=>file.id===record.id&&!file.withdrawn&&file.role===record.uploadRole))return null;
  return{record,session};
 };
 function grantUpload(input={}){
  if(fault)throw failure();
  const {customer,caseId,caseSignature,sources,sessionId,expiresAt}=input;
  if(!profile(input)||!UUID.test(sessionId||'')||!Array.isArray(sources)||sources.length>5||new Set(sources.map(x=>x?.id)).size!==sources.length||!Number.isFinite(expiresAt)||expiresAt<=now())throw failure();
  const eligible=sources.filter(source=>['passport','residence'].includes(source?.uploadRole||source?.role));
  if(!eligible.length)return{};
  const checked=eligible.map(source=>{const current=active({customer,caseId,caseSignature,source,sessionId});if(!current||expiresAt>current.session.expiresAt)throw failure();return current;});
  const existing=store.data.visaMrzConsent;if(existing&&!data())throw failure();
  const namespace=existing||{version:1,items:{}};
  if(Object.keys(namespace.items).length+checked.length>5000)throw failure();
  // An already decided upload may not acquire new grants through a retry.
  if(Object.values(namespace.items).some(item=>item.sessionDigest===opaque('session',sessionId)))throw failure();
  const records=checked.map(({record,session})=>({id:randomUUID(),customerDigest:opaque('customer',customer),caseDigest:opaque('case',caseId),caseSignature,sourceDigest:opaque('source',record.id),sourceSha256:record.checksum,sessionDigest:opaque('session',session.id),role:record.uploadRole,provider:'openai',readerFingerprint:input.readerFingerprint,inputPolicy:input.inputPolicy,policySha256:input.policySha256,consentPolicy:CONSENT_POLICY,grantedAt:now(),expiresAt:Math.min(expiresAt,session.expiresAt,record.expiresAt),revokedAt:null}));
  const result={};for(let i=0;i<records.length;i++){const item=records[i];item.consentDigest=consentDigest(item);namespace.items[item.id]=item;result[checked[i].record.id]={consentId:item.id,consentDigest:item.consentDigest};}
  store.data.visaMrzConsent=namespace;
  try{persist();}catch{
   // No reference escapes on an uncertain write. Verification stays poisoned
   // for this process even after removing the unconfirmed in-memory entries.
   for(const item of records)delete namespace.items[item.id];if(!existing)delete store.data.visaMrzConsent;
   throw failure();
  }
  return result;
 }
 function verify(reference,input={}){
  try{
   if(fault||!reference||!UUID.test(reference.consentId||'')||!SHA.test(reference.consentDigest||''))return false;
   const item=data()?.items[reference.consentId];
   if(!item||Object.keys(item).sort().join(',')!==['id','customerDigest','caseDigest','caseSignature','sourceDigest','sourceSha256','sessionDigest','role','provider','readerFingerprint','inputPolicy','policySha256','consentPolicy','grantedAt','expiresAt','revokedAt','consentDigest'].sort().join(',')||item.id!==reference.consentId||item.revokedAt!==null||!Number.isFinite(item.grantedAt)||item.grantedAt>now()||!Number.isFinite(item.expiresAt)||item.expiresAt<=now()||item.consentDigest!==reference.consentDigest||consentDigest(item)!==reference.consentDigest||!profile(item)||item.consentPolicy!==CONSENT_POLICY)return false;
   if(item.provider!==input.provider||item.readerFingerprint!==input.readerFingerprint||item.inputPolicy!==input.inputPolicy||item.policySha256!==input.policySha256||item.customerDigest!==opaque('customer',input.customer)||item.caseDigest!==opaque('case',input.caseId)||item.caseSignature!==input.caseSignature||item.sourceDigest!==opaque('source',input.source?.id)||item.sourceSha256!==(input.source?.checksum||input.source?.sourceSha256))return false;
   const current=active(input);return Boolean(current&&item.sessionDigest===opaque('session',current.session.id)&&item.role===current.record.uploadRole&&item.expiresAt<=current.session.expiresAt);
  }catch{return false;}
 }
 function revokeItems(items){
  items=items.filter(item=>item.revokedAt===null||pendingRevocations.has(item.id));
  if(!items.length)return false;for(const item of items)if(item.revokedAt===null)item.revokedAt=now();
  try{persist();for(const item of items)pendingRevocations.delete(item.id);}catch(error){for(const item of items)pendingRevocations.add(item.id);throw error;}return true;
 }
 function revoke(reference,{customer}={}){
  const item=data()?.items[typeof reference==='string'?reference:reference?.consentId];
  if(!item||customer!==undefined&&item.customerDigest!==opaque('customer',customer))return false;
  return revokeItems([item]);
 }
 function hasSessionConsent(sessionId,{includeRevoked=false}={}){return UUID.test(sessionId||'')&&Object.values(data()?.items||{}).some(item=>item?.sessionDigest===opaque('session',sessionId)&&(includeRevoked||item.revokedAt===null||pendingRevocations.has(item.id)));}
 function revokeSession(sessionId){return revokeItems(Object.values(data()?.items||{}).filter(item=>item?.sessionDigest===opaque('session',sessionId)));}
 function revokeCustomer(customer){if(!validCustomer(customer))return false;return revokeItems(Object.values(data()?.items||{}).filter(item=>item?.customerDigest===opaque('customer',customer)));}
 return{grantUpload,verify,revoke,revokeSession,revokeCustomer,hasSessionConsent,get healthy(){return !fault;}};
}
module.exports={createVisaMrzConsent,visaMrzConsentCustomerDigest:customer=>opaque('customer',customer)};
