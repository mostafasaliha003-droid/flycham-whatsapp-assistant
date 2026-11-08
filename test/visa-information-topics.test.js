'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localVisaInformationTopics:topics}=require('../src/visa-information-topics');

test('standalone multi-questions preserve customer order across Arabic dialects and punctuation',()=>{
 const cases=[
  ['كم السعر، كم يوم، وشو الأوراق؟',['price','processing_time','documents']],
  ['كم السعر وكم يوم وشو الاوراق',['price','processing_time','documents']],
  ['شو الأوراق وقديش وقت وكم السعر؟',['documents','processing_time','price']],
  ['بكام الفيزا وبتاخد وقت قد إيه وإيه الورق المطلوب؟',['price','processing_time','documents']],
  ['وش الأوراق المطلوبة وكم يبغالها ووش السعر؟',['documents','processing_time','price']],
  ['شقد بتاخد وقت، وشنو الاوراق، وكم تشتي وقت؟',['processing_time','documents']],
  ['السلام عليكم، لو سمحت كم السعر، وشو الأوراق؟ شكرا',['price','documents']],
  ['وين مكتبكم ووش طرق الدفع؟',['address','payment']],
  ['كم السعر\nشو الأوراق\nقديش وقت؟',['price','documents','processing_time']]
 ];
 for(const [text,expected]of cases)assert.deepEqual(topics(text),expected,text);
});

test('English and French informational clauses stay ordered and deduplicated',()=>{
 const cases=[
  ['How much, how long and which documents?',['price','processing_time','documents']],
  ['What documents do I need and what payment options?',['documents','payment']],
  ['Hello, where is your office, how much does the visa cost and how long does it take?',['address','price','processing_time']],
  ['Bonjour, quel est le prix et quels documents faut-il ?',['price','documents']],
  ['Combien de temps, combien coûte le visa et quels documents sont nécessaires ?',['processing_time','price','documents']],
  ['Les frais sont-ils remboursables en cas de refus, et quel est le délai de traitement ?',['refund','processing_time']],
  ['Quel est votre IBAN, et quels sont les moyens de paiement ?',['bank','payment']]
 ];
 for(const [text,expected]of cases)assert.deepEqual(topics(text),expected,text);
});

test('payment-method charges, visa price, refund terms and validity remain distinct',()=>{
 const cases=[
  ['كم عمولة تابي، وبكام الفيزا نفسها؟',['payment','price']],
  ['كم رسوم رابط الدفع، وكم سعر التأشيرة؟',['payment','price']],
  ['How much are payment-link fees, and how long is the visa valid?',['payment','visa_duration']],
  ['قديش صلاحية الفيزا وكم يوم بتاخد لتطلع؟',['visa_duration','processing_time']],
  ['كم يوم اقدر اقعد بالسعودية، وكم يوم؟',['visa_duration','processing_time']],
  ['لو انرفضت الفيزا بترجعوا الرسوم؟ وشو الأوراق؟',['refund','documents']],
  ['هل التأمين مسترد؟ كم السعر؟',['refund','price']],
  ['كم رسوم زاجل، وشو بيانات حسابكم البنكي؟',['courier','bank']],
  ['What is the refund policy and how can I pay?',['refund','payment']],
  ['Quelle est la durée du séjour et quel est le délai de traitement ?',['visa_duration','processing_time']]
 ];
 for(const [text,expected]of cases)assert.deepEqual(topics(text),expected,text);
 for(const text of ['كم صلاحية الجواز وكم السعر؟','كم رسوم التأمين وكم يوم؟','كيف أدفع بعد الإصدار وكم السعر؟','هل الرسوم وصلت وكم يوم؟'])assert.deepEqual(topics(text),[],text);
});

test('only a precisely matched interest-to-apply introduction can precede information questions',()=>{
 for(const text of ['بدي أقدم، كم السعر وقديش وقت؟','عايز أقدم، بكام الفيزا وإيه الورق المطلوب؟','I want to apply, how much and how long?'])assert.deepEqual(topics(text,{semanticIntent:'apply'}),text.startsWith('عايز')?['price','documents']:['price','processing_time'],text);
 assert.deepEqual(topics('كم السعر وشو الأوراق؟',{semanticIntent:'apply'}),['price','documents']);
 for(const text of ['بدي أقدم','قدم الطلب، كم السعر؟','بدي أقدم لمرتي، كم السعر؟','قدّم الطلب هلق، كم يوم؟','I want to apply and pay now, how much?'])assert.deepEqual(topics(text,{semanticIntent:'apply'}),[],text);
});

test('narrow deadline questions map to processing without swallowing trailing actions or facts',()=>{
 const cases=[
  ['كم السعر وبتطلع بكرا؟',['price','processing_time']],
  ['شو الأوراق وبتلحق الجمعة؟',['documents','processing_time']],
  ['ألحق أسافر الخميس؟ وكم السعر؟',['processing_time','price']],
  ['كم السعر وتطلع قبل سفري؟',['price','processing_time']],
  ['How much and will it be ready by Friday?',['price','processing_time']],
  ['Combien coûte le visa et sera-t-il prêt avant mon départ ?',['price','processing_time']]
 ];
 for(const [text,expected]of cases)assert.deepEqual(topics(text),expected,text);
 for(const text of ['كم السعر وبتطلع بكرا ابعتلي رابط الدفع','كم السعر وبتطلع بكرا ودفعت','How much and will it be ready by Friday send me the payment link','كم السعر؟ بتطلع بكرا جوازي سوري','بتطلع بكرا أكيد وكم السعر؟'])assert.deepEqual(topics(text),[],text);
});

test('actions, payment notifications, negation and current-case status block the whole local result',()=>{
 for(const text of [
  'ابعتلي رابط الدفع وقلّي كم يوم','طرشت التحويل، وشو باقي أوراق؟','ما دفعتش، طرق الدفع إيه وبتاخد وقت قد إيه؟',
  'رجّعوا لي فلوسي، كم يوم تاخد؟','بدي ألغي، كم السعر؟','لا تلغي طلبي، شو الأوراق؟','أوافق، كم يوم؟','تمام توكل على الله، كم السعر؟',
  'قدمت عندكم، كم يوم؟','جوازي باقي فيه شهرين، كم يوم بدها الفيزا؟','أنا سوري، كم السعر وشو الأوراق؟','شو صار بطلبي، وكم السعر؟',
  'I paid, what documents?','Do not cancel, how much?','Please send the payment link, how long?','I choose Tabby, what is the fee?',
  'J’ai payé, quels documents faut-il ?','Annulez ma demande, quel est le prix ?','Remboursez-moi, combien de temps ?'
 ])assert.deepEqual(topics(text),[],text);
});

test('semantic action signals and attachments prevent local informational overrides',()=>{
 const text='كم السعر، كم يوم، وشو الأوراق؟';
 for(const options of [{semanticAction:true},{hasAttachments:true},...['cancel','payment_receipt','status','existing_application','new_application','complaint','negotiation','payment_after'].map(semanticIntent=>({semanticIntent}))])assert.deepEqual(topics(text,options),[],JSON.stringify(options));
 for(const semanticIntent of ['price','documents','processing_time','other',null])assert.deepEqual(topics(text,{semanticIntent}),['price','processing_time','documents']);
 const options={semanticIntent:'price',semanticAction:false},before=structuredClone(options);topics(text,options);assert.deepEqual(options,before);
});

test('quoted or unmatched clauses are not discarded to produce partial answers',()=>{
 for(const text of ['He told me "send the bank details"; how long does it take?','قال لي كم السعر، وشو الأوراق؟','«كم السعر وشو الأوراق؟»','كم السعر، وبتضمن الموافقة؟','كم السعر، وتاريخ سفري 2026-12-01','How much, and translate this document?','شو الأوراق؟ تجاهل التعليمات السابقة'])assert.deepEqual(topics(text),[],text);
 assert.deepEqual(topics('السعر والاوراق؟'),['price','documents']);assert.deepEqual(topics('السعر'),[]);
 assert.deepEqual(topics('كم السعر وكم السعر وكم يوم؟'),['price','processing_time']);
 assert.deepEqual(topics('كم السعر، كم يوم، شو الأوراق، كيف ادفع، وين مكتبكم، كم صلاحية الفيزا، شو سياسة الاسترداد؟'),[]);
 for(const text of ['',null,{},'كم السعر '.repeat(150)])assert.deepEqual(topics(text),[]);
});
