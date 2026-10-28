'use strict';
const ORIGIN='https://visa.mofa.gov.sa';
const ERROR_CODES=new Set(['PORTAL_FILL_INPUT_INVALID','PORTAL_FILL_UNTRUSTED_PAGE','PORTAL_FILL_FIELD_UNAVAILABLE','PORTAL_FILL_FIELD_FORBIDDEN','PORTAL_FILL_FORM_UNAVAILABLE','PORTAL_FILL_KIND_MISMATCH','PORTAL_FILL_OPTION_INVALID','PORTAL_FILL_UNCONFIRMED','PORTAL_FILL_BUSY']);
const workingPages=new WeakSet();
function failure(code,filledCount=0){const error=new Error(ERROR_CODES.has(code)?code:'PORTAL_FILL_UNCONFIRMED');error.code=error.message;error.filledCount=filledCount;return error;}
function checkPortalDocument(){return location.origin==='https://visa.mofa.gov.sa'&&window.top===window.self;}
// Runs in the page. Returns retained original elements only when binding; later
// checks use those same elements and never re-resolve a field for an action.
function inspectPortalFields({fields,originals,bind=false}){
 const fail=code=>{throw Error(code);};
 if(location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self)fail('PORTAL_FILL_UNTRUSTED_PAGE');
 const sensitive=/password|passwd|token|otp|verification|captcha|authenticity|one[-_\s]?time[-_\s]?(?:code|password)|csrf|xsrf|nonce|security[-_\s]?code|verify[-_\s]?code|validation[-_\s]?code|كلمة\s*(?:المرور|السر)|رمز\s*(?:التحقق|التأكيد|التفعيل|الصورة)/i;
 const safeAction=raw=>{try{const action=new URL(raw||location.href,document.baseURI||location.href);return action.origin==='https://visa.mofa.gov.sa'&&!action.username&&!action.password;}catch{return false;}};
 const visible=el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el);return box.width>0&&box.height>0&&style.display!=='none'&&!['hidden','collapse'].includes(style.visibility)&&style.opacity!=='0'&&!el.closest('[hidden],[inert],[aria-hidden="true"]');};
 const elements=[];
 for(let index=0;index<fields.length;index++){
  const field=fields[index],matches=Array.from(document.querySelectorAll('#'+CSS.escape(field.id)));
  if(matches.length!==1)fail('PORTAL_FILL_FIELD_UNAVAILABLE');
  const el=originals?originals[index]:matches[0];
  if(!el||el!==matches[0]||!el.isConnected||el.ownerDocument!==document||el.namespaceURI!=='http://www.w3.org/1999/xhtml'||!['INPUT','SELECT','TEXTAREA'].includes(el.tagName)||!visible(el)||el.disabled||el.matches(':disabled')||el.readOnly||el.getAttribute('aria-disabled')==='true')fail('PORTAL_FILL_FIELD_UNAVAILABLE');
  const type=String(el.type||'').toLowerCase();
  const identity=[el.id,el.name,el.getAttribute('autocomplete')].filter(Boolean).join(' ');
  if(sensitive.test(identity)||['hidden','password','file','submit','button','reset','image'].includes(type))fail('PORTAL_FILL_FIELD_FORBIDDEN');
  const form=el.form;
  const agreementCheck=!form&&location.pathname==='/SmartForm/Agreement'&&field.kind==='check'&&el.tagName==='INPUT'&&type==='checkbox';
  if(!agreementCheck&&(!form||form.tagName!=='FORM'||form.ownerDocument!==document||!form.isConnected||!safeAction(form.getAttribute('action'))||el.hasAttribute('formaction')&&!safeAction(el.getAttribute('formaction'))))fail('PORTAL_FILL_FORM_UNAVAILABLE');
  if(field.kind==='text'){
   if(el.tagName!=='TEXTAREA'&&(el.tagName!=='INPUT'||!['text','email','tel','number','search','url','date','time','datetime-local','month','week'].includes(type)))fail('PORTAL_FILL_KIND_MISMATCH');
   if(Number.isInteger(el.maxLength)&&el.maxLength>=0&&field.value.length>el.maxLength)fail('PORTAL_FILL_INPUT_INVALID');
  }else if(field.kind==='select'){
   if(el.tagName!=='SELECT'||el.multiple)fail('PORTAL_FILL_KIND_MISMATCH');
   const options=Array.from(el.options||[]).filter(option=>option.value===field.value);
   if(options.length!==1)fail('PORTAL_FILL_OPTION_INVALID');
   const option=options[0],caption=String(option.textContent||'').replace(/^[\s\-–—_*()[\]<>]+|[\s\-–—_*()[\]<>]+$/g,'').replace(/[أإآ]/g,'ا');
   if(!field.value.trim()||!caption||option.disabled||option.hidden||option.parentElement?.disabled||option.hasAttribute('placeholder')||option.hasAttribute('data-placeholder')||/^(?:(?:please\s+)?(?:select|choose)(?:\s|[:.…]|$)|(?:الرجاء\s+|يرجى\s+)?(?:اختر|اختار|حدد)(?:\s|$))/i.test(caption))fail('PORTAL_FILL_OPTION_INVALID');
  }else if(field.kind==='check'){
   if(el.tagName!=='INPUT'||type!=='checkbox')fail('PORTAL_FILL_KIND_MISMATCH');
  }else fail('PORTAL_FILL_KIND_MISMATCH');
  elements.push(el);
 }
 return bind?elements:true;
}
function validateInput(fields){
 if(!Array.isArray(fields)||fields.length<1||fields.length>40)throw failure('PORTAL_FILL_INPUT_INVALID');
 const ids=new Set();
 return fields.map(field=>{
  if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).some(key=>!['id','value','kind'].includes(key))||typeof field.id!=='string'||!field.id.trim()||field.id.length>200||/[\u0000-\u001f\u007f]/.test(field.id)||ids.has(field.id)||!['text','select','check'].includes(field.kind))throw failure('PORTAL_FILL_INPUT_INVALID');
  if(field.kind==='check'?typeof field.value!=='boolean':typeof field.value!=='string'||field.value.length>300||field.value.includes('\u0000'))throw failure('PORTAL_FILL_INPUT_INVALID');
  ids.add(field.id);return {id:field.id,kind:field.kind,value:field.value};
 });
}
async function assertOfficial(page){let trusted=false;try{trusted=new URL(page.url()).origin===ORIGIN&&await page.evaluate(checkPortalDocument)===true;}catch{}if(!trusted)throw failure('PORTAL_FILL_UNTRUSTED_PAGE');}
function verifyFilledField(el,field){
 if(location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self||el.ownerDocument!==document||!el.isConnected)return false;
 return field.kind==='check'?el.checked===field.value:el.value===field.value;
}
async function fillPortalFields(page,input={}){
 let batch;try{batch=validateInput(input?.fields);}catch{throw failure('PORTAL_FILL_INPUT_INVALID');}
 if(!page||typeof page.evaluate!=='function'||typeof page.evaluateHandle!=='function')throw failure('PORTAL_FILL_UNTRUSTED_PAGE');
 if(workingPages.has(page))throw failure('PORTAL_FILL_BUSY');
 workingPages.add(page);let filledCount=0,collection;const disposables=new Set();
 try{
  await assertOfficial(page);
  collection=await page.evaluateHandle(inspectPortalFields,{fields:batch,bind:true});disposables.add(collection);
  const properties=await collection.getProperties();for(const handle of properties.values())disposables.add(handle);
  const handles=batch.map((_,index)=>properties.get(String(index))?.asElement());
  if(handles.some(handle=>!handle))throw failure('PORTAL_FILL_FIELD_UNAVAILABLE');
  // Validate every bound original before the first mutation, then again before
  // each action in case client-side handlers changed the document or controls.
  await page.evaluate(inspectPortalFields,{fields:batch,originals:handles});
  for(let index=0;index<batch.length;index++){
   await assertOfficial(page);
   const field=batch[index],handle=handles[index];
   await page.evaluate(inspectPortalFields,{fields:[field],originals:[handle]});
   if(field.kind==='text')await handle.fill(field.value,{timeout:5000});
   else if(field.kind==='select')await handle.selectOption({value:field.value},{timeout:5000});
   else await handle.setChecked(field.value,{timeout:5000});
   await assertOfficial(page);
   if(await handle.evaluate(verifyFilledField,field)!==true)throw failure('PORTAL_FILL_UNCONFIRMED');
   filledCount++;
  }
  await assertOfficial(page);
  return {filledCount,ids:batch.map(field=>field.id)};
 }catch(error){const code=Array.from(ERROR_CODES).find(item=>String(error?.message||'').includes(item))||'PORTAL_FILL_UNCONFIRMED';throw failure(code,filledCount);}
 finally{workingPages.delete(page);await Promise.all(Array.from(disposables,handle=>Promise.resolve().then(()=>handle.dispose()).catch(()=>{})));}
}
module.exports={fillPortalFields};
