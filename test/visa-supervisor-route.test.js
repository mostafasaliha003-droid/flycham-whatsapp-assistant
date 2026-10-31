'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SUPERVISOR_SMS_NUMBER,SUPERVISOR_WHATSAPP_NUMBER,supervisorSmsRoute,supervisorSmsVerified,assertSupervisorSmsDestination,supervisorWhatsAppRecipient}=require('../src/visa-supervisor-route');
const NOW=1793354400000;
const generic=()=>({origin:'https://visa.mofa.gov.sa',path:'/SmartForm/TraditionalApp',mobileFieldId:'MobileInfo_Mobile',prefixFieldId:'MobileInfo_MobilePrefix',sourceUrl:'https://visa.mofa.gov.sa/SmartForm/TraditionalApp',evidenceSha256:'a'.repeat(64),verifiedAt:NOW-1000,expiresAt:NOW+60000,role:'office_verification_contact',basis:'user_authorization_and_observed_generic_field',officialRepresentativeStatus:'not_established',authorization:{source:'explicit_user_instruction',declaredRole:'office_license_owner',scope:'saudi_visa_sms',number:SUPERVISOR_SMS_NUMBER},observation:{fieldLabel:'رقم الجوال',actionLabel:'إرسال رمز التحقق',ownership:'not_specified_in_observed_ui',nearbyInstructionText:''}});
test('explicit office-owner instruction plus generic verification label is honest office-contact basis, not official status',()=>{
 const route=supervisorSmsRoute(generic(),NOW);assert.equal(route.number,SUPERVISOR_SMS_NUMBER);assert.equal(route.role,'office_supervisor');assert.equal(route.contactBasis,'user_authorized_office_verification_contact');assert.equal(route.officialRepresentativeStatus,'not_established');assert.equal(route.officeContactLabel,'رقم الجوال');assert.ok(Object.isFrozen(route));
 assert.equal(Object.hasOwn(route,'applicantPhone'),false);assert.equal(Object.hasOwn(route,'officiallyApproved'),false);
});
test('neither license-owner assertion alone nor generic UI alone grants the contact interpretation',()=>{
 for(const patch of [{authorization:null},{observation:null},{officialRepresentativeStatus:'verified'},{allowsSupervisor:true},{basis:'the_field_is_blank'},{role:'applicant_phone'}])assert.equal(supervisorSmsVerified({...generic(),...patch},NOW),false);
 for(const patch of [{source:'inferred'},{scope:'all_accounts'},{declaredRole:'third_party'},{number:'971500000000'}])assert.equal(supervisorSmsVerified({...generic(),authorization:{...generic().authorization,...patch}},NOW),false);
});
test('explicit applicant ownership in label or nearby instructions always stops, in Arabic and English',()=>{
 for(const value of ['رقم جوال مقدم الطلب','رقم هاتف صاحب الطلب','هاتف المتقدم','Applicant mobile number','This number must belong to the applicant','هاتف المسافر','رقم الجوال الخاص بطالب التأشيرة','يجب أن يكون الرقم لصاحب التأشيرة','رقم مقدم طلب التأشيرة','رقم حامل الجواز'])for(const field of ['fieldLabel','nearbyInstructionText'])assert.throws(()=>supervisorSmsRoute({...generic(),observation:{...generic().observation,[field]:value}},NOW),e=>e.code==='SUPERVISOR_SMS_APPLICANT_PHONE_REQUIRED');
});
test('ambiguous/unknown UI, wrong field, stale evidence and missing verification action fail closed',()=>{
 for(const observation of [{fieldLabel:'Contact details'},{actionLabel:'Save'},{ownership:'applicant'},{nearbyInstructionText:undefined}])assert.equal(supervisorSmsVerified({...generic(),observation:{...generic().observation,...observation}},NOW),false);
 for(const patch of [{mobileFieldId:'ApplicantPhone'},{sourceUrl:'https://foreign.example/form'},{sourceUrl:'https://visa.mofa.gov.sa/Account/Loginindividuals'},{expiresAt:NOW},{evidenceSha256:''}])assert.equal(supervisorSmsVerified({...generic(),...patch},NOW),false);
});
test('WhatsApp destination is only the explicitly confirmed supervisor, with no unconfigured or conflicting fallback',()=>{
 assert.equal(supervisorWhatsAppRecipient({}),null);
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:'+'+SUPERVISOR_WHATSAPP_NUMBER}),SUPERVISOR_WHATSAPP_NUMBER);
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:SUPERVISOR_WHATSAPP_NUMBER,RAAD_OTP_OWNER_RECIPIENT:SUPERVISOR_WHATSAPP_NUMBER}),SUPERVISOR_WHATSAPP_NUMBER);
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:SUPERVISOR_WHATSAPP_NUMBER,RAAD_OTP_OWNER_RECIPIENT:'971500000000'}),null);
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:'971500000000'}),null);
});
test('only the pinned supervisor and Saudi country code satisfy the actual boundary, regardless of extra manifest fields',()=>{
 const contract={...generic(),applicationPhone:'971500000000'};assert.equal(assertSupervisorSmsDestination({phone:SUPERVISOR_SMS_NUMBER.slice(3),prefixLabel:'Saudi (00966)'},contract,NOW).number,SUPERVISOR_SMS_NUMBER);
 for(const input of [{phone:'500000000',prefixLabel:'Saudi (00966)'},{phone:SUPERVISOR_SMS_NUMBER.slice(3),prefixLabel:'UAE (00971)'}])assert.throws(()=>assertSupervisorSmsDestination(input,contract,NOW),e=>e.code==='SUPERVISOR_SMS_DESTINATION_MISMATCH');
});
test('a separately verified official contract remains a different, explicitly named evidence basis',()=>{
 const policy={...generic(),basis:'verified_official_contract',role:'authorized_representative_contact',allowsSupervisor:true};delete policy.authorization;delete policy.observation;
 const route=supervisorSmsRoute(policy,NOW);assert.equal(route.contactBasis,'verified_official_contract');assert.equal(route.officialRepresentativeStatus,'established_by_supplied_contract');assert.equal(route.officeContactLabel,undefined);
});
test('permitted office contact cannot bypass the still-missing production SMS response verifier',()=>{
 const {createSmsRequestProof}=require('../src/raad-login-pilot/sms-request-proof');let listeners=0;
 const route=supervisorSmsRoute(generic(),NOW),page={on(){listeners++;},off(){},url:()=> 'https://visa.mofa.gov.sa/SmartForm/TraditionalApp',mainFrame:()=>({url:()=> 'https://visa.mofa.gov.sa/SmartForm/TraditionalApp'})};
 const proof=createSmsRequestProof(page);assert.throws(()=>proof.arm({expectedPhone:route.nationalNumber,expectedDialCode:route.dialCode}),e=>e.code==='APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED'&&e.notDispatched===true);assert.equal(listeners,0);
});

test('Saudi SMS destination and UAE WhatsApp identity are separate pinned configuration',()=>{
 assert.equal(SUPERVISOR_SMS_NUMBER,'966591182035');
 assert.equal(SUPERVISOR_WHATSAPP_NUMBER,'971507993145');
 const route=supervisorSmsRoute(generic(),NOW);
 assert.equal(route.dialCode,'966');assert.equal(route.nationalNumber,'591182035');
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:SUPERVISOR_SMS_NUMBER}),null);
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:SUPERVISOR_WHATSAPP_NUMBER,RAAD_OTP_OWNER_RECIPIENT:SUPERVISOR_SMS_NUMBER}),null);
 const old={...generic(),authorization:{...generic().authorization,number:SUPERVISOR_WHATSAPP_NUMBER}};
 assert.equal(supervisorSmsVerified(old,NOW),false,'old-number authorization must not silently cover the new SMS destination');
 for(const prefixLabel of ['Saudi Arabia (00966)','السعودية (+966)','Saudi (966)'])assert.equal(assertSupervisorSmsDestination({phone:'591182035',prefixLabel},generic(),NOW).dialCode,'966');
 for(const input of [{phone:'0591182035',prefixLabel:'Saudi (00966)'},{phone:'966591182035',prefixLabel:'Saudi (00966)'},{phone:'591182035',prefixLabel:'Saudi (00966) UAE (00971)'}])assert.throws(()=>assertSupervisorSmsDestination(input,generic(),NOW),e=>e.code==='SUPERVISOR_SMS_DESTINATION_MISMATCH');
});
