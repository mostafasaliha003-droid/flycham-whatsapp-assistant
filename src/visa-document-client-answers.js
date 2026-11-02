'use strict';
const {visaCaseSignature}=require('./visa-case-signature');
const {validateAnswer}=require('./visa-client-questions');
// Customer answers remain distinct from OCR evidence and financial approval.
function documentClientAnswers(store,customer,app,now=Date.now()){
 const c=store?.data?.visaCases?.[customer],state=store?.data?.visaDocumentIntake?.cases?.[customer];
 if(!c||!state||state.caseId!==c.id||state.caseSignature!==visaCaseSignature(c)||!app?.id)return {};
 const fields={};
 for(const item of Object.values(store.data.visaDocumentNotifications?.items||{})){
  const a=item?.answer,b=item?.binding;
  const sourceList=values=>Array.isArray(values)&&values.length>0&&values.length<=100&&values.every(v=>v&&/^[a-f0-9-]{36}$/i.test(v.mediaId||'')&&/^[a-f0-9]{64}$/.test(v.sha256||''))?values.map(v=>[v.mediaId,v.sha256]).sort((a,b)=>a[0].localeCompare(b[0])):null;
  const currentSources=sourceList(app.sourceManifest),answeredSources=sourceList(b?.sources);
  const unchangedSingleApplicant=c.applicantCount===1&&state.applicants?.length===1&&app.applicantIndex===0&&currentSources&&answeredSources&&JSON.stringify(currentSources)===JSON.stringify(answeredSources);

  if(item.customer!==customer||item.state!=='accepted'||!Number.isFinite(item.expiresAt)||item.expiresAt<=now||item.payload?.type!=='question'||item.payload.field!=='passportType'||item.payload.applicantIndex!==app.applicantIndex||!a||a.field!=='passportType'||a.applicantIndex!==app.applicantIndex||a.evidenceId!==app.id&&!unchangedSingleApplicant||b?.caseId!==c.id||b.caseSignature!==state.caseSignature||b.generation!==state.generation||!app.clientFieldsRequired?.includes(a.field))continue;
  try{const value=validateAnswer(a.field,a.value);if(fields[a.field]&&fields[a.field]!==value)return {};fields[a.field]=value;}catch{}
 }
 return fields;
}
module.exports={documentClientAnswers};
