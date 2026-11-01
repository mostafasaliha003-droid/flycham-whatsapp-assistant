'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CLINEPASS_MODELS,CASES,scoreOutput,evaluateModel,runClineModelEvaluation,EVALUATION_POLICY}=require('../src/cline-model-evaluation');
const {schema}=require('../src/consultant-brain');
function decision(){return{intent:'other',fields:Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,s])=>[k,s.type==='array'?[]:null])),question:null,option:null,consultant:{action:'answer',reply:null,preferences:{priority:null,airportFlexibility:null},nextStep:'none',knowledgeQuery:null}};}
function golden(){return{decisions:CASES.map(c=>{const d=decision();if(c.id==='complete_trip'){d.intent='request';d.consultant.action='search';d.consultant.nextStep='search';Object.assign(d.fields,{origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',tripType:'one_way',adults:1,children:0,infants:0,weightKg:30});}if(c.id==='preserve_week'){d.intent='change';d.consultant.action='amend';d.consultant.nextStep='search';d.fields.weightKg=30;}if(c.id==='inquiry_not_selection'){d.intent='compare';d.consultant.action='compare';d.consultant.nextStep='compare_options';}if(c.id==='price_objection'){d.intent='negotiate';d.consultant.reply='خلّينا نشوف بدائل بالمطار أو الوزن، والتواريخ منخلّيها متل ما طلبت.';}if(c.id==='knowledge_routing'){d.intent='explain';d.consultant.action='knowledge';d.consultant.nextStep='research';d.consultant.knowledgeQuery='متطلبات دخول تايلند للمقيمين في الإمارات';}if(c.id==='waiting_context'){d.intent='status';d.consultant.action='status';d.consultant.reply='عم نقارن الخيارات المناسبة، وبنخبرك لما تتأكد النتيجة.';}return{id:c.id,decision:d};})};}
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(golden())}}]});
const env={CLINE_MODEL_EVALUATION_ENABLED:'true',CLINE_API_KEY:'synthetic-evaluation-secret'};
test('rubric distinguishes correct Arabic context decisions from collapsed weeks, accidental selections and invented booking claims',()=>{
 const original=golden();assert.equal(scoreOutput(JSON.stringify(original)).score,100);
 const week=golden();week.decisions[1].decision.fields.departureDate='2026-12-07';assert.ok(scoreOutput(JSON.stringify(week)).score<100);
 const select=golden();select.decisions[2].decision.intent='select';select.decisions[2].decision.option=2;select.decisions[2].decision.consultant.action='answer';assert.ok(scoreOutput(JSON.stringify(select)).score<100);
 const lie=golden();lie.decisions[3].decision.consultant.reply='تم الحجز والسعر مضمون';assert.equal(scoreOutput(JSON.stringify(lie)).validCases,5);
 assert.equal(scoreOutput('{').score,0);
 const duplicate=golden();duplicate.decisions[5].id=duplicate.decisions[0].id;assert.equal(scoreOutput(JSON.stringify(duplicate)).error,'INVALID_BATCH');
});
test('model evaluation accepts exact subscription IDs only and sends fixed synthetic cases without customer state',async()=>{
 assert.equal(CLINEPASS_MODELS.length,15);assert.equal(Object.isFrozen(CLINEPASS_MODELS),true);
 let calls=0;const fetchImpl=async(url,options)=>{calls++;assert.equal(url,'https://api.cline.bot/api/v1/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Response-Format'],'openai');const body=JSON.parse(options.body);assert.equal(body.model,'cline-pass/kimi-k3.1-pro');assert.equal(body.messages.length,2);assert.equal(JSON.parse(body.messages[1].content).cases.length,6);assert.equal(options.body.includes(env.CLINE_API_KEY),false);assert.equal(Object.hasOwn(body,'tools'),false);return response();};
 const result=await evaluateModel('cline-pass/kimi-k3.1-pro',{env,fetchImpl});assert.equal(result.score,100);assert.equal(result.validCases,6);assert.equal(calls,1);
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
