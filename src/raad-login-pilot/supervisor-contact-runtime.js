'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {supervisorSmsRoute}=require('../visa-supervisor-route');
const PROFILE='office-saudi-2026-10-30';
const EVIDENCE_SHA='5427f21289c19c7ff77f25f8adf0919cfe9bb87aca4c73c6ad651758a8d59e85';
const VERIFIED_AT=Date.parse('2026-10-30T13:52:32Z');
// Fixed seven-day local evidence freshness window; never renewed at startup.
const EXPIRES_AT=Date.parse('2026-11-06T13:52:32Z');
function fail(){throw Object.assign(new Error('SUPERVISOR_SMS_PROFILE_INVALID'),{code:'SUPERVISOR_SMS_PROFILE_INVALID',notDispatched:true});}
function deepFreeze(value){for(const child of Object.values(value))if(child&&typeof child==='object')deepFreeze(child);return Object.freeze(value);}
function loadSupervisorSmsContract(env={},now=Date.now()){
 const selected=env.RAAD_SUPERVISOR_SMS_CONTACT_PROFILE;
 if(selected===undefined||selected==='')return null;
 if(selected!==PROFILE)fail();
 let raw,evidence;
 try{raw=fs.readFileSync(path.join(__dirname,'contact-profiles',PROFILE+'.json'));if(raw.length>8192||crypto.createHash('sha256').update(raw).digest('hex')!==EVIDENCE_SHA)fail();evidence=JSON.parse(raw.toString('utf8'));}catch{fail();}
 const contract={origin:evidence.origin,path:evidence.path,sourceUrl:evidence.origin+evidence.path,mobileFieldId:'MobileInfo_Mobile',prefixFieldId:'MobileInfo_MobilePrefix',evidenceSha256:EVIDENCE_SHA,verifiedAt:VERIFIED_AT,expiresAt:EXPIRES_AT,role:'office_verification_contact',basis:evidence.basis,officialRepresentativeStatus:evidence.officialRepresentativeStatus,authorization:{source:'explicit_user_instruction',declaredRole:'office_license_owner',scope:'saudi_visa_sms',number:evidence.smsNumber},observation:{fieldLabel:evidence.fieldLabel,actionLabel:evidence.actionLabel,ownership:evidence.ownership,nearbyInstructionText:evidence.nearbyInstructionText}};
 supervisorSmsRoute(contract,now);
 return deepFreeze(contract);
}
module.exports={loadSupervisorSmsContract};
