'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {inspectVerificationControls,inspectVerificationStructure}=require('./verification-controls');

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


function diagnose(f,{frames=0}={}){
 const result=vm.runInNewContext('('+inspectVerificationStructure.toString()+')()',{
  document:{querySelectorAll(selector){
   if(selector==='input')return f.fields;
   if(selector==='iframe')return Array.from({length:frames},()=>({}));
   if(selector==='button,input[type=submit],input[type=button],a[role=button]')return f.controls;
   throw Error('Unexpected selector');
  }},
  getComputedStyle(){return {display:'block',visibility:'visible'};}
 });
 return JSON.parse(JSON.stringify(result));
}
test('zero-box form still permits visible same-form OTP and confirm controls',()=>{
 const f=fixture();f.form.getBoundingClientRect=()=>({width:0,height:0});
 assert.deepEqual(f.run(),{inputSelector:'#otp',buttonSelector:'#confirm',maxLength:6});
 assert.equal(diagnose(f).fields[0].formHasBox,false);
});
test('diagnostics return only safe structure without editable values or source labels',()=>{
 const privateEmail='private@example.test',privateCode='987654',privateLabel='رمز التفعيل '+privateEmail+' '+privateCode;
 const f=fixture({inputs:[{id:privateEmail,name:privateEmail,attrs:{'aria-label':privateLabel,placeholder:privateLabel,autocomplete:'one-time-code'}}],buttons:[{id:'verify',textContent:'تأكيد '+privateEmail+' '+privateCode}]});
 f.fields[0].labels=[{textContent:privateLabel}];
 const out=diagnose(f),encoded=JSON.stringify(out);
 assert.equal(out.fields[0].id,null);assert.equal(out.fields[0].name,null);
 assert.equal(out.fields[0].verificationLabel,true);assert.equal(out.fields[0].otpAutocomplete,true);
 assert.equal(out.buttons[0].kind,'verify');
 for(const secret of [privateEmail,privateCode,privateLabel,'aria-label','placeholder','textContent','value'])assert.equal(encoded.includes(secret),false);
 assert.deepEqual(Object.keys(out.fields[0]).sort(),['formHasBox','hasForm','id','imageCodeLabel','maxLength','name','otpAutocomplete','type','verificationLabel']);
});
test('diagnostics categorize captcha and OTP labels and buttons without captions',()=>{
 const f=fixture({inputs:[{id:'Captcha',name:'Captcha',attrs:{'aria-label':'رمز الصورة'}},{id:'verificationCode',name:'code',attrs:{'aria-label':'رمز التأكيد'}}],buttons:[
  {id:'resend',textContent:'إرسال',attrs:{title:'إعادة الإرسال'}},
  {id:'confirm',textContent:'تأكيد'},
  {id:'login',textContent:'تسجيل الدخول'},
  {id:'continue',textContent:'متابعة'},
  {id:'cancel',textContent:'إلغاء'}
 ]});
 const out=diagnose(f);
 assert.equal(out.fields[0].imageCodeLabel,true);assert.equal(out.fields[1].verificationLabel,true);
 assert.deepEqual(out.buttons.map(b=>b.kind),['resend','verify','login','submit','other']);
});
test('diagnostics cap output counts and omit hidden controls',()=>{
 const f=fixture({inputs:[{id:'hidden',visible:false},...Array.from({length:24},(_,i)=>({id:'field'+i,name:'field'+i}))],buttons:[{id:'hiddenButton',visible:false},...Array.from({length:24},(_,i)=>({id:'button'+i,textContent:'تأكيد'}))]});
 const out=diagnose(f,{frames:25});
 assert.equal(out.fields.length,16);assert.equal(out.buttons.length,16);assert.equal(out.frameCount,16);
 assert.equal(out.fields[0].id,null);assert.equal(out.buttons[0].id,null);
 assert.equal(JSON.stringify(out).includes('hidden'),false);
});


test('observed six-digit verification field and native btnSubmit need no caption match',()=>{
 const f=fixture({inputs:[{id:'emailActivation',name:'emailActivation',attrs:{'aria-label':'رمز التفعيل'},maxLength:6}],buttons:[{tagName:'INPUT',id:'btnSubmit',type:'submit',attrs:{value:'تفعيل الحساب'}}]});
 assert.deepEqual(f.run(),{inputSelector:'#emailActivation',buttonSelector:'#btnSubmit',maxLength:6});
});
test('observed fallback rejects hidden, disabled, wrong-form, resend or non-six-digit controls',()=>{
 const base={tagName:'INPUT',id:'btnSubmit',type:'submit',attrs:{value:'تفعيل الحساب'}};
 for(const overrides of [{visible:false},{disabled:true},{attrs:{value:'تفعيل الحساب',title:'إعادة إرسال'}},{id:'differentSubmit'}]){
  assert.equal(fixture({buttons:[{...base,...overrides}]}).run(),null);
 }
 const wrong=fixture({buttons:[base]});wrong.controls[0].form={};assert.equal(wrong.run(),null);
 assert.equal(fixture({inputs:[{id:'otp',maxLength:8}],buttons:[base]}).run(),null);
});
