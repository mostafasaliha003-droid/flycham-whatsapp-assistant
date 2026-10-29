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

function structuralFixture({association='aria',toggleCount=1,logoutCount=1,logoutTag='A',logoutForm=null,logoutFormAction=null,unrelatedToggle=false,href='#',tag='BUTTON',type='button',onclick=null,formaction=null,form=null,formAncestor=form,formOwner=form,visible=true,disabled=false,ariaDisabled=false,ancestorClasses=[],ancestorReadThrows=false}={}){
 const html={nodeType:1,tagName:'HTML',parentElement:null,previousElementSibling:null};
 const toggles=[],logouts=[],scope={nodeType:1,tagName:'DIV',parentElement:html,previousElementSibling:null,matches:s=>{if(ancestorReadThrows&&s==='.header-login')throw Error('PRIVATE_DIAGNOSTIC_ERROR');return s==='.dropdown'&&association==='legacy'||ancestorClasses.includes(s);},querySelectorAll:()=>toggles};
 const target={contains:el=>logouts.includes(el)},otherTarget={contains:()=>false};
 const make=({tag='A',attrs={},text='',shown=true,parent=scope,nodeType=1}={})=>({nodeType,tagName:tag,textContent:text,type:attrs.type||'',disabled:false,form:null,parentElement:parent,previousElementSibling:null,getAttribute:k=>Object.hasOwn(attrs,k)?attrs[k]:null,closest:()=>null,matches:s=>s==='.dropdown-toggle'&&String(attrs.class||'').split(/\s+/).includes('dropdown-toggle'),getBoundingClientRect:()=>({width:shown?20:0,height:shown?20:0})});
 for(let i=0;i<logoutCount;i++){const item=make({tag:logoutTag,attrs:{href:'/Account/LogOff',formaction:logoutFormAction},text:'Logout',shown:false});item.closest=()=>logoutForm;logouts.push(item);}
 const base=association==='legacy'?{'data-toggle':'dropdown'}:association==='bs5'?{'data-bs-toggle':'dropdown','data-bs-target':'#account-menu'}:association==='target'?{'data-toggle':'dropdown','data-target':'#account-menu'}:association==='targetOnly'?{'data-target':'#account-menu'}:association==='bsTargetOnly'?{'data-bs-target':'#account-menu'}:{'aria-haspopup':'menu','aria-controls':'account-menu'};
 for(let i=0;i<toggleCount;i++){const item=make({tag,attrs:{...base,href,type,onclick,formaction,'aria-disabled':ariaDisabled?'true':null},text:'private@example.test',shown:visible});item.form=formOwner;item.closest=()=>formAncestor;item.disabled=disabled;toggles.push(item);}
 if(unrelatedToggle)toggles.push(make({tag:'BUTTON',attrs:{type:'button','aria-haspopup':'menu','aria-controls':'unrelated-menu'},text:'Unrelated menu'}));
 const location=new URL('https://visa.mofa.gov.sa/Home/Index'),window={};window.self=window;window.top=window;
 return {run(withCensus=false){return JSON.parse(JSON.stringify(vm.runInNewContext('('+findAccountMenuToggle.toString()+')('+JSON.stringify(withCensus)+')',{location,window,URL,getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{documentElement:html,querySelectorAll:()=>[...logouts,...toggles],getElementById:id=>id==='account-menu'?target:id==='unrelated-menu'?otherTarget:null}})));}};
}

test('observed ARIA and Bootstrap 5 target associations discover a unique safe native toggle',()=>{
 for(const association of ['aria','bs5','target','targetOnly','bsTargetOnly','legacy']){const out=structuralFixture({association}).run();assert.ok(out);assert.match(out.selector,/button:nth-of-type\(1\):visible$/);assert.equal(out.alreadyExpanded,false);}
});
test('duplicate hidden logout nodes do not block one associated toggle and unrelated toggles do not count',()=>{
 const out=structuralFixture({logoutCount:2,unrelatedToggle:true}).run(true);assert.ok(out.toggle);assert.equal(out.census.logoutControls,2);assert.equal(out.census.observedToggles,2);assert.equal(out.census.associatedVisibleSafeToggles,1);assert.equal(out.census.ambiguous,false);
});
test('ambiguous associated toggles, missing logout or hidden toggle fail closed',()=>{
 const ambiguous=structuralFixture({toggleCount:2}).run(true);assert.equal(ambiguous.toggle,null);assert.equal(ambiguous.census.ambiguous,true);assert.equal(ambiguous.census.associatedVisibleSafeToggles,2);
 assert.equal(structuralFixture({logoutCount:0}).run(),null);assert.equal(structuralFixture({visible:false}).run(),null);
});
test('associated form, submit and inline action toggles remain unavailable',()=>{
 assert.equal(structuralFixture({form:{}}).run(),null);assert.equal(structuralFixture({type:'submit'}).run(),null);assert.equal(structuralFixture({onclick:'submitForm()'}).run(),null);
});
test('fixed empty anchor actions are supported while navigation and executable code are rejected',()=>{
 for(const href of ['#','javascript:;','javascript:void(0)','javascript:void(0);'])assert.ok(structuralFixture({tag:'A',href}).run());
 for(const href of ['/SmartForm','https://external.test/','#account-menu','javascript:void(1)','javascript:void(0);submitForm()'])assert.equal(structuralFixture({tag:'A',href}).run(),null);
});
test('finite census excludes identity text, URLs and selector data',()=>{
 const out=structuralFixture({association:'bs5',logoutCount:20,toggleCount:40}).run(true);assert.equal(out.toggle,null);assert.equal(out.census.observed,true);assert.equal(out.census.logoutControls,16);assert.equal(out.census.observedToggles,32);assert.equal(out.census.associatedVisibleSafeToggles,32);assert.equal(out.census.bs5Associations,32);
 assert.deepEqual(Object.keys(out.census).sort(),['observed','logoutControls','observedToggles','associatedVisibleSafeToggles','ambiguous','legacyAssociations','bs5Associations','ariaAssociations','rejectionCensusObserved','associatedTogglesBeforeSafety','associatedVisibleToggles','visibleMarkedToggles','enabledMarkedToggles','rejectedInlineAction','rejectedFormAncestor','rejectedFormOwner','rejectedTagOrType','rejectedHref','rejectedLogout','visibleDropdownToggles','visibleHeaderLoginToggles','visibleDesktopHeaderToggles','visibleMobileHeaderToggles','logoutAnchors','logoutButtons','logoutInputs','logoutDirectTargets','logoutInheritedTargets'].sort());
 assert.equal(out.census.rejectionCensusObserved,true);assert.equal(out.census.associatedTogglesBeforeSafety,32);assert.equal(out.census.associatedVisibleToggles,32);assert.equal(out.census.visibleMarkedToggles,32);assert.equal(out.census.enabledMarkedToggles,32);
 for(const [key,value]of Object.entries(out.census))if(!['observed','ambiguous','rejectionCensusObserved'].includes(key))assert.ok(Number.isInteger(value)&&value>=0&&value<=32);
 for(const secret of ['private@example.test','account-menu','Home/Index','LogOff','selector','http'])assert.equal(JSON.stringify(out.census).includes(secret),false);
});
test('rejection census distinguishes association before safety from hidden and disabled toggles',()=>{
 for(const association of ['legacy','aria','bs5']){const out=structuralFixture({association,visible:false}).run(true);assert.equal(out.toggle,null);assert.equal(out.census.rejectionCensusObserved,true);assert.equal(out.census.associatedTogglesBeforeSafety,1);assert.equal(out.census.associatedVisibleToggles,0);assert.equal(out.census.associatedVisibleSafeToggles,0);assert.equal(out.census.visibleMarkedToggles,0);assert.equal(out.census.enabledMarkedToggles,1);}
 for(const options of [{disabled:true},{ariaDisabled:true}]){const out=structuralFixture(options).run(true);assert.equal(out.toggle,null);assert.equal(out.census.associatedTogglesBeforeSafety,1);assert.equal(out.census.associatedVisibleToggles,1);assert.equal(out.census.visibleMarkedToggles,1);assert.equal(out.census.enabledMarkedToggles,0);}
 const unrelated=structuralFixture({logoutCount:0}).run(true);assert.equal(unrelated.census.associatedTogglesBeforeSafety,0);assert.equal(unrelated.census.visibleMarkedToggles,1);assert.equal(unrelated.toggle,null);
});
test('bounded predicate counts distinguish form context, action attributes, type and href without returning values',()=>{
 for(const options of [{onclick:'PRIVATE_INLINE_ACTION'},{formaction:'/PRIVATE_FORM_ACTION'}]){const out=structuralFixture(options).run(true);assert.equal(out.toggle,null);assert.equal(out.census.associatedTogglesBeforeSafety,1);assert.equal(out.census.rejectedInlineAction,1);assert.equal(JSON.stringify(out.census).includes('PRIVATE'),false);}
 const ancestor=structuralFixture({formAncestor:{},formOwner:null}).run(true);assert.equal(ancestor.toggle,null);assert.equal(ancestor.census.rejectedFormAncestor,1);assert.equal(ancestor.census.rejectedFormOwner,0);
 const owner=structuralFixture({formAncestor:null,formOwner:{}}).run(true);assert.equal(owner.toggle,null);assert.equal(owner.census.rejectedFormOwner,1);assert.equal(owner.census.rejectedFormAncestor,0);
 const submit=structuralFixture({type:'submit'}).run(true);assert.equal(submit.toggle,null);assert.equal(submit.census.rejectedTagOrType,1);assert.equal(submit.census.rejectedHref,0);
 const navigation=structuralFixture({tag:'A',href:'https://external.test/PRIVATE_ACCOUNT?token=PRIVATE_TOKEN'}).run(true);assert.equal(navigation.toggle,null);assert.equal(navigation.census.rejectedHref,1);assert.equal(navigation.census.rejectedTagOrType,0);assert.equal(JSON.stringify(navigation.census).includes('PRIVATE'),false);
 const logout=structuralFixture({tag:'A',href:'/Account/LogOff'}).run(true);assert.equal(logout.toggle,null);assert.equal(logout.census.rejectedLogout,1);
 const bounded=structuralFixture({toggleCount:40,onclick:'PRIVATE_INLINE_ACTION',form:{},type:'submit'}).run(true);for(const key of ['rejectedInlineAction','rejectedFormAncestor','rejectedFormOwner','rejectedTagOrType'])assert.equal(bounded.census[key],32);
});
test('known ancestor census reports only finite visible desktop and mobile counts',()=>{
 for(const mode of ['Desktop','Mobile']){const f=structuralFixture({ancestorClasses:['.dropdown','.header-login',mode==='Desktop'?'.page-header-menu':'.page-header-menu-mobile']}),out=f.run(true);assert.deepEqual(out.toggle,f.run());assert.equal(out.census.visibleDropdownToggles,1);assert.equal(out.census.visibleHeaderLoginToggles,1);assert.equal(out.census['visible'+mode+'HeaderToggles'],1);assert.equal(out.census['visible'+(mode==='Desktop'?'Mobile':'Desktop')+'HeaderToggles'],0);}
 const hidden=structuralFixture({visible:false,ancestorClasses:['.dropdown','.header-login','.page-header-menu-mobile']}).run(true);for(const key of ['visibleDropdownToggles','visibleHeaderLoginToggles','visibleDesktopHeaderToggles','visibleMobileHeaderToggles'])assert.equal(hidden.census[key],0);
});
test('a failed diagnostic-only ancestor read cannot change a discovered toggle',()=>{
 const f=structuralFixture({ancestorReadThrows:true}),out=f.run(true);assert.deepEqual(out.toggle,f.run());assert.ok(out.toggle);assert.equal(out.census.observed,true);assert.equal(out.census.rejectionCensusObserved,false);assert.equal(out.census.associatedVisibleSafeToggles,1);assert.equal(out.census.associatedTogglesBeforeSafety,0);assert.equal(out.census.visibleMarkedToggles,0);assert.equal(JSON.stringify(out.census).includes('PRIVATE'),false);
});
test('logout subtype and direct versus inherited target counts expose no target values',()=>{
 const anchor=structuralFixture().run(true);assert.equal(anchor.census.logoutAnchors,1);assert.equal(anchor.census.logoutButtons,0);assert.equal(anchor.census.logoutInputs,0);assert.equal(anchor.census.logoutDirectTargets,1);assert.equal(anchor.census.logoutInheritedTargets,0);
 for(const [logoutTag,key]of [['BUTTON','logoutButtons'],['INPUT','logoutInputs']]){
  const direct=structuralFixture({logoutTag,logoutFormAction:'/Account/LogOff?token=PRIVATE_TARGET'}).run(true);assert.equal(direct.census[key],1);assert.equal(direct.census.logoutDirectTargets,1);assert.equal(direct.census.logoutInheritedTargets,0);
  const inherited=structuralFixture({logoutTag,logoutForm:{getAttribute:()=>'/Account/LogOff?token=PRIVATE_TARGET'}}).run(true);assert.equal(inherited.census[key],1);assert.equal(inherited.census.logoutDirectTargets,0);assert.equal(inherited.census.logoutInheritedTargets,1);
  for(const row of [direct,inherited]){assert.equal(row.census.rejectionCensusObserved,true);assert.ok(row.toggle);assert.equal(JSON.stringify(row.census).includes('PRIVATE'),false);assert.equal(JSON.stringify(row.census).includes('LogOff'),false);}
 }
 const bounded=structuralFixture({logoutCount:40}).run(true);assert.equal(bounded.census.logoutAnchors,32);assert.equal(bounded.census.logoutDirectTargets,32);assert.equal(bounded.census.logoutControls,16);
});
test('menu adapter exposes only bounded census and still activates once with enriched discovery',async()=>{
 const f=fakePage(),original=f.page.evaluate;f.page.evaluate=async(fn,arg)=>fn.name==='findAccountMenuToggle'?{toggle:{selector:'a:visible',alreadyExpanded:false},census:{observed:true,logoutControls:999,observedToggles:999,associatedVisibleSafeToggles:1,ambiguous:false,legacyAssociations:0,bs5Associations:1,ariaAssociations:0,private:'private@example.test'}}:original(fn,arg);
 const out=await openAccountMenu(f.page);assert.equal(out.census.logoutControls,16);assert.equal(out.census.observedToggles,32);assert.equal(out.census.bs5Associations,1);assert.equal(out.census.private,undefined);assert.equal(JSON.stringify(out).includes('a:visible'),false);assert.equal(JSON.stringify(out).includes('private@example.test'),false);assert.equal(f.presses(),1);await openAccountMenu(f.page);assert.equal(f.presses(),1);
});
test('adapter retains rejection diagnostics without returning private or malformed census data',async()=>{
 const f=fakePage(),original=f.page.evaluate;f.page.evaluate=async(fn,arg)=>fn.name==='findAccountMenuToggle'?{toggle:null,census:{observed:true,rejectionCensusObserved:true,associatedTogglesBeforeSafety:2,associatedVisibleToggles:1,rejectedInlineAction:1,rejectedHref:99,visibleMarkedToggles:-1,logoutAnchors:2,logoutButtons:0,logoutInputs:'PRIVATE_INPUT',logoutDirectTargets:2,private:'PRIVATE_ACCOUNT'}}:original(fn,arg);
 const out=await openAccountMenu(f.page);assert.equal(out.reason,'TOGGLE_UNAVAILABLE');assert.equal(out.census.rejectionCensusObserved,true);assert.equal(out.census.associatedTogglesBeforeSafety,2);assert.equal(out.census.associatedVisibleToggles,1);assert.equal(out.census.rejectedInlineAction,1);assert.equal(out.census.logoutAnchors,2);for(const key of ['rejectedHref','visibleMarkedToggles','logoutInputs','private'])assert.equal(out.census[key],undefined);assert(!JSON.stringify(out).includes('PRIVATE'));assert.equal(f.presses(),0);
});
