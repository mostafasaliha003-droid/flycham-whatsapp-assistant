'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VERIFIED_FAMILY_PROVIDERS,classifyParty,partyCapability,partyCapabilityStatus,partyControlMetadataAction,inspectPartyControls}=require('../src/party-capabilities');

test('only a verified one-adult scope is enabled for either supplier',()=>{
 assert.deepEqual(VERIFIED_FAMILY_PROVIDERS,[]);assert.ok(Object.isFrozen(VERIFIED_FAMILY_PROVIDERS));
 for(const provider of ['airarabia','flycham']){
  assert.equal(partyCapability(provider,{adults:1,children:0,infants:0}).supported,true);
  for(const p of [{adults:1,children:1,infants:0,ages:[7]},{adults:1,children:0,infants:1,ages:[1]}])assert.deepEqual(partyCapability(provider,p),{supported:false,profile:classifyParty(p),reason:'family_portal_verification_required'});
 }
 assert.equal(partyCapability('unknown',{adults:1,children:0,infants:0}).supported,false);
});

test('age categories and actual party composition are validated without price inference',()=>{
 assert.equal(classifyParty({adults:1,children:1,infants:0,ages:[2]}),'adult_child');
 assert.equal(classifyParty({adults:1,children:1,infants:0,ages:[11]}),'adult_child');
 assert.equal(classifyParty({adults:1,children:0,infants:1,ages:[0]}),'adult_infant');
 for(const p of [{adults:1,children:1,infants:0,ages:[1]},{adults:1,children:1,infants:0,ages:[12]},{adults:1,children:0,infants:1,ages:[2]},{adults:1,children:1,infants:0,ages:[]},{adults:2,children:0,infants:0,ages:[]},{adults:0,children:1,infants:0,ages:[7]},{adults:'1',children:0,infants:0},{adults:1,children:0,infants:0,ages:[7]}])assert.equal(classifyParty(p),null);
 const status=partyCapabilityStatus();assert.equal(status.airarabia.family,false);assert.equal(status.flycham.family,false);assert.ok(status.airarabia.blockers.includes('per_passenger_ancillaries_unverified'));assert.ok(status.flycham.blockers.includes('aggregate_party_total_unverified'));
});

test('diagnostic emits only bounded metadata and cannot declare family support',async()=>{
 const raw={status:'observed',counts:{adultCount:{present:true,visible:true,kind:'select',value:1,options:[0,1,2,99,'PRIVATE_VALUE']},childCount:{present:true,visible:true,kind:'select',value:1,options:[0,1]},infantCount:{present:true,visible:true,kind:'select',value:0,options:[0,1]}},ageControls:{child:1,infant:999},totalHints:{aedTotalVisible:true,aggregateLabel:true,perPersonLabel:false},capabilityVerified:true,password:'PRIVATE_PASSWORD',passenger:{name:'PRIVATE_NAME',dob:'PRIVATE_DOB'},amount:'PRIVATE_PRICE'};
 const result=await inspectPartyControls({evaluate:async fn=>{assert.equal(fn,partyControlMetadataAction);return raw;}});
 assert.equal(result.capabilityVerified,false);assert.deepEqual(result.counts.adultCount.options,[0,1,2]);assert.equal(result.ageControls.infant,0);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|password|passenger|amount|dob/);
 raw.counts.adultCount.value='TOKEN';raw.counts.adultCount.kind='PRIVATE_KIND';const bad=await inspectPartyControls({evaluate:async()=>raw});assert.equal(bad.counts.adultCount.value,null);assert.equal(bad.counts.adultCount.kind,'other');
});

test('untrusted or failing diagnostics never become capability evidence',async()=>{
 for(const frame of [{evaluate:async()=>({status:'untrusted_origin',capabilityVerified:true})},{evaluate:async()=>{throw Error('PRIVATE_FAILURE');}}])assert.deepEqual(await inspectPartyControls(frame),{status:'unavailable',capabilityVerified:false});
});

test('browser diagnostic reads observed form structure without passenger or monetary values',()=>{
 const previous=Object.fromEntries(['location','document','getComputedStyle'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const field=(id,value)=>({id,name:id,tagName:'SELECT',value,options:[{value:'0'},{value:'1'},{value:'2',disabled:true}],getClientRects:()=>[{}]});
 const counts={adultCount:field('adultCount','1'),childCount:field('childCount','1'),infantCount:field('infantCount','0')};
 const age={id:'1_displayChildDOB',name:'childDOB',tagName:'INPUT',get value(){throw Error('DOB must not be read');},getClientRects:()=>[{}]};
 try{
  Object.defineProperty(globalThis,'location',{value:{origin:'https://reservations.flycham.com'},configurable:true});
  Object.defineProperty(globalThis,'getComputedStyle',{value:()=>({visibility:'visible',display:'block'}),configurable:true});
  Object.defineProperty(globalThis,'document',{value:{querySelectorAll:selector=>selector==='input,select'?[...Object.values(counts),age]:[counts[selector.match(/id="([^"]+)"/)?.[1]]].filter(Boolean),getElementById:()=>({textContent:'AED 1,000.00',parentElement:{textContent:'Grand total AED 1,000.00'},getClientRects:()=>[{}]})},configurable:true});
  const result=partyControlMetadataAction();assert.equal(result.status,'observed');assert.equal(result.counts.childCount.value,1);assert.deepEqual(result.counts.childCount.options,[0,1]);assert.equal(result.ageControls.child,1);assert.equal(result.totalHints.aggregateLabel,true);assert.equal(result.capabilityVerified,false);assert.doesNotMatch(JSON.stringify(result),/1,000|DOB/);
  globalThis.location.origin='https://foreign.example';assert.deepEqual(partyControlMetadataAction(),{status:'untrusted_origin'});
 }finally{for(const k of Object.keys(previous))if(previous[k])Object.defineProperty(globalThis,k,previous[k]);else delete globalThis[k];}
});
