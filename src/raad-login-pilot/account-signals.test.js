'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {inspectAccountSignals,getAccountSignals}=require('./account-signals');
function el({tag='A',text='',href='/SmartForm/Index',visible=true,disabled=false,attrs={},form=null}={}){
 const item={tagName:tag,textContent:text,disabled,getAttribute(k){if(k==='href')return href;return Object.hasOwn(attrs,k)?attrs[k]:null;},closest(){return form;},getBoundingClientRect(){return {width:visible?10:0,height:visible?10:0};}};
 Object.defineProperty(item,'value',{get(){throw Error('editable value read');}});return item;
}
function inspect({controls=[el({text:'تسجيل الخروج',href:'/Account/LogOff'}),el({text:'طلباتي'})],login=[],tables=[],url='https://visa.mofa.gov.sa/SmartForm/Index',otp=false,main=true}={}){
 const location=new URL(url),window={};window.self=window;window.top=main?window:{};
 return JSON.parse(JSON.stringify(vm.runInNewContext('('+inspectAccountSignals.toString()+')('+JSON.stringify(otp)+')',{
  location,window,URL,getComputedStyle(){return {display:'block',visibility:'visible',opacity:'1'};},document:{querySelectorAll(selector){return selector.startsWith('#myform')?login:selector==='table'?tables:selector==='a[href]'?controls.filter(item=>item.tagName==='A'):controls;}}
 })));
}
test('both visible main official account controls establish boolean UI evidence',()=>{const r=inspect();assert.equal(r.accountUiVerified,true);assert.equal(r.logoutVisible,true);assert.equal(r.applicationsVisible,true);for(const value of Object.values(r))assert.equal(typeof value,'boolean');});
test('one control alone does not establish account UI',()=>{assert.equal(inspect({controls:[el({text:'طلباتي'})]}).accountUiVerified,false);assert.equal(inspect({controls:[el({text:'Logout'})]}).accountUiVerified,false);});
test('external logout and external applications links are not counted',()=>{assert.equal(inspect({controls:[el({text:'Logout',href:'https://external.test/logout'}),el({text:'طلباتي'})]}).logoutVisible,false);assert.equal(inspect({controls:[el({text:'Logout'}),el({text:'My Applications',href:'https://external.test/'})]}).applicationsVisible,false);});
test('visible login input blocks evidence; hidden login does not',()=>{assert.equal(inspect({login:[el({tag:'INPUT'})]}).accountUiVerified,false);assert.equal(inspect({login:[el({tag:'INPUT',visible:false})]}).accountUiVerified,true);});
test('OTP presence blocks account proof',()=>{assert.equal(inspect({otp:true}).accountUiVerified,false);});
test('known login routes never establish proof',()=>{for(const p of ['/Account/Loginindividuals','/Account/Login','/Account/Login/company'])assert.equal(inspect({url:'https://visa.mofa.gov.sa'+p}).accountUiVerified,false);});
test('untrusted origin and child frame never establish proof',()=>{assert.equal(inspect({url:'https://external.test/'}).accountUiVerified,false);assert.equal(inspect({main:false}).accountUiVerified,false);});
test('hidden or disabled account controls do not count',()=>{assert.equal(inspect({controls:[el({text:'Logout',visible:false}),el({text:'طلباتي'})]}).accountUiVerified,false);assert.equal(inspect({controls:[el({text:'Logout',disabled:true}),el({text:'طلباتي'})]}).accountUiVerified,false);});
test('same-origin logout route can supply logout evidence without private text output',()=>{const privateText='private@example.test 987654';const r=inspect({controls:[el({text:privateText,href:'/Account/SignOut?private=secret'}),el({text:'My Applications'})]});assert.equal(r.accountUiVerified,true);const s=JSON.stringify(r);for(const secret of [privateText,'private@example.test','987654','secret','SignOut','https:'])assert.equal(s.includes(secret),false);});
test('external form actions cannot supply account evidence',()=>{const form={getAttribute(){return 'https://external.test/logout';}};const r=inspect({controls:[el({tag:'BUTTON',text:'Logout',form}),el({text:'طلباتي'})]});assert.equal(r.logoutVisible,false);});
test('wrapper returns only booleans and recomputes proof rather than trusting flag',async()=>{const r=await getAccountSignals({evaluate:async()=>({...inspect({otp:true}),accountUiVerified:true,unexpected:'private@example.test'})},true);assert.equal(r.accountUiVerified,false);assert.equal(r.unexpected,undefined);for(const v of Object.values(r))assert.equal(typeof v,'boolean');});
test('wrapper failure is fail closed',async()=>{assert.equal((await getAccountSignals({evaluate:async()=>{throw Error('private');}})).accountUiVerified,false);});

test('hidden account menu presence is metadata only, never proof',()=>{const r=inspect({controls:[el({text:'Logout',visible:false}),el({text:'طلباتي',visible:false})]});assert.equal(r.logoutPresent,true);assert.equal(r.myApplicationsPresent,true);assert.equal(r.logoutVisible,false);assert.equal(r.applicationsVisible,false);assert.equal(r.accountUiVerified,false);});

test('an application image captcha alone is not a login control',()=>{const location=new URL('https://visa.mofa.gov.sa/SmartForm/TraditionalApp'),window={};window.top=window;window.self=window;const result=vm.runInNewContext('('+inspectAccountSignals.toString()+')(false)',{location,window,URL,getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{querySelectorAll:selector=>selector.includes('#Captcha')?[el({tag:'INPUT'})]:[]}});assert.equal(result.loginControlsVisible,false);assert.equal(result.accountUiVerified,false);});

test('observed exact official applications anchor route supplies applications evidence without inventing labels',()=>{
 for(const href of ['/SmartForm','/SmartForm/']){const r=inspect({controls:[el({text:'Logout',href:'/Account/LogOff'}),el({text:'Observed application navigation',href})]});assert.equal(r.applicationsVisible,true);assert.equal(r.accountUiVerified,true);}
});
test('route evidence rejects other paths, query, fragment, external target and non-anchor controls',()=>{
 for(const href of ['/SmartForm?view=all','/SmartForm#section','/SmartForm/Agreement','/SmartForm/Index','/smartform','https://external.test/SmartForm']){const r=inspect({controls:[el({text:'Logout',href:'/Account/LogOff'}),el({text:'Observed navigation',href})]});assert.equal(r.myApplicationsPresent,false);assert.equal(r.accountUiVerified,false);}
 const form={getAttribute:()=>'/SmartForm'};assert.equal(inspect({controls:[el({text:'Logout',href:'/Account/LogOff'}),el({tag:'BUTTON',text:'Observed navigation',form})]}).accountUiVerified,false);
});
test('applications route never substitutes for visible logout or overrides login and OTP blockers',()=>{
 const controls=[el({text:'Logout',href:'/Account/LogOff',visible:false}),el({text:'Observed application navigation',href:'/SmartForm'})];assert.equal(inspect({controls}).accountUiVerified,false);
 controls[0]=el({text:'Logout',href:'/Account/LogOff'});assert.equal(inspect({controls,otp:true}).accountUiVerified,false);assert.equal(inspect({controls,login:[el({tag:'INPUT'})]}).accountUiVerified,false);
 assert.equal(inspect({controls:[controls[0],el({text:'Observed navigation',href:'/SmartForm',visible:false})]}).accountUiVerified,false);
});

function caseTable({headers=['Applicant name','Passport No.','Application No.'],extraHeaders=[],hidden=false,headerHidden=false,spanned=false,foreignRow=false}={}){
 const table=el({tag:'TABLE',visible:!hidden});
 const headerRow=texts=>{const row=el({tag:'TR',visible:!headerHidden});row.parentElement={tagName:'THEAD'};row.closest=selector=>selector==='table'?(foreignRow?{}:table):null;row.cells=texts.map(text=>{const cell=el({tag:'TH',text,visible:!headerHidden});cell.colSpan=spanned?2:1;cell.rowSpan=1;return cell;});return row;};
 const body=el({tag:'TR'});body.parentElement={tagName:'TBODY'};body.closest=selector=>selector==='table'?table:null;body.cells=headers.map(()=>{const cell=el({tag:'TD'});Object.defineProperty(cell,'textContent',{get(){throw Error('private case row read');}});return cell;});
 table.rows=[headerRow(headers),...extraHeaders.map(headerRow),body];return table;
}
function protectedCase(overrides={}){
 return {url:'https://visa.mofa.gov.sa/SmartForm',controls:[el({text:'PRIVATE_ACCOUNT',href:'/Account/LogOff',visible:false}),el({text:'طلبات التأشيرات',href:'/SmartForm'}),el({text:'إضافة طلب جديد',href:'/SmartForm/Agreement'})],tables:[caseTable()],...overrides};
}
test('protected applications list can establish proof while responsive account menus are hidden',()=>{
 for(const headers of [['Applicant name','Passport No.','Application No.'],['رقم الطلب','حالة الطلب','رقم جواز السفر']]){
  const result=inspect(protectedCase({tables:[caseTable({headers})]}));
  assert.equal(result.applicationsRoute,true);assert.equal(result.logoutPresent,true);assert.equal(result.logoutVisible,false);assert.equal(result.applicationsVisible,true);assert.equal(result.protectedApplicationsVisible,true);assert.equal(result.accountUiVerified,true);
  for(const value of Object.values(result))assert.equal(typeof value,'boolean');for(const secret of ['PRIVATE_ACCOUNT','Passport','رقم الطلب','SmartForm','https:'])assert(!JSON.stringify(result).includes(secret));
 }
});
test('protected list proof rejects anonymous home redirects, other routes, query, hash, external origin and child frames',()=>{
 for(const url of ['https://visa.mofa.gov.sa/','https://visa.mofa.gov.sa/Home/Index','https://visa.mofa.gov.sa/SmartForm/','https://visa.mofa.gov.sa/SmartForm?view=all','https://visa.mofa.gov.sa/SmartForm#list','https://visa.mofa.gov.sa/SmartForm/TraditionalApp','https://external.test/SmartForm']){
  const result=inspect(protectedCase({url}));assert.equal(result.protectedApplicationsVisible,false,url);assert.equal(result.accountUiVerified,false,url);
 }
 assert.equal(inspect(protectedCase({main:false})).accountUiVerified,false);
});
test('protected list proof requires the actual safe visible new application anchor',()=>{
 for(const spec of [{visible:false},{disabled:true},{tag:'BUTTON'},{href:'https://external.test/SmartForm/Agreement'},{href:'/SmartForm/Agreement?accept=true'},{href:'/SmartForm/Agreement#next'},{href:'/SmartForm/TraditionalApp'},{attrs:{onclick:''}},{attrs:{download:''}},{attrs:{'aria-disabled':'true'}},{text:'PRIVATE_UNRECOGNIZED_LABEL'}]){
  const settings=protectedCase();settings.controls[2]=el({text:'إضافة طلب جديد',href:'/SmartForm/Agreement',...spec});const result=inspect(settings);assert.equal(result.protectedApplicationsVisible,false,JSON.stringify(spec));assert.equal(result.accountUiVerified,false,JSON.stringify(spec));
 }
 const noNew=protectedCase();noNew.controls.pop();assert.equal(inspect(noNew).accountUiVerified,false);
});
test('protected list proof rejects absent, hidden, ambiguous, unknown and merged table headers without reading private case rows',()=>{
 const tables=[[],[caseTable({hidden:true})],[caseTable(),caseTable()],[caseTable({headers:['Name','Details']})],[caseTable({headers:['Passport No','Passport Number','Application No']})],[caseTable({extraHeaders:[['Passport No','Application No']]})],[caseTable({headerHidden:true})],[caseTable({spanned:true})],[caseTable({foreignRow:true})],Array.from({length:11},()=>caseTable())];
 for(const value of tables){const result=inspect(protectedCase({tables:value}));assert.equal(result.protectedApplicationsVisible,false);assert.equal(result.accountUiVerified,false);}
});
test('protected list proof retains logout, applications visibility, login and OTP requirements',()=>{
 for(const mode of ['logout','applications','login','otp']){
  const settings=protectedCase();if(mode==='logout')settings.controls.shift();if(mode==='applications')settings.controls[1]=el({text:'طلباتي',href:'/SmartForm',visible:false});if(mode==='login')settings.login=[el({tag:'INPUT'})];if(mode==='otp')settings.otp=true;
  const result=inspect(settings);assert.equal(result.protectedApplicationsVisible,false,mode);assert.equal(result.accountUiVerified,false,mode);
 }
});
test('wrapper recomputes protected proof with both new flags and retains compatibility with legacy visible-control evidence',async()=>{
 const valid=inspect(protectedCase());assert.equal((await getAccountSignals({evaluate:async()=>({...valid,private:'PRIVATE_ACCOUNT'})})).accountUiVerified,true);
 for(const key of ['applicationsRoute','protectedApplicationsVisible','logoutPresent','applicationsVisible','officialHost','mainDocument']){const result=await getAccountSignals({evaluate:async()=>({...valid,[key]:false,accountUiVerified:true})});assert.equal(result.accountUiVerified,false,key);}
 assert.equal((await getAccountSignals({evaluate:async()=>valid},true)).accountUiVerified,false);
 const legacy=inspect();delete legacy.applicationsRoute;delete legacy.protectedApplicationsVisible;const result=await getAccountSignals({evaluate:async()=>legacy});assert.equal(result.accountUiVerified,true);assert.equal(result.applicationsRoute,false);assert.equal(result.protectedApplicationsVisible,false);
 const malformed={...valid,applicationsRoute:'PRIVATE_ROUTE',protectedApplicationsVisible:'PRIVATE_UI'};const rejected=await getAccountSignals({evaluate:async()=>malformed});assert.equal(rejected.accountUiVerified,false);assert(!JSON.stringify(rejected).includes('PRIVATE'));
});
