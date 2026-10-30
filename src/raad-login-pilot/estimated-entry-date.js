'use strict';
function fail(code){throw Object.assign(Error(code),{code});}
function dubaiDate(now){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));}
function estimate(referenceDate){if(typeof referenceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate))fail('ENTRY_DATE_PROVENANCE_INVALID');const d=new Date(referenceDate+'T12:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==referenceDate)fail('ENTRY_DATE_PROVENANCE_INVALID');d.setUTCDate(d.getUTCDate()+15);return d.toISOString().slice(0,10);}
function cleanEntryDateProvenance(value){
 if(value===undefined)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))fail('ENTRY_DATE_PROVENANCE_INVALID');
 if(['applicant_confirmed','staff_entered'].includes(value.source)&&Object.keys(value).length===1)return {source:value.source};
 if(value.source!=='office_estimate'||Object.keys(value).length!==3||value.offsetDays!==15)fail('ENTRY_DATE_PROVENANCE_INVALID');
 estimate(value.referenceDate);return {source:'office_estimate',referenceDate:value.referenceDate,offsetDays:15};
}
function assertEstimatedEntryDateCurrent({provenance,date,now=Date.now(),existingApplicationReference}={}){
 const p=cleanEntryDateProvenance(provenance);if(p?.source!=='office_estimate')return {source:p?.source||'legacy_unverified',estimated:false};
 if(existingApplicationReference)fail('ESTIMATED_ENTRY_DATE_SAVED_VALUE_UNCONFIRMED');
 if(p.referenceDate!==dubaiDate(now)||date!==estimate(p.referenceDate))fail('ESTIMATED_ENTRY_DATE_STALE');
 return {source:'office_estimate',estimated:true,referenceDate:p.referenceDate,offsetDays:15};
}
function verifyExpectedEntryDate(control,{provenance,date,now=Date.now()}={}){
 const current=assertEstimatedEntryDateCurrent({provenance,date,now});if(!current.estimated)return current;
 verifyExpectedEntryDateField(control);
 return {...current,expectedFieldVerified:true};
}
function verifyExpectedEntryDateField(control){
 // An identifier alone is insufficient evidence of the official field meaning.
 // Current read-only top-document metadata must also identify an expected date.
 const label=String(control?.label||'').normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/\s+/g,' ').trim().replace(/\s*[*:：]\s*$/u,'');
 if(control?.id!=='ExpectedEntryDate'||control.disabled||control.readOnly||!/^(?:تاريخ\s+الدخول\s+المتوقع|expected\s+(?:date\s+of\s+entry|entry\s+date))$/iu.test(label))fail('ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');
 return true;
}
function verifiedSubmittedEntryDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail('SUBMITTED_ENTRY_DATE_UNCONFIRMED');
 const parsed=new Date(value+'T12:00:00Z');if(!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==value)fail('SUBMITTED_ENTRY_DATE_UNCONFIRMED');return value;
}
function insuranceEntryDate(control,{evidence,applicationReference,caseSignature,applicantIndex}={}){
 // Insurance is a different page. The earlier application field says nothing
 // about this control's meaning. No +15 computation belongs after Save.
 verifyExpectedEntryDateField(control);
 if(!evidence||evidence.source!=='verified_current_run_submission'||evidence.applicationReference!==applicationReference||!/^[A-Z]{0,3}[0-9]{3,20}$/.test(applicationReference||'')||!/^[a-f0-9]{64}$/i.test(caseSignature||'')||evidence.caseSignature!==caseSignature||evidence.applicantIndex!==applicantIndex||!Number.isInteger(applicantIndex)||applicantIndex<0||applicantIndex>30)fail('SAVED_ENTRY_DATE_UNCONFIRMED');
 return verifiedSubmittedEntryDate(evidence.date);
}
module.exports={cleanEntryDateProvenance,assertEstimatedEntryDateCurrent,verifyExpectedEntryDate,verifyExpectedEntryDateField,verifiedSubmittedEntryDate,insuranceEntryDate,estimate,dubaiDate};
