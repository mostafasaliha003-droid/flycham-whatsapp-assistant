'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {inspectVerificationControls}=require('./verification-controls');

function element({tagName='INPUT',id='',name='',type='text',textContent='',attrs={},visible=true,disabled=false,readOnly=false,maxLength=-1}={}){
 const el={nodeType:1,tagName,id,name,type,textContent,disabled,readOnly,maxLength,labels:[],parentElement:null,previousElementSibling:null,
  getAttribute(key){return Object.hasOwn(attrs,key)?attrs[key]:null;},
  getBoundingClientRect(){return {width:visible?100:0,height:visible?20:0};},
  closest(tag){return tag==='form'?this.form:null;}
 };
 // Discovery must never read any editable value, including OTP or password.
 Object.defineProperty(el,'value',{get(){throw Error('Input values must not be read');}});
 return el;
}
function fixture({inputs=[{}],buttons=[{id:'confirm',textContent:'تأكيد'}],formText='رمز التحقق'}={}){
 const form=element({tagName:'FORM',id:'verification',textContent:formText});
 const fields=inputs.map(options=>element({id:'otp',name:'otp',maxLength:6,...options}));
 const controls=buttons.map(options=>element({tagName:'BUTTON',type:'submit',...options}));
 for(const el of [...fields,...controls]){el.form=form;el.parentElement=form;}
 form.querySelectorAll=()=>controls;
 return {fields,controls,form,run(){
  const result=vm.runInNewContext('('+inspectVerificationControls.toString()+')()',{
   document:{querySelectorAll(selector){assert.equal(selector,'input');return fields;}},
   getComputedStyle(){return {display:'block',visibility:'visible'};},
   CSS:{escape(value){return value;}}
  });
  return result===null?null:JSON.parse(JSON.stringify(result));
 }};
}

test('one visible OTP and one same-form confirmation button yield structural selectors only',()=>{
 const out=fixture().run();
 assert.deepEqual(out,{inputSelector:'#otp',buttonSelector:'#confirm',maxLength:6});
 assert.deepEqual(Object.keys(out).sort(),['buttonSelector','inputSelector','maxLength']);
});
test('two OTP candidate inputs fail closed',()=>{
 assert.equal(fixture({inputs:[{id:'otp'},{id:'verificationCode',name:'verificationCode'}]}).run(),null);
});
test('missing confirmation button fails closed',()=>{
 assert.equal(fixture({buttons:[]}).run(),null);
});
test('multiple confirmation buttons fail closed',()=>{
 assert.equal(fixture({buttons:[{id:'confirm',textContent:'تأكيد'},{id:'continue',textContent:'متابعة'}]}).run(),null);
});
test('resend metadata excludes plain send caption',()=>{
 for(const metadata of [{id:'btnResend'},{name:'resendCode'},{attrs:{'aria-label':'resend'}},{attrs:{title:'إعادة الإرسال'}},{attrs:{formaction:'/ResendCode'}}]){
  assert.equal(fixture({buttons:[{textContent:'إرسال',...metadata}]}).run(),null);
 }
});
test('ordinary password and captcha fields never become OTP candidates',()=>{
 assert.equal(fixture({inputs:[{id:'Password',name:'Password',type:'password'},{id:'Captcha',name:'Captcha',attrs:{'aria-label':'رمز التحقق'}}]}).run(),null);
 const out=fixture({inputs:[{id:'Password',name:'Password',type:'password'},{id:'Captcha',name:'Captcha'},{id:'otp',name:'otp'}]}).run();
 assert.equal(out.inputSelector,'#otp');
});
test('OneTimePassword with one-time-code autocomplete is supported',()=>{
 const out=fixture({inputs:[{id:'OneTimePassword',name:'OneTimePassword',type:'password',attrs:{autocomplete:'one-time-code'},maxLength:6}]}).run();
 assert.deepEqual(out,{inputSelector:'#OneTimePassword',buttonSelector:'#confirm',maxLength:6});
});
test('hidden and disabled candidates are excluded',()=>{
 const out=fixture({inputs:[{id:'hiddenOtp',name:'otp',visible:false},{id:'disabledOtp',name:'otp',disabled:true},{id:'otp',name:'otp'}]}).run();
 assert.equal(out.inputSelector,'#otp');
});
test('discovery refuses OTP input without an enclosing form',()=>{
 const f=fixture();f.fields[0].form=null;
 assert.equal(f.run(),null);
});
