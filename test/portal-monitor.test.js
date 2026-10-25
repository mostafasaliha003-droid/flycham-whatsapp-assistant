'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {PortalMonitor,stageFromCode,safeJob}=require('../src/portal-monitor');
let jpeg;
test.before(async()=>{jpeg=await sharp({create:{width:2,height:2,channels:3,background:{r:20,g:40,b:60}}}).jpeg().toBuffer();});
const job=(extra={})=>({request:{origin:'دبي',destination:'دمشق',departureDate:'2026-11-11',returnDate:null,tripType:'one_way',...extra}});
const update=(extra={})=>({provider:'flycham',stage:'flights',state:'ready',ready:true,activeJob:job(),...extra});
const preview=bytes=>({redacted:true,jpeg:(bytes||jpeg).toString('base64')});
const row=(monitor,readiness={})=>monitor.list(readiness).providers.find(p=>p.provider==='flycham');

test('an untouched monitor reports no ready provider, job, screenshot or invented progress',()=>{
 const m=new PortalMonitor({now:()=>1000});const list=m.list();assert.equal(list.providers.length,2);
 for(const p of list.providers){assert.equal(p.ready,false);assert.equal(p.state,'stale');assert.equal(p.stage,'unavailable');assert.equal(p.activeJob,null);assert.equal(p.previewAvailable,false);assert.equal(p.screenshot,null);assert.ok(!Object.hasOwn(p,'progressPercent'));}
 assert.equal(m.preview('flycham'),null);
});
test('stages accept only fixed codes and classify authentication failures before success substrings',()=>{
 assert.equal(stageFromCode('PORTAL_AUTHENTICATED'),'idle');assert.equal(stageFromCode('PORTAL_PROTECTED_REFRESH_AUTHENTICATION_BLOCKED'),'unavailable');assert.equal(stageFromCode('FLYCHAM_SESSION_UNAVAILABLE'),'unavailable');assert.equal(stageFromCode('PORTAL_VERIFICATION_SUBMITTED'),'authentication');assert.equal(stageFromCode('PORTAL_TEST_PASSENGER_FIELDS_PREPARED'),'passengers');assert.equal(stageFromCode('PORTAL_SEAT_SCAN_STARTED'),'seats');assert.equal(stageFromCode('PORTAL_MEAL_SCAN_STARTED'),'meals');assert.equal(stageFromCode('PORTAL_BAGGAGE_SCAN_STARTED'),'baggage');assert.equal(stageFromCode('FLYCHAM_FLIGHT_RESULTS_READY'),'flights');assert.equal(stageFromCode('PORTAL_CUSTOMER_QUOTE_PRICED'),'completed');
 for(const invalid of ['secret=PRIVATE_VALUE','PORTAL_LOGIN\nCOOKIE',{},'a'.repeat(500)])assert.equal(stageFromCode(invalid),null);
});
test('job projection keeps only route, dates and trip type, dropping identity, credentials and customer context',()=>{
 const source=job({password:'PRIVATE_PASSWORD',cookie:'PRIVATE_COOKIE',customer:'PRIVATE_PHONE',passengers:{name:'PRIVATE_NAME'},pnr:'PRIVATE_PNR',apiKey:'PRIVATE_API_KEY'});source.id='PRIVATE_JOB';
 assert.deepEqual(safeJob(source),{origin:'دبي',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way'});
 const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(update({activeJob:source})),true);assert.doesNotMatch(JSON.stringify(m.list()),/PRIVATE_/);assert.equal(row(m).stageLabel,'فحص الرحلات والتواقيت');
 assert.equal(safeJob({origin:'<script>alert(1)</script>',destination:'user@example.com',departureDate:'PRIVATE_DATE'}),null);
});
test('a real redacted JPEG is available only for a ready supported stage with a sanitized active job',()=>{
 const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(update({preview:preview()})),true);const p=row(m);assert.equal(p.ready,true);assert.equal(p.previewAvailable,true);assert.equal(p.screenshot.redacted,true);assert.equal(p.screenshot.url,'/internal/assistant/portal-monitor/flycham/preview');assert.deepEqual(m.preview('flycham'),jpeg);
 const projection=m.list({flycham:false});assert.equal(row(m,{flycham:false}).previewAvailable,false);assert.equal(projection.providers.find(p=>p.provider==='flycham').ready,false);assert.doesNotMatch(JSON.stringify(projection),/base64|jpeg|\/9j\//);
});
test('invalid JPEG structures, malformed base64 and unsafe preview metadata are rejected',()=>{
 const invalid=[
  update({preview:{redacted:false,jpeg:jpeg.toString('base64')}}),
  update({preview:{redacted:true,jpeg:jpeg.toString('base64')+'$'}}),
  update({preview:{redacted:true,jpeg:' '+jpeg.toString('base64')}}),
  update({preview:{redacted:true,jpeg:jpeg.toString('base64').slice(1)}}),
  update({preview:preview(Buffer.from([255,216,255,217]))}),
  update({preview:preview(Buffer.from('not a JPEG'))}),
  update({preview:preview(Buffer.concat([Buffer.from([255,216]),Buffer.alloc(30),Buffer.from([255,217])]))}),
  update({stage:'authentication',preview:preview()}),
  update({stage:'passengers',preview:preview()}),
  update({ready:false,preview:preview()}),
  update({activeJob:null,preview:preview()}),
 ];
 for(const data of invalid){const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(data),false);assert.equal(m.preview('flycham'),null);}
});
test('oversized encoded and decoded previews are rejected without storing a screenshot',()=>{
 const encoded=update({preview:{redacted:true,jpeg:'A'.repeat(700001)}}),large=Buffer.alloc(500001);large[0]=255;large[1]=216;large[large.length-2]=255;large[large.length-1]=217;
 for(const data of [encoded,update({preview:preview(large)})]){const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(data),false);assert.equal(row(m).previewAvailable,false);}
});
test('metadata freshness and preview lifetime expire independently without fake live status',()=>{
 let now=1000;const m=new PortalMonitor({now:()=>now,ttl:30000});assert.equal(m.accept(update({preview:preview()})),true);now+=20000;assert.equal(m.accept(update()),true);assert.equal(row(m).previewAvailable,true);now+=10001;assert.equal(row(m).ready,true);assert.equal(row(m).previewAvailable,false);assert.equal(m.preview('flycham'),null);now+=20000;assert.equal(row(m).ready,false);assert.equal(row(m).state,'stale');assert.equal(row(m).activeJob,null);
});
test('an authentication or failure update clears old preview immediately even if readiness is inconsistent',()=>{
 for(const data of [update({stage:'authentication',state:'verification',ready:false}),update({stage:'unavailable',state:'blocked',ready:false}),update({stage:'authentication',state:'verification',ready:true}),update({stage:'flights',state:'blocked',ready:true})]){
  const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(update({preview:preview()})),true);assert.equal(m.accept(data),true);assert.equal(row(m).ready,false);assert.equal(row(m).previewAvailable,false);assert.equal(m.preview('flycham'),null);
 }
});
test('a new job cannot inherit another job screenshot and explicit withholding always clears it',()=>{
 const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(update({preview:preview()})),true);assert.equal(m.accept(update({activeJob:job({departureDate:'2026-11-12'})})),true);assert.equal(row(m).previewAvailable,false);assert.equal(m.preview('flycham'),null);
 assert.equal(m.accept(update({preview:preview()})),true);assert.equal(m.accept(update({previewWithheld:true})),true);assert.equal(row(m).previewAvailable,false);assert.equal(m.preview('flycham'),null);
});
test('changing to a different allowed search stage also withholds the old image until a fresh screenshot arrives',()=>{
 const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(update({preview:preview()})),true);assert.equal(m.accept(update({stage:'pricing'})),true);assert.equal(row(m).ready,true);assert.equal(row(m).stage,'pricing');assert.equal(row(m).previewAvailable,false);assert.equal(m.preview('flycham'),null);
});
test('provider and stage allowlists prevent arbitrary monitor entries',()=>{
 const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(update({provider:'evil-provider'})),false);assert.equal(m.accept(update({stage:'send_password'})),false);assert.equal(m.accept(null),false);assert.equal(m.list().providers.length,2);assert.equal(m.preview('evil-provider'),null);
});
test('intentional dormancy is labelled truthfully and clears a previous authenticated image',()=>{
 const m=new PortalMonitor({now:()=>1000});assert.equal(m.accept(update({preview:preview()})),true);
 assert.equal(m.accept(update({state:'dormant',stage:'idle',ready:false,activeJob:null,preview:null,previewWithheld:true})),true);
 const current=row(m);assert.equal(current.state,'dormant');assert.equal(current.ready,false);assert.equal(current.previewAvailable,false);assert.equal(current.activeJob,null);assert.match(current.stageLabel,/توفير الذاكرة/);assert.equal(m.preview('flycham'),null);
});
