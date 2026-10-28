'use strict';
// Separates a later application challenge from the completed login challenge.
// Structural metadata only; this function never accepts or returns code values.
function applicationVerificationPhase(inspection){
 const value=inspection?.applicationVerification;
 const controls=Array.isArray(value?.controls)?value.controls:[];
 const codeFields=controls.filter(control=>control&&control.disabled!==true&&control.readonly!==true&&['text','tel','number','search'].includes(control.type)&&! /captcha|password|token|secret/i.test([control.id,control.name].join(' ')));
 const explicitSms=Array.isArray(value?.evidence)&&value.evidence.includes('explicit_sms_caption');
 const namedSms=codeFields.some(control=>/otp|sms|(?:mobile|phone).*code|one.?time/i.test([control.id,control.name].join(' ')));
 const required=value?.context==='sms'&&codeFields.length>0&&(explicitSms||namedSms);
 return {kind:required?'sms':'unconfirmed',stage:required?'application_sms_required':'application_in_progress',visibleCodeFieldCount:codeFields.length,requiresUserCode:required,canEnterCode:required&&codeFields.length===1};
}
module.exports={applicationVerificationPhase};
