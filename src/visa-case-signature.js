'use strict';
const {createHash}=require('node:crypto');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value===undefined?null:value;}
// No revision/timestamps: a harmless staff note must not invalidate evidence.
// Document metadata is part of the identity of the reviewed case.
function visaCaseSignature(c){return createHash('sha256').update(JSON.stringify(canonical({caseId:c?.id||null,policyVersion:c?.policyVersion||null,applicantCount:c?.applicantCount||null,applicants:c?.applicants||[],quote:c?.quote||null,paymentMethod:c?.paymentMethod||null,travelMode:c?.transport||c?.travelMode||null,hasHost:c?.hasHost??null,departureDate:c?.departureDate||null,returnDate:c?.returnDate||null,documents:(c?.documents||[]).map(x=>typeof x==='object'&&x?Object.fromEntries(['id','mediaId','hash','sha256','kind','type','mimeType'].filter(k=>Object.hasOwn(x,k)).map(k=>[k,x[k]])):x)}))).digest('hex');}
function currentVisaEvidence(c){const sig=visaCaseSignature(c),v=c?.staffVerification||{};return{signature:sig,payment:c?.paymentStatus==='verified'&&v.payment?.caseSignature===sig&&Number.isFinite(v.payment?.amount)&&Math.round(v.payment.amount*100)===Math.round(Number(c?.quote?.total)*100),documents:v.documentsReviewed===true&&v.documentsSignature===sig,submission:c?.submissionStatus==='submitted'&&v.submission?.caseSignature===sig};}
module.exports={visaCaseSignature,currentVisaEvidence};
