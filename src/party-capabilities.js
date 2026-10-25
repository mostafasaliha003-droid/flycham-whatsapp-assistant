'use strict';

// Capability is established by a completed portal pricing verification, not by
// an environment toggle, an age-category assumption, or multiplying one fare.
const VERIFIED_FAMILY_PROVIDERS=Object.freeze([]);
const PROVIDERS=Object.freeze(['airarabia','flycham']);
const BLOCKERS=Object.freeze({
 airarabia:Object.freeze(['child_infant_passenger_form_unverified','per_passenger_ancillaries_unverified','family_total_unverified']),
 flycham:Object.freeze(['child_infant_age_flow_unverified','aggregate_party_total_unverified','family_margin_policy_unconfirmed']),
});

function classifyParty(passengers){
 const p=passengers;
 if(!p||!['adults','children','infants'].every(k=>Number.isInteger(p[k])&&p[k]>=0&&p[k]<=9))return null;
 const ages=p.ages===undefined?[]:p.ages;
 if(!Array.isArray(ages)||ages.some(a=>!Number.isInteger(a)||a<0||a>11))return null;
 if(p.adults===1&&p.children===0&&p.infants===0&&ages.length===0)return 'adult';
 if(p.adults===1&&p.children===1&&p.infants===0&&ages.length===1&&ages[0]>=2)return 'adult_child';
 if(p.adults===1&&p.children===0&&p.infants===1&&ages.length===1&&ages[0]<2)return 'adult_infant';
 return null;
}

function partyCapability(provider,passengers){
 const profile=classifyParty(passengers);
 if(!PROVIDERS.includes(provider))return {supported:false,profile:null,reason:'provider_unknown'};
 if(!profile)return {supported:false,profile:null,reason:'party_scope_unverified'};
 if(profile==='adult')return {supported:true,profile,reason:null};
 return {supported:false,profile,reason:'family_portal_verification_required'};
}

function partyCapabilityStatus(){
 return Object.fromEntries(PROVIDERS.map(provider=>[provider,{adult:true,family:false,verifiedFamilyProfiles:[],blockers:[...BLOCKERS[provider]]}]));
}

// Read-only UI structure inspection for the operator's next verification pass.
// No submit, click, fill, hidden field mutation, cookie, script source, PNR,
// passenger name, document number, DOB, contact value or price is returned.
function partyControlMetadataAction(){
 if(!['https://agents.airarabia.com','https://reservations.flycham.com'].includes(location.origin))return {status:'untrusted_origin'};
 const visible=e=>Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');
 const count=id=>{
  const elements=[...document.querySelectorAll('[id="'+id+'"]')],e=elements.length===1?elements[0]:null;
  const value=e&&/^\d$/.test(String(e.value))?Number(e.value):null;
  const options=e?.tagName==='SELECT'?[...e.options].filter(o=>!o.disabled&&/^\d$/.test(String(o.value))).map(o=>Number(o.value)):[];
  return {present:elements.length===1,ambiguous:elements.length>1,visible:visible(e),kind:e?.tagName==='SELECT'?'select':e?.tagName==='INPUT'?'input':'other',value,options};
 };
 const ageCount=kind=>[...document.querySelectorAll('input,select')].filter(e=>visible(e)&&new RegExp(kind,'i').test(String(e.id||'')+' '+String(e.name||''))&&/dob|birth|age/i.test(String(e.id||'')+' '+String(e.name||''))).length;
 const total=document.getElementById('divFQTxnCurr'),context=visible(total)?String(total.parentElement?.textContent||'').slice(0,1500):'';
 return {status:'observed',counts:{adultCount:count('adultCount'),childCount:count('childCount'),infantCount:count('infantCount')},ageControls:{child:ageCount('child'),infant:ageCount('infant')},totalHints:{aedTotalVisible:visible(total)&&/\bAED\s+[\d,]+\.\d{2}\b/.test(total.textContent||''),aggregateLabel:/\bgrand\s+total\b|\btotal\s+(?:amount|price|fare)\b/i.test(context),perPersonLabel:/\bper\s+(?:person|passenger|adult)\b/i.test(context)},capabilityVerified:false};
}

async function inspectPartyControls(frame){
 try{
  const observed=await frame.evaluate(partyControlMetadataAction);
  if(observed?.status!=='observed')return {status:'unavailable',capabilityVerified:false};
  const integer=v=>Number.isInteger(v)&&v>=0&&v<=9?v:null;
  const counts={};
  for(const key of ['adultCount','childCount','infantCount']){
   const c=observed.counts?.[key]||{};
   counts[key]={present:c.present===true,ambiguous:c.ambiguous===true,visible:c.visible===true,kind:['input','select'].includes(c.kind)?c.kind:'other',value:integer(c.value),options:[...new Set((Array.isArray(c.options)?c.options:[]).map(integer).filter(v=>v!==null))].slice(0,10)};
  }
  const bounded=v=>Number.isInteger(v)&&v>=0&&v<=30?v:0;
  return {status:'observed',counts,ageControls:{child:bounded(observed.ageControls?.child),infant:bounded(observed.ageControls?.infant)},totalHints:{aedTotalVisible:observed.totalHints?.aedTotalVisible===true,aggregateLabel:observed.totalHints?.aggregateLabel===true,perPersonLabel:observed.totalHints?.perPersonLabel===true},capabilityVerified:false};
 }catch{return {status:'unavailable',capabilityVerified:false};}
}

module.exports={VERIFIED_FAMILY_PROVIDERS,classifyParty,partyCapability,partyCapabilityStatus,partyControlMetadataAction,inspectPartyControls};
