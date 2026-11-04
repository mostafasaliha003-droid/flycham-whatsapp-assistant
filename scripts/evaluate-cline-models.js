'use strict';
// Synthetic, bounded evaluation only. Never reads customer state or changes env.
const fs=require('node:fs'),path=require('node:path');
const {CLINEPASS_MODELS,CASES,EVALUATION_POLICY,evaluateModel}=require('../src/cline-model-evaluation');
const REPORT=path.join(__dirname,'../docs/model-evaluation-2026-11.md');
function percentile(values,p){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]:null;}
function aggregate(model,runs){
 const average=runs.length?Math.round(runs.reduce((n,r)=>n+r.score,0)/runs.length*100)/100:null,minimum=runs.length?Math.min(...runs.map(r=>r.score)):null;
 const p50=percentile(runs.map(r=>r.latencyMs),.5),p95=percentile(runs.map(r=>r.latencyMs),.95),validCases=runs.reduce((n,r)=>n+(r.validCases||0),0);
 return {model,runs:runs.length,average,minimum,validCases,p50,p95,eligible:runs.length===3&&runs.every(r=>!r.error)&&average>=90&&minimum>=85&&validCases===3*CASES.length&&p95<=15000};
}
function rank(rows){return [...rows].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||(b.average??-1)-(a.average??-1)||(a.p95??Infinity)-(b.p95??Infinity));}
function renderReport({state,rows,winner,blockedHttp}){
 const n=v=>v===null?'Not measured':String(v);
 return `# Cline understanding evaluation — November 2026\n\nStatus: **${state}**${blockedHttp?' (HTTP '+blockedHttp+')':''}.\n\nPolicy: \`${EVALUATION_POLICY}\`. Synthetic cases: ${CASES.length}; required repetitions: 3 per model.\n\nNo customer data, credentials or model response text are included. No production model settings were changed.\n\n| Model | Runs | Average | Minimum | Valid cases | p50 ms | p95 ms | Qualified |\n|---|---:|---:|---:|---:|---:|---:|---|\n`+rank(rows).map(r=>`| ${r.model} | ${r.runs}/3 | ${n(r.average)} | ${n(r.minimum)} | ${r.validCases}/${3*CASES.length} | ${n(r.p50)} | ${n(r.p95)} | ${r.eligible?'Yes':'No'} |`).join('\n')+`\n\nWinner: **${winner||'none — no measured qualifying model'}**.\n\nGate: average >= 90, minimum >= 85, all schema-valid cases, p95 <= 15 seconds; higher average wins, then lower p95. Latency is measured per complete synthetic batch, not per individual customer turn. Three samples are a small readiness screen, not a production performance guarantee.\n\nRun in an authorized shell with the existing CLINE_API_KEY: \`node scripts/evaluate-cline-models.js\`. The runner stops immediately on HTTP 401, 402 or 429 and never changes CLINE_MODEL.\n\nOwner approval of the measured table is required before a production model change.\n`;
}
async function runEvaluation({env=process.env,evaluate=evaluateModel,write=text=>fs.writeFileSync(REPORT,text),progress=()=>{}}={}){
 const byModel=new Map(CLINEPASS_MODELS.map(model=>[model,[]]));let state=env.CLINE_API_KEY?'running':'blocked_missing_runtime_credentials',blockedHttp;
 const snapshot=()=>{const rows=[...byModel].map(([model,runs])=>aggregate(model,runs)),winner=state==='completed'?rank(rows).find(r=>r.eligible)?.model||null:null;const result={state,rows,winner,blockedHttp};write(renderReport(result));return result;};
 snapshot();if(!env.CLINE_API_KEY)return snapshot();
 for(const model of CLINEPASS_MODELS)for(let iteration=0;iteration<3;iteration++){
  const result=await evaluate(model,{env});byModel.get(model).push(result);progress({model,run:iteration+1,score:result.score,error:result.error||null});
  if(result.stop||[401,402,429].includes(result.http)){state='blocked_auth_or_quota';blockedHttp=result.http;return snapshot();}snapshot();
 }
 state='completed';return snapshot();
}
if(require.main===module)runEvaluation({progress:r=>console.log(JSON.stringify(r))}).then(r=>{console.log(JSON.stringify({state:r.state,winner:r.winner,report:'docs/model-evaluation-2026-11.md'}));if(r.state!=='completed')process.exitCode=2;}).catch(()=>{console.error('MODEL_EVALUATION_FAILED');process.exitCode=1;});
module.exports={percentile,aggregate,rank,renderReport,runEvaluation};
