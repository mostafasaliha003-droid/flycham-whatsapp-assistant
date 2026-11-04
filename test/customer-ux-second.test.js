'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {languagePatch}=require('../src/travel-language');
const {formatHandoffCard}=require('../src/handoff-notification');
const {MessageBatcher,urgentMessage}=require('../src/message-batcher');
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('passenger phrases work mid-sentence with Arabic boundaries and preserve an explicit count',()=>{
 for(const phrase of ['أنا ومرتي','انا وزوجتي','انا وزوجي','انا ورفيقي','انا وصاحبي','انا وامي','انا ووالدتي','انا وابي','انا ووالدي','انا واخي','انا واختي','شخصين','مسافرين اتنين','مسافرين اثنين','تذكرتين','مقعدين','نحنا اتنين','نحن اثنين','نحنا تنين'])assert.equal(languagePatch('بدي طيران، '+phrase+' من الشارقة للشام').adults,2,phrase);
 for(const phrase of ['لحالي','انا لحالي','انا بس','لوحدي','مسافر لحالي','تذكرة وحدة','تذكرة واحدة'])assert.equal(languagePatch('بدي طيران '+phrase+'، بتاريخ 15 نوفمبر').adults,1,phrase);
 assert.equal(languagePatch('نحن ثلاثة بالغين وبدي تذكرتين لحلب').adults,3);
 assert.equal(languagePatch('بدي تذكرتينهم').adults,undefined);
});
test('new urgent commands flush pending text immediately without overtaking an active turn',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});let release;const seen=[];
 const b=new MessageBatcher(async(id,m)=>{seen.push(m.map(x=>x.text));if(seen.length===1)await new Promise(r=>release=r);});
 const first=b.serial('a',[{text:'first'}]);await drain();
 const earlier=b.push('a',{text:'من الشارقة للشام'}),urgent=b.push('a',{text:'حوّلني للموظف'});t.mock.timers.tick(0);await drain();assert.equal(seen.length,1);
 release();await Promise.all([first,earlier,urgent]);assert.deepEqual(seen,[['first'],['من الشارقة للشام','حوّلني للموظف']]);b.close();
});
test('all fast commands include Arabic digits and punctuation without matching a general sentence',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const seen=[],b=new MessageBatcher(async(id,m)=>seen.push(m[0].text));
 const commands=['المزيد','باقي العروض','باقي الخيارات','الخيار 2','العرض ٣','ثبتلي','بدي ثبت','حوّلني للموظف','شوف سعر شخص واحد','حسابكم البنكي','عنوان المكتب','احذف بياناتي','شو صار'];
 for(const text of commands){assert.equal(urgentMessage({text:text+' ؟'}),true);const result=b.push('a',{text});t.mock.timers.tick(0);await result;}
 assert.equal(seen.length,commands.length);assert.equal(urgentMessage({text:'بدنا باقي العروض بشهر نوفمبر'}),false);assert.equal(urgentMessage({requestChoice:{id:'choice'}}),true);b.close();
});
test('handoff card describes the selected round trip and warns staff to recheck without dumping private state',()=>{
 const r={origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',returnDate:'2090-11-20',tripType:'round_trip',passengers:{adults:2,children:1,infants:1}},offer={provider:'flycham',reference:2,request:r,price:{currency:'AED',sellingTotal:'1234.50',weights:[{kg:30}]},timing:{out:{flight:'XH123',departure:'08:00',arrival:'10:00'},back:{flight:'XH124',departure:'11:00',arrival:'14:00'}},secret:'PRIVATE'};
 const card=formatHandoffCard('15550001234',{request:r,offer,secret:'INTERNAL'});assert.match(card,/https:\/\/wa.me\/15550001234/);for(const value of ['+15550001234','الشارقة','دمشق','2090-11-11','2090-11-20','2 بالغ، 1 طفل، 1 رضيع','الخيار 2','فلاي شام','1234.50 درهم','XH123','XH124','30 كغ'])assert.ok(card.includes(value),value);
 assert.match(card,/أعد التحقق من السعر والتوفر لجميع المسافرين/);assert.doesNotMatch(card,/PRIVATE|INTERNAL|JSON|"request"/);
});
test('handoff card handles no offer and incomplete request without inventing a booking or URL',()=>{
 const card=formatHandoffCard('+15550001234',{request:{origin:'دبي',departureRange:{start:'2090-11-01',end:'2090-11-30'},passengers:{adults:3}}});assert.match(card,/2090-11-01 إلى 2090-11-30/);assert.match(card,/لم يُحدد عرض/);assert.match(card,/3 بالغ/);assert.match(card,/لم يتم حجز أو إصدار تذكرة/);
 assert.doesNotMatch(formatHandoffCard('invalid',{}),/wa.me|undefined|null/);
});
