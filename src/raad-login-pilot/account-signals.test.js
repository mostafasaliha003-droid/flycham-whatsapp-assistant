'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {inspectAccountSignals,getAccountSignals}=require('./account-signals');
function el({tag='A',text='',href='/SmartForm/Index',visible=true,disabled=false,attrs={},form=null}={}){
 const item={tagName:tag,textContent:text,disabled,getAttribute(k){if(k==='href')return href;return Object.hasOwn(attrs,k)?attrs[k]:null;},closest(){return form;},getBoundingClientRect(){return {width:visible?10:0,height:visible?10:0};}};
 Object.defineProperty(item,'value',{get(){throw Error('editable value read');}});return item;
}
function inspect({controls=[el({text:'تسجيل الخروج',href:'/Account/LogOff'}),el({text:'طلباتي'})],login=[],url='https://visa.mofa.gov.sa/SmartForm/Index',otp=false,main=true}={}){
 const location=new URL(url),window={};window.self=window;window.top=main?window:{};
 return JSON.parse(JSON.stringify(vm.runInNewContext('('+inspectAccountSignals.toString()+')('+JSON.stringify(otp)+')',{
  location,window,URL,getComputedStyle(){return {display:'block',visibility:'visible'};},document:{querySelectorAll(selector){return selector.startsWith('#myform')?login:controls;}}
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
