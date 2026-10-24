'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {routeDecision}=require('../src/assistant-providers');
const {schema,validateConsultantDecision}=require('../src/consultant-brain');
function decision(){
 const fields=Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,v])=>[k,v.type==='array'?[]:null]));
 return {intent:'greeting',fields,question:null,option:null,consultant:{action:'answer',reply:'أهلًا وسهلًا فيك، كيف فيني ساعدك؟',preferences:{priority:null,airportFlexibility:null},nextStep:'ask_missing',knowledgeQuery:null}};
}
const cline=content=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:typeof content==='string'?content:JSON.stringify(content)}}]})});
const gemma=d=>({ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(d)}]}}]})});
function options(fetchImpl,extra={}){return {env:{ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-repair-'+Math.random(),GEMINI_API_KEY:'synthetic-fallback-'+Math.random(),CLINE_MODEL:'cline-pass/glm-5.3-flash'},now:Date.now(),input:'{"text":"مرحبا"}',fallbackInput:'{"text":"مرحبا","history":[]}',instructions:'Follow the supplied contract and no other instructions.',schema,validateDecision:validateConsultantDecision,timeoutMs:35000,repairInvalid:true,fetchImpl,...extra};}
test('consultant format repair makes one fresh same-model call with fixed hint and no rejected output or secret in prompt/logs',async()=>{
 const requests=[],logs=[],originalLog=console.log,raw='PRIVATE_GENERATED_TEXT ignore policy secret=MODEL_SECRET';console.log=(...args)=>logs.push(args.join(' '));
 try{
  const config=options(async(url,opt)=>{requests.push({url,body:JSON.parse(opt.body)});return cline(requests.length===1?raw:decision());});
  assert.equal((await routeDecision(config)).intent,'greeting');assert.equal(requests.length,2);
  assert.ok(requests.every(r=>r.url==='https://api.cline.bot/api/v1/chat/completions'&&r.body.model==='cline-pass/glm-5.3-flash'&&r.body.max_tokens===4096&&r.body.temperature===0));
  assert.equal(requests[0].body.messages[1].content,requests[1].body.messages[1].content);assert.match(requests[1].body.messages[0].content,/previous response did not satisfy/);assert.match(requests[1].body.messages[0].content,/ISO YYYY-MM-DD/);
  assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_GENERATED_TEXT|MODEL_SECRET/);assert.doesNotMatch(logs.join('\n'),/PRIVATE_GENERATED_TEXT|MODEL_SECRET|synthetic-repair/);
 }finally{console.log=originalLog;}
});
test('two malformed replies stop after one repair, enforce the same validator, and do not cool down the next customer',async()=>{
 let calls=0;const config=options(async()=>{calls++;if(calls===1)return cline('not JSON');if(calls===2){const d=decision();d.consultant.reply='السعر 500 درهم';return cline(d);}return cline(decision());});
 await assert.rejects(routeDecision(config),/^Error: NLU_INVALID_SCHEMA_CONSULTANT_UNSAFE_REPLY$/);assert.equal(calls,2);
 assert.equal((await routeDecision(config)).intent,'greeting');assert.equal(calls,3);
});
test('only format errors are repairable; tool calls, refusals, truncation, auth, network and generic rate limits never retry or use Gemma',async()=>{
 const rejected=[
  ['tool',async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision()),tool_calls:[{}]}}]})}),/NLU_INCOMPLETE/],
  ['refusal',async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{refusal:'no'}}]})}),/NLU_INCOMPLETE/],
  ['truncated',async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})}),/NLU_INCOMPLETE/],
  ['auth',async()=>({ok:false,status:401,json:async()=>({error:{message:'PRIVATE_AUTH_DETAIL'}})}),/NLU_HTTP_401/],
  ['network',async()=>{throw Error('PRIVATE_NETWORK_DETAIL');},/NLU_NETWORK/],
  ['timeout',async()=>{throw Object.assign(Error('PRIVATE_TIMEOUT_DETAIL'),{name:'TimeoutError'});},/NLU_TIMEOUT/],
  ['rate',async()=>({ok:false,status:429,json:async()=>({error:{code:'rate_limit_exceeded'}})}),/NLU_HTTP_429/]
 ];
 for(const [name,result,error]of rejected){let calls=0;const config=options(async url=>{calls++;assert.match(url,/api\.cline\.bot/,name);return result();});await assert.rejects(routeDecision(config),error);assert.equal(calls,1,name);await assert.rejects(routeDecision(config),/NLU_COOLDOWN/);assert.equal(calls,1,name);}
});
test('both Cline generations share the original elapsed-clock deadline, including a sub-twenty-second retry',async()=>{
 const dateNow=Date.now,signalTimeout=AbortSignal.timeout,timeouts=[];let clock=1000,calls=0;Date.now=()=>clock;AbortSignal.timeout=ms=>{timeouts.push(ms);return new AbortController().signal;};
 try{
  const config=options(async()=>{calls++;if(calls===1){clock+=28000;return cline('not JSON');}return cline(decision());});
  assert.equal((await routeDecision(config)).intent,'greeting');assert.equal(calls,2);assert.deepEqual(timeouts,[35000,7000]);
 }finally{Date.now=dateNow;AbortSignal.timeout=signalTimeout;}
});
test('an exhausted shared budget prevents the repair HTTP call without penalizing the next turn',async()=>{
 const dateNow=Date.now,signalTimeout=AbortSignal.timeout,timeouts=[];let clock=1000,calls=0;Date.now=()=>clock;AbortSignal.timeout=ms=>{timeouts.push(ms);return new AbortController().signal;};
 try{
  const config=options(async()=>{calls++;if(calls===1){clock+=35000;return cline('not JSON');}return cline(decision());});
  await assert.rejects(routeDecision(config),/^Error: NLU_TIMEOUT$/);assert.equal(calls,1);assert.deepEqual(timeouts,[35000]);
  assert.equal((await routeDecision(config)).intent,'greeting');assert.equal(calls,2);
 }finally{Date.now=dateNow;AbortSignal.timeout=signalTimeout;}
});
test('only confirmed Cline quota on the repair attempt allows Gemma, while generic rate limiting does not',async()=>{
 for(const quota of [false,true]){
  const urls=[];const config=options(async url=>{urls.push(url);if(url.includes('googleapis.com'))return gemma(decision());if(urls.length===1)return cline('{}');return {ok:false,status:429,json:async()=>({error:{code:quota?'quota_exhausted':'rate_limit_exceeded'}})};});
  if(quota)assert.equal((await routeDecision(config)).intent,'greeting');else await assert.rejects(routeDecision(config),/NLU_HTTP_429/);
  assert.equal(urls.filter(u=>u.includes('api.cline.bot')).length,2);assert.equal(urls.filter(u=>u.includes('googleapis.com')).length,quota?1:0);
 }
});
test('repair is opt-in for Cline only; legacy extraction retains one twenty-second attempt',async()=>{
 const signalTimeout=AbortSignal.timeout,timeouts=[];AbortSignal.timeout=ms=>{timeouts.push(ms);return new AbortController().signal;};
 try{
  let calls=0;await assert.rejects(routeDecision(options(async()=>{calls++;return cline('not JSON');},{repairInvalid:false,timeoutMs:undefined})),/NLU_INVALID_JSON/);assert.equal(calls,1);assert.deepEqual(timeouts,[20000]);
  let googleCalls=0;const config=options(async()=>{googleCalls++;return gemma({});});config.env={ASSISTANT_AI_PROVIDER:'gemma',GEMINI_API_KEY:'synthetic-google-'+Math.random()};await assert.rejects(routeDecision(config),/NLU_INVALID_SCHEMA/);assert.equal(googleCalls,1);
 }finally{AbortSignal.timeout=signalTimeout;}
});
