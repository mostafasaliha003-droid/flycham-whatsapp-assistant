'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {languagePatch}=require('../src/travel-language');
test('Package 10 Arabic passenger dialects retain prior synonyms and explicit counts',()=>{
 for(const text of ['أنا ومراتي','أنا وجوزي','أنا وأخوي','أنا والمدام','أنا والحرمة','أنا وخطيبتي','أنا وصديقي','أنا ورفيقي','فردين','نفرين','احنا اتنين','نحنا اثنين','مسافرين اتنين','تذكرتين'])assert.equal(languagePatch(text).adults,2,text);
 for(const text of ['بطولي','بس أنا','أنا فقط','أنا لوحدي','شخص واحد','مسافر واحد','تذكرة وحدة'])assert.equal(languagePatch(text).adults,1,text);
 assert.equal(languagePatch('نحن ثلاثة أنا ومراتي وأمي').adults,3);assert.equal(languagePatch('3 بالغين أنا ومراتي وأمي').adults,undefined);
 assert.equal(languagePatch('شخصينهم').adults,undefined);
});
test('Package 10 zero checked baggage dialects do not erase an explicitly requested checked bag',()=>{
 for(const text of ['بدون عفش','بلا عفش','بدون شنط','بلا شنط','بدون أمتعة','يدوي فقط','شنطة يد','حقيبة يد فقط','ما معي وزن','مامعي وزن','ما بدي وزن','مابدي وزن'])assert.equal(languagePatch(text).weightKg,0,text);
 assert.deepEqual(languagePatch('بطولي بدون عفش'),{adults:1,weightKg:0});assert.equal(languagePatch('ثلاثين كيلو وشنطة يد').weightKg,30);
});
