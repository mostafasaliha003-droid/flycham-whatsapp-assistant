'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const {schema,safeContext,validateDecision}=require('../src/assistant-nlu');
const {languagePatch}=require('../src/travel-language');
const legacy=require('../src/conversation');
const now=Date.parse('2026-10-23T08:00:00Z');
const initial='من الشارقة للشام11-11-2026 ذهاب بس شخص واحد';
function d(fields={},intent='request',question=null){return{intent,fields:{...Object.fromEntries(Object.keys(schema.properties.fields.properties).map(k=>[k,['ages','excludedDates'].includes(k)?[]:null])),...fields},question,option:null};}
function engine(nlu=async()=>null){return new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu});}
test('understanding receives each meaningful social turn once and keeps its original wording',async()=>{
 const seen=[];const e=engine(async(text,context)=>{seen.push({text,context});return text==='ألف شكر إلك'?d({},'thanks'):text==='طمني وين صرنا'?d({},'status'):null;});
 await e.handle('all-turns','مرحبا',{now});await e.handle('all-turns',initial,{now});e.jobState('all-turns','searching');
 await e.handle('all-turns','ألف شكر إلك',{now});const status=await e.handle('all-turns','طمني وين صرنا',{now});
 assert.deepEqual(seen.map(x=>x.text),['مرحبا',initial,'ألف شكر إلك','طمني وين صرنا']);assert.match(status.reply,/طلبك|البحث/);
 const history=e.state('all-turns').history;assert.equal(history.filter(m=>m.role==='user'&&m.text==='ألف شكر إلك').length,1);assert.equal(history.some(m=>m.role==='user'&&m.text==='شكرا'),false);
});
test('privacy deletion remains local and does not forward deleted data to understanding',async()=>{
 let calls=0;const e=engine(async()=>{calls++;return null;});await e.handle('delete','احذف بياناتي',{now});assert.equal(calls,0);assert.equal(e.store.get('delete'),undefined);
});
test('mixed gratitude and a contextual return amendment preserve all unrelated trip facts',async()=>{
 let amended=false;const e=engine(async()=>amended?d({stayNights:14},'thanks'):null);
 await e.handle('return-edit','من الشارقة للشام11-11-2026 والعودة18-11-2026 شخص واحد',{now});const before=structuredClone(e.state('return-edit').base.request);amended=true;
 const result=await e.handle('return-edit','يسلمو، خلي موعد الرجعة بعد أسبوعين',{now});assert.equal(result.complete,true);assert.equal(result.request.returnDate,'2026-11-25');assert.equal(result.request.stayNights,14);assert.equal(result.request.origin,before.origin);assert.equal(result.request.departureDate,before.departureDate);assert.deepEqual(result.request.passengers,before.passengers);
});
test('a single stored expansion proposal is accepted by شفلي with dates and weight retained',async()=>{
 const e=engine();await e.handle('proposal',initial,{now});e.jobState('proposal','done');
 const suggestion=await e.handle('proposal','غالي',{now});assert.match(suggestion.reply,/سبعة أيام/);const p=e.state('proposal').base.proposal;assert.equal(p.start,'2026-11-12');assert.equal(p.end,'2026-11-18');
 const accepted=await e.handle('proposal','شفلي',{now});assert.equal(accepted.complete,true);assert.deepEqual(accepted.request.departureRange,{start:p.start,end:p.end,kind:'accepted_proposal'});assert.equal(accepted.request.baggageRequest.checkedWeightKg,30);assert.equal(accepted.request.passengers.adults,1);assert.equal(e.state('proposal').base.proposal,undefined);
});
test('an expired proposal never authorizes an automatic expansion',()=>{
 legacy.resetSessions();legacy.handleMessage('expired',initial,{now});legacy.proposeExpansion('expired',{now});const r=legacy.handleMessage('expired','شفلي',{now:now+31*60000});assert.equal(r.complete,false);assert.equal(legacy.exportSession('expired').request.departureDate,'2026-11-11');
});
test('Cline sees bounded scopes, default baggage provenance, proposal and semantic ledger without arbitrary profile keys',()=>{
 const context=safeContext({request:{stayNights:14,originScope:'any_uae',destinationCountry:'سوريا',searchMode:'cheapest',providerExclusive:false,baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false,password:'PRIVATE'}},questions:{returnDate:{field:'returnDate',tripId:'trip',askedAt:now,answered:false,status:'asked',private:'PRIVATE'}},proposal:{kind:'extend_after_last_date',start:'2026-11-12',end:'2026-11-18',choiceCount:1,requestFingerprint:'PRIVATE'}},true);
 assert.equal(context.request.stayNights,14);assert.equal(context.request.originScope,'any_uae');assert.equal(context.request.baggageRequest.requestedByCustomer,false);assert.equal(context.request.baggageRequest.source,'default30');assert.equal(context.proposal.start,'2026-11-12');assert.equal(context.questions.returnDate.status,'asked');assert.doesNotMatch(JSON.stringify(context),/PRIVATE|password|requestFingerprint/);
});
test('uncertainty uses one contextual question and never mutates the known trip',async()=>{
 let unknown=false;const e=engine(async()=>unknown?d({},'uncertain','قصدك مقارنة وقت الوصول أو شروط التذكرة؟'):null);await e.handle('uncertain',initial,{now});const before=JSON.stringify(e.state('uncertain').base.request);unknown=true;
 const one=await e.handle('uncertain','ما ارتحت لهالشي',{now});const two=await e.handle('uncertain','لسا قصدي شي تاني',{now});assert.match(one.reply,/قصدك مقارنة/);assert.doesNotMatch(two.reply,/قصدك مقارنة/);assert.equal(JSON.stringify(e.state('uncertain').base.request),before);assert.equal(e.state('uncertain').questions.clarification.reason,'uncertain');
});
test('status preserves unanswered question and the next answer resolves its semantic ledger',async()=>{
 const e=engine();await e.handle('ledger','من الشارقة للشام11-11-2026 ذهاب بس',{now});const question=e.state('ledger').lastQuestion;const status=await e.handle('ledger','ناطر',{now});assert.match(status.reply,/بانتظار جوابك/);assert.equal(e.state('ledger').lastQuestion,question);
 await e.handle('ledger','شخص واحد',{now});assert.equal(e.state('ledger').questions.passengers.status,'answered');assert.equal(e.state('ledger').questions.passengers.answeredAt,now);assert.equal(e.state('ledger').lastQuestion,null);
});
test('a substantive service explanation avoids starting another quote or inventing a fare',async()=>{
 let explain=false;const e=engine(async()=>explain?d({},'explain'):null);await e.handle('explain',initial,{now});explain=true;const before=JSON.stringify(e.state('explain').base.request);const r=await e.handle('explain','شو الفرق بين فلاي شام والعربية؟',{now});assert.equal(r.complete,false);assert.match(r.reply,/ثلاثين كيلو/);assert.doesNotMatch(r.reply,/\d|درهم|أرخص|مضمون/);assert.equal(JSON.stringify(e.state('explain').base.request),before);
});
test('spoken plural numbers and positive direction survive a preceding negated airport',()=>{
 assert.equal(languagePatch('تلاتة كبار').adults,3);assert.equal(languagePatch('ثلاثة كبار').adults,3);
 assert.equal(languagePatch('مو من دبي، بدي من الشارقة').origin,'الشارقة');assert.equal(languagePatch('مو من دبي').origin,undefined);
});
test('airline preference alone is not an exclusive restriction, which can be explicitly cleared',()=>{
 legacy.resetSessions();let r=legacy.handleMessage('exclusive',initial+' مع فلاي شام',{now});assert.equal(r.request.provider,'flycham');assert.equal(Boolean(r.request.providerExclusive),false);
 r=legacy.handleMessage('exclusive','فلاي شام حصرا',{now});assert.equal(r.request.providerExclusive,true);
 r=legacy.handleMessage('exclusive','أي شركة ما بتفرق معي الشركة',{now});assert.equal(r.request.providerExclusive,false);
 assert.equal(languagePatch('فلاي شام ذهاب فقط').providerExclusive,undefined);
});
test('a preferred FlyCham weight outside its supported allowance does not block a nonexclusive Air Arabia comparison',async()=>{
 const e=engine();const result=await e.handle('compare-weight',initial+' مع فلاي شام بدي40 كيلو',{now});assert.equal(result.complete,true);assert.equal(result.request.baggageRequest.checkedWeightKg,40);
 const exclusive=await e.handle('compare-weight','فلاي شام حصرا',{now});assert.equal(exclusive.complete,false);assert.equal(e.state('compare-weight').status,'unsupported');
});
test('the bounded intent and duration schema accepts recovery but rejects invented durations and prose fields',()=>{
 assert.equal(validateDecision(d({stayNights:7},'uncertain','أي نقطة من العرض بدك نراجعها؟')).intent,'uncertain');assert.throws(()=>validateDecision(d({stayNights:0})),/NLU_INVALID/);assert.throws(()=>validateDecision({...d(),reply:'السعر500 درهم'}),/NLU_INVALID/);
});

test('negated directional or bare airports cannot be installed by a broad parser or a conflicting model',async()=>{
 let negative=false;const e=engine(async()=>negative?d({origin:'دبي'}):null);
 await e.handle('negative-route','من الشارقة للشام11-11-2026 ذهاب بس',{now});negative=true;
 await e.handle('negative-route','مو من دبي',{now});assert.equal(e.state('negative-route').base.request.origin,'الشارقة');
 const other=engine();await other.handle('negative-bare','من الشارقة11-11-2026 ذهاب بس',{now});await other.handle('negative-bare','مو الشام',{now});assert.equal(other.state('negative-bare').base.request.destination,null);
});

function addShownOffers(e,id){
 const base=e.state(id).base.request;
 for(const [reference,provider,price,flight]of [[1,'airarabia','700.00','G9433'],[2,'flycham','850.00','XH744']])e.progress(id,{offer:{reference,provider,request:{...base,provider},timing:{out:{flight,departure:'08:00',arrival:'10:00'}},price:{sellingTotal:price,weights:[{kg:30}]}}},'shown-'+reference);
}
test('shown offer context explicitly identifies each provider without exposing prices to Cline',async()=>{
 let captured;const e=engine(async(text,context)=>{captured=context;return null;});await e.handle('provider-context',initial,{now});addShownOffers(e,'provider-context');await e.handle('provider-context','شو عندك؟',{now});
 assert.deepEqual(captured.offerSummaries.map(o=>o.provider),['airarabia','flycham']);const safe=safeContext(captured,true);assert.deepEqual(safe.offerSummaries.map(o=>o.provider),['airarabia','flycham']);assert.doesNotMatch(JSON.stringify(safe.offerSummaries),/700.00|850.00|sellingTotal/);
 assert.equal(safeContext({offerSummaries:[{provider:'UNTRUSTED_PROVIDER'}]}).offerSummaries[0].provider,null);
});
test('a FlyCham price inquiry reads the verified card without selecting or changing the trip',async()=>{
 let inquiry=false;const e=engine(async()=>inquiry?{...d({},'explain'),option:2}:null);await e.handle('readback',initial,{now});addShownOffers(e,'readback');inquiry=true;const before=JSON.stringify(e.state('readback').base.request);
 const r=await e.handle('readback','قديش سعر فلاي شام؟',{now,quotedMessageId:'shown-2'});assert.equal(r.complete,false);assert.match(r.reply,/فلاي شام/);assert.match(r.reply,/850\.00/);assert.doesNotMatch(r.reply,/700\.00|اخترت الخيار/);assert.equal(e.state('readback').selected,null);assert.equal(JSON.stringify(e.state('readback').base.request),before);assert.equal(e.store.data.handoffs.length,0);
});
test('a cheapest-shown recommendation uses verified totals and does not choose or book for the customer',async()=>{
 let advice=false;const e=engine(async()=>advice?d({},'explain'):null);await e.handle('advice',initial,{now});addShownOffers(e,'advice');advice=true;
 const r=await e.handle('advice','شو الأفضل بالسعر؟',{now});assert.equal(r.complete,false);assert.match(r.reply,/من ناحية السعر/);assert.match(r.reply,/بين العروض المتحققة المعروضة/);assert.match(r.reply,/700\.00/);assert.doesNotMatch(r.reply,/850\.00|اخترت الخيار/);assert.equal(e.state('advice').selected,null);assert.equal(e.store.data.handoffs.length,0);
 const empty=engine(async()=>({...d({},'explain'),option:1}));const noOffer=await empty.handle('no-readback','قديش السعر؟',{now});assert.match(noOffer.reply,/ما عندي عرض متحقق/);assert.doesNotMatch(noOffer.reply,/undefined|درهم/);
});

test('a mapped single-card quote resolves its offer even without a per-offer message ID',async()=>{
 const e=engine();await e.handle('mapped-one',initial,{now});addShownOffers(e,'mapped-one');const s=e.state('mapped-one');s.offerMessages={'comparison-part-one':[1]};e.store.set('mapped-one',s);
 const r=await e.handle('mapped-one','بدي40كيلو',{now,quotedMessageId:'comparison-part-one'});assert.equal(r.complete,true);assert.equal(r.request.provider,'airarabia');assert.equal(r.request.providerExclusive,true);assert.equal(r.request.baggageRequest.checkedWeightKg,40);
});
test('a multi-card quote rejects a model-only deictic choice, asks once, and preserves an amendment for an explicit option',async()=>{
 let ambiguous=false,captured;const e=engine(async(text,context)=>{captured=context;return ambiguous?{...d(text.includes('40')?{weightKg:40}:{},'select'),option:2}:null;});
 await e.handle('mapped-many',initial,{now});addShownOffers(e,'mapped-many');const s=e.state('mapped-many');s.offerMessages={'comparison-part-many':[1,2]};e.store.set('mapped-many',s);const before=JSON.stringify(s.base.request);ambiguous=true;
 const first=await e.handle('mapped-many','هاد بس خليه40كيلو',{now,quotedMessageId:'comparison-part-many',turnMessages:[{text:'هاد بس خليه40كيلو',quotedOfferReferences:[1,2]}]});assert.equal(first.complete,false);assert.match(first.reply,/أي خيار تقصد/);assert.doesNotMatch(first.reply,/من أي|كم عدد/);assert.equal(e.state('mapped-many').selected,null);assert.equal(JSON.stringify(e.state('mapped-many').base.request),before);assert.deepEqual(captured.quotedOfferReferences,[1,2]);assert.deepEqual(safeContext(captured,true).turnMessages[0].quotedOfferReferences,[1,2]);
 const again=await e.handle('mapped-many','نفسه',{now});assert.doesNotMatch(again.reply,/أي خيار تقصد/);assert.equal(e.store.data.handoffs.length,0);
 const resolved=await e.handle('mapped-many','الخيار1',{now});assert.equal(resolved.complete,true);assert.equal(resolved.request.provider,'airarabia');assert.equal(resolved.request.baggageRequest.checkedWeightKg,40);assert.equal(e.state('mapped-many').questions.offerChoice.status,'answered');assert.equal(e.state('mapped-many').pendingQuotedOffer,undefined);
});
