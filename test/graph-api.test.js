'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {safeGraphFailure,checkWhatsAppConnection}=require('../src/graph-api');
test('Graph diagnostics expose only bounded numeric status and codes',()=>{
 assert.equal(safeGraphFailure(401,{error:{code:190,error_subcode:463,message:'private secret',fbtrace_id:'private'}}),'WHATSAPP_GRAPH_HTTP_401_CODE_190_SUBCODE_463');
 assert.equal(safeGraphFailure('private',{error:{code:'private',error_subcode:-1}}),'WHATSAPP_GRAPH_HTTP_0_CODE_0_SUBCODE_0');
});
test('connection probe is read-only and never returns credentials or response content',async()=>{
 const original=global.fetch;try{
 global.fetch=async(url,options)=>{assert.equal(options.method,undefined);assert.ok(url.endsWith('?fields=id'));assert.equal(options.body,undefined);return{ok:false,status:401,json:async()=>({error:{code:190,error_subcode:463,message:'secret'}})};};
 assert.equal(await checkWhatsAppConnection({DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'test',WHATSAPP_PHONE_NUMBER_ID:'test'}),'WHATSAPP_GRAPH_HTTP_401_CODE_190_SUBCODE_463');
 }finally{global.fetch=original;}
});
