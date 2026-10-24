'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FlyChamPortalAdapter,createFlyChamPage,runFlyCham}=require('../src/flycham-worker');

test('runtime creates an explicit context before any page so recovery does not hit Playwright owned-context restrictions',async()=>{
 let contexts=0,pages=0,closed=0;
 await runFlyCham({env:{FLYCHAM_PORTAL_ENABLED:'true',FLYCHAM_AGENT_USERNAME:'test',FLYCHAM_AGENT_PASSWORD:'test'},log:{log:()=>{}},launch:async()=>({
  newPage:async()=>{throw Error('browser.newPage must never own the session context');},
  newContext:async()=>{contexts++;return{newPage:async()=>{pages++;throw Error('TEST_STOP_BEFORE_LOGIN');}};},
  close:async()=>closed++
 })});
 assert.equal(contexts,1);assert.equal(pages,1);assert.equal(closed,1);
});

test('recovering from the runtime page preserves its explicit context after closing the old page',async()=>{
 let closed=false,pageCount=0,attempts=0;const pages=[],events=[];
 const context={pages:()=>pages.filter(p=>!p.isClosed()),newPage:async()=>{assert.equal(closed,false);pageCount++;let pageClosed=false;const p={context:()=>context,setDefaultTimeout:()=>{},isClosed:()=>pageClosed,close:async()=>{pageClosed=true;}};pages.push(p);return p;}};
 const page=await createFlyChamPage({newPage:async()=>{throw Error('Please use browser.newContext()');},newContext:async()=>context});
 const a=new FlyChamPortalAdapter(page,{report:e=>events.push(e)});a.hasVerificationChallenge=async()=>false;
 a.openSearchForm=async()=>{if(++attempts===1)throw Error('FLYCHAM_SEARCH_FORM_UNCONFIRMED');return 'restored';};
 a.signIn=async()=>{assert.equal(a.page.context(),context);assert.equal(page.isClosed(),true);assert.equal(closed,false);};
 assert.equal(await a.openSearchFormWithRecovery(),'restored');assert.equal(pageCount,2);assert.equal(a.page.isClosed(),false);assert.ok(events.includes('FLYCHAM_SEARCH_PAGE_RECOVERY_COMPLETED'));
});

test('search navigation waits for the old origin input to detach before accepting the new form',async()=>{
 let ticks=0,disposed=0,clicked=0;
 const old={evaluate:async()=>ticks<3,dispose:async()=>disposed++};
 const input={count:async()=>1,elementHandle:async()=>old};
 const frame={locator:()=>input};
 const a=new FlyChamPortalAdapter({waitForTimeout:async()=>ticks++},{});
 a.authenticatedFrame=async()=>({});a.isAuthenticated=async()=>true;a.searchFrames=()=>[frame];
 a.reservationControl={click:async()=>clicked++};a.findControl=async()=>null;
 assert.equal(await a.openSearchForm(),frame);assert.equal(ticks,3);assert.equal(clicked,1);assert.equal(disposed,1);
});

test('an unchanged old search form is never accepted as a completed navigation',async()=>{
 let disposed=0;
 const old={evaluate:async()=>true,dispose:async()=>disposed++};
 const frame={locator:()=>({count:async()=>1,elementHandle:async()=>old})};
 const a=new FlyChamPortalAdapter({waitForTimeout:async()=>{}},{});
 a.authenticatedFrame=async()=>({});a.isAuthenticated=async()=>true;a.searchFrames=()=>[frame];
 a.reservationControl={click:async()=>{}};a.findControl=async()=>null;a.inspectSearchState=async()=>{};
 await assert.rejects(a.openSearchForm(),/FLYCHAM_SEARCH_FORM_UNCONFIRMED/);assert.equal(disposed,1);
});

function recoveryFixture({challenge=false,secondFailure=false,error='FLYCHAM_SEARCH_FORM_UNCONFIRMED'}={}){
 const events=[];let attempts=0;
 const fresh={setDefaultTimeout:n=>assert.equal(n,15000),context:()=>context};
 const old={isClosed:()=>false,close:async()=>events.push('close')};
 const context={pages:()=>[old],newPage:async()=>{events.push('new');return fresh;}};
 const a=new FlyChamPortalAdapter({context:()=>context},{report:e=>events.push(e)});
 a.openSearchForm=async()=>{attempts++;if(attempts===1||secondFailure)throw Error(error);return 'new-form';};
 a.hasVerificationChallenge=async()=>challenge;
 a.signIn=async()=>{assert.equal(a.page,fresh);assert.ok(events.includes('close'));events.push('signIn');};
 return{a,events,attempts:()=>attempts};
}

const retryRequest={origin:'أبوظبي',destination:'دمشق',departureDate:'2099-11-18',tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0},baggageRequest:{checkedWeightKg:30,requestedByCustomer:true}};
const timeout=()=>Object.assign(Error('Synthetic timeout'),{name:'TimeoutError'});
for(const stage of ['NAVIGATION','SUBMISSION','RESULTS'])test('a '+stage+' timeout retries the exact requested flight once on the recovered page',async()=>{
 const f=recoveryFixture();let attempts=0;
 f.a.searchAttempt=async(r,config)=>{assert.deepEqual(r,retryRequest);assert.equal(config.origin,'AUH');assert.equal(config.destination,'DAM');f.a.searchStage=stage;if(++attempts===1)throw timeout();return 'verified-results';};
 assert.equal(await f.a.search(retryRequest),'verified-results');assert.equal(attempts,2);assert.equal(f.events.filter(e=>e==='signIn').length,1);assert.ok(f.events.includes('FLYCHAM_SEARCH_TIMEOUT_'+stage));
});
test('a navigation TimeoutError is recoverable for keepalive as well as customer searches',async()=>{
 const f=recoveryFixture();let attempts=0;f.a.openSearchForm=async()=>{if(++attempts===1)throw timeout();return 'restored';};
 assert.equal(await f.a.openSearchFormWithRecovery(),'restored');assert.equal(attempts,2);assert.equal(f.events.filter(e=>e==='signIn').length,1);
});
test('two timeouts fail without looping and the next job starts with page recovery',async()=>{
 const f=recoveryFixture();let attempts=0;f.a.searchAttempt=async()=>{attempts++;throw timeout();};
 await assert.rejects(f.a.search(retryRequest),e=>e.name==='TimeoutError');assert.equal(attempts,2);assert.equal(f.events.filter(e=>e==='signIn').length,1);assert.equal(f.a.searchRecoveryRequired,true);
 f.a.searchAttempt=async()=>{assert.equal(f.events.filter(e=>e==='signIn').length,2);return 'next-job-results';};
 assert.equal(await f.a.search(retryRequest),'next-job-results');assert.equal(f.a.searchRecoveryRequired,false);
});
test('a superseded background search yields before recovery and leaves the next customer job a fresh page',async()=>{
 const f=recoveryFixture();f.a.searchAttempt=async()=>{throw timeout();};
 await assert.rejects(f.a.search(retryRequest,async()=>{throw Error('QUOTE_SUPERSEDED');}),/QUOTE_SUPERSEDED/);
 assert.ok(!f.events.includes('signIn'));assert.equal(f.a.searchRecoveryRequired,true);
 f.a.searchAttempt=async()=>{assert.ok(f.events.includes('signIn'));return 'customer-results';};assert.equal(await f.a.search(retryRequest),'customer-results');
});
test('timeouts never bypass a verification challenge',async()=>{
 const f=recoveryFixture({challenge:true});f.a.searchAttempt=async()=>{throw timeout();};
 await assert.rejects(f.a.search(retryRequest),/FLYCHAM_MANUAL_VERIFICATION/);assert.ok(!f.events.includes('new'));assert.ok(!f.events.includes('signIn'));
});
test('confirmed empty inventory and mismatched itineraries never trigger a speculative retry',async()=>{
 for(const error of ['NO_FLIGHTS_CONFIRMED','FLYCHAM_REQUEST_NOT_MATCHED','FLYCHAM_SESSION_UNAVAILABLE','FLYCHAM_BOOKING_CONTROL_REFUSED']){
  const f=recoveryFixture();f.a.searchAttempt=async()=>{throw Error(error);};await assert.rejects(f.a.search(retryRequest),new RegExp(error));assert.ok(!f.events.includes('new'));
 }
});

test('missing search page recovers once using a fresh page in the existing browser context',async()=>{
 const f=recoveryFixture();assert.equal(await f.a.openSearchFormWithRecovery(),'new-form');
 assert.equal(f.attempts(),2);assert.equal(f.events.filter(e=>e==='new').length,1);
 assert.equal(f.events.filter(e=>e==='signIn').length,1);
 assert.ok(f.events.includes('FLYCHAM_SEARCH_PAGE_RECOVERY_COMPLETED'));
});

test('a repeated recovery failure is surfaced without looping sign-in or creating more pages',async()=>{
 const f=recoveryFixture({secondFailure:true});
 await assert.rejects(f.a.openSearchFormWithRecovery(),/FLYCHAM_SEARCH_FORM_UNCONFIRMED/);
 assert.equal(f.attempts(),2);assert.equal(f.events.filter(e=>e==='signIn').length,1);
 assert.equal(f.events.filter(e=>e==='new').length,1);
});

test('a verification challenge preserves the page for the operator without attempting fresh-page recovery',async()=>{
 const f=recoveryFixture({challenge:true});
 await assert.rejects(f.a.openSearchFormWithRecovery(),/FLYCHAM_MANUAL_VERIFICATION/);
 assert.equal(f.attempts(),1);assert.deepEqual(f.events,[]);
});

test('untrusted origins, refused booking controls and rejected credentials never trigger page recovery',async()=>{
 for(const error of ['FLYCHAM_UNTRUSTED_ORIGIN','FLYCHAM_BOOKING_CONTROL_REFUSED','FLYCHAM_BAD_CREDENTIALS']){
  const f=recoveryFixture({error});await assert.rejects(f.a.openSearchFormWithRecovery(),new RegExp(error));
  assert.equal(f.attempts(),1);assert.deepEqual(f.events,[]);
 }
});

test('explicit Search Flights tab activation can safely reuse the existing search document',async()=>{
 let tabClicks=0,disposed=0;
 const old={evaluate:async()=>true,dispose:async()=>disposed++};
 const frame={locator:()=>({count:async()=>1,elementHandle:async()=>old}),getByRole:()=>({count:async()=>1,isVisible:async()=>true,click:async()=>tabClicks++})};
 const a=new FlyChamPortalAdapter({waitForTimeout:async()=>{}},{});
 a.authenticatedFrame=async()=>({});a.isAuthenticated=async()=>true;a.searchFrames=()=>[frame];
 a.reservationControl={click:async()=>{}};a.findControl=async()=>null;
 assert.equal(await a.openSearchForm(),frame);assert.equal(tabClicks,1);assert.equal(disposed,1);
});
