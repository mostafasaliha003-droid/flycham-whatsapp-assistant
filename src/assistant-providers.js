'use strict';
const {createHash}=require('node:crypto');
const GEMMA_MODEL='gemma-4-26b-a4b-it';
const CLINE_MODEL='cline-pass/qwen3.8-max';
const CLINE_MODELS=new Set(['cline-pass/qwen3.8-max','cline-pass/qwen3.7-max','cline-pass/qwen3.7-plus','cline-pass/glm-5.3','cline-pass/glm-5.3-flash','cline-pass/kimi-k3','cline-pass/deepseek-v4.1-flash']);
const REPAIR_HINT='The previous response did not satisfy the JSON/schema contract. Generate a fresh decision for the original input. Return exactly one JSON object matching the supplied schema, without markdown, commentary or extra keys. Dates must be ISO YYYY-MM-DD in date fields only. Use null for unchanged nullable fields and arrays for array fields. Keep action and intent compatible; operational replies and complete-search questions must be null. Do not invent facts or repeat a known question.';
const circuits=new Map();
function clineBudget(timeoutMs){return Number.isFinite(timeoutMs)?Math.max(20000,Math.min(35000,Math.trunc(timeoutMs))):20000;}
function invalidDecision(error){return /^NLU_INVALID_(?:JSON|OUTPUT|SCHEMA(?:_[A-Z0-9_]+)?)$/.test(error?.message||'');}
function aiProvider(env=process.env){return env.ASSISTANT_AI_PROVIDER||(env.CLINE_API_KEY?'cline':env.GEMINI_API_KEY?'gemma':'openai');}
function keyFor(p,env){return p==='cline'?env.CLINE_API_KEY:p==='gemma'?env.GEMINI_API_KEY:p==='openai'?env.OPENAI_API_KEY:null;}
function fallbackFor(env){return aiProvider(env)==='cline'&&env.ASSISTANT_AI_FALLBACK!=='none'?'gemma':null;}
function aiConfigured(env=process.env){return Boolean(keyFor(aiProvider(env),env));}
function aiStatus(env=process.env){return{aiProvider:aiProvider(env),aiConfigured:aiConfigured(env),primaryConfigured:Boolean(keyFor(aiProvider(env),env)),fallbackProvider:fallbackFor(env),fallbackConfigured:Boolean(keyFor(fallbackFor(env),env)),fallbackMode:aiProvider(env)==='cline'?'quota_only':null};}
function modelFor(p,env){if(p==='cline'){const model=env.CLINE_MODEL||CLINE_MODEL;if(!CLINE_MODELS.has(model))throw Error('NLU_MODEL_NOT_ALLOWED');return model;}if(p==='gemma'){if(env.GEMINI_MODEL&&env.GEMINI_MODEL!==GEMMA_MODEL)throw Error('NLU_MODEL_NOT_ALLOWED');return GEMMA_MODEL;}return env.OPENAI_MODEL||'gpt-4o-mini';}
function stateFor(p,env){const id=p+':'+createHash('sha256').update(String(keyFor(p,env))).digest('hex').slice(0,16)+':'+modelFor(p,env);if(!circuits.has(id)){if(circuits.size>=16)circuits.delete(circuits.keys().next().value);circuits.set(id,{until:0,failures:0,probing:false,quotaExhausted:false});}return circuits.get(id);}
function retryDelay(response,now){const raw=response.headers?.get?.('retry-after');if(raw){const ms=/^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now;if(Number.isFinite(ms)&&ms>0)return Math.min(5*3600000,Math.max(1000,ms));}return response.status===429?300000:[401,402,403,404].includes(response.status)?900000:30000;}
async function failHTTP(response,p,now){
 let code='',quotaExhausted=false;
 try{
  const data=await response.json();
  if(p==='openai')code=String(data?.error?.code||'').toUpperCase().replace(/[^A-Z0-9_]/g,'').slice(0,50);
  if(p==='cline'&&[402,429].includes(response.status)){
   const errorCode=String(data?.error?.code||data?.code||'').toLowerCase();
   const message=String(data?.error?.message||data?.message||(typeof data?.error==='string'?data.error:'')).slice(0,2000).toLowerCase();
   quotaExhausted=['insufficient_quota','quota_exceeded','quota_exhausted','usage_limit_reached','subscription_limit_reached','credits_exhausted','plan_limit_exceeded'].includes(errorCode)||
    /(?:quota|credits?|(?:five|5)[ -]?hour(?:ly)?(?: usage)? limit|weekly (?:usage )?limit|monthly (?:usage )?limit|subscription (?:usage )?limit|clinepass (?:usage )?limit).{0,70}(?:exhausted|exceeded|depleted|reached|used up)|(?:exhausted|exceeded|depleted|reached|used up).{0,70}(?:quota|credits?|usage (?:cap|limit))/.test(message);
  }
 }catch{}
 const error=Error('NLU_HTTP_'+response.status+(code?'_'+code:''));
 error.retryMs=retryDelay(response,now);error.quotaExhausted=quotaExhausted;throw error;
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
 try{return validate(d);}catch(error){
  // Fixed validation classifications only; never log the generated text or
  // customer fields. This distinguishes a rejected claim from bad structure.
  const allowed=new Set(['CONSULTANT_INVALID','CONSULTANT_INVALID_PREFERENCES','CONSULTANT_UNSAFE_REPLY','CONSULTANT_INVALID_QUERY','CONSULTANT_INVALID_ACTION','CONSULTANT_ACTION_INTENT_MISMATCH','CONSULTANT_CLARIFICATION_REQUIRED','CONSULTANT_QUESTION_MISMATCH']);
  throw Error('NLU_INVALID_SCHEMA'+(allowed.has(error?.message)?'_'+error.message:''));
 }
}
async function callProvider(p,{env,fetchImpl,now,input,instructions,schema,validateDecision,timeoutMs=20000,remainingMs}){
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
 // Only an explicit application-side consultant option may extend Cline's
 // request budget. Legacy extraction and other providers retain twenty seconds.
 const requestTimeout=p==='cline'?(Number.isFinite(remainingMs)?Math.max(1,Math.min(35000,Math.trunc(remainingMs))):clineBudget(timeoutMs)):20000;
 let response;try{response=await fetchImpl(url,{method:'POST',headers,signal:AbortSignal.timeout(requestTimeout),body:JSON.stringify(body)});}catch(error){throw Error(['TimeoutError','AbortError'].includes(error?.name)?'NLU_TIMEOUT':'NLU_NETWORK');}
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
 if(state.until>now||state.probing){const error=Error('NLU_COOLDOWN');error.quotaExhausted=state.quotaExhausted;throw error;}
 const probe=state.failures>0;if(probe)state.probing=true;
 const repair=p==='cline'&&options.repairInvalid===true,startedAt=Date.now(),budget=clineBudget(options.timeoutMs);
 const generate=async repairing=>{
  if(!repair)return callProvider(p,options);
  const remainingMs=budget-Math.max(0,Date.now()-startedAt);
  if(remainingMs<=0){const error=Error('NLU_TIMEOUT');error.turnBudgetExhausted=true;throw error;}
  return callProvider(p,{...options,remainingMs,instructions:options.instructions+(repairing?' '+REPAIR_HINT:'')});
 };
 try{
  let decision;
  try{decision=await generate(false);}
  catch(error){
   if(!repair||!invalidDecision(error))throw error;
   console.log('ASSISTANT_AI_REPAIR_CLINE');
   decision=await generate(true);
  }
  state.failures=0;state.until=0;state.quotaExhausted=false;console.log('ASSISTANT_AI_OK_'+p.toUpperCase());return decision;
 }
 catch(error){
  // A rejected turn is not evidence of a provider outage. Other customers
  // may try immediately; real transport/auth/quota failures still open the
  // existing circuit. Exhausting the shared turn budget before a retry also
  // requires no provider-wide penalty.
  if(!(repair&&(invalidDecision(error)||error.turnBudgetExhausted===true))){state.failures++;state.quotaExhausted=error.quotaExhausted===true;state.until=now+(error.retryMs||(error.message==='NLU_TIMEOUT'?3000:30000));}
  throw error;
 }
 finally{if(probe)state.probing=false;}
}
async function routeDecision(options){
 const primary=aiProvider(options.env),fallback=fallbackFor(options.env);
 if(!keyFor(primary,options.env))return null;
 try{return await attempt(primary,options);}
 catch(error){
  console.log('ASSISTANT_AI_UNAVAILABLE_'+primary.toUpperCase()+'_'+(/^NLU_[A-Z0-9_]+$/.test(error.message)?error.message:'NETWORK'));
  // Only explicit Cline quota exhaustion authorizes Gemma, never latency,
  // malformed replies, authentication problems or generic rate limiting.
  if(primary==='cline'&&fallback&&keyFor(fallback,options.env)&&error.quotaExhausted===true){
   console.log('ASSISTANT_AI_FALLBACK_QUOTA_CONFIRMED');
   try{return await attempt(fallback,{...options,input:options.fallbackInput||options.input});}
   catch(fallbackError){console.log('ASSISTANT_AI_UNAVAILABLE_'+fallback.toUpperCase()+'_'+(/^NLU_[A-Z0-9_]+$/.test(fallbackError.message)?fallbackError.message:'NETWORK'));throw fallbackError;}
  }
  throw error;
 }
}
module.exports={aiProvider,aiConfigured,aiStatus,routeDecision,CLINE_MODEL,GEMMA_MODEL};
