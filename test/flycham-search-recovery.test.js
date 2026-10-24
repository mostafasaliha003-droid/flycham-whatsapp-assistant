'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FlyChamPortalAdapter}=require('../src/flycham-worker');

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
 const fresh={setDefaultTimeout:n=>assert.equal(n,15000)};
 const old={isClosed:()=>false,close:async()=>events.push('close')};
 const context={pages:()=>[old],newPage:async()=>{events.push('new');return fresh;}};
 const a=new FlyChamPortalAdapter({context:()=>context},{report:e=>events.push(e)});
 a.openSearchForm=async()=>{attempts++;if(attempts===1||secondFailure)throw Error(error);return 'new-form';};
 a.hasVerificationChallenge=async()=>challenge;
 a.signIn=async()=>{assert.equal(a.page,fresh);assert.ok(events.includes('close'));events.push('signIn');};
 return{a,events,attempts:()=>attempts};
}

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
