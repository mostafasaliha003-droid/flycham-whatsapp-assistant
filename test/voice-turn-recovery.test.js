'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VoiceTurnRecovery,TTL_MS,MAX_CUSTOMERS}=require('../src/voice-turn-recovery');
const customer='synthetic-customer',contextKey='saudi_visa|case-one|4';
const failed={id:'failed',text:'[مرفق صوتي يحتاج تفريغاً]',timestamp:20,media:{id:'123456',type:'audio',mimeType:'audio/ogg'}};
const before={id:'before',text:'بدي أقدم الطلب',timestamp:10},after={id:'after',text:'بس بعد ما أتأكد من الموعد',timestamp:30,voiceTranscript:true};
const options={messages:[before,failed,after],failedIds:['failed'],revision:7,contextKey};
function ready({messages=options.messages,now=()=>1000}={}){
 const recovery=new VoiceTurnRecovery({now}),held=recovery.hold(customer,{...options,messages});
 assert.equal(held.ok,true);assert.equal(recovery.bind(customer,held.token,'prompt-one'),true);
 return {recovery,held};
}
const reply=(text='لا تقدم الطلب الآن')=>({id:'retry',text,timestamp:40,contextId:'prompt-one'});
const resolveOptions=messages=>({messages,revision:8,contextKey});

test('a quoted replacement restores the complete turn in original order exactly once',()=>{
 const {recovery,held}=ready();assert.equal(held.ordinal,1);assert.match(held.reply,/محتفظ بسياقها مؤقتًا/);
 const result=recovery.resolve(customer,resolveOptions([reply()]));
 assert.equal(result.status,'complete');
 assert.deepEqual(result.messages.map(m=>m.text),[before.text,'لا تقدم الطلب الآن',after.text]);
 assert.deepEqual(result.messages.map(m=>m.timestamp),[10,20,30]);
 assert.equal(result.messages[1].contextId,undefined);
 assert.equal(result.messages[2].voiceTranscript,true);
 assert.equal(recovery.resolve(customer,resolveOptions([reply()])).status,'none');
});

test('unquoted, stale, cross-context and multi-message replies never revive partial actions',()=>{
 const scenarios=[
  {messages:[{id:'new',text:'شكرا'}]},
  {messages:[{...reply(),contextId:'old-prompt'}]},
  {revision:9},{revision:7},{revision:NaN},
  {contextKey:'flight|case-one|4'},{contextKey:'saudi_visa|case-two|4'},{contextKey:'saudi_visa|case-one|5'},
  {messages:[reply(),{id:'new',text:'عندي سؤال جديد'}]}
 ];
 for(const change of scenarios){
  const {recovery}=ready();
  assert.equal(recovery.resolve(customer,{...resolveOptions([reply()]),...change}).status,'superseded');
  assert.equal(recovery.isReply(customer,'prompt-one'),false);
  assert.equal(recovery.resolve(customer,resolveOptions([reply()])).status,'none');
 }
});

test('a draft cannot accept a replacement until its real outbound prompt is bound',()=>{
 const recovery=new VoiceTurnRecovery({now:()=>1000}),held=recovery.hold(customer,options);
 assert.equal(recovery.bind(customer,'wrong-token','prompt-one'),false);
 assert.equal(recovery.isReply(customer,'prompt-one'),false);
 assert.equal(recovery.resolve(customer,resolveOptions([reply()])).status,'superseded');
 const next=recovery.hold(customer,options);
 assert.equal(recovery.bind(customer,held.token,'prompt-one'),false);
 assert.equal(recovery.bind(customer,next.token,'prompt-one'),true);
 assert.equal(recovery.bind(customer,next.token,'different-prompt'),false);
 assert.equal(recovery.isReply(customer,'different-prompt'),false);
});

test('a failed quoted retry retains known parts and requires a newly bound prompt and revision',()=>{
 const {recovery,held}=ready();
 const waiting=recovery.resolve(customer,resolveOptions([{...failed,id:'retry-failed',contextId:'prompt-one',timestamp:40}]));
 assert.equal(waiting.status,'waiting');assert.notEqual(waiting.token,held.token);
 assert.equal(recovery.isReply(customer,'prompt-one'),false);
 assert.equal(recovery.bind(customer,held.token,'prompt-two'),false);
 assert.equal(recovery.bind(customer,waiting.token,'prompt-two'),true);
 const result=recovery.resolve(customer,{messages:[{...reply('ما بدي قدم'),contextId:'prompt-two'}],revision:9,contextKey});
 assert.equal(result.status,'complete');
 assert.deepEqual(result.messages.map(m=>m.text),[before.text,'ما بدي قدم',after.text]);
});

test('TTL expires even while retrying and explicit clear prevents later resumption',()=>{
 let time=1000;const {recovery}=ready({now:()=>time});
 time+=TTL_MS-1;
 const waiting=recovery.resolve(customer,resolveOptions([{...failed,contextId:'prompt-one'}]));
 assert.equal(waiting.status,'waiting');recovery.bind(customer,waiting.token,'prompt-two');
 time++;assert.equal(recovery.isReply(customer,'prompt-two'),false);
 assert.equal(recovery.resolve(customer,{messages:[{...reply(),contextId:'prompt-two'}],revision:9,contextKey}).status,'none');
 const other=ready().recovery;assert.equal(other.clear(customer),true);
 assert.equal(other.resolve(customer,resolveOptions([reply()])).status,'none');
});

test('capacity bounds memory and evicts old drafts without mixing customers',()=>{
 const recovery=new VoiceTurnRecovery({now:()=>1000});
 for(let i=0;i<=MAX_CUSTOMERS;i++){
  const held=recovery.hold('customer-'+i,options);assert.equal(held.ok,true);recovery.bind('customer-'+i,held.token,'prompt-'+i);
 }
 assert.equal(recovery.isReply('customer-0','prompt-0'),false);
 assert.equal(recovery.isReply('customer-1','prompt-1'),true);
 assert.equal(recovery.isReply('customer-1','prompt-2'),false);
 assert.equal(recovery.drafts.size,MAX_CUSTOMERS);
});

test('stored parts are redacted whitelisted text without raw audio, metadata, media IDs or credentials',()=>{
 const sentinel='raw-audio-never-retained',known={...before,text:'My passport number N01234567. لا تقدم الطلب',name:'Sensitive Name',bytes:Buffer.from(sentinel),url:'https://private.invalid/document',unexpected:{secret:'opaque'}};
 const {recovery}=ready({messages:[known,{...failed,bytes:Buffer.from(sentinel),media:{...failed.media,url:'https://private.invalid/audio',bytes:Buffer.from(sentinel)}}]});
 const serialized=JSON.stringify([...recovery.drafts.values()]);
 assert.doesNotMatch(serialized,/N01234567|Sensitive Name|raw-audio-never-retained|private\.invalid|123456|opaque/);
 const result=recovery.resolve(customer,resolveOptions([reply('مو الساعة ستة ونص، الساعة سبعة ونص')]));
 assert.match(result.messages[0].text,/لا تقدم الطلب/);assert.match(result.messages[0].text,/document number/);
 assert.equal(result.messages[1].text,'مو الساعة ستة ونص، الساعة سبعة ونص');
});

test('oversize known content or ambiguous failed slots are refused without truncating a negation',()=>{
 const recovery=new VoiceTurnRecovery({now:()=>1000});
 const scenarios=[
  {...options,messages:[{text:'ك'.repeat(4000)+' لا تقدم الطلب'},failed]},
  {...options,messages:[...Array.from({length:4},()=>({text:'ك'.repeat(3100)})),failed]},
  {...options,messages:[...Array.from({length:50},()=>({text:'نعم'})),failed]},
  {...options,failedIds:['failed','other']},
  {...options,messages:[failed,{...failed}]},
  {...options,messages:[before,{...failed,text:'لا تقدم الطلب'}]},
  {...options,messages:[{text:'my name is John do not submit'},failed]},
  {...options,messages:[{text:'P<<PRIVATE'},failed]},
  {...options,failedIds:['not-present']}
 ];
 for(const scenario of scenarios){assert.equal(recovery.hold(customer,scenario).ok,false);assert.equal(recovery.drafts.size,0);}
});

test('an oversized or fully redacted quoted replacement keeps context for another try',()=>{
 for(const text of ['ك'.repeat(4000)+' لا تقدم','my name is John do not submit','P<<PRIVATE','']){
  const {recovery}=ready();const waiting=recovery.resolve(customer,resolveOptions([reply(text)]));
  assert.equal(waiting.status,'waiting');recovery.bind(customer,waiting.token,'prompt-two');
  const result=recovery.resolve(customer,{messages:[{...reply('٢'),contextId:'prompt-two'}],revision:9,contextKey});
  assert.equal(result.status,'complete');assert.equal(result.messages[1].text,'٢');
 }
});

test('redaction cannot erase a negating clause while retaining an earlier operational request',()=>{
 const recovery=new VoiceTurnRecovery({now:()=>1000});
 for(const text of ['قدملي الطلب، اسمي أحمد لا تقدم الطلب','Submit the application. My name is John do not submit','قدملي الطلب، passport number N01234567 do not submit']){
  assert.equal(recovery.hold(customer,{...options,messages:[{text},failed]}).ok,false,text);
  const draft=ready().recovery;
  assert.equal(draft.resolve(customer,resolveOptions([reply(text)])).status,'waiting',text);
 }
});

test('document attachments and interactive actions cannot be retained or resume an old turn',()=>{
 const controls=[{serviceChoice:{service:'flight'}},{visaConfirmation:{confirm:true}},{visaOwnerAction:{id:'one'}},{requestChoice:{action:'continue'}},{payload:'approve'}];
 for(const extra of [{media:{type:'document',id:'999'}},...controls]){
  const recovery=new VoiceTurnRecovery({now:()=>1000});
  assert.equal(recovery.hold(customer,{...options,messages:[{...before,...extra},failed]}).ok,false);
  const readyRecovery=ready().recovery;
  assert.equal(readyRecovery.resolve(customer,resolveOptions([{...reply(),...extra}])).status,'superseded');
 }
});

test('audio ordinal counts earlier successful recordings and new drafts supersede old prompts',()=>{
 const {recovery}=ready({messages:[{...before,voiceTranscript:true},failed,after]});
 const held=recovery.hold(customer,{...options,messages:[{...before,voiceTranscript:true},failed,after]});
 assert.equal(held.ordinal,2);assert.match(held.reply,/رقم 2/);
 assert.equal(recovery.isReply(customer,'prompt-one'),false);
});
