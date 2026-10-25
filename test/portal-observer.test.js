'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const sharp=require('sharp');
const {captureRedactedPreview,installPortalObserver}=require('../src/portal-observer');
const {PortalMonitor}=require('../src/portal-monitor');
let jpeg;
test.before(async()=>{jpeg=await sharp({create:{width:2,height:2,channels:3,background:{r:20,g:40,b:60}}}).jpeg().toBuffer();});
const request={origin:'SHJ',destination:'DAM',departureDate:'2026-11-12',tripType:'one_way'};
const drain=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function fixture({origin='https://agents.airarabia.com',authenticated=true}={}){
 const captures=[],inspections=[];
 const page={url:()=>origin+'/xbe/private/main.action',isClosed:()=>false,frames:()=>frames,screenshot:()=>{throw Error('Full page capture forbidden');}};
 const frames=[];
 function add(options={}){
  const state={url:origin+'/xbe/private/search.action',sensitive:0,markers:1,visible:true,detached:false,...options};
  const frame={state,url:()=>state.url,isDetached:()=>state.detached,page:()=>state.owner||page};
  frame.locator=selector=>{
   inspections.push({frame,selector});
   if(selector==='body')return{isVisible:async()=>state.visible,screenshot:async settings=>{captures.push({frame,settings});if(state.afterCapture)await state.afterCapture();return state.bytes||jpeg;}};
   if(selector.startsWith('input[type="password"]'))return{count:async()=>state.sensitive};
   if(selector.startsWith('#fAirport:'))return{count:async()=>state.markers};
   return{selector,frame};
  };
  frame.getByText=pattern=>({pattern,frame});frames.push(frame);return frame;
 }
 const adapter={page,isAuthenticated:async()=>authenticated,report:()=>{}};
 return{adapter,page,frames,add,captures,inspections};
}
function sessionFor(adapter){return{adapter,isReady:()=>true,healthStatus:()=>({state:'ready'})};}
test('a preview crops the trusted active frame and masks all editable fields, PII and nested documents',async()=>{
 const f=fixture(),header=f.add({markers:0}),search=f.add();f.adapter.searchFrame=search;
 const preview=await captureRedactedPreview(f.adapter,'flights');
 assert.equal(preview.redacted,true);assert.deepEqual(Buffer.from(preview.jpeg,'base64'),jpeg);
 assert.equal(f.captures.length,1);assert.equal(f.captures[0].frame,search);
 const {settings}=f.captures[0];assert.equal(settings.type,'jpeg');assert.equal(settings.timeout,1800);assert.equal(settings.animations,'disabled');
 assert.equal(settings.mask[0].frame,search);
 for(const selector of ['input','textarea','select','[contenteditable]','iframe','frame','object','embed'])assert.ok(settings.mask[0].selector.split(',').includes(selector));
 for(const text of ['client@example.com','+971544123456','Passport number','PNR:ABC123','TEST PERSON','اسم المسافر'])assert.match(text,settings.mask[1].pattern);
 assert.ok(!f.captures.some(c=>c.frame===header));
 const monitor=new PortalMonitor();assert.equal(monitor.accept({provider:'airarabia',state:'ready',ready:true,stage:'flights',activeJob:request,preview}),true);
});
test('Fly Cham skips the header, ignores foreign sibling frames and selects its actual trusted results',async()=>{
 const f=fixture({origin:'https://reservations.flycham.com'}),header=f.add({markers:0}),foreign=f.add({url:'https://foreign.invalid/xbe/search'}),search=f.add();
 foreign.locator=()=>{throw Error('Foreign frames must never be inspected');};f.adapter.searchFrames=()=>[header,foreign,search];
 assert.ok(await captureRedactedPreview(f.adapter,'flights'));
 assert.equal(f.captures.length,1);assert.equal(f.captures[0].frame,search);
});
test('preview capture defaults to denied outside an authenticated known supplier search frame',async()=>{
 for(const stage of ['idle','passengers','authentication','completed','unavailable','arbitrary']){
  const f=fixture();f.adapter.searchFrame=f.add();assert.equal(await captureRedactedPreview(f.adapter,stage),null);assert.equal(f.inspections.length,0);
 }
 const unauthenticated=fixture({authenticated:false});unauthenticated.add();assert.equal(await captureRedactedPreview(unauthenticated.adapter,'flights'),null);
 for(const url of ['https://foreign.invalid/xbe/search','https://agents.airarabia.com.evil.invalid/xbe/search','http://agents.airarabia.com/xbe/search','https://agents.airarabia.com/outside/search','https://agents.airarabia.com/xbe/showLogin.action','https://agents.airarabia.com/xbe/sendOTP.action']){
  const f=fixture();f.adapter.searchFrame=f.add({url});assert.equal(await captureRedactedPreview(f.adapter,'flights'),null);assert.equal(f.captures.length,0);
 }
 for(const options of [{markers:0},{visible:false},{detached:true},{sensitive:1}]){
  const f=fixture();f.adapter.searchFrame=f.add(options);assert.equal(await captureRedactedPreview(f.adapter,'flights'),null);assert.equal(f.captures.length,0);
 }
});
test('foreign roots and retained results from another window never supply a preview',async()=>{
 const foreignRoot=fixture({origin:'https://foreign.invalid'});foreignRoot.add({url:'https://agents.airarabia.com/xbe/private/search.action'});assert.equal(await captureRedactedPreview(foreignRoot.adapter,'flights'),null);
 const f=fixture(),oldWindow={url:()=>f.page.url(),isClosed:()=>false};f.adapter.searchFrame=f.add({owner:oldWindow});assert.equal(await captureRedactedPreview(f.adapter,'flights'),null);
 const active=f.add({sensitive:1});f.adapter.searchFrame=active;f.add();assert.equal(await captureRedactedPreview(f.adapter,'flights'),null);assert.equal(f.captures.length,0);
});
test('navigation, a newly visible sensitive form and malformed or oversized bytes withhold captures',async()=>{
 for(const change of [s=>{s.url='https://foreign.invalid/xbe/search';},s=>{s.sensitive=1;}]){
  const f=fixture(),frame=f.add();f.adapter.searchFrame=frame;frame.state.afterCapture=()=>change(frame.state);assert.equal(await captureRedactedPreview(f.adapter,'flights'),null);
 }
 const f=fixture(),frame=f.add();f.adapter.searchFrame=frame;frame.state.afterCapture=()=>{f.adapter.page={...f.page};};assert.equal(await captureRedactedPreview(f.adapter,'flights'),null);
 for(const bytes of [Buffer.from('not an image'),Buffer.alloc(500001),Buffer.from([255,216,255,217])]){
  const f=fixture();f.adapter.searchFrame=f.add({bytes});assert.equal(await captureRedactedPreview(f.adapter,'flights'),null);
 }
});
test('observer publishes safe job and stage metadata and logs accepted metadata/image proof only once',async()=>{
 const records=[],reports=[],f=fixture();f.adapter.report=code=>reports.push(code);
 let preview=null,time=1000;
 const obs=installPortalObserver(sessionFor(f.adapter),{provider:'flycham',now:()=>time,capture:async()=>preview,publish:async data=>{records.push(data);return{accepted:true};}});
 try{
  await obs.job({id:'private-job',lease:'secret',phone:'+971500000000',request:{...request,passengers:{adults:1},customerName:'PRIVATE CUSTOMER'}});
  assert.deepEqual(records[0].activeJob,request);assert.doesNotMatch(JSON.stringify(records),/private-job|secret|PRIVATE|500000000/);
  assert.equal(records[0].stage,'search_form');assert.equal(records[0].previewWithheld,true);
  f.adapter.report('FLYCHAM_FLIGHT_RESULTS_READY');time+=3000;preview={jpeg:jpeg.toString('base64'),redacted:true};await obs.flush();
  assert.equal(records.at(-1).stage,'flights');assert.equal(records.at(-1).preview,preview);
  await obs.flush(true);assert.equal(reports.filter(c=>c==='FLYCHAM_PORTAL_MONITOR_PUBLISH_CONFIRMED').length,1);assert.equal(reports.filter(c=>c==='FLYCHAM_PORTAL_MONITOR_PREVIEW_PUBLISHED').length,1);
  assert.ok(reports.includes('FLYCHAM_FLIGHT_RESULTS_READY'));
  await obs.finish();assert.equal(records.at(-1).stage,'completed');assert.equal(records.at(-1).activeJob,null);assert.equal(records.at(-1).preview,null);
 }finally{await obs.stop();}
 assert.equal(records.at(-1).state,'closed');assert.equal(records.at(-1).ready,false);
});
test('unaccepted or failed monitor requests never produce a success proof or break original reports',async()=>{
 for(const publish of [async()=>({accepted:false}),async()=>{throw Error('private diagnostic');}]){
  const f=fixture(),reports=[];f.adapter.report=code=>reports.push(code);
  const obs=installPortalObserver(sessionFor(f.adapter),{provider:'airarabia',capture:async()=>null,publish});
  try{await obs.job(request);f.adapter.report('PORTAL_QUOTE_FLIGHT_RESULTS_READY');await obs.flush(true);assert.deepEqual(reports,['PORTAL_QUOTE_FLIGHT_RESULTS_READY']);}finally{await obs.stop();}
 }
});
test('a late screenshot is discarded after a sensitive stage or readiness change',async()=>{
 for(const change of ['passengers','readiness']){
  const f=fixture(),pending=deferred(),records=[],session=sessionFor(f.adapter);
  const obs=installPortalObserver(session,{provider:'airarabia',capture:()=>pending.promise,publish:async data=>{records.push(data);return{accepted:true};}});
  try{
   const first=obs.job(request);await drain();
   if(change==='passengers')f.adapter.report('PORTAL_TEST_PASSENGER_FIELDS_READY');else session.authBlocked=true;
   pending.resolve({redacted:true,jpeg:jpeg.toString('base64')});await first;await obs.flush(true);
   assert.ok(records.every(data=>data.preview===null));
   if(change==='passengers')assert.equal(records.at(-1).stage,'passengers');else assert.equal(records.at(-1).ready,false);
  }finally{pending.resolve(null);await obs.stop();}
 }
});
test('stop restores the original report, discards in-flight captures and prevents future observation',async()=>{
 const f=fixture(),pending=deferred(),records=[],original=()=>{};f.adapter.report=original;
 const obs=installPortalObserver(sessionFor(f.adapter),{provider:'airarabia',capture:()=>pending.promise,publish:async data=>{records.push(data);return{accepted:true};}});
 const job=obs.job(request);await drain();const stop=obs.stop();assert.equal(f.adapter.report,original);
 pending.resolve({redacted:true,jpeg:jpeg.toString('base64')});await job;await stop;
 assert.equal(records.length,1);assert.equal(records[0].state,'closed');assert.equal(records[0].preview,null);
 await obs.job(request);await obs.flush(true);await obs.stop();assert.equal(records.length,1);
});
test('observer throttles periodic captures and refreshes safe stage metadata without a new log event',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:1000});
 const f=fixture(),records=[];let captured=0;
 const obs=installPortalObserver(sessionFor(f.adapter),{provider:'airarabia',capture:async()=>{captured++;return null;},publish:async data=>{records.push(data);return{accepted:true};}});
 try{
  await obs.job(request);assert.equal(captured,1);
  f.adapter.report('PORTAL_QUOTE_FLIGHT_RESULTS_READY');await obs.flush();assert.equal(captured,1);
  t.mock.timers.tick(3000);await drain();assert.equal(captured,2);assert.equal(records.at(-1).stage,'flights');
  t.mock.timers.tick(3000);await drain();assert.equal(captured,3);
 }finally{await obs.stop();t.mock.timers.reset();}
});
