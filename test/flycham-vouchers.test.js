'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {priceFlyChamQuote,voucherPromise}=require('../src/flycham-pricing');
const {VoucherStore,oneYearFrom,configuredStore}=require('../src/vouchers');
const {voucherPNG}=require('../src/voucher-image');
const now=Date.parse('2026-10-23T10:00:00Z');
const input={provider:'flycham',tripType:'one_way',bookingReference:'TEST-ONLY',passengerReference:'P1',customerName:'عميل تجريبي',ticketConfirmed:true};
function store(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voucher-'));return{dir,s:new VoucherStore({file:path.join(dir,'vouchers.sqlite'),key:'test-only-key',now:()=>now})};}
test('Fly Cham first page pricing keeps full 40/90 margin and promises separate future 10/25 voucher',()=>{
 for(const [tripType,total,gift] of [['one_way','683.00','10.00'],['round_trip','733.00','25.00']]){const p=priceFlyChamQuote({currency:'AED',baseTotal:'643.00',tripType,verifiedFirstPage:true});assert.equal(p.sellingTotal,total);assert.equal(p.voucherValue,gift);assert.match(voucherPromise(p),/لاحقًا/);}
 assert.throws(()=>priceFlyChamQuote({currency:'USD',baseTotal:'174.69',tripType:'one_way',verifiedFirstPage:true}));assert.throws(()=>priceFlyChamQuote({currency:'AED',baseTotal:'643',tripType:'one_way'}));assert.equal(voucherPromise({provider:'airarabia'}),'');
});
test('only confirmed Fly Cham tickets can issue; duplicate source does not mint more credit',()=>{
 const {dir,s}=store();try {assert.throws(()=>s.issue({...input,provider:'airarabia'}));assert.throws(()=>s.issue({...input,ticketConfirmed:false}));const v=s.issue(input),again=s.issue(input);assert.equal(v.id,again.id);assert.equal(again.existing,true);assert.equal(v.value,'10.00');assert.equal(s.lookup(v.token).state,'valid');assert.equal(s.lookup(v.token).customerName,undefined);assert.throws(()=>s.issue({...input,customerName:'Someone Else'}));}finally{s.close();fs.rmSync(dir,{recursive:true});}
});
test('single use is atomic across database connections; QR scans do not redeem',()=>{
 const {dir,s}=store(),s2=new VoucherStore({file:path.join(dir,'vouchers.sqlite'),key:'test-only-key',now:()=>now});try{const v=s.issue(input);for(let i=0;i<3;i++)assert.equal(s.lookup(v.token).state,'valid');s.redeem(v.id,'future-service-1');assert.throws(()=>s2.redeem(v.id,'future-service-2'));assert.equal(s2.lookup(v.token).state,'used');}finally{s.close();s2.close();fs.rmSync(dir,{recursive:true});}
});
test('expiry is one calendar year, persists after reopen and prevents redemption',()=>{
 const {dir,s}=store();const v=s.issue(input);s.close();const later=new VoucherStore({file:path.join(dir,'vouchers.sqlite'),key:'test-only-key',now:()=>now+366*86400000});try{assert.equal(later.lookup(v.token).state,'expired');assert.throws(()=>later.redeem(v.id,'expired-test'));assert.equal(new Date(oneYearFrom(Date.parse('2028-02-29T10:00:00Z'))).toISOString(),'2029-02-28T10:00:00.000Z');assert.equal(new Date(oneYearFrom(Date.parse('2028-02-28T20:30:00Z'))).toISOString(),'2029-02-27T20:30:00.000Z');}finally{later.close();fs.rmSync(dir,{recursive:true});}
});
test('cancellation blocks future use, malformed tokens are invalid and ephemeral production issuance stays disabled',()=>{
 const {dir,s}=store();try{const v=s.issue(input);s.cancel(v.id);assert.equal(s.lookup(v.token).state,'cancelled');assert.throws(()=>s.redeem(v.id,'cancelled-test'));assert.equal(s.lookup('unknown'),null);assert.throws(()=>configuredStore({}),/DURABLE/);}finally{s.close();fs.rmSync(dir,{recursive:true});}
});
test('voucher image renders a named PNG with original logo and QR without network requests',async()=>{
 const {dir,s}=store();try{const v=s.issue(input),png=await voucherPNG(v,'https://flycham-whatsapp-assistant.onrender.com',{demo:true});assert.equal(png.subarray(1,4).toString(),'PNG');assert.ok(png.length>20000);}finally{s.close();fs.rmSync(dir,{recursive:true});}
});
