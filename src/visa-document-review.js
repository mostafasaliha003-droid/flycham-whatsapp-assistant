'use strict';
const {validateDocumentExtraction}=require('./visa-document-vision');
const {parseTD3MRZ}=require('./raad-document-validation');
const POLICY='independent-cline-document-review-v2',THRESHOLD=0.98;
const PASSPORT_FIELDS=['birthDate','expiryDate','issueDate','birthPlace','passportType','sex'];
function needsDocumentReview(extraction){return extraction?.kind==='passport'&&extraction.readable===true&&PASSPORT_FIELDS.some(name=>{const field=extraction.fields?.[name];return field?.visible!==true||field.confidence<THRESHOLD;});}
const comparable=(name,value)=>name.includes('Name')?value.normalize('NFKC').toUpperCase().replace(/\s+/g,' ').trim():value;
function mergeDocumentReview(primary,secondary){
 const first=validateDocumentExtraction(primary),second=validateDocumentExtraction(secondary);
 if(first.kind!==second.kind||first.rotation!==second.rotation||!second.readable)throw Object.assign(Error('DOCUMENT_REVIEW_UNCONFIRMED'),{code:'DOCUMENT_REVIEW_UNCONFIRMED'});
 const fields=structuredClone(first.fields);
 for(const [name,field]of Object.entries(second.fields)){
  if(field.visible!==true||field.confidence<THRESHOLD)continue;
  const previous=fields[name];
  if(previous?.visible===true&&previous.confidence>=THRESHOLD&&comparable(name,previous.value)!==comparable(name,field.value))return{extraction:first,conflictField:name};
  if(previous?.visible!==true||previous.confidence<field.confidence)fields[name]=structuredClone(field);
 }
 return{extraction:validateDocumentExtraction({...first,fields,portraitBox:first.portraitBox||second.portraitBox})};
}
function corroboratedPassportDate(document,field){
 if(!['birthDate','expiryDate'].includes(field)||document.extraction?.kind!=='passport')return false;
 const proof=document.reviewEvidence;if(!proof||proof.policy!==POLICY||proof.mediaId!==document.mediaId||proof.page!==document.page||proof.sha256!==document.sha256||proof.sourceSha256!==document.sourceSha256||!/^[a-f0-9]{64}$/.test(proof.sourceSha256||''))return false;
 try{
  const first=validateDocumentExtraction(document.reviewOriginalExtraction),second=validateDocumentExtraction(document.reviewSecondaryExtraction),current=validateDocumentExtraction(document.extraction);
  if([first,second,current].some(v=>v.kind!=='passport'||!v.readable||v.rotation!==current.rotation))return false;
  const a=first.fields[field],b=second.fields[field],shown=current.fields[field];if(a?.visible!==true||b?.visible!==true||shown?.visible!==true||a.confidence<0.90||b.confidence<0.90||a.value!==b.value||shown.value!==a.value||!/^\d{4}-\d{2}-\d{2}$/.test(a.value))return false;
  const parsed=parseTD3MRZ(current.mrzLines,{referenceDate:'2000-12-31'}),checks=['documentNumber','birthDate','expiryDate','optionalData','composite'];if(parsed.format!=='TD3'||!checks.every(name=>parsed.checks?.[name]?.ok===true)||!parsed.issues.every(i=>i.code==='ambiguous_century'))return false;
  return a.value.slice(2).replace(/-/g,'')===parsed.fields[field+'Raw'];
 }catch{return false;}
}
module.exports={DOCUMENT_REVIEW_POLICY:POLICY,needsDocumentReview,mergeDocumentReview,corroboratedPassportDate};
