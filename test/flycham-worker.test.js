'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QuoteJobs}=require('../src/quote-jobs');
const {readFlyChamConfig,formatFlyChamOffers,runFlyCham}=require('../src/flycham-worker');
const {priceFlyChamQuote}=require('../src/flycham-pricing');
test('FlyCham jobs cannot be claimed by the Air Arabia consumer and readiness is supplier-specific',()=>{
 let now=100000;const q=new QuoteJobs({now:()=>now});q.claim();assert.equal(q.ready(),true);assert.equal(q.ready('flycham'),false);
 assert.throws(()=>q.enqueue('a',{provider:'flycham'}),/QUEUE_UNAVAILABLE/);q.claim('flycham');const id=q.enqueue('a',{provider:'flycham'});assert.equal(q.claim(),null);const j=q.claim('flycham');assert.equal(j.id,id);now+=21000;q.current(j.id,j.lease);assert.equal(q.ready('flycham'),true);assert.equal(q.ready(),false);
});
test('switching an existing request to an unavailable supplier cannot bypass readiness',()=>{
 const q=new QuoteJobs({now:()=>100000});q.claim();q.enqueue('a',{});assert.throws(()=>q.enqueue('a',{provider:'flycham'}),/QUEUE_UNAVAILABLE/);assert.throws(()=>q.claim('other'),/QUEUE_PROVIDER_INVALID/);
});
test('FlyCham runtime is inert before its explicit enable flag',async()=>{
 let launched=false;await runFlyCham({env:{},launch:async()=>{launched=true;}});assert.equal(launched,false);
});
test('worker reads credentials only from its own environment without any network distribution',async()=>{
 const config=await readFlyChamConfig({FLYCHAM_AGENT_USERNAME:'test-user',FLYCHAM_AGENT_PASSWORD:'test-password'});assert.equal(config.username,'test-user');
 await assert.rejects(readFlyChamConfig({}),/FLYCHAM_CONFIG_MISSING/);
 await assert.rejects(readFlyChamConfig({FLYCHAM_AGENT_USERNAME:'test-user'}),/FLYCHAM_CONFIG_MISSING/);
});
test('FlyCham customer card uses FlyCham margin and future gift without Air Arabia meal or seat fees',()=>{
 const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way'};
 const price=priceFlyChamQuote({currency:'AED',baseTotal:'643.00',tripType:'one_way',verifiedFirstPage:true});
 const text=formatFlyChamOffers(request,[{request,price,timing:{out:{origin:'SHJ',destination:'DAM',flight:'XH744',departure:'05:30',arrival:'08:00'}}}],{dates:['2026-11-11']});
 assert.match(text,/683.00/);assert.match(text,/10.00/);assert.match(text,/XH744/);assert.match(text,/لم يكتمل/);assert.match(text,/بعد تأكيد التذكرة/);assert.doesNotMatch(text,/العربية للطيران/);
});
test('explicit FlyCham preference is retained through a short amendment',()=>{
 const c=require('../src/conversation');const now=Date.parse('2026-10-23T08:00:00Z');
 const a=c.handleMessage('fly-preference','من الشارقة على الشام، 11-11-2026، ذهاب فقط، 1 بالغ، فلاي شام',{now});assert.equal(a.request.provider,'flycham');
 const b=c.handleMessage('fly-preference','12-11-2026',{now});assert.equal(b.request.provider,'flycham');assert.equal(b.request.departureDate,'2026-11-12');
});

test('login follows an automatically opened blank popup and fills only its trusted supplier frame',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');let authenticated=false;const filled=[],events=[];
 const frame={url:()=>authenticated?'https://reservations.flycham.com/xbe/private/home':'https://reservations.flycham.com/xbe/public/login',locator:selector=>({count:async()=>selector.includes('autocomplete')?0:1,fill:async value=>filled.push(value)}),getByRole:()=>({count:async()=>1,click:async()=>{authenticated=true;}})};
 const popup={isClosed:()=>false,frames:()=>[frame],url:()=> 'about:blank',waitForLoadState:async()=>{},waitForTimeout:async()=>{}};
 const root={goto:async()=>{},context:()=>({pages:()=>[root,popup]}),frames:()=>[],getByRole:()=>({count:async()=>1}),waitForTimeout:async()=>{}};
 const adapter=new FlyChamPortalAdapter(root,{username:'fake-user',password:'fake-password',report:e=>events.push(e)});adapter.authenticatedFrame=async()=>authenticated?frame:null;
 await adapter.signIn();assert.equal(adapter.page,popup);assert.deepEqual(filled,['fake-user','fake-password']);assert.match(adapter.protectedURL,/\/private\/home$/);assert.ok(events.includes('FLYCHAM_PORTAL_AUTHENTICATED'));
});

test('authentication requires sign-out and reservation markers across trusted frames in the same window',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');let password=false;
 const locator=visible=>({count:async()=>visible?1:0,nth(){return this;},isVisible:async()=>visible});
 const frame=kind=>({url:()=> 'https://reservations.flycham.com/xbe/private/'+kind,locator:()=>({count:async()=>password?1:0}),getByRole:(role,{name})=>locator(kind==='header'&&role==='img'&&name.test('Sign Out')||kind==='menu'&&role==='img'&&name.test('Make Reservation'))});
 const header=frame('header'),menu=frame('menu');const page={isClosed:()=>false,frames:()=>[header,menu],context:()=>({pages:()=>[page]})};const adapter=new FlyChamPortalAdapter(page,{});
 assert.equal(await adapter.authenticatedFrame(),menu);password=true;assert.equal(await adapter.authenticatedFrame(),null);
});

test('legacy plain-text navigation controls can confirm authentication without ARIA roles',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');const empty={count:async()=>0};const visible={count:async()=>1,nth(){return this;},isVisible:async()=>true};
 const frame={url:()=> 'https://reservations.flycham.com/xbe/private/nav',locator:()=>empty,getByRole:()=>empty,getByText:pattern=>pattern.test('Sign Out')||pattern.test('Make Reservation')?visible:empty};
 const page={isClosed:()=>false,frames:()=>[frame],context:()=>({pages:()=>[page]})};const adapter=new FlyChamPortalAdapter(page,{});assert.equal(await adapter.authenticatedFrame(),frame);
});

test('FlyCham keepalive uses the authenticated reservation menu without reloading a popup child URL',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');
 const events=[],form={locator:()=>({count:async()=>1})};let clicked=0;const page={goto:()=>{throw Error('must not reload popup shell');},waitForTimeout:async()=>{}};
 const a=new FlyChamPortalAdapter(page,{username:'test',password:'test',report:x=>events.push(x)});a.authenticatedFrame=async()=>({});a.reservationControl={click:async()=>clicked++};a.frames=()=>[form];a.isAuthenticated=async()=>true;
 await a.searchFlightsForHeartbeat();assert.equal(clicked,1);assert.ok(events.includes('FLYCHAM_HEARTBEAT_NAVIGATION_COMPLETED'));
});

test('a new trusted search popup can hold the form while navigation stays in the original window',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');const frame={url:()=> 'https://reservations.flycham.com/xbe/private/makeReservation.action',locator:()=>({count:async()=>1})};
 const child={isClosed:()=>false,frames:()=>[frame]},page={context:()=>({pages:()=>[child]}),waitForTimeout:async()=>{}};
 const a=new FlyChamPortalAdapter(page,{username:'test',password:'test'});a.frames=()=>[];a.authenticatedFrame=async()=>({});a.reservationControl={click:async()=>{}};
 assert.equal(await a.openSearchForm(),frame);assert.equal(a.page,page);
});
test('a search form taking more than the old7.5s window is awaited within the bounded30s window',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');let ticks=0;const frame={locator:()=>({count:async()=>ticks>=20?1:0})};const page={waitForTimeout:async()=>ticks++};
 const a=new FlyChamPortalAdapter(page,{username:'test',password:'test'});a.frames=()=>[frame];a.authenticatedFrame=async()=>({});a.reservationControl={click:async()=>{}};a.findControl=async()=>null;
 assert.equal(await a.openSearchForm(),frame);assert.equal(ticks,20);
});

test('Make Reservation result button is never mistaken for an authenticated navigation control',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');
 const bad={isVisible:async()=>true,getAttribute:async()=> 'btnBook'},good={isVisible:async()=>true,getAttribute:async()=> 'reservationMenu'};
 const group=items=>({count:async()=>items.length,nth:i=>items[i]});
 const f={getByRole:role=>group(role==='button'?[bad,good]:[])};
 const a=new FlyChamPortalAdapter({}, {username:'test',password:'test'});assert.equal(await a.findControl(f,/^make reservation$/i),good);
});
test('an accidentally supplied booking control is refused before any click',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');let clicks=0;const a=new FlyChamPortalAdapter({}, {username:'test',password:'test'});a.authenticatedFrame=async()=>({});a.reservationControl={getAttribute:async()=> 'btnBook',click:async()=>clicks++};
 await assert.rejects(a.openSearchForm(),/FLYCHAM_BOOKING_CONTROL_REFUSED/);assert.equal(clicks,0);
});
test('Search Flights tab reveals the existing form without entering the result reservation flow',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');let visible=false,clicks=0;
 const frame={locator:selector=>({count:async()=>selector==='#fAirport'?1:visible?1:0}),getByRole:()=>({count:async()=>1,isVisible:async()=>true,click:async()=>{visible=true;clicks++;}})};
 const a=new FlyChamPortalAdapter({waitForTimeout:async()=>{}},{username:'test',password:'test'});a.frames=()=>[frame];a.authenticatedFrame=async()=>({});a.reservationControl={getAttribute:async()=> 'menu',click:async()=>{}};
 assert.equal(await a.openSearchForm(),frame);assert.equal(clicks,1);
});

test('an OTP route vetoes stale sign-out and reservation controls across the portal windows',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');
 const visible={count:async()=>1,nth(){return this;},isVisible:async()=>true};
 const nav={url:()=> 'https://reservations.flycham.com/xbe/private/nav',locator:()=>({count:async()=>0}),getByRole:()=>visible};
 const otp={url:()=> 'https://reservations.flycham.com/xbe/private/sendOTP.action',locator:()=>({count:async()=>0})};
 const page={isClosed:()=>false,frames:()=>[nav,otp],context:()=>({pages:()=>[page]})};
 const adapter=new FlyChamPortalAdapter(page,{});
 assert.equal(await adapter.authenticatedFrame(),null);
 assert.equal(await adapter.isAuthenticated(),false);
});

test('FlyCham consumes one operator code using its isolated handoff and ordinary form controls',async()=>{
 const {FlyChamPortalAdapter,FLYCHAM_VERIFICATION_FILE}=require('../src/flycham-worker');
 let pending=true,supplied=0,clicked=0;const events=[],filled=[];
 const frame={url:()=>pending?'https://reservations.flycham.com/xbe/private/sendOTP.action':'https://reservations.flycham.com/xbe/private/home',evaluate:async()=>true,locator:selector=>({count:async()=>selector.includes('captcha')?0:1,isVisible:async()=>pending,fill:async code=>filled.push(code),click:async()=>{clicked++;pending=false;}})};
 const page={isClosed:()=>false,frames:()=>[frame],context:()=>({pages:()=>[page]}),waitForTimeout:async()=>{}};
 const adapter=new FlyChamPortalAdapter(page,{report:event=>events.push(event),verificationProvider:async options=>{supplied++;assert.equal(options.path,FLYCHAM_VERIFICATION_FILE);assert.equal(typeof options.requestedAt,'number');return '123456';}});
 adapter.authenticatedFrame=async()=>pending?null:frame;
 await adapter.resumeVerification();
 assert.equal(supplied,1);assert.equal(clicked,1);assert.deepEqual(filled,['123456']);
 assert.ok(events.includes('FLYCHAM_VERIFICATION_WAITING_FOR_OPERATOR'));
 assert.ok(!events.join(' ').includes('123456'));
});

test('FlyCham verification timeout cannot reuse a code, refill credentials or retry the handoff',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');let supplied=0,submissions=0;
 const frame={url:()=> 'https://reservations.flycham.com/xbe/private/sendOTP.action',evaluate:async()=>true,locator:selector=>({count:async()=>selector.includes('captcha')?0:1,isVisible:async()=>true,fill:async()=>submissions++,click:async()=>submissions++})};
 const page={isClosed:()=>false,frames:()=>[frame],context:()=>({pages:()=>[page]}),waitForTimeout:async()=>{}};
 const adapter=new FlyChamPortalAdapter(page,{verificationProvider:async()=>{supplied++;throw Object.assign(Error('private value'),{code:'VERIFICATION_TIMEOUT'});}});
 await assert.rejects(adapter.resumeVerification(),/FLYCHAM_VERIFICATION_TIMEOUT/);
 await assert.rejects(adapter.resumeVerification(),/FLYCHAM_MANUAL_VERIFICATION/);
 assert.equal(supplied,1);assert.equal(submissions,0);
});

test('FlyCham OTP form validation rejects foreign actions, ambiguous controls, passwords and booking controls',()=>{
 const vm=require('node:vm'),{inspectVerificationForm}=require('../src/flycham-worker');
 const run=change=>{
  const form={action:'https://reservations.flycham.com/xbe/private/verifyOTP.action',querySelector:()=>null};
  const input={type:'text',form,getClientRects:()=>[1]};
  const button={type:'submit',form,id:'btnSubmit',textContent:'Verify',getClientRects:()=>[1],closest:()=>null,getAttribute:()=>null};
  const controls={input:[input],button:[button]};let origin='https://reservations.flycham.com';
  change?.({form,input,button,controls,setOrigin:value=>{origin=value;}});
  return vm.runInNewContext('('+inspectVerificationForm.toString()+')()',{location:{origin,href:origin+'/xbe/private/sendOTP.action'},URL,getComputedStyle:()=>({visibility:'visible'}),document:{querySelectorAll:selector=>selector.startsWith('input[autocomplete')?controls.input:controls.button}});
 };
 assert.equal(run(),true);
 assert.equal(run(({form})=>{form.action='https://foreign.example/verify';}),false);
 assert.equal(run(({button})=>{button.form={};}),false);
 assert.equal(run(({form})=>{form.querySelector=()=>({});}),false);
 assert.equal(run(({button})=>{button.id='btnBook';}),false);
 assert.equal(run(({controls,input})=>{controls.input=[input,input];}),false);
 assert.equal(run(({setOrigin})=>setOrigin('https://foreign.example')),false);
});

test('FlyCham quote authentication loss is distinct from evidence of no flights',async()=>{
 const {FlyChamPortalAdapter}=require('../src/flycham-worker');
 const adapter=new FlyChamPortalAdapter({},{});adapter.isAuthenticated=async()=>false;adapter.hasVerificationChallenge=async()=>true;
 await assert.rejects(adapter.assertQuoteSession([{date:'2026-11-11',status:'unverified',confirmed:0,failed:1}]),error=>error.code==='PORTAL_SESSION_EXPIRED'&&error.coverage[0].status==='authentication_required');
});
