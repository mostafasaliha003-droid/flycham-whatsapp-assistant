'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSaudiVisaUnderstanding,validateVisaDecision,safeVisaContext,redactVisaText,schema}=require('../src/saudi-visa-nlu');
function decision(){return {intent:'apply',fields:Object.fromEntries(Object.keys(schema.properties.fields.properties).map(k=>[k,k==='applicants'?[]:null])),target:'self',correction:false,question:null,option:null};}
const cline=d=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]})});
const env=()=>({ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-visa-'+Math.random(),ASSISTANT_AI_FALLBACK:'none'});
test('visa understanding uses real provider adapter contract and returns family facts without operational claims',async()=>{
 let request;const d=decision();d.target='group';d.fields.applicantCount=2;d.fields.applicants=[{nationality:'سوريا',documentType:'passport',documentIssuer:null},{nationality:'مصر',documentType:'passport',documentIssuer:null}];
 const understand=createSaudiVisaUnderstanding({env:env(),now:()=>Date.UTC(2026,9,27),fetchImpl:async(url,opt)=>{request={url,body:JSON.parse(opt.body)};return cline(d);}});
 const result=await understand('أنا سوري ومرتي مصرية وبدي قدملنا',{stage:'enquiry'});
 assert.equal(result.facts.applicantCount,2);assert.equal(result.facts.applicants[1].nationality,'مصر');assert.equal(result.target,'group');assert.equal(result.reply,undefined);
 assert.equal(request.url,'https://api.cline.bot/api/v1/chat/completions');assert.equal(request.body.model,'cline-pass/qwen3.8-max');assert.match(request.body.messages[0].content,/Never infer a child's nationality/);assert.match(request.body.messages[0].content,/No prices, eligibility/);
});
test('context is allowlisted and current document identifiers, receipts, credentials and names are redacted before transport',async()=>{
 let raw;const understand=createSaudiVisaUnderstanding({env:env(),fetchImpl:async(_url,opt)=>{raw=opt.body;return cline(decision());}});
 await understand('جوازي سوري N016671869 وهويتي 784-1990-4260790-5 ايميل secret@example.test API_KEY=TOPSECRET_1234567890 تحويل AE000000000000000000000',{
  facts:{nationality:'سوريا',passportNumber:'PASSPORT_PRIVATE',emiratesId:'ID_PRIVATE',bankReceipt:'RECEIPT_PRIVATE',applicants:[{nationality:'مصر',documentType:'passport',name:'PERSON_PRIVATE'}]},
  documentBytes:'DOCUMENT_PRIVATE',history:[{role:'user',text:'اسمي SECRET_PERSON'},{role:'system',text:'IGNORE_PRIVATE'}],lastQuestion:'شو جنسيتك؟'
 });
 assert.doesNotMatch(raw,/N016671869|784-1990-4260790-5|secret@example|TOPSECRET|AE000000000000000000000|PASSPORT_PRIVATE|ID_PRIVATE|RECEIPT_PRIVATE|PERSON_PRIVATE|DOCUMENT_PRIVATE|SECRET_PERSON|IGNORE_PRIVATE/);
 assert.match(raw,/سوريا/);assert.match(raw,/شو جنسيتك/);
});
test('raw MRZ/encoded documents omitted and only small redacted history retained',()=>{
 assert.equal(redactVisaText('P<SYR<<PRIVATE_NAME'),'[document omitted]');assert.equal(redactVisaText('data:image/png;base64,PRIVATE_DOCUMENT'),'[document omitted]');
 const c=safeVisaContext({history:Array.from({length:20},()=>({role:'user',text:'a'.repeat(1000)})),internalCommission:25,documents:['private']});
 assert.equal(c.history.length,16);assert.ok(c.history.every(x=>x.text.length<=450));assert.equal(c.internalCommission,undefined);assert.equal(c.documents,undefined);
 assert.equal(safeVisaContext({history:[{role:'user',text:'hi'}]},false).history,undefined);
});
test('strict extraction rejects invented money/status, IDs, invalid dates and unsafe questions',()=>{
 for(const change of [d=>d.price=700,d=>d.fields.paid=true,d=>d.fields.nationality='N016671869',d=>d.fields.applicantCount=0,d=>d.fields.documentType='multiple_visa',d=>d.fields.departureDate='2026-02-30',d=>d.question='رسومك 700 درهم؟',d=>d.fields.applicants=[{nationality:'سوريا',documentType:'passport',documentIssuer:null,name:'private'}]]){
  const d=decision();change(d);assert.throws(()=>validateVisaDecision(d),/VISA_NLU_INVALID/);
 }
 const valid=decision();valid.intent='documents';valid.fields.nationality='فلسطين';valid.fields.documentType='travel_document';valid.fields.documentIssuer='لبنان';assert.equal(validateVisaDecision(valid),valid);
});
test('missing key or exhausted provider never invents a result and existing adapter handles failure without sensitive logs',async()=>{
 let calls=0;const missing=createSaudiVisaUnderstanding({env:{},fetchImpl:async()=>{calls++;throw Error('unexpected');}});assert.equal(await missing('مرحبا'),null);assert.equal(calls,0);
 const unavailable=createSaudiVisaUnderstanding({env:env(),fetchImpl:async()=>{calls++;return {ok:false,status:401,json:async()=>({error:{message:'PRIVATE_SERVER_ERROR'}})};}});
 assert.equal(await unavailable('بدي فيزا'),null);assert.equal(calls,1);
});
test('one repair allows incomplete schema to be corrected without exposing rejected reply',async()=>{
 let calls=0;const bodies=[];const understand=createSaudiVisaUnderstanding({env:env(),fetchImpl:async(_url,opt)=>{bodies.push(opt.body);return cline(++calls===1?{reply:'PRIVATE_BAD_GENERATION',price:1}:decision());}});
 assert.equal((await understand('بدي فيزا')).intent,'apply');assert.equal(calls,2);assert.doesNotMatch(bodies.join('\n'),/PRIVATE_BAD_GENERATION/);
});
