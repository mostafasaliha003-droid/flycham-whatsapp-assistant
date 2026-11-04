'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CLINEPASS_MODELS,CASES,scoreOutput,evaluateModel,runClineModelEvaluation,EVALUATION_POLICY}=require('../src/cline-model-evaluation');
const {schema}=require('../src/consultant-brain');
function decision(){return{intent:'other',fields:Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,s])=>[k,s.type==='array'?[]:null])),question:null,option:null,consultant:{action:'answer',reply:null,preferences:{priority:null,airportFlexibility:null},nextStep:'none',knowledgeQuery:null}};}
function golden(){return{decisions:CASES.map(c=>{const d=decision();if(c.id==='complete_trip'){d.intent='request';d.consultant.action='search';d.consultant.nextStep='search';Object.assign(d.fields,{origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',tripType:'one_way',adults:1,children:0,infants:0,weightKg:30});}if(c.id==='preserve_week'){d.intent='change';d.consultant.action='amend';d.consultant.nextStep='search';d.fields.weightKg=30;}if(c.id==='inquiry_not_selection'){d.intent='compare';d.consultant.action='compare';d.consultant.nextStep='compare_options';}if(c.id==='price_objection'){d.intent='negotiate';d.consultant.reply='خلّينا نشوف بدائل بالمطار أو الوزن، والتواريخ منخلّيها متل ما طلبت.';}if(c.id==='knowledge_routing'){d.intent='explain';d.consultant.action='knowledge';d.consultant.nextStep='research';d.consultant.knowledgeQuery='متطلبات دخول تايلند للمقيمين في الإمارات';}if(c.id==='waiting_context'){d.intent='status';d.consultant.action='status';d.consultant.reply='عم نقارن الخيارات المناسبة، وبنخبرك لما تتأكد النتيجة.';}const additions={gulf_family:['request','clarify',{origin:'الشارقة',destination:'حلب',adults:2,children:0,infants:0},'إيمتى حابب تسافر؟'],egyptian_solo:['request','clarify',{destination:'دمشق',departureDate:'2026-11-02',adults:1,children:0,infants:0,weightKg:0},'من أي مدينة حابب تسافر؟'],iraqi_family:['request','clarify',{destination:'دمشق',adults:2,children:0,infants:0},'من أي مدينة حابب تسافر؟'],partial_round_trip:['change','amend',{tripType:'round_trip'}],advice_during_search:['explain','answer',{}],frustrated_request:['change','amend',{weightKg:30}],urgent_request:['change','amend',{departureDate:'2026-11-02'}],sarcasm_not_booking:['negotiate','answer',{}],indic_digits:['request','search',{origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',tripType:'one_way',adults:3,children:0,infants:0,weightKg:30}],first_friday_next_month:['change','amend',{departureDate:'2026-12-04'}],child_age:['request','search',{origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',tripType:'one_way',adults:1,children:1,infants:0,ages:[7]}],explicit_rejection:['explain','answer',{}],payment_question:['explain','answer',{}],delete_data:['cancel','cancel',{}]};const e=additions[c.id];if(e){d.intent=e[0];d.consultant.action=e[1];Object.assign(d.fields,e[2]);d.question=e[3]||null;}
return{id:c.id,decision:d};})};}
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(golden())}}]});
const env={CLINE_MODEL_EVALUATION_ENABLED:'true',CLINE_API_KEY:'synthetic-evaluation-secret'};
test('rubric distinguishes correct Arabic context decisions from collapsed weeks, accidental selections and invented booking claims',()=>{
 const original=golden();assert.equal(scoreOutput(JSON.stringify(original)).score,100);
 const week=golden();week.decisions[1].decision.fields.departureDate='2026-12-07';assert.ok(scoreOutput(JSON.stringify(week)).score<100);
 const select=golden();select.decisions[2].decision.intent='select';select.decisions[2].decision.option=2;select.decisions[2].decision.consultant.action='answer';assert.ok(scoreOutput(JSON.stringify(select)).score<100);
 const lie=golden();lie.decisions[3].decision.consultant.reply='تم الحجز والسعر مضمون';assert.equal(scoreOutput(JSON.stringify(lie)).validCases,CASES.length-1);
 assert.equal(scoreOutput('{').score,0);
 const duplicate=golden();duplicate.decisions[5].id=duplicate.decisions[0].id;assert.equal(scoreOutput(JSON.stringify(duplicate)).error,'INVALID_BATCH');
});
test('model evaluation accepts exact subscription IDs only and sends fixed synthetic cases without customer state',async()=>{
 assert.equal(CLINEPASS_MODELS.length,15);assert.equal(Object.isFrozen(CLINEPASS_MODELS),true);
 let calls=0;const fetchImpl=async(url,options)=>{calls++;assert.equal(url,'https://api.cline.bot/api/v1/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Response-Format'],'openai');const body=JSON.parse(options.body);assert.equal(body.model,'cline-pass/kimi-k3.1-pro');assert.equal(body.messages.length,2);assert.equal(JSON.parse(body.messages[1].content).cases.length,CASES.length);assert.equal(options.body.includes(env.CLINE_API_KEY),false);assert.equal(Object.hasOwn(body,'tools'),false);return response();};
 const result=await evaluateModel('cline-pass/kimi-k3.1-pro',{env,fetchImpl});assert.equal(result.score,100);assert.equal(result.validCases,CASES.length);assert.equal(calls,1);
 await assert.rejects(evaluateModel('anthropic/claude-sonnet-4-6',{env,fetchImpl}),/EVALUATION_MODEL_NOT_ALLOWED/);assert.equal(calls,1);
});
test('checkpointed evaluation dispatches at most once per model and cached completion never replays provider calls',async()=>{
 const store={data:{},save(){}},logs=[];let calls=0;
 const fetchImpl=async(url,options)=>{const model=JSON.parse(options.body).model;assert.equal(store.data.clineModelEvaluation.results[model].state,'running');calls++;return response();};
 const options={store,env,fetchImpl,report:(kind,data)=>logs.push({kind,data})};
 const first=await runClineModelEvaluation(options);assert.equal(calls,15);assert.equal(first.results.length,15);assert.ok(first.results.every(r=>r.score===100));
 await runClineModelEvaluation(options);assert.equal(calls,15);assert.equal(JSON.stringify(logs).includes(env.CLINE_API_KEY),false);
});
test('quota rejection stops the batch and restarts do not spend more quota; unsaved intent never dispatches',async()=>{
 let calls=0;const store={data:{},save(){}},options={store,env,fetchImpl:async()=>{calls++;return new Response('{}',{status:429});},report:()=>{}};
 const result=await runClineModelEvaluation(options);assert.equal(result.state,'quota_or_auth_blocked');assert.equal(calls,1);await runClineModelEvaluation(options);assert.equal(calls,1);
 await assert.rejects(runClineModelEvaluation({...options,store:{data:{},save(){throw Error('SAVE_FAILED');}}}),/SAVE_FAILED/);assert.equal(calls,1);
 await runClineModelEvaluation({...options,env:{...env,CLINE_MODEL_EVALUATION_ENABLED:'false'}});assert.equal(calls,1);
});
test('interrupted dispatch is retained without replay while untouched models can complete',async()=>{
 let calls=0;const store={data:{clineModelEvaluation:{policy:EVALUATION_POLICY,state:'running',results:{[CLINEPASS_MODELS[0]]:{model:CLINEPASS_MODELS[0],state:'running'}}}},save(){}};
 const result=await runClineModelEvaluation({store,env,fetchImpl:async()=>{calls++;return response();},report:()=>{}});assert.equal(calls,14);assert.equal(result.results.length,14);assert.equal(store.data.clineModelEvaluation.results[CLINEPASS_MODELS[0]].state,'running');
});

test('expanded rubric rejects invented route/date/party, accidental selection and unsafe action for each new case',()=>{
 const original=golden();assert.equal(CASES.length,20);
 for(const entry of original.decisions.slice(6)){
  for(const corrupt of [d=>d.option=1,d=>d.fields.destination='القاهرة',d=>d.fields.departureDate='2026-11-30',d=>d.fields.adults=8]){
   const batch=structuredClone(original),changed=batch.decisions.find(x=>x.id===entry.id);corrupt(changed.decision);assert.ok(scoreOutput(JSON.stringify(batch)).score<100,entry.id);
  }
 }
});
test('three-run evaluation reports thresholds and ties, and stops on the first auth/quota response',async()=>{
 const {runEvaluation,aggregate,rank}=require('../scripts/evaluate-cline-models');let calls=0,report='';
 const result=await runEvaluation({env:{CLINE_API_KEY:'synthetic-key'},evaluate:async model=>{calls++;return {model,score:95,validCases:CASES.length,latencyMs:5000};},write:s=>report=s});
 assert.equal(calls,CLINEPASS_MODELS.length*3);assert.equal(result.state,'completed');assert.ok(result.winner);assert.equal(result.rows[0].runs,3);assert.doesNotMatch(report,/synthetic-key/);
 const samples=[{score:95,validCases:20,latencyMs:1000},{score:95,validCases:20,latencyMs:2000},{score:84,validCases:20,latencyMs:4000}];assert.equal(aggregate('test',samples).eligible,false);samples[2].score=90;samples[2].latencyMs=15001;assert.equal(aggregate('test',samples).eligible,false);
 assert.equal(rank([{model:'slow',eligible:true,average:95,p95:9000},{model:'fast',eligible:true,average:95,p95:5000}])[0].model,'fast');
 for(const http of [401,402,429]){calls=0;const blocked=await runEvaluation({env:{CLINE_API_KEY:'synthetic'},evaluate:async model=>{calls++;return {model,http,score:0,validCases:0,latencyMs:1};},write:()=>{}});assert.equal(calls,1);assert.equal(blocked.state,'blocked_auth_or_quota');assert.equal(blocked.winner,null);}
 calls=0;const missing=await runEvaluation({env:{},evaluate:async()=>calls++,write:()=>{}});assert.equal(calls,0);assert.match(missing.state,/missing/);
});
test('voice probe measures WER for mp3 and ogg and stops at quota without claiming support',async()=>{
 const {REFERENCE,wordErrorRate,runProbe}=require('../scripts/probe-voice-models'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 assert.equal(wordErrorRate(REFERENCE,REFERENCE),0);assert.equal(wordErrorRate('أنا ومرتي','أنا ومرتي وصديقي'),.5);assert.equal(wordErrorRate('أنا ومرتي',''),1);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'voice-probe-')),mp3=path.join(directory,'sample.mp3'),ogg=path.join(directory,'sample.ogg');fs.writeFileSync(mp3,'ID3-synthetic');fs.writeFileSync(ogg,'OggS-synthetic');let calls=0,report='';
 try{
  const result=await runProbe({mp3,ogg,env:{CLINE_API_KEY:'synthetic-c',GEMINI_API_KEY:'synthetic-g'},fetchImpl:async(url,init)=>{calls++;const body=JSON.parse(init.body);if(String(url).includes('cline.bot')){assert.ok(['mp3','ogg'].includes(body.messages[1].content[0].input_audio.format));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({clear:true,transcript:REFERENCE})}}]});}return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({clear:true,transcript:REFERENCE})}]}}]});},write:s=>report=s});
  assert.equal(calls,32);assert.equal(result.state,'completed');assert.ok(result.rows.every(r=>r.supported&&r.wer===0));assert.match(result.recommendation,/CLINE_AUDIO_MODEL=/);assert.doesNotMatch(report,/synthetic-c|synthetic-g|base64/);
  calls=0;const blocked=await runProbe({mp3,ogg,env:{CLINE_API_KEY:'synthetic',GEMINI_API_KEY:'synthetic'},fetchImpl:async()=>{calls++;return new Response('{}',{status:429});},write:()=>{}});assert.equal(calls,1);assert.equal(blocked.recommendation,null);assert.equal(blocked.state,'blocked_auth_or_quota');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
