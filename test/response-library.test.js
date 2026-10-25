'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SITUATIONS,getConversationGuide,chooseApprovedReply}=require('../src/response-library');
const trip={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-10',tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30}};
test('one hundred distinct reviewed situations cover ten travel conversation groups',()=>{
 assert.equal(SITUATIONS.length,100);assert.equal(new Set(SITUATIONS.map(s=>s.id)).size,100);assert.equal(new Set(SITUATIONS.map(s=>s.group)).size,10);assert.equal(new Set(SITUATIONS.map(s=>s.action)).size,100);
 for(const s of SITUATIONS){assert.ok(s.pattern instanceof RegExp);assert.ok(s.action.length>20);assert.ok(s.examples.length);assert.ok(!/[\d٠-٩]/.test(s.examples.join('')));}
});
test('guide emits only curated relevant cases within a strict character budget and no private source content',()=>{
 const raw='بدي عدل الوزن ثلاثين كيلو وغيّر التاريخ من دبي ارخص للشهر القادم واسم العميل PRIVATE_CUSTOMER ومفتاح API_SECRET_VALUE user@example.com';
 const guide=getConversationGuide({text:raw,status:'searching',request:{...trip,password:'PRIVATE_PASSWORD'},history:[{role:'user',text:'MY_PRIVATE_HISTORY'}],offers:[{customer:'PRIVATE_CUSTOMER',price:{sellingTotal:'99999.99'}}]});
 assert.ok(guide.situations.length<=3);assert.ok(JSON.stringify(guide).length<=2500);assert.doesNotMatch(JSON.stringify(guide),/PRIVATE_|API_SECRET|user@example.com|99999/);assert.ok(guide.situations.some(s=>s.id==='weight_amendment'));
});
test('a complete known trip does not receive repeated missing-field questions',()=>{
 const guide=getConversationGuide({text:'بدي سافر من الشارقة، شو السعر؟',request:trip,status:'done'});assert.ok(guide.situations.every(s=>!['origin_missing','destination_missing','date_missing','party_missing','return_missing','child_ages_missing'].includes(s.id)));
 const state={base:{request:trip},status:'done'};for(const kind of ['clarify_missing','clarify_origin','clarify_destination','clarify_dates','clarify_party'])assert.doesNotMatch(chooseApprovedReply(kind,{state}),/كم عدد|كم شخص|من أي مدينة|لوين|أي فترة/);
});
test('one adult alone does not prompt for unmentioned children and negated priorities are respected',()=>{
 const g=getConversationGuide({text:'شخص واحد لحالي',request:trip});assert.ok(g.situations.some(s=>s.id==='adult_alone'));assert.ok(!g.situations.some(s=>s.id==='child_ages_missing'));
 const n=getConversationGuide({text:'مو غالي، السعر مو مهم، مو حصرا دبي',request:trip});assert.ok(!n.situations.some(s=>s.id==='price_objection'));assert.ok(!n.situations.some(s=>s.id==='fixed_airport'));
 const rejected=getConversationGuide({text:'مو من الشارقة، بدي من دبي',request:trip});assert.ok(!rejected.situations.some(s=>s.id==='sharjah_alias'));assert.ok(rejected.situations.some(s=>s.id==='airport_negation'));
});
test('waiting prose follows actual workflow state and never claims pending work for an idle or failed request',()=>{
 for(const status of ['idle','collecting','failed','done','unsupported','cancelled']){
  const reply=chooseApprovedReply('waiting',{state:{status,base:{request:trip}}});assert.doesNotMatch(reply,/البحث مستمر|قيد البحث|عم نكمّل التحقق/);
 }
 for(const status of ['queued','searching'])assert.match(chooseApprovedReply('waiting',{state:{status}}),/قيد البحث|البحث مستمر|عم نكمّل التحقق/);
});
test('approved variants avoid the latest spoken reply and keep bounded nonpersonal choice memory',()=>{
 const state={status:'searching',history:[]},seen=[];for(let i=0;i<30;i++){const reply=chooseApprovedReply('waiting',{state,now:100+i});if(seen.length)assert.notEqual(reply,seen.at(-1));seen.push(reply);state.history=[...state.history,{role:'assistant',text:reply}].slice(-4);}
 assert.ok(new Set(seen).size>=3);assert.equal(state.responseLibraryRecent.length,12);assert.ok(state.responseLibraryRecent.every(x=>Object.keys(x).sort().join(',')==='at,index,kind'));
});
test('missing facts ask only one actual missing slot and do not mutate travel facts',()=>{
 const state={status:'collecting',base:{request:{...trip,passengers:null}}},before=structuredClone(state.base);
 assert.match(chooseApprovedReply('clarify_missing',{state}),/عدد المسافرين|كم شخص/);assert.deepEqual(state.base,before);
 const children={base:{request:{...trip,passengers:{adults:1,children:1,infants:0,ages:[]}}}};assert.match(chooseApprovedReply('clarify_missing',{state:children}),/أعمار|عمر/);
});
test('unknown input has bounded clarification guidance and reply cannot invent operational success',()=>{
 const g=getConversationGuide({text:'zxv qqq ???',request:trip});assert.equal(g.situations[0].id,'unfamiliar_context');assert.match(g.situations[0].action,/سؤالًا واحدًا/);
 const s={introduced:true};assert.doesNotMatch(chooseApprovedReply('greeting',{state:s}),/أنا أحمد|معك أحمد/);
 const reply=chooseApprovedReply('anything_untrusted',{state:s});assert.doesNotMatch(reply,/تم الحجز|تم الإصدار|تم التحويل|آخر مقعد|درهم|مجاني|مضمون/);
});
test('missing or malformed optional context is safely bounded',()=>{
 for(const input of [null,{}, {request:null},{request:[],history:null,offers:null,consultantMemory:null}])assert.ok(JSON.stringify(getConversationGuide(input)).length<=2500);
 assert.equal(typeof chooseApprovedReply('waiting',{state:null}),'string');
});
