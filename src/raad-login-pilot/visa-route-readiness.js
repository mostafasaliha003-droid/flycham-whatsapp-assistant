'use strict';
// Bounded, read-only readiness checks. Hidden phone controls are not a wrong form.
const FORM='/SmartForm/TraditionalApp';
const normalize=value=>String(value??'').normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').toLowerCase().replace(/[\s-]+/g,' ').trim();
const fail=(code,field)=>{throw Object.assign(new Error(code),{code,...(field?{field}:{})});};
function abuDhabiMission(value){
 if(value===undefined||value===null||value==='')return 'Abu Dhabi';
 if(!['abu dhabi','ابوظبي','ابو ظبي'].includes(normalize(value)))fail('MISSION_POLICY_CONFLICT','mission');
 return 'Abu Dhabi';
}
function namedOption(control,labels,field){
 const accepted=labels.map(normalize),matches=(control?.options||[]).filter(option=>typeof option.value==='string'&&option.value.trim()&&!option.disabled&&!option.hidden&&accepted.includes(normalize(option.label)));
 if(matches.length!==1)fail('PORTAL_OPTION_UNCONFIRMED',field);
 return matches[0];
}
function abuDhabiOption(control){return namedOption(control,['Abu Dhabi','أبوظبي','أبو ظبي'],'mission');}
function tourismOption(control){return namedOption(control,['زيارة سياحية','Tourist visit','Tourism visit'],'visitPurpose');}
async function waitForPhoneSection({inspect,wait,guard,locate,now=Date.now,timeoutMs=15000,pollMs=500}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(pollMs)||pollMs<1||pollMs>timeoutMs)fail('APPLICATION_SMS_READINESS_CONFIG_INVALID');
 const started=now(),deadline=started+timeoutMs,maxPolls=Math.ceil(timeoutMs/pollMs)+1;
 for(let poll=0;poll<maxPolls;poll++){
  await guard();
  if((await locate())?.path!==FORM)fail('APPLICATION_SMS_FORM_CHANGED');
  const data=await inspect();await guard();
  if((await locate())?.path!==FORM||data?.path!==FORM)fail('APPLICATION_SMS_FORM_CHANGED');
  const elapsed=now()-started;if(elapsed<0||now()>deadline)fail('APPLICATION_SMS_SECTION_UNAVAILABLE');
  const controls=Array.isArray(data.controls)?data.controls:[];
  const prefix=controls.filter(c=>c.id==='MobileInfo_MobilePrefix'),phone=controls.filter(c=>c.id==='MobileInfo_Mobile');
  if(prefix.length>1||phone.length>1)fail('APPLICATION_SMS_SECTION_AMBIGUOUS');
  // Inspection returns only visible native controls, including visible select2.
  if(prefix.length===1&&phone.length===1&&!prefix[0].disabled&&!phone[0].disabled&&!phone[0].readonly)return {ready:true};
  if(poll===maxPolls-1||now()>=deadline)break;
  await wait(Math.min(pollMs,deadline-now()));
 }
 fail('APPLICATION_SMS_SECTION_UNAVAILABLE');
}
module.exports={abuDhabiMission,abuDhabiOption,tourismOption,waitForPhoneSection};
