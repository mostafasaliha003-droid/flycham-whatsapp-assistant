'use strict';

// Local-only Playwright prototype: the upload IDs below are synthetic and
// MUST NOT be assumed to correspond to MOFA. This module is not wired to the
// server. It never accepts a URL, never submits and never accepts declarations.
const sharp = require('sharp');
const FIELDS = Object.freeze({arabicFirstName:'#AFIRSTNAME',arabicFamilyName:'#AFAMILY',latinFirstName:'#EFIRSTNAME',latinFamilyName:'#EFAMILY',passportNumber:'#PASSPORTnumber'});
const UPLOADS = Object.freeze({passport:'#mock-passport',residence:'#mock-residence',photo:'#mock-photo'});
const TEST_VALUES=Object.freeze({arabicFirstName:'اختبار',arabicFamilyName:'اختبار',latinFirstName:'TEST',latinFamilyName:'TEST',passportNumber:'TEST123456'});
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Local mock only</title></head><body><main data-raad-mock="v1"><label>First Arabic<input id="AFIRSTNAME"></label><label>Family Arabic<input id="AFAMILY"></label><label>First English<input id="EFIRSTNAME"></label><label>Family English<input id="EFAMILY"></label><label>Passport<input id="PASSPORTnumber"></label><label>Passport image<input type="file" id="mock-passport" accept="image/png,image/jpeg"></label><label>Residence image<input type="file" id="mock-residence" accept="image/png,image/jpeg"></label><label>Photo<input type="file" id="mock-photo" accept="image/png,image/jpeg"></label></main></body></html>`;
function error(code){return Object.assign(new Error(code),{code});}
function plain(x){return x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;}
async function syntheticFiles(){
 const files={};for(const [kind,background] of Object.entries({passport:'#ed7777',residence:'#77ed77',photo:'#7777ed'})){
  files[kind]={bytes:await sharp({create:{width:12,height:12,channels:3,background}}).png().toBuffer(),mimeType:'image/png'};
 }return files;
}
async function validate(fields,files){
 if(!plain(fields)||!plain(files)||Object.keys(fields).length!==Object.keys(FIELDS).length||Object.keys(files).length!==Object.keys(UPLOADS).length||!Object.keys(fields).every(k=>Object.hasOwn(FIELDS,k))||!Object.keys(files).every(k=>Object.hasOwn(UPLOADS,k)))throw error('MOCK_INPUT_INVALID');
 // Only fixed synthetic values and generated images are permitted in this
 // pilot. A real applicant cannot accidentally enter the local test page.
 for(const [key,value] of Object.entries(fields))if(value!==TEST_VALUES[key])throw error('MOCK_SYNTHETIC_ONLY');
 const synthetic=await syntheticFiles();
 const out={};
 for(const [kind,file] of Object.entries(files)){
  if(!plain(file)||!Buffer.isBuffer(file.bytes)||file.bytes.length<8||file.bytes.length>1000000||!['image/png','image/jpeg'].includes(file.mimeType))throw error('MOCK_IMAGE_INVALID');
  if(file.mimeType!==synthetic[kind].mimeType||!file.bytes.equals(synthetic[kind].bytes))throw error('MOCK_SYNTHETIC_ONLY');
  let meta;try{meta=await sharp(file.bytes,{limitInputPixels:20000000}).metadata();}catch{throw error('MOCK_IMAGE_INVALID');}
  if(!meta.width||!meta.height||meta.pages>1||(file.mimeType==='image/png'?meta.format!=='png':meta.format!=='jpeg'))throw error('MOCK_IMAGE_INVALID');
  out[kind]={name:`mock-${kind}.${meta.format==='png'?'png':'jpg'}`,mimeType:file.mimeType,buffer:file.bytes};
 }
 return out;
}
async function runMockPortal({page,fields={},files={},enabled=false}={}){
 if(enabled!==true)throw error('MOCK_DISABLED');
 if(!page||typeof page.url!=='function'||page.url()!=='about:blank'||typeof page.setContent!=='function'||typeof page.locator!=='function'||typeof page.route!=='function'||typeof page.unroute!=='function')throw error('MOCK_PAGE_REQUIRED');
 const uploads=await validate(fields,files);
 const block=route=>route.abort();
 await page.route('**/*',block);
 try{
  if(page.url()!=='about:blank')throw error('MOCK_PAGE_REQUIRED');
  await page.setContent(FIXTURE,{waitUntil:'domcontentloaded'});
  if(page.url()!=='about:blank')throw error('MOCK_PAGE_REQUIRED');
  // Confirm all controls exist before the first mutation. Do not infer omitted
  // fields, write health answers, click agreements, or trigger form submission.
  for(const selector of [...Object.keys(fields).map(k=>FIELDS[k]),...Object.keys(uploads).map(k=>UPLOADS[k])])if(await page.locator(selector).count()!==1)throw error('MOCK_CONTROL_MISSING');
  for(const [key,value] of Object.entries(fields)){if(page.url()!=='about:blank')throw error('MOCK_PAGE_REQUIRED');await page.locator(FIELDS[key]).fill(value);}
  for(const [kind,file] of Object.entries(uploads)){if(page.url()!=='about:blank')throw error('MOCK_PAGE_REQUIRED');await page.locator(UPLOADS[kind]).setInputFiles(file);}
  if(page.url()!=='about:blank')throw error('MOCK_PAGE_REQUIRED');
  return {ok:true,mode:'local_mock_only',fieldsFilled:Object.keys(fields).length,filesAttached:Object.keys(uploads).length,submitted:false};
 }finally{await page.unroute('**/*',block);}
}
module.exports={runMockPortal,syntheticFiles,syntheticFields:()=>({...TEST_VALUES})};
