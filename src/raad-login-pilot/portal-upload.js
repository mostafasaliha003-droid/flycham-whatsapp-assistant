'use strict';
const ORIGIN='https://visa.mofa.gov.sa',MAX_FILE=1000000,MAX_TOTAL=3000000;
const CODES=new Set(['UPLOAD_INPUT_INVALID','UPLOAD_PAGE_UNAVAILABLE','UPLOAD_FIELD_UNAVAILABLE','UPLOAD_FAILED']);
class PortalUploadError extends Error{constructor(code,count=0){super(CODES.has(code)?code:'UPLOAD_FAILED');this.code=this.message;this.uploadedCount=count;}}
function validateDocuments(documents){
 if(!Array.isArray(documents)||documents.length<1||documents.length>3)throw new PortalUploadError('UPLOAD_INPUT_INVALID');
 let total=0;const ids=new Set(),roles=new Set();
 return documents.map(doc=>{
  if(!doc||typeof doc!=='object'||Array.isArray(doc)||Object.keys(doc).sort().join(',')!=='data,id,mimeType,name,role')throw new PortalUploadError('UPLOAD_INPUT_INVALID');
  if(typeof doc.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(doc.id)||ids.has(doc.id)||!['passport','residence','portrait'].includes(doc.role)||roles.has(doc.role)||typeof doc.name!=='string'||doc.name.length>64||!/^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:jpg|jpeg|png)$/i.test(doc.name)||!['image/jpeg','image/png'].includes(doc.mimeType)||typeof doc.data!=='string'||doc.data.length>1333336||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(doc.data))throw new PortalUploadError('UPLOAD_INPUT_INVALID');
  const extension=doc.name.slice(doc.name.lastIndexOf('.')).toLowerCase();if((doc.mimeType==='image/png')!==(extension==='.png'))throw new PortalUploadError('UPLOAD_INPUT_INVALID');
  const buffer=Buffer.from(doc.data,'base64');if(!buffer.length||buffer.length>MAX_FILE||buffer.toString('base64')!==doc.data)throw new PortalUploadError('UPLOAD_INPUT_INVALID');
  if(doc.mimeType==='image/png'){
   if(buffer.length<33||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||buffer.readUInt32BE(8)!==13||buffer.toString('ascii',12,16)!=='IHDR')throw new PortalUploadError('UPLOAD_INPUT_INVALID');
   const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);if(!width||!height||width>20000||height>20000||width*height>40000000||![1,2,4,8,16].includes(buffer[24])||![0,2,3,4,6].includes(buffer[25])||buffer[26]!==0||buffer[27]!==0||![0,1].includes(buffer[28]))throw new PortalUploadError('UPLOAD_INPUT_INVALID');
  }else if(buffer.length<4||buffer[0]!==255||buffer[1]!==216||buffer[buffer.length-2]!==255||buffer[buffer.length-1]!==217)throw new PortalUploadError('UPLOAD_INPUT_INVALID');
  total+=buffer.length;if(total>MAX_TOTAL)throw new PortalUploadError('UPLOAD_INPUT_INVALID');ids.add(doc.id);roles.add(doc.role);return {id:doc.id,role:doc.role,name:doc.name,mimeType:doc.mimeType,extension,buffer};
 });
}
function inspectUploadInput({id,mimeType,extension}){
 try{
  if(location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self)return null;
  const all=Array.from(document.querySelectorAll('input[type="file"]')).filter(el=>el.id===id);if(all.length!==1)return null;const el=all[0];
  if(el.disabled||el.readOnly||el.getAttribute('aria-disabled')==='true'||!el.form)return null;
  const action=new URL(el.form.getAttribute('action')||location.href,location.href);if(action.origin!==location.origin||action.username||action.password)return null;
  const accepts=(el.getAttribute('accept')||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);if(accepts.length&&!accepts.some(x=>x===mimeType||x===extension||x==='image/*'))return null;
  const visible=node=>{if(node.hidden||node.getAttribute('aria-hidden')==='true'||node.closest('[hidden],[aria-hidden="true"]'))return false;const s=getComputedStyle(node);return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&node.getClientRects().length>0;};
  const labelled=Array.from(el.labels||[]).some(label=>visible(label)&&label.getAttribute('for')===id);
  const parent=el.parentElement;const widget=parent&&visible(parent)&&/(?:^|\s)(?:custom-file|fileinput|file-upload|upload-widget|input-file|file-widget)(?:\s|$)/i.test(parent.getAttribute('class')||'')&&parent.querySelectorAll('input[type="file"]').length===1;
  if(!visible(el)&&!labelled&&!widget)return null;
  return el;
 }catch{return null;}
}
async function uploadPortalDocuments(page,{documents}={}){
 const batch=validateDocuments(documents),prepared=[];let uploadedCount=0;
 async function guard(){const url=new URL(page.url()),main=page.mainFrame();if(url.origin!==ORIGIN||url.username||url.password||!main||main.url()!==page.url())throw new PortalUploadError('UPLOAD_PAGE_UNAVAILABLE',uploadedCount);}
 try{
  await guard();
  // Validate the entire batch and capture each original control/form BEFORE any
  // native attachment. No selector is re-resolved during the upload phase.
  for(const doc of batch){
   const raw=await page.evaluateHandle(inspectUploadInput,{id:doc.id,mimeType:doc.mimeType,extension:doc.extension});const input=raw.asElement();if(!input){await raw.dispose();throw new PortalUploadError('UPLOAD_FIELD_UNAVAILABLE');}
   const entry={doc,input,form:null,action:null};prepared.push(entry);entry.form=await input.evaluateHandle(el=>el.form);entry.action=await input.evaluate(el=>new URL(el.form.getAttribute('action')||location.href,location.href).href);
  }
  for(const item of prepared){
   await guard();const valid=await item.input.evaluate((el,expected)=>{
    if(!el.isConnected||el.id!==expected.id||el.disabled||el.readOnly||el.getAttribute('aria-disabled')==='true'||el.tagName!=='INPUT'||el.type!=='file'||el.form!==expected.form||location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self)return false;
    const accepts=(el.getAttribute('accept')||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);if(accepts.length&&!accepts.some(value=>value===expected.mimeType||value===expected.extension||value==='image/*'))return false;
    try{const action=new URL(el.form.getAttribute('action')||location.href,location.href);return action.origin===location.origin&&!action.username&&!action.password&&action.href===expected.action;}catch{return false;}
   },{form:item.form,action:item.action,id:item.doc.id,mimeType:item.doc.mimeType,extension:item.doc.extension});if(!valid)throw new PortalUploadError('UPLOAD_FIELD_UNAVAILABLE',uploadedCount);
   await item.input.setInputFiles({name:item.doc.name,mimeType:item.doc.mimeType,buffer:item.doc.buffer},{timeout:10000});uploadedCount++;await guard();
  }
  return {uploadedCount,roles:batch.map(doc=>doc.role)};
 }catch(error){if(error instanceof PortalUploadError){error.uploadedCount=uploadedCount;throw error;}throw new PortalUploadError('UPLOAD_FAILED',uploadedCount);}
 finally{for(const item of prepared){if(item.form)await item.form.dispose().catch(()=>{});await item.input.dispose().catch(()=>{});}for(const doc of batch)doc.buffer.fill(0);}
}
module.exports={uploadPortalDocuments,validateDocuments,inspectUploadInput,PortalUploadError};
