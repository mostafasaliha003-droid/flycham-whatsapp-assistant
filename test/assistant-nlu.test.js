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
