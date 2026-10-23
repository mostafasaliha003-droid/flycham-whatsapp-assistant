'use strict';
const {createHash}=require('node:crypto');
const GEMMA_MODEL='gemma-4-26b-a4b-it';
const CLINE_MODEL='cline-pass/qwen3.8-max';
const CLINE_MODELS=new Set(['cline-pass/qwen3.8-max','cline-pass/qwen3.7-max','cline-pass/qwen3.7-plus','cline-pass/glm-5.3','cline-pass/glm-5.3-flash','cline-pass/kimi-k3','cline-pass/deepseek-v4.1-flash']);
const circuits=new Map();
function aiProvider(env=process.env){return env.ASSISTANT_AI_PROVIDER||(env.CLINE_API_KEY?'cline':env.GEMINI_API_KEY?'gemma':'openai');}
function keyFor(p,env){return p==='cline'?env.CLINE_API_KEY:p==='gemma'?env.GEMINI_API_KEY:p==='openai'?env.OPENAI_API_KEY:null;}
function fallbackFor(env){return aiProvider(env)==='cline'&&env.ASSISTANT_AI_FALLBACK!=='none'?'gemma':null;}
function aiConfigured(env=process.env){return Boolean(keyFor(aiProvider(env),env)||keyFor(fallbackFor(env),env));}
function aiStatus(env=process.env){return{aiProvider:aiProvider(env),aiConfigured:aiConfigured(env),primaryConfigured:Boolean(keyFor(aiProvider(env),env)),fallbackProvider:fallbackFor(env),fallbackConfigured:Boolean(keyFor(fallbackFor(env),env))};}
function modelFor(p,env){if(p==='cline'){const model=env.CLINE_MODEL||CLINE_MODEL;if(!CLINE_MODELS.has(model))throw Error('NLU_MODEL_NOT_ALLOWED');return model;}if(p==='gemma'){if(env.GEMINI_MODEL&&env.GEMINI_MODEL!==GEMMA_MODEL)throw Error('NLU_MODEL_NOT_ALLOWED');return GEMMA_MODEL;}return env.OPENAI_MODEL||'gpt-4o-mini';}
function stateFor(p,env){const id=p+':'+createHash('sha256').update(String(keyFor(p,env))).digest('hex').slice(0,16)+':'+modelFor(p,env);if(!circuits.has(id)){if(circuits.size>=16)circuits.delete(circuits.keys().next().value);circuits.set(id,{until:0,failures:0,probing:false});}return circuits.get(id);}
function retryDelay(response,now){const raw=response.headers?.get?.('retry-after');if(raw){const ms=/^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now;if(Number.isFinite(ms)&&ms>0)return Math.min(5*3600000,Math.max(1000,ms));}return response.status===429?300000:[401,402,403,404].includes(response.status)?900000:30000;}
async function failHTTP(response,p,now){let code='';if(p==='openai'){try{code=String((await response.json())?.error?.code||'').toUpperCase().replace(/[^A-Z0-9_]/g,'').slice(0,50);}catch{}}
 const error=Error('NLU_HTTP_'+response.status+(code?'_'+code:''));error.retryMs=retryDelay(response,now);throw error;
}
function parseDecision(output,validate,schema){
 if(typeof output!=='string'||output.length>30000)throw Error('NLU_INVALID_OUTPUT');
 const text=output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1');
 let d;try{d=JSON.parse(text);}catch{throw Error('NLU_INVALID_JSON');}
 // Missing nullable extraction slots mean unchanged, never inferred travel facts.
 if(d&&typeof d==='object'&&!Array.isArray(d)&&d.fields&&typeof d.fields==='object'&&!Array.isArray(d.fields)){
  for(const [k,spec] of Object.entries(schema.properties.fields.properties)){
   if(!Object.hasOwn(d.fields,k))d.fields[k]=spec.type==='array'?[]:null;
  }
  for(const k of ['question','option'])if(!Object.hasOwn(d,k))d[k]=null;
 }
 try{return validate(d);}catch{throw Error('NLU_INVALID_SCHEMA');}
}
async function callProvider(p,{env,fetchImpl,now,input,instructions,schema,validateDecision}){
 const model=modelFor(p,env),jsonInstructions=instructions+' Output one JSON object, no markdown, no reasoning. JSON schema: '+JSON.stringify(schema);
 let url,headers,body;
 if(p==='cline'){
  url='https://api.cline.bot/api/v1/chat/completions';headers={Authorization:'Bearer '+env.CLINE_API_KEY,'Content-Type':'application/json'};
  body={model,messages:[{role:'system',content:jsonInstructions},{role:'user',content:input}],stream:false,temperature:0,max_tokens:4096};
 }else if(p==='gemma'){
  url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent';headers={'x-goog-api-key':env.GEMINI_API_KEY,'Content-Type':'application/json'};
  body={systemInstruction:{parts:[{text:jsonInstructions}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{temperature:0,maxOutputTokens:1800,thinkingConfig:{thinkingLevel:'minimal'}}};
 }else if(p==='openai'){
  url='https://api.openai.com/v1/responses';headers={Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'};
  body={model,store:false,instructions,input,max_output_tokens:1200,text:{format:{type:'json_schema',name:'travel_intent',strict:true,schema}}};
 }else throw Error('NLU_PROVIDER_NOT_ALLOWED');
 let response;try{response=await fetchImpl(url,{method:'POST',headers,signal:AbortSignal.timeout(p==='cline'?45000:20000),body:JSON.stringify(body)});}catch(error){throw Error(['TimeoutError','AbortError'].includes(error?.name)?'NLU_TIMEOUT':'NLU_NETWORK');}
 if(!response.ok)await failHTTP(response,p,now);
 const data=await response.json();let output;
 if(p==='cline'){
  const payload=data.choices?data:data.data,choice=payload?.choices?.[0];
  if(data.success===false||!choice||choice.finish_reason!=='stop'||choice.message?.refusal||choice.message?.tool_calls?.length)throw Error('NLU_INCOMPLETE');
  output=choice.message?.content;
 }else if(p==='gemma'){
  const candidate=data.candidates?.[0];if(data.promptFeedback?.blockReason||candidate?.finishReason!=='STOP')throw Error('NLU_INCOMPLETE');
  output=(candidate.content?.parts||[]).filter(x=>!x.thought&&typeof x.text==='string').map(x=>x.text).join('');
 }else{
  if(data.status!=='completed')throw Error('NLU_INCOMPLETE');output=(data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
 }
 return parseDecision(output,validateDecision,schema);
}
async function attempt(p,options){
 const state=stateFor(p,options.env),now=options.now;
 if(state.until>now||state.probing)throw Error('NLU_COOLDOWN');
 const probe=state.failures>0;if(probe)state.probing=true;
 try{const decision=await callProvider(p,options);state.failures=0;state.until=0;console.log('ASSISTANT_AI_OK_'+p.toUpperCase());return decision;}
 catch(error){state.failures++;state.until=now+(error.retryMs||30000);throw error;}
 finally{if(probe)state.probing=false;}
}
async function routeDecision(options){
 const primary=aiProvider(options.env),fallback=fallbackFor(options.env);let error;
 for(const p of [primary,fallback].filter(Boolean)){
  if(!keyFor(p,options.env))continue;
  try{return await attempt(p,p===primary?options:{...options,input:options.fallbackInput||options.input});}catch(e){error=e;console.log('ASSISTANT_AI_UNAVAILABLE_'+p.toUpperCase()+'_'+(/^NLU_[A-Z0-9_]+$/.test(e.message)?e.message:'NETWORK'));}
 }
 if(error)throw error;return null;
}
module.exports={aiProvider,aiConfigured,aiStatus,routeDecision,CLINE_MODEL,GEMMA_MODEL};
