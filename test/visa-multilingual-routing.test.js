'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {routeService,setService}=require('../src/service-routing');
const make=()=>({data:{},save(){}});

test('explicit Saudi visa and Umrah entries reach Ismail across supported routing scripts',()=>{
 for(const text of [
  'مجھے سعودی عرب کا ویزا چاہیے','سعودی ویزا کی قیمت کیا ہے؟','عمرہ کا ویزا چاہیے',
  'मुझे सऊदी अरब का वीज़ा चाहिए','सऊदी वीजा के लिए क्या चाहिए?','उमरा का वीज़ा चाहिए',
  'Bonjour, je voudrais un visa pour l’Arabie saoudite','Quel est le prix du visa saoudien ?',"Visa pour l'omra",
  'Мне нужна виза в Саудовскую Аравию','Хочу саудовскую визу','Какая цена визы для умры?',
  'Suudi Arabistan vizesi istiyorum','Suudi vizesine başvurmak istiyorum','Umre vizesi gerekiyor'
 ]){
  const store=make();assert.equal(routeService(store,'customer',text).service,'saudi_visa',text);
  assert.equal(store.data.serviceSessions.customer.service,'saudi_visa');
  assert.equal(store.data.visaCases,undefined,'routing must not infer applicant facts');
 }
});

test('greetings, nationality, unrelated countries and substrings do not imply a Saudi visa request',()=>{
 for(const text of ['Bonjour','Здравствуйте','Merhaba','नमस्ते','السلام علیکم','Je suis saoudien','Я из Саудовской Аравии','Suudi Arabistanlıyım','مجھے ترکی کا ویزا چاہیے','मुझे भारत का वीज़ा चाहिए','visa pour la Turquie','Мне нужна виза в Турцию','Türkiye vizesi istiyorum','notvisa saoudienx']){
  assert.equal(routeService(make(),'customer',text).service,'choose',text);
 }
});

test('mixed visa and flight requests retain service choice rather than selecting visa automatically',()=>{
 for(const text of [
  'Visa saoudien et billet d’avion','Виза в Саудовскую Аравию и авиабилеты',
  'Suudi Arabistan vizesi ve uçak bileti','सऊदी वीज़ा और टिकट','سعودی عرب کا ویزا اور ٹکٹ',
  'Visa saoudien and flight ticket'
 ])assert.equal(routeService(make(),'customer',text).service,'choose',text);
});

test('existing service is stable for non-service multilingual followups and explicit visa switches work',()=>{
 for(const service of ['flight','saudi_visa']){
  const store=make();setService(store,'customer',service);
  for(const text of ['Merci beaucoup','أنا لبناني','شکریہ','Здравствуйте'])assert.equal(routeService(store,'customer',text).service,service,text);
  assert.equal(routeService(store,'customer','Suudi Arabistan vizesi istiyorum').service,'saudi_visa');
 }
 const store=make();routeService(store,'customer','فيزا تركيا');
 assert.ok(store.data.serviceSessions.customer.serviceInquiry);
 assert.equal(routeService(store,'customer','Мне нужна виза в Саудовскую Аравию').service,'saudi_visa');
 assert.equal(store.data.serviceSessions.customer.serviceInquiry,undefined);
});

test('visa feature flag and current service menu nonce still govern multilingual selections',()=>{
 assert.equal(routeService(make(),'customer','Visa saoudien',{env:{SAUDI_VISA_ENABLED:'false'}}).service,'flight');
 const store=make(),menu=routeService(store,'customer','Bonjour');
 assert.equal(routeService(store,'customer','Visa saoudien',{serviceChoice:{id:'stale',service:'saudi_visa'}}).service,'choose');
 assert.notEqual(store.data.serviceSessions.customer.menuId,menu.menuId);
});
