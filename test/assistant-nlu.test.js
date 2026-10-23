'use strict';const test=require('node:test'),assert=require('node:assert/strict');const {understand,schema,validateDecision}=require('../src/assistant-nlu');
function decision(){const fields=Object.fromEntries(Object.keys(schema.properties.fields.properties).map(k=>[k,['ages','excludedDates'].includes(k)?[]:null]));return{intent:'change',fields,question:null,option:null};}
test('NLU is inert without an API key and emits strict structured extraction when configured',async()=>{
 assert.equal(await understand('hello',{}, {env:{}}),null);const d=decision();d.fields.weightKg=30;let called=0;
 const result=await understand('بدي 30 كيلو',{}, {env:{OPENAI_API_KEY:'private'},fetchImpl:async(url,options)=>{called++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);return{ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(d)}]}]})};}});assert.equal(result.fields.weightKg,30);assert.equal(called,1);
});
test('unknown fields, invented monetary replies and invalid dates are rejected',()=>{
 const d=decision();assert.throws(()=>validateDecision({...d,price:100}));assert.throws(()=>validateDecision({...d,question:'السعر 500 درهم'}));assert.throws(()=>validateDecision({...d,fields:{...d.fields,departureDate:'2026-02-31'}}));assert.throws(()=>validateDecision({...d,fields:{...d.fields,adults:99}}));
});
test('missing or refused model outputs never become a successful extraction',async()=>{
 await assert.rejects(understand('x',{}, {env:{OPENAI_API_KEY:'test'},fetchImpl:async()=>({ok:true,json:async()=>({status:'incomplete',output:[]})})}),/NLU_INCOMPLETE/);
});

test('API failure logs contain only HTTP status and safe error code, never the provider message',async()=>{
 await assert.rejects(understand('x',{}, {env:{OPENAI_API_KEY:'private'},fetchImpl:async()=>({ok:false,status:429,json:async()=>({error:{code:'insufficient_quota',message:'secret-provider-detail'}})})}),/^Error: NLU_HTTP_429_INSUFFICIENT_QUOTA$/);
});

test('Gemma uses Google only, strips thought parts and retains structured baggage intent',async()=>{
 const d=decision();d.fields.weightKg=30;let calls=0;
 const result=await understand('بدي 30 كيلو',{request:{origin:'الشارقة',customerName:'PRIVATE_NAME'},history:[{text:'PRIVATE_HISTORY'}],selectedOffer:{customer:'PRIVATE_CUSTOMER'}},{env:{GEMINI_API_KEY:'google-private',OPENAI_API_KEY:'paid-key'},fetchImpl:async(url,options)=>{
  calls++;assert.match(url,/^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/gemma-4-26b-a4b-it:generateContent$/);assert.equal(options.headers['x-goog-api-key'],'google-private');assert.equal(options.headers.Authorization,undefined);
  const payload=JSON.parse(options.body);assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel,'minimal');assert.doesNotMatch(options.body,/PRIVATE_NAME|PRIVATE_HISTORY|PRIVATE_CUSTOMER/);
  return{ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'private thinking'},{text:'```json\n'+JSON.stringify(d)+'\n```'}]}}]})};
 }});assert.equal(result.fields.weightKg,30);assert.equal(calls,1);
});
test('explicit Gemma never falls back to paid OpenAI, including missing key and quota errors',async()=>{
 let calls=0;assert.equal(await understand('hello',{}, {env:{ASSISTANT_AI_PROVIDER:'gemma',OPENAI_API_KEY:'paid'},fetchImpl:async()=>{calls++;}}),null);assert.equal(calls,0);
 await assert.rejects(understand('hello',{}, {env:{ASSISTANT_AI_PROVIDER:'gemma',GEMINI_API_KEY:'google',OPENAI_API_KEY:'paid'},fetchImpl:async()=>{calls++;return{ok:false,status:429};}}),/NLU_HTTP_429/);assert.equal(calls,1);
});
test('Gemma rejects unapproved models, truncated output, invalid enums and credential messages',async()=>{
 const env={GEMINI_API_KEY:'google'};let calls=0;const fetchImpl=async()=>{calls++;return{ok:true,json:async()=>({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[]}}]})};};
 await assert.rejects(understand('hello',{}, {env:{...env,GEMINI_MODEL:'gemini-paid'},fetchImpl}),/NLU_MODEL_NOT_ALLOWED/);assert.equal(calls,0);
 assert.equal(await understand('كلمة المرور secret',{}, {env,fetchImpl}),null);assert.equal(calls,0);
 await assert.rejects(understand('hello',{}, {env,fetchImpl}),/NLU_INCOMPLETE/);
 const d=decision();assert.throws(()=>validateDecision({...d,fields:{...d.fields,tripType:'invented'}}),/NLU_INVALID/);const missing={...d};delete missing.question;assert.throws(()=>validateDecision(missing),/NLU_INVALID/);
});
