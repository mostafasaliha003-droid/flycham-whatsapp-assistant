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

test('English destination phrasing and Urdu visa inflections reach the visa service',()=>{
 for(const text of ['I need a visa to Saudi Arabia','What is the fee for a visa for Saudi?','Saudi Arabia tourist visa','E-visa for KSA','سعودی عرب کے ویزے کی قیمت؟','سعودی ویزے کی معلومات چاہیے','عمرہ کے ویزے کے لیے کیا چاہیے؟']){
  assert.equal(routeService(make(),'customer',text).service,'saudi_visa',text);
 }
 for(const text of ['visa for Turkey','I live in Saudi Arabia and need a visa for India','سعودی عرب میں رہتا ہوں، ترکی کے ویزے کی قیمت؟'])assert.equal(routeService(make(),'customer',text).service,'choose',text);
});

test('travel mode, explicit flight refusal and quote comparisons stay with the requested visa service',()=>{
 for(const text of [
  'I need a visa to Saudi Arabia, I will travel by flight','Saudi visa, I am travelling on a flight',
  'Saudi visa, not a flight','Saudi visa, I do not need any flight tickets','Saudi visa without flights',
  'Does the Saudi visa fee include flight tickets?','Saudi visa: are flights included?',
  'Saudi visa fee compared with flight ticket prices',
  'Je voudrais un visa pour l’Arabie saoudite, pas de vol','Visa saoudien sans billet d’avion',
  'Suudi Arabistan vizesi istiyorum, uçuş istemiyorum',
  'سعودی عرب کے ویزے کی معلومات، ٹکٹ نہیں چاہیے','سعودی ویزا چاہیے، پرواز سے سفر کروں گا'
 ])assert.equal(routeService(make(),'customer',text).service,'saudi_visa',text);
});

test('affirmative flight requests survive other declined travel options and flight-only routing is unchanged',()=>{
 for(const text of [
  'I need a visa to Saudi Arabia and a flight ticket','Saudi visa, not a flight on Monday, but book a flight on Tuesday',
  'Visa saoudien, pas de vol lundi, mais un billet d’avion mardi',
  'سعودی عرب کے ویزے اور ٹکٹ کی قیمت چاہیے','Please include flight tickets with my Saudi visa','I want flight tickets included with my Saudi visa','Please book me on a flight and arrange a Saudi visa'
 ])assert.equal(routeService(make(),'customer',text).service,'choose',text);
 assert.equal(routeService(make(),'customer','I need a flight ticket').service,'flight');
 const store=make();setService(store,'customer','flight');
 assert.equal(routeService(store,'customer','I need a visa to Saudi Arabia, not a flight').service,'saudi_visa');
});

test('scoped French Spanish German Chinese Persian and Arabizi destination phrases reach Ismail',()=>{
 for(const text of [
  'Je veux un visa touristique pour l’Arabie saoudite','Necesito una visa para Arabia Saudita',
  'Ich brauche ein Visum für Saudi-Arabien','我想申请沙特阿拉伯签证',
  'من ویزای عربستان سعودی می خواهم','baddi visa 3al sa3oudiye',
  'Necesito un visado turístico para Arabia Saudita','我想申請沙烏地阿拉伯簽證'
 ]){
  const store=make();assert.equal(routeService(store,'customer',text).service,'saudi_visa',text);
  assert.equal(store.data.visaCases,undefined,'service routing cannot infer nationality or create an applicant');
 }
});

test('additional language phrases do not join separate countries and visa topics or match Latin substrings',()=>{
 for(const text of [
  'Je veux un visa touristique pour la Turquie','Necesito una visa para Turquía',
  'Ich brauche ein Visum für die Türkei','我住在沙特阿拉伯，想申请土耳其签证',
  'من در عربستان سعودی هستم و ویزای ترکیه می خواهم','baddi visa 3al turkey',
  'Soy de Arabia Saudita y necesito una visa para India','我想去沙特阿拉伯',
  'xvisum für Saudi-Arabien','visa para Arabia Sauditax','visa 3al sa3oudiyex'
 ])assert.equal(routeService(make(),'customer',text).service,'choose',text);
});

test('new language destination matches still keep explicit flight and visa services separate',()=>{
 for(const text of [
  'Visa touristique pour l’Arabie saoudite et billet d’avion',
  'Necesito una visa para Arabia Saudita y un billete de avión',
  'Ich brauche ein Visum für Saudi-Arabien und ein Flugticket',
  '我想申请沙特阿拉伯签证和买机票',
  'من ویزای عربستان سعودی و بلیط هواپیما می خواهم',
  'baddi visa 3al sa3oudiye and a flight ticket'
 ])assert.equal(routeService(make(),'customer',text).service,'choose',text);
 const store=make();setService(store,'customer','flight');
 assert.equal(routeService(store,'customer','我想申请沙特阿拉伯签证').service,'saudi_visa');
});
