'use strict';
// Contact identity and user instruction are not claims of government-recognized
// representative status. This module cannot establish legal authority.
const SUPERVISOR_WHATSAPP_NUMBER='971507993145';
const SUPERVISOR_SMS_NUMBER='966591182035';
// Backward-compatible alias is the WhatsApp identity, never the portal SMS destination.
const SUPERVISOR_NUMBER=SUPERVISOR_WHATSAPP_NUMBER;
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm/TraditionalApp';
const normalized=value=>String(value||'').normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640\u200b-\u200f\u202a-\u202e\u2066-\u2069*:：]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
function applicantOwnershipWording(value){return /(?:مقدم\s*(?:الطلب|طلب)|صاحب\s*الطلب|(?:طالب|صاحب)\s*(?:التأشير[ةه]|التاشير[ةه])|حامل\s*(?:جواز|الجواز)|المتقدم|المسافر|المستفيد|applicant|travell?er|beneficiary|passenger)/i.test(normalized(value));}
function fail(code='SUPERVISOR_SMS_FIELD_UNVERIFIED'){throw Object.assign(new Error(code),{code,notDispatched:true});}
function supervisorWhatsAppRecipient(env={}){const values=[env.RAAD_OTP_OWNER_WHATSAPP,env.RAAD_OTP_OWNER_RECIPIENT].filter(v=>v!==undefined&&v!=='');return values.length&&values.every(v=>typeof v==='string'&&v.replace(/^\+/,'')===SUPERVISOR_WHATSAPP_NUMBER)?SUPERVISOR_WHATSAPP_NUMBER:null;}
function supervisorSmsRoute(contract,now=Date.now()){
 if(!contract||typeof contract!=='object'||Array.isArray(contract)||contract.origin!==ORIGIN||contract.path!==PATH||contract.mobileFieldId!=='MobileInfo_Mobile'||contract.prefixFieldId!=='MobileInfo_MobilePrefix'||!/^[a-f0-9]{64}$/.test(contract.evidenceSha256||'')||!Number.isSafeInteger(now)||!Number.isSafeInteger(contract.verifiedAt)||!Number.isSafeInteger(contract.expiresAt)||contract.verifiedAt<=0||contract.verifiedAt>now||contract.expiresAt<=now||contract.expiresAt-contract.verifiedAt>30*86400000)fail();
 try{const url=new URL(contract.sourceUrl);if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash)fail();}catch{fail();}
 const observed=contract.observation;
 // Explicit applicant ownership always stops the office-contact interpretation.
 if(observed&&applicantOwnershipWording([observed.fieldLabel,observed.nearbyInstructionText].join(' ')))fail('SUPERVISOR_SMS_APPLICANT_PHONE_REQUIRED');
 let contactBasis,officialRepresentativeStatus,officeContactLabel;
 if(contract.role==='authorized_representative_contact'&&contract.basis==='verified_official_contract'&&contract.allowsSupervisor===true){
  contactBasis='verified_official_contract';officialRepresentativeStatus='established_by_supplied_contract';
 }else if(contract.role==='office_verification_contact'&&contract.basis==='user_authorization_and_observed_generic_field'){
  const authority=contract.authorization;
  if(new URL(contract.sourceUrl).pathname!==PATH)fail();
  if(!authority||authority.source!=='explicit_user_instruction'||authority.declaredRole!=='office_license_owner'||authority.scope!=='saudi_visa_sms'||authority.number!==SUPERVISOR_SMS_NUMBER||contract.allowsSupervisor!==undefined||contract.officialRepresentativeStatus!=='not_established')fail();
  if(!observed||observed.ownership!=='not_specified_in_observed_ui'||typeof observed.nearbyInstructionText!=='string'||observed.nearbyInstructionText.length>1000||!['رقم الجوال','mobile number'].includes(normalized(observed.fieldLabel))||!['إرسال رمز التحقق','ارسال رمز التحقق','send verification code'].includes(normalized(observed.actionLabel)))fail();
  contactBasis='user_authorized_office_verification_contact';officialRepresentativeStatus='not_established';officeContactLabel=normalized(observed.fieldLabel);
 }else fail();
 return Object.freeze({number:SUPERVISOR_SMS_NUMBER,nationalNumber:SUPERVISOR_SMS_NUMBER.slice(3),dialCode:'966',role:'office_supervisor',contactBasis,officialRepresentativeStatus,...(officeContactLabel?{officeContactLabel}:{})});
}
function supervisorSmsVerified(contract,now=Date.now()){try{supervisorSmsRoute(contract,now);return true;}catch{return false;}}
function assertSupervisorSmsDestination({phone,prefixLabel}={},contract,now=Date.now()){
 const route=supervisorSmsRoute(contract,now),codes=typeof prefixLabel==='string'?[...prefixLabel.matchAll(/\((?:00|\+)?([1-9][0-9]{0,3})\)/g)]:[];
 if(phone!==route.nationalNumber||codes.length!==1||codes[0][1]!==route.dialCode)fail('SUPERVISOR_SMS_DESTINATION_MISMATCH');return route;
}
module.exports={SUPERVISOR_NUMBER,SUPERVISOR_SMS_NUMBER,SUPERVISOR_WHATSAPP_NUMBER,supervisorWhatsAppRecipient,supervisorSmsRoute,supervisorSmsVerified,assertSupervisorSmsDestination,applicantOwnershipWording};
