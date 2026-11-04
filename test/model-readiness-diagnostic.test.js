'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CASES,CLINEPASS_MODELS}=require('../src/cline-model-evaluation');
const {schema}=require('../src/consultant-brain');
const {evaluateTurn,summary,runDiagnostic,readBounded}=require('../scripts/diagnose-cline-turns');
function complete(){return {intent:'request',fields:{...Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,v])=>[k,v.type==='array'?[]:null])),origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',tripType:'one_way',adults:1,children:0,infants:0,weightKg:30},question:null,option:null,consultant:{action:'search',reply:null,preferences:{priority:null,airportFlexibility:null},nextStep:'search',knowledgeQuery:null}};}
test('single-turn diagnostic calls the real consultant path once, with one fixture, bounded redirects and no fallback or env mutation',async()=>{
 const env={CLINE_API_KEY:'synthetic-diagnostic-key',GEMINI_API_KEY:'DO_NOT_SEND',CLINE_CONSULTANT_MODEL:'unchanged'},original={...env};let calls=0;
 const result=await evaluateTurn(CLINEPASS_MODELS[0],CASES[0],{env,fetchImpl:async(url,options)=>{
  calls++;assert.equal(options.redirect,'error');assert.equal(url,'https://api.cline.bot/api/v1/chat/completions');const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content);
  assert.equal(body.model,CLINEPASS_MODELS[0]);assert.equal(input.text,CASES[0].text);assert.equal(input.todayDubai,'2026-11-01');assert.equal(input.cases,undefined);assert.doesNotMatch(options.body,/synthetic-diagnostic-key|DO_NOT_SEND/);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(complete())}}]});
 }});
 assert.equal(result.passed,10);assert.equal(result.valid,true);assert.equal(result.requests,1);assert.equal(calls,1);assert.deepEqual(env,original);assert.doesNotMatch(JSON.stringify(result),/الشارقة|synthetic-diagnostic-key|DO_NOT_SEND/);
});
test('single-turn diagnostic retains actual HTTP and sanitized failure, and refuses unknown models or fixture injection',async()=>{
 const r=await evaluateTurn(CLINEPASS_MODELS[1],CASES[0],{env:{CLINE_API_KEY:'synthetic-429'},fetchImpl:async()=>new Response('{"error":{"message":"PRIVATE_SERVER_DETAIL"}}',{status:429})});
 assert.equal(r.http,429);assert.equal(r.stop,true);assert.equal(r.valid,false);assert.equal(r.requests,1);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_SERVER_DETAIL/);
 await assert.rejects(evaluateTurn('evil',CASES[0]),/TARGET_NOT_ALLOWED/);await assert.rejects(evaluateTurn(CLINEPASS_MODELS[0],{...CASES[0]}),/TARGET_NOT_ALLOWED/);
 await assert.rejects(readBounded(new Response('x'.repeat(131073))),/RESPONSE_TOO_LARGE/);
});
test('diagnostic requires all 60 valid turns, retains outliers, and stops all models on authentication or quota failures',async()=>{
 let calls=0,report='';const models=CLINEPASS_MODELS.slice(0,2),good=async(model,c)=>{calls++;return {model,caseId:c.id,passed:10,total:10,valid:true,latencyMs:1000,http:200,requests:1,error:null};};
 const result=await runDiagnostic({models,env:{CLINE_API_KEY:'synthetic'},evaluate:good,write:s=>report=s});assert.equal(calls,120);assert.equal(result.state,'completed');assert.equal(summary(models[0],result.results).qualified,true);assert.match(report,/not a new all-model ranking/);assert.doesNotMatch(report,/synthetic-diagnostic-key/);
 assert.equal(summary(models[0],result.results.slice(0,59)).qualified,false);
 const bad=structuredClone(result.results);bad[0].valid=false;assert.equal(summary(models[0],bad).qualified,false);
 const slow=structuredClone(result.results);for(let i=0;i<4;i++)slow[i].latencyMs=15001;assert.equal(summary(models[0],slow).qualified,false);
 for(const http of [401,402,429]){calls=0;const stopped=await runDiagnostic({models,env:{CLINE_API_KEY:'synthetic'},evaluate:async(model,c)=>{calls++;return {model,caseId:c.id,passed:0,total:10,valid:false,latencyMs:1,http,requests:1,error:'NLU_HTTP_'+http};},write:()=>{}});assert.equal(calls,1);assert.equal(stopped.state,'blocked_auth_or_quota');}
 calls=0;await runDiagnostic({models,env:{},evaluate:good,write:()=>{}});assert.equal(calls,0);
});
test('silence transport probe distinguishes rejected silence from invented speech and stops at quota; it never claims WER or model approval',async()=>{
 const {runSilenceProbe}=require('../scripts/probe-voice-silence'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-silence-')),mp3=path.join(dir,'silence.mp3'),ogg=path.join(dir,'silence.ogg');fs.writeFileSync(mp3,'ID3-fixture');fs.writeFileSync(ogg,'OggS-fixture');
 try{
  let calls=0,report='';const result=await runSilenceProbe({mp3,ogg,env:{CLINE_API_KEY:'synthetic-c',GEMINI_API_KEY:'synthetic-g'},write:s=>report=s,fetchImpl:async url=>{calls++;const value={clear:calls===1,transcript:calls===1?'INVENTED SPEECH':''};return String(url).includes('cline.bot')?Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}):Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});}});
  assert.equal(calls,32);assert.equal(result.rows[0].rejectedSilence,false);assert.ok(result.rows.slice(1).every(r=>r.rejectedSilence));assert.match(report,/cannot select an audio model/);assert.doesNotMatch(report,/INVENTED SPEECH|synthetic-c|synthetic-g/);
  calls=0;const blocked=await runSilenceProbe({mp3,ogg,env:{CLINE_API_KEY:'c',GEMINI_API_KEY:'g'},write:()=>{},fetchImpl:async()=>{calls++;return new Response('{}',{status:402});}});assert.equal(calls,1);assert.equal(blocked.state,'blocked_auth_or_quota');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
