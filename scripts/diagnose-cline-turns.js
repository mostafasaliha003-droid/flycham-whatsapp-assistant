'use strict';
// Synthetic single-turn diagnostic. Uses the real consultant path, without
// customer storage, fallback providers, model-setting changes or raw outputs.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {CLINEPASS_MODELS,CASES,EVALUATION_POLICY,scoreDecision}=require('../src/cline-model-evaluation');
const {understandConsultant,CONSULTANT_CLINE_MODEL}=require('../src/consultant-brain');
const {percentile}=require('./evaluate-cline-models');
const REPORT=path.join(__dirname,'../docs/cline-single-turn-diagnostic-2026-11.md');
const POLICY=createHash('sha256').update(EVALUATION_POLICY).update('single-turn-production-path-v1').update(fs.readFileSync(path.join(__dirname,'../src/consultant-brain.js'))).update(fs.readFileSync(path.join(__dirname,'../src/assistant-providers.js'))).digest('hex');
const DEFAULT_MODELS=Object.freeze(['cline-pass/deepseek-v4.1-flash-1017',CONSULTANT_CLINE_MODEL]);
const FIXED_TIME=Date.UTC(2026,10,1,8);
function safeError(error){return /^NLU_[A-Z0-9_]{1,80}$/.test(error?.message||'')?error.message:'REQUEST_FAILED';}
async function readBounded(response){
 let size=0;const parts=[];
 if(!response.body||typeof response.body[Symbol.asyncIterator]!=='function')throw Error('NLU_RESPONSE_STREAM_REQUIRED');
 for await(const part of response.body){size+=part.length;if(size>131072)throw Error('NLU_RESPONSE_TOO_LARGE');parts.push(Buffer.from(part));}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function evaluateTurn(model,fixture,{env=process.env,fetchImpl=fetch,understand=understandConsultant,now=Date.now,logicalNow=FIXED_TIME}={}){
 if(!CLINEPASS_MODELS.includes(model)||!CASES.some(c=>c===fixture))throw Error('DIAGNOSTIC_TARGET_NOT_ALLOWED');
 const started=now();let http=null,requests=0,stop=false;
 const wrapped=async(url,options)=>{
  if(url!=='https://api.cline.bot/api/v1/chat/completions'||stop)throw Error('NLU_DIAGNOSTIC_DESTINATION_REJECTED');
  requests++;
  const response=await fetchImpl(url,{...options,redirect:'error'});http=response.status;
  stop=[401,402,429].includes(http);
  return {ok:response.ok,status:response.status,headers:response.headers,json:()=>readBounded(response)};
 };
 try{
  const decision=await understand(fixture.text,fixture.context,{env:{CLINE_API_KEY:env.CLINE_API_KEY,ASSISTANT_AI_PROVIDER:'cline',ASSISTANT_AI_FALLBACK:'none',CLINE_CONSULTANT_MODEL:model},fetchImpl:wrapped,now:logicalNow});
  const score=scoreDecision(fixture.id,decision);
  return {model,caseId:fixture.id,latencyMs:now()-started,http,requests,stop,valid:score.valid,passed:score.passed,total:score.total,error:score.valid?null:'CONTRACT_REJECTED'};
 }catch(error){return {model,caseId:fixture.id,latencyMs:now()-started,http,requests,stop,valid:false,passed:0,total:10,error:safeError(error)};}
}
function summary(model,results){
 const rows=results.filter(r=>r.model===model),scores=[1,2,3].map(run=>{const group=rows.filter(r=>r.run===run);return group.length===CASES.length?group.reduce((n,r)=>n+r.passed,0)/(CASES.length*10)*100:null;});
 const complete=scores.every(x=>x!==null),average=complete?Math.round(scores.reduce((a,b)=>a+b,0)/3*100)/100:null,minimum=complete?Math.min(...scores):null;
 const valid=rows.filter(r=>r.valid).length,p50=percentile(rows.map(r=>r.latencyMs),.5),p95=percentile(rows.map(r=>r.latencyMs),.95);
 return {model,turns:rows.length,valid,average,minimum,p50,p95,qualified:complete&&valid===60&&rows.every(r=>!r.error)&&average>=90&&minimum>=85&&p95<=15000};
}
function render(result){
 const n=v=>v===null?'Not measured':String(v),rows=result.models.map(model=>summary(model,result.results));
 return '# Cline single-turn diagnostic — November 2026\n\nStatus: **'+result.state+'**. Policy: `'+POLICY+'`.\n\n'+
 'This is a focused diagnostic of explicitly selected models, not a new all-model ranking. The original 15-model batch report remains unchanged. Each request uses the actual consultant instructions, schema, context guide and bounded repair path. Three runs of the same 20 synthetic cases are required per selected model. Latency is measured per individual turn, including a repair when needed.\n\n'+
 '| Model | Turns | Average | Minimum | Valid | p50 ms | p95 ms | Qualified in this diagnostic |\n|---|---:|---:|---:|---:|---:|---:|---|\n'+rows.map(r=>`| ${r.model} | ${r.turns}/60 | ${n(r.average)} | ${n(r.minimum)} | ${r.valid}/60 | ${n(r.p50)} | ${n(r.p95)} | ${r.qualified?'Yes':'No'} |`).join('\n')+
 '\n\nGate unchanged: average >= 90, minimum >= 85, 60/60 valid decisions, p95 <= 15 seconds. All failures count; no timeout is silently retried or removed. This diagnostic does not authorize a production model change.\n\n| Model | Run | Case | Passed checks | Valid | Latency ms | Requests | HTTP | Error |\n|---|---:|---|---:|---|---:|---:|---:|---|\n'+result.results.map(r=>`| ${r.model} | ${r.run} | ${r.caseId} | ${r.passed}/${r.total} | ${r.valid?'Yes':'No'} | ${r.latencyMs} | ${r.requests} | ${r.http??'—'} | ${r.error||'—'} |`).join('\n')+
 '\n\nSynthetic metadata only: no keys, customer data, generated replies or model-setting writes. HTTP 401/402/429 stops the entire run immediately. Partial runs are not qualified. Owner review is required before production configuration changes.\n';
}
async function runDiagnostic({models=DEFAULT_MODELS,env=process.env,evaluate=evaluateTurn,now=Date.now,write=text=>fs.writeFileSync(REPORT,text),progress=()=>{}}={}){
 if(!Array.isArray(models)||!models.length||models.length>15||new Set(models).size!==models.length||models.some(m=>!CLINEPASS_MODELS.includes(m)))throw Error('DIAGNOSTIC_MODELS_NOT_ALLOWED');
 const result={state:env.CLINE_API_KEY?'running':'blocked_missing_credentials',models:[...models],results:[]};
 const save=()=>{write(render(result));return result;};save();if(!env.CLINE_API_KEY)return result;
 const started=now();
 for(const model of models)for(let run=1;run<=3;run++)for(const fixture of CASES){
  const row={...await evaluate(model,fixture,{env,logicalNow:FIXED_TIME+Math.max(0,now()-started)}),run};result.results.push(row);progress(row);
  if(row.stop||[401,402,429].includes(row.http)){result.state='blocked_auth_or_quota';return save();}save();
 }
 result.state='completed';return save();
}
if(require.main===module){const models=process.argv.slice(2);runDiagnostic({models:models.length?models:DEFAULT_MODELS,progress:r=>console.log(JSON.stringify(r))}).then(r=>{console.log(JSON.stringify({state:r.state,summaries:r.models.map(m=>summary(m,r.results))}));if(r.state!=='completed')process.exitCode=2;}).catch(()=>{console.error('SINGLE_TURN_DIAGNOSTIC_FAILED');process.exitCode=1;});}
module.exports={POLICY,DEFAULT_MODELS,evaluateTurn,summary,render,runDiagnostic,readBounded};
