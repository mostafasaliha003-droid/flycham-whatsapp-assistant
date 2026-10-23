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
 const env={GEMINI_API_KEY:'google-validation'};let calls=0;const fetchImpl=async()=>{calls++;return{ok:true,json:async()=>({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[]}}]})};};
 await assert.rejects(understand('hello',{}, {env:{...env,GEMINI_MODEL:'gemini-paid'},fetchImpl}),/NLU_MODEL_NOT_ALLOWED/);assert.equal(calls,0);
 assert.equal(await understand('كلمة المرور secret',{}, {env,fetchImpl}),null);assert.equal(calls,0);
 await assert.rejects(understand('hello',{}, {env,fetchImpl}),/NLU_INCOMPLETE/);
 const d=decision();assert.throws(()=>validateDecision({...d,fields:{...d.fields,tripType:'invented'}}),/NLU_INVALID/);const missing={...d};delete missing.question;assert.throws(()=>validateDecision(missing),/NLU_INVALID/);
});

const clineResponse=d=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]})});
const googleResponse=d=>({ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(d)}]}}]})});
test('ClinePass receives nested trip facts and redacted context using subscription model only',async()=>{
 const d=decision();d.fields.weightKg=30;
 const result=await understand('اسمي سامر، بدي ثلاثين كيلو',{request:{origin:'الشارقة',departureRange:{start:'2026-10-24',end:'2026-10-30'},passengers:{adults:1},baggageRequest:{checkedWeightKg:20},customerName:'PRIVATE_PROFILE'},history:[{role:'user',text:'بدي نفس الأيام'}]},{env:{CLINE_API_KEY:'cline-context'},fetchImpl:async(url,options)=>{
  assert.equal(url,'https://api.cline.bot/api/v1/chat/completions');const body=JSON.parse(options.body);assert.equal(body.model,'cline-pass/qwen3.8-max');assert.equal(body.stream,false);assert.equal(options.headers.Authorization,'Bearer cline-context');
  const input=JSON.parse(body.messages[1].content);assert.equal(input.context.request.passengers.adults,1);assert.equal(input.context.request.baggageRequest.checkedWeightKg,20);assert.equal(input.context.request.departureRange.end,'2026-10-30');assert.equal(input.context.history.length,1);assert.doesNotMatch(options.body,/سامر|PRIVATE_PROFILE/);return clineResponse(d);
 }});assert.equal(result.fields.weightKg,30);
});
test('quota rejection switches to Gemma, honors cooldown, and probes Cline again after Retry-After',async()=>{
 const env={ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'cline-quota',GEMINI_API_KEY:'google-quota',OPENAI_API_KEY:'paid'};const now=Date.now(),urls=[];let recovered=false;
 const fetchImpl=async(url,options)=>{urls.push(url);if(url.includes('api.cline.bot'))return recovered?clineResponse(decision()):{ok:false,status:429,headers:{get:()=> '60'}};const data=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);assert.deepEqual(data.context.history,[]);return googleResponse(decision());};
 const context={history:[{role:'user',text:'TRAVEL_HISTORY'}]};
 await understand('بدي ثلاثين كيلو',context,{env,now,fetchImpl});assert.equal(urls.length,2);
 await understand('بدي نفس الأيام',context,{env,now:now+1000,fetchImpl});assert.equal(urls.filter(u=>u.includes('api.cline.bot')).length,1);
 recovered=true;await understand('نفس الطلب',context,{env,now:now+61000,fetchImpl});assert.equal(urls.filter(u=>u.includes('api.cline.bot')).length,2);assert.equal(urls.some(u=>u.includes('api.openai.com')),false);
});
test('Cline quota HTTP response need not have JSON; no quota duration is inferred from the error text',async()=>{
 const env={CLINE_API_KEY:'cline-htmlquota',GEMINI_API_KEY:'google-htmlquota'};let calls=0;
 const d=await understand('نفس الأيام',{}, {env,fetchImpl:async url=>{calls++;return url.includes('api.cline.bot')?{ok:false,status:429}:googleResponse(decision());}});assert.equal(d.intent,'change');assert.equal(calls,2);
});
test('missing Cline key uses configured Gemma but never an existing paid key',async()=>{
 const env={ASSISTANT_AI_PROVIDER:'cline',GEMINI_API_KEY:'google-missingprimary',OPENAI_API_KEY:'paid'};
 await understand('نفس الأيام',{}, {env,fetchImpl:async url=>{assert.match(url,/generativelanguage.googleapis.com/);return googleResponse(decision());}});
 assert.equal(await understand('x',{}, {env:{ASSISTANT_AI_PROVIDER:'cline',OPENAI_API_KEY:'paid'}}),null);
});
test('usage billing model cannot be requested even with a valid Cline key',async()=>{
 let called=false;await assert.rejects(understand('x',{}, {env:{CLINE_API_KEY:'cline-badmodel',CLINE_MODEL:'anthropic/claude-sonnet-4-6'},fetchImpl:async()=>{called=true;}}),/NLU_MODEL_NOT_ALLOWED/);assert.equal(called,false);
});
test('nested Cline response is accepted while refusal, tool calls and truncated output are rejected',async()=>{
 const d=decision();assert.equal((await understand('x',{}, {env:{CLINE_API_KEY:'cline-nested'},fetchImpl:async()=>({ok:true,json:async()=>({success:true,data:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]}})})})).intent,'change');
 for(const [suffix,body]of [['failure',{success:false,choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]}],['length',{choices:[{finish_reason:'length',message:{content:JSON.stringify(d)}}]}],['tool',{choices:[{finish_reason:'stop',message:{content:JSON.stringify(d),tool_calls:[{}]}}]}]])await assert.rejects(understand('x',{}, {env:{CLINE_API_KEY:'cline-'+suffix},fetchImpl:async()=>({ok:true,json:async()=>body})}),/NLU_INCOMPLETE/);
});
test('both providers unavailable use bounded attempts and expose no raw provider secrets',async()=>{
 const env={CLINE_API_KEY:'cline-bothfail',GEMINI_API_KEY:'google-bothfail',OPENAI_API_KEY:'paid'};let calls=0;
 await assert.rejects(understand('بدي ثلاثين كيلو',{}, {env,fetchImpl:async()=>{calls++;return{ok:false,status:503,json:async()=>({error:{message:'DO_NOT_LOG'}})};}}),/^Error: NLU_HTTP_503$/);assert.equal(calls,2);
});
test('after cooldown only one concurrent probe hits Cline while other requests use Gemma',async()=>{
 const env={CLINE_API_KEY:'cline-concurrent',GEMINI_API_KEY:'google-concurrent'},now=Date.now();
 await understand('x',{}, {env,now,fetchImpl:async url=>url.includes('api.cline.bot')?{ok:false,status:429,headers:{get:()=> '1'}}:googleResponse(decision())});
 let release,calls=0;const gate=new Promise(r=>release=r);const fetchImpl=async url=>{if(url.includes('api.cline.bot')){calls++;await gate;return clineResponse(decision());}return googleResponse(decision());};
 const a=understand('x',{}, {env,now:now+1100,fetchImpl});const b=understand('y',{}, {env,now:now+1100,fetchImpl});await b;release();await a;assert.equal(calls,1);
});

test('privacy minimization preserves dates, weights and offer rankings while removing contact identifiers',()=>{
 const {safeContext}=require('../src/assistant-nlu');const context=safeContext({request:{departureDate:'2026-10-24',departureRange:{start:'2026-10-24',end:'2026-10-30'},baggageRequest:{checkedWeightKg:30}},lastQuestion:'بـ 24-10-2026 أو 25-10-2026؟',history:[{role:'user',text:'رقمي +971544908485 وبريدي user@example.com'}],offerSummaries:[{reference:2,departureDate:'2026-10-25',departureTime:'08:30',cheapestRank:1,customer:'PRIVATE'}]},true);
 assert.equal(context.request.departureDate,'2026-10-24');assert.equal(context.request.departureRange.end,'2026-10-30');assert.equal(context.request.baggageRequest.checkedWeightKg,30);assert.equal(context.offerSummaries[0].cheapestRank,1);assert.equal(context.offerSummaries[0].departureTime,'08:30');assert.match(context.lastQuestion,/24-10-2026/);assert.doesNotMatch(JSON.stringify(context),/971544908485|user@example.com|PRIVATE/);
});
test('NLU instructions do not share internal commission amounts with providers',async()=>{
 await understand('hello',{}, {env:{CLINE_API_KEY:'cline-no-margin'},fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);assert.doesNotMatch(body.messages[0].content,/ticketMarginAED|extraWeightMarginAED|paidSeatMarginAED|paidMealMarginAED/);return clineResponse(decision());}});
});

test('sparse extraction fills unchanged slots but never invents trip facts',async()=>{
 const d=await understand('ثلاثين كيلو',{}, {env:{GEMINI_API_KEY:'sparse-safe'},fetchImpl:async()=>googleResponse({intent:'change',fields:{weightKg:30}})});
 assert.equal(d.fields.weightKg,30);assert.equal(d.fields.adults,null);assert.equal(d.fields.tripType,null);assert.deepEqual(d.fields.ages,[]);assert.equal(d.question,null);
 for(const [key,value] of [['price',100],['tripType','invented']]){
  await assert.rejects(understand('x',{}, {env:{GEMINI_API_KEY:'sparse-invalid-'+key},fetchImpl:async()=>googleResponse({intent:'change',fields:{[key]:value}})}),/NLU_INVALID_SCHEMA/);
 }
});
test('provider timeout has a safe diagnostic and falls back without leaking exception text',async()=>{
 let calls=0;
 const d=await understand('مرحبا',{}, {env:{CLINE_API_KEY:'timeout-safe',GEMINI_API_KEY:'timeout-fallback'},fetchImpl:async url=>{
  calls++;if(url.includes('api.cline.bot'))throw Object.assign(Error('PRIVATE_NETWORK_DETAIL'),{name:'TimeoutError'});return googleResponse(decision());
 }});assert.equal(calls,2);assert.equal(d.intent,'change');
});
