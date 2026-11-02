'use strict';
const {validateDocumentExtraction}=require('./visa-document-vision');
const POLICY='independent-cline-document-review-v1',THRESHOLD=0.98;
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
module.exports={DOCUMENT_REVIEW_POLICY:POLICY,needsDocumentReview,mergeDocumentReview};
