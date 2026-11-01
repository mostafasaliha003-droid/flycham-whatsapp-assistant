'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {findAccountMenuToggle,openAccountMenu}=require('./account-menu');
function fixture({toggleCount=1,href='#',tag='A',type='button',expanded=false,disabled=false,onclick=null,logoutHref='/Account/LogOff',form=null,origin='https://visa.mofa.gov.sa',main=true}={}){
 const html={nodeType:1,tagName:'HTML',parentElement:null,previousElementSibling:null};
 const scope={nodeType:1,tagName:'DIV',parentElement:html,previousElementSibling:null,matches:s=>s==='.dropdown',querySelectorAll:()=>toggles};
 const make=(attrs={})=>({nodeType:1,tagName:tag,type,form,disabled,textContent:'private@example.test',parentElement:scope,previousElementSibling:null,getBoundingClientRect:()=>({width:20,height:20}),closest:()=>form,matches:()=>true,getAttribute:k=>Object.hasOwn(attrs,k)?attrs[k]:null});
 const toggles=Array.from({length:toggleCount},()=>make({href,onclick,'aria-expanded':expanded?'true':'false','data-toggle':'dropdown'}));
 const logout={...make({href:logoutHref}),tagName:'A',textContent:'Logout',getBoundingClientRect:()=>({width:0,height:0})};
 const location=new URL(origin+'/Home/Index'),window={};window.self=window;window.top=main?window:{};
 return {run(){return JSON.parse(JSON.stringify(vm.runInNewContext('('+findAccountMenuToggle.toString()+')()',{
  location,window,URL,getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{documentElement:html,querySelectorAll:()=>[logout]}
 })));}};
}
test('hidden same-origin logout finds one visible safe menu toggle, returning selector only',()=>{const out=fixture().run();assert.deepEqual(Object.keys(out),['selector','alreadyExpanded']);assert.equal(out.alreadyExpanded,false);assert.match(out.selector,/a:nth-of-type\(1\):visible$/);assert.equal(JSON.stringify(out).includes('private@example.test'),false);});
test('ambiguous/missing toggle fails closed',()=>{assert.equal(fixture({toggleCount:2}).run(),null);assert.equal(fixture({toggleCount:0}).run(),null);});
test('navigation, external, form and inline-action toggles rejected',()=>{for(const href of ['/SmartForm/Agreement','https://external.test/','javascript:Logout()'])assert.equal(fixture({href}).run(),null);assert.equal(fixture({onclick:'submitForm()'}).run(),null);assert.equal(fixture({form:{}}).run(),null);});
test('only safe native buttons or anchors can be selected',()=>{assert.ok(fixture({tag:'BUTTON',type:'button'}).run());assert.equal(fixture({tag:'BUTTON',type:'submit'}).run(),null);assert.equal(fixture({tag:'SPAN'}).run(),null);assert.ok(fixture({href:'javascript:;'}).run());});
test('untrusted logout, disabled toggle or frame rejected',()=>{assert.equal(fixture({logoutHref:'https://external.test/logout'}).run(),null);assert.equal(fixture({disabled:true}).run(),null);assert.equal(fixture({origin:'https://external.test'}).run(),null);assert.equal(fixture({main:false}).run(),null);});
test('already expanded menu is reported without another activation',()=>{assert.equal(fixture({expanded:true}).run().alreadyExpanded,true);});
function fakePage({expanded=false}={}){
 let presses=0,focused=0,disposed=0;
 const signals={officialHost:true,mainDocument:true,loginRoute:false,logoutPresent:true,myApplicationsPresent:true,logoutVisible:true,applicationsVisible:true,loginControlsVisible:false,otpPresent:false,accountUiVerified:true};
 const handle={focus:async()=>{focused++;},evaluate:async()=>true,press:async(key,opts)=>{assert.equal(key,'Enter');assert.equal(opts.noWaitAfter,true);presses++;},dispose:async()=>{disposed++;}};
 const locator={count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,elementHandle:async()=>handle};
 const page={url:()=> 'https://visa.mofa.gov.sa/Home/Index',evaluate:async fn=>fn.name==='findAccountMenuToggle'?{selector:'a:visible',alreadyExpanded:expanded}:signals,locator:()=>locator};
 return {page,presses:()=>presses,focused:()=>focused,disposed:()=>disposed};
}
test('original handle activation occurs at most once per page, no pointer/nav call',async()=>{const f=fakePage();const out=await openAccountMenu(f.page);assert.equal(out.attempted,true);assert.equal(out.opened,true);assert.equal(out.reason,'EXPANDED');assert.equal(out.signals.accountUiVerified,true);assert.equal(f.presses(),1);assert.equal(f.focused(),1);assert.equal(f.disposed(),1);assert.equal((await openAccountMenu(f.page)).reason,'ALREADY_ATTEMPTED');assert.equal(f.presses(),1);});
test('already expanded menu does not focus or activate',async()=>{const f=fakePage({expanded:true});const out=await openAccountMenu(f.page);assert.equal(out.reason,'ALREADY_EXPANDED');assert.equal(f.presses(),0);assert.equal(f.focused(),0);});
test('untrusted page refuses before any DOM evaluation',async()=>{let read=false;const out=await openAccountMenu({url:()=> 'https://external.test/',evaluate:async()=>{read=true;}});assert.equal(out.reason,'UNTRUSTED_PAGE');assert.equal(read,false);});
