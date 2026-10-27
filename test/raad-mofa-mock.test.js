'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
const {runMockPortal,syntheticFiles,syntheticFields}=require('../src/raad-mofa-mock');

function fakePage({url='about:blank',missing=null}={}){
 const log=[];return {log,url:()=>url,route:async(pattern)=>log.push(['route',pattern]),unroute:async(pattern)=>log.push(['unroute',pattern]),setContent:async(html)=>log.push(['html',/data-raad-mock="v1"/.test(html)]),locator(selector){return{count:async()=>selector===missing?0:1,fill:async()=>log.push(['fill',selector]),setInputFiles:async(file)=>log.push(['upload',selector,file.mimeType,Buffer.isBuffer(file.buffer)])};}};
}
test('mock is off by default and refuses real or unknown pages',async()=>{
 let page=fakePage();await assert.rejects(runMockPortal({page}),{code:'MOCK_DISABLED'});assert.equal(page.log.length,0);
 page=fakePage({url:'https://visa.mofa.gov.sa/SmartForm'});await assert.rejects(runMockPortal({page,enabled:true}),{code:'MOCK_PAGE_REQUIRED'});assert.equal(page.log.length,0);
});
test('fixture accepts only generated synthetic fields and images in memory',async()=>{
 const page=fakePage(),files=await syntheticFiles();const result=await runMockPortal({page,fields:syntheticFields(),files,enabled:true});
 assert.deepEqual(result,{ok:true,mode:'local_mock_only',fieldsFilled:5,filesAttached:3,submitted:false});
 assert.equal(page.log.filter(x=>x[0]==='fill').length,5);assert.equal(page.log.filter(x=>x[0]==='upload').length,3);
 assert.equal(page.log[0][0],'route');assert.equal(page.log.at(-1)[0],'unroute');assert.ok(page.log.filter(x=>x[0]==='upload').every(x=>x[3]));
});
test('unknown fields, real-like fields, unexpected uploads and real-like images fail before UI writes',async()=>{
 const files=await syntheticFiles(),fields=syntheticFields();for(const [input,code] of [[{fields:{...fields,medical:'no'},files},'MOCK_INPUT_INVALID'],[{fields:{...fields,passportNumber:'P123456789'},files},'MOCK_SYNTHETIC_ONLY'],[{fields,files:{...files,extra:files.passport}},'MOCK_INPUT_INVALID'],[{fields,files:{...files,passport:{bytes:Buffer.from('notanimage'),mimeType:'image/png'}}},'MOCK_SYNTHETIC_ONLY'],[{fields,files:{...files,photo:undefined}},'MOCK_IMAGE_INVALID'],[{fields,files:{}},'MOCK_INPUT_INVALID']]){
  const page=fakePage();await assert.rejects(runMockPortal({page,...input,enabled:true}),{code});assert.equal(page.log.length,0);
 }
});
test('missing controls fail without any field or attachment mutations',async()=>{
 const page=fakePage({missing:'#mock-photo'});await assert.rejects(runMockPortal({page,fields:syntheticFields(),files:await syntheticFiles(),enabled:true}),{code:'MOCK_CONTROL_MISSING'});
 assert.ok(!page.log.some(x=>x[0]==='fill'||x[0]==='upload'));assert.equal(page.log.at(-1)[0],'unroute');
});
test('real browser exercises the isolated mock only when Chromium is installed',{skip:!fs.existsSync(chromium.executablePath())},async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();const result=await runMockPortal({page,fields:syntheticFields(),files:await syntheticFiles(),enabled:true});
  assert.equal(result.filesAttached,3);assert.equal(result.submitted,false);assert.equal(await page.locator('#mock-passport').evaluate(el=>el.files.length),1);
  assert.equal(await page.locator('form,button').count(),0);
 }finally{await browser.close();}
});
