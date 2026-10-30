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
 // An identifier alone is insufficient evidence of the official field meaning.
 // Current read-only top-document metadata must also identify an expected date.
 const label=String(control?.label||'').normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/\s+/g,' ').trim().replace(/\s*[*:：]\s*$/u,'');
 if(control?.id!=='ExpectedEntryDate'||control.disabled||control.readOnly||!/^(?:تاريخ\s+الدخول\s+المتوقع|expected\s+(?:date\s+of\s+entry|entry\s+date))$/iu.test(label))fail('ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');
 return {...current,expectedFieldVerified:true};
}
module.exports={cleanEntryDateProvenance,assertEstimatedEntryDateCurrent,verifyExpectedEntryDate,estimate,dubaiDate};
