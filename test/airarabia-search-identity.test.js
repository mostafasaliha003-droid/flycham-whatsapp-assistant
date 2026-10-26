'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {captureSearchBaseline,waitForSearchIdentity,assertSearchIdentity,captureSearchBaselineAction,searchIdentityAction}=require('../src/airarabia-search-identity');
const BASE={startedAt:100,endedAt:110};
function expected(extra={}){return{origin:'AUH',destination:'DAM',departureDate:'11/11/2026',returnDate:null,carrier:{value:'observed-all',carrier:'3L',mode:'SEARCH_ALL'},currency:'AED',...extra};}
function row({from='AUH',to='DAM',carrier='3L',number='3L504',day='20261111',compact='2611110920',ref='opaque$segment$identifier$'+day+'0920$opaque'}={}){return{segmentCodeList:[from+'/'+to],carrierList:[carrier],flightNoList:[number],depatureTimeList:[compact],flightRPHList:[ref],csOcCarrierList:[null]};}
function fixture({e=expected(),out=[row()],back=[],success=true,startedAt=200,endedAt=210,active=0,origin='https://agents.airarabia.com'}={}){
 const params={fromAirport:e.origin,toAirport:e.destination,departureDate:e.departureDate,returnDate:e.returnDate||'',adultCount:1,childCount:0,infantCount:0,selectedCurrency:'AED',searchSystem:e.carrier.value};
 const response={success,searchParams:params,outboundFlights:out,returnFlights:back};
 const ui={searchStartTime:startedAt,searchEndTime:endedAt,latestResponse:response,objResSrchParams:params,strOutDate:e.departureDate,strRetDate:e.returnDate||'',flightInfo:[]};
 const sandbox={location:{origin},jQuery:{active},UI_tabSearchFlights:ui,jsonOutFlts:out,jsonRetFlts:back};
 const reports=[],calls=[];
 const run=(fn,args)=>vm.runInNewContext('('+fn.toString()+')(args)',{...sandbox,args});
 const frame={evaluate:async(fn,args)=>{calls.push('evaluate');return run(fn,args);},waitForFunction:async(fn,args)=>{calls.push('wait');const value=run(fn,args);if(!value)throw Object.assign(Error('private synthetic timeout'),{name:'TimeoutError'});return{jsonValue:async()=>JSON.parse(JSON.stringify(value)),dispose:async()=>calls.push('dispose')};}};
 return{e,params,response,ui,sandbox,frame,reports,calls,run,report:code=>reports.push(code)};
}
const selected={out:{row:1,flight:'3L 504',departure:'09:20',arrival:'11:50'},back:null};
function bindSelected(f,legs=[['out',1]]){f.ui.flightInfo=legs.flatMap(([leg,index])=>{const r=(leg==='out'?f.sandbox.jsonOutFlts:f.sandbox.jsonRetFlts)[index-1];return r.flightRPHList.map((ref,i)=>({flightRefNumber:ref,orignNDest:r.segmentCodeList[i],flightNo:r.flightNoList[i],airLine:r.carrierList[i]}));});}

test('baseline reads only safe numeric supplier timestamps and never source/customer payloads',async()=>{
 const f=fixture();f.ui.unknownSecret='not returned';const baseline=await captureSearchBaseline(f.frame);assert.deepEqual(JSON.parse(JSON.stringify(baseline)),{startedAt:200,endedAt:210});assert.doesNotMatch(JSON.stringify(baseline),/secret|opaque|AUH|carrier/i);
 f.ui.searchStartTime=undefined;f.ui.searchEndTime='private';assert.deepEqual(JSON.parse(JSON.stringify(await captureSearchBaseline(f.frame))),{startedAt:null,endedAt:null});
 f.sandbox.location.origin='https://foreign.example';await assert.rejects(captureSearchBaseline(f.frame),/SEARCH_IDENTITY_UNVERIFIED/);
});
for(const mode of ['EXPLICIT','SEARCH_ALL'])test('a fresh successful response bound to its real arrays and AUH route is verified: '+mode,async()=>{
 const f=fixture({e:expected({carrier:{value:'observed-enum',carrier:'3L',mode}})}),before=JSON.stringify(f.sandbox);
 const result=await waitForSearchIdentity(f.frame,f.e,BASE,{report:f.report});assert.deepEqual(JSON.parse(JSON.stringify(result)),{status:'confirmed',outbound:1,inbound:0});assert.equal(JSON.stringify(f.sandbox),before);assert.ok(f.calls.includes('dispose'));assert.deepEqual(f.reports,['PORTAL_SEARCH_IDENTITY_CONFIRMED']);
});
test('reverse AUH journeys and return dates bind the correct airports and separate legs',async()=>{
 const e=expected({origin:'DAM',destination:'AUH',returnDate:'18/11/2026'}),out=[row({from:'DAM',to:'AUH'})],back=[row({day:'20261118',compact:'2611180920',number:'3L505',ref:'other$segment$id$202611180920$opaque'})],f=fixture({e,out,back});
 assert.equal((await waitForSearchIdentity(f.frame,e,BASE)).inbound,1);
 const chosen={out:{row:1,flight:'3L504'},back:{row:1,flight:'3L505'}};bindSelected(f,[['out',1],['back',1]]);assert.equal((await assertSearchIdentity(f.frame,e,BASE,{selected:chosen})).status,'confirmed');
});
test('G9 remains valid only for the matching non-AUH request and explicit observed selection',async()=>{
 const e=expected({origin:'SHJ',carrier:{value:'observed-g9',carrier:'G9',mode:'EXPLICIT'}}),f=fixture({e,out:[row({from:'SHJ',carrier:'G9',number:'G9433'})]});
 assert.equal((await waitForSearchIdentity(f.frame,e,BASE)).status,'confirmed');
 await assert.rejects(waitForSearchIdentity(f.frame,{...e,origin:'AUH'},BASE),/SEARCH_IDENTITY_UNVERIFIED/);
});
test('initial or unfinished empty arrays are never certified as absence',async()=>{
 for(const patch of [{startedAt:null,endedAt:null},{startedAt:100,endedAt:110},{startedAt:200,endedAt:110},{startedAt:200,endedAt:199},{active:1}]){
  const f=fixture({...patch,out:[]});await assert.rejects(waitForSearchIdentity(f.frame,f.e,BASE,{report:f.report}),error=>error.message==='SEARCH_IDENTITY_UNVERIFIED');assert.doesNotMatch(f.reports.join(','),/NO_FLIGHTS/);
 }
});
test('only a completed matched successful empty response produces confirmed zero counts',async()=>{
 const f=fixture({out:[]});assert.deepEqual(JSON.parse(JSON.stringify(await waitForSearchIdentity(f.frame,f.e,BASE))),{status:'confirmed',outbound:0,inbound:0});
});
for(const [name,change,reason]of [
 ['a wrong origin',f=>{f.params.fromAirport='SHJ';},'ROUTE'],
 ['a wrong destination',f=>{f.params.toAirport='ALP';},'ROUTE'],
 ['a different searched date',f=>{f.params.departureDate='12/11/2026';},'DATE'],
 ['a different return date',f=>{f.params.returnDate='18/11/2026';},'DATE'],
 ['a stale UI date',f=>{f.ui.strOutDate='12/11/2026';},'DATE'],
 ['a different adult count',f=>{f.params.adultCount=2;},'PARTY'],
 ['a child',f=>{f.params.childCount=1;},'PARTY'],
 ['a non-numeric count',f=>{f.params.infantCount='unknown';},'PARTY'],
 ['a different currency',f=>{f.params.selectedCurrency='USD';},'CURRENCY'],
 ['a reset search option',f=>{f.params.searchSystem='G9';},'SEARCH_SYSTEM'],
 ['a failed supplier response with old data',f=>{f.response.success=false;},'RESPONSE'],
 ['a detached parameter clone',f=>{f.ui.objResSrchParams={...f.params};},'PARAMETERS'],
 ['unbound outbound arrays',f=>{f.sandbox.jsonOutFlts=[...f.response.outboundFlights];},'ARRAY_BINDING'],
 ['unbound return arrays',f=>{f.sandbox.jsonRetFlts=[];},'ARRAY_BINDING'],
 ['a foreign origin',f=>{f.sandbox.location.origin='https://foreign.example';},'UNTRUSTED'],
 ])test('a completed mismatched search is unverified, never no flights: '+name,async()=>{
 const f=fixture();change(f);await assert.rejects(waitForSearchIdentity(f.frame,f.e,BASE,{report:f.report}),/^Error: SEARCH_IDENTITY_UNVERIFIED$/);assert.ok(f.reports.includes('PORTAL_SEARCH_IDENTITY_'+reason));assert.ok(f.reports.every(r=>/^[A-Z_]+$/.test(r)));assert.doesNotMatch(f.reports.join(','),/private|opaque|AUH|SHJ/);
});
test('numeric string counts and null one-way return are grounded supported response forms',async()=>{
 const f=fixture();Object.assign(f.params,{adultCount:'1',childCount:'0',infantCount:'0',returnDate:null});assert.equal((await waitForSearchIdentity(f.frame,f.e,BASE)).status,'confirmed');
});
for(const [name,change]of [
 ['another route',r=>{r.segmentCodeList=['SHJ/DAM'];}],
 ['another carrier',r=>{r.carrierList=['G9'];r.flightNoList=['G9433'];}],
 ['contradictory flight designator',r=>{r.flightNoList=['G9433'];}],
 ['an unverified codeshare',r=>{r.csOcCarrierList=['G9'];}],
 ['another date',r=>{r.flightRPHList=['a$b$c$202611120920$z'];r.depatureTimeList=['2611120920'];}],
 ['the same month/day in another year',r=>{r.flightRPHList=['a$b$c$202711110920$z'];r.depatureTimeList=['2711110920'];}],
 ['contradictory compact date',r=>{r.depatureTimeList=['2711110920'];}],
 ['an invalid compact time',r=>{r.depatureTimeList=['2611112461'];}],
 ['an invalid calendar date',r=>{r.flightRPHList=['a$b$c$202602300920$z'];r.depatureTimeList=['2602300920'];}],
 ['a guessed non-RPH date',r=>{r.flightRPHList=['not-a-grounded-reference'];}],
 ['unequal parallel segment arrays',r=>{r.carrierList=[];}],
 ])test('Search All cannot certify unproven row identity: '+name,async()=>{
 const f=fixture();change(f.sandbox.jsonOutFlts[0]);await assert.rejects(waitForSearchIdentity(f.frame,f.e,BASE),/SEARCH_IDENTITY_UNVERIFIED/);
});
test('shared identical flight references across alternative rows do not invalidate all choices',async()=>{
 const first=row(),f=fixture({out:[first,structuredClone(first)]});assert.equal((await waitForSearchIdentity(f.frame,f.e,BASE)).outbound,2);bindSelected(f,[['out',2]]);assert.equal((await assertSearchIdentity(f.frame,f.e,BASE,{selected:{out:{row:2,flight:'3L504'},back:null}})).status,'confirmed');
});
test('selected raw segment references, route, carrier and flight must still bind before pricing',async()=>{
 const f=fixture();bindSelected(f);assert.equal((await assertSearchIdentity(f.frame,f.e,BASE,{selected})).status,'confirmed');
 for(const [key,value]of [['flightRefNumber','stale-ref'],['orignNDest','SHJ/DAM'],['airLine','G9'],['flightNo','G9433']]){
  const bad=fixture();bindSelected(bad);bad.ui.flightInfo[0][key]=value;await assert.rejects(assertSearchIdentity(bad.frame,bad.e,BASE,{selected}),/SEARCH_IDENTITY_UNVERIFIED/);
 }
});
test('a selected row or displayed flight that changed is never priced as the original choice',async()=>{
 const f=fixture();bindSelected(f);await assert.rejects(assertSearchIdentity(f.frame,f.e,BASE,{selected:{out:{row:2,flight:'3L504'},back:null}}),/SEARCH_IDENTITY_UNVERIFIED/);
 await assert.rejects(assertSearchIdentity(f.frame,f.e,BASE,{selected:{out:{row:1,flight:'G9433'},back:null}}),/SEARCH_IDENTITY_UNVERIFIED/);
});
test('unknown identity configuration fails before reading or waiting on a supplier frame',async()=>{
 const f=fixture();for(const change of [{carrier:null},{currency:'USD'},{departureDate:'2026-11-11'},{carrier:{value:'x',carrier:'XH',mode:'EXPLICIT'}},{carrier:{value:'x',carrier:'G9',mode:'SEARCH_ALL'}}])await assert.rejects(waitForSearchIdentity(f.frame,{...f.e,...change},BASE),/SEARCH_IDENTITY_UNVERIFIED/);
 assert.deepEqual(f.calls,[]);
});
