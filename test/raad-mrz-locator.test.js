'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {locatePassportMrz,detectPassportPage}=require('../src/raad-mrz-locator');
function digit(value){return String([...value].reduce((sum,c,i)=>sum+(c==='<'?0:/\d/.test(c)?Number(c):c.charCodeAt(0)-55)*[7,3,1][i%3],0)%10);}
function synthetic(){const first='P<UTOEXAMPLE<<SYNTHETIC<PERSON'.padEnd(44,'<'),num='N12345678',birth='900115',expiry='310101',optional='<'.repeat(14);const body=num+digit(num)+'ZZZ'+birth+digit(birth)+'F'+expiry+digit(expiry)+optional+digit(optional);return[first,body+digit(body.slice(0,10)+body.slice(13,20)+body.slice(21,43))].join('\n');}
async function pages(){const bytes=await sharp({create:{width:320,height:240,channels:3,background:'white'}}).png().toBuffer();return[{pageNumber:1,bytes},{pageNumber:2,bytes}];}
test('only a unique checksum-valid MRZ identifies a page and orientation, without identity text',async()=>{const source=synthetic(),p=await pages();let calls=0;const out=await locatePassportMrz(p,{recognize:async(_,ctx)=>{calls++;return ctx.pageNumber===2&&ctx.rotation===90?source:'';}});assert.deepEqual(out,{status:'matched',needsVisualReview:true,page:2,rotation:90});assert.equal(calls,8);assert.doesNotMatch(JSON.stringify(out),/SYNTHETIC|N12345678/);});
test('multiple valid pages or orientations fail closed',async()=>{const source=synthetic(),p=await pages();assert.equal((await locatePassportMrz(p,{recognize:async(_,ctx)=>ctx.rotation===90?source:''})).status,'ambiguous');});
test('checksum failures, malformed lines and guessed OCR characters do not match',async()=>{const p=await pages(),bad=synthetic().replace('N12345678','N12345679');assert.equal((await locatePassportMrz(p,{recognize:async()=>bad})).status,'not_found');assert.equal((await locatePassportMrz(p,{recognize:async()=>synthetic().replace('N12345678','N1234567O')})).status,'not_found');});
test('engine error and hanging OCR fail closed with no identity output',async()=>{const p=await pages();assert.equal((await locatePassportMrz(p,{recognize:async()=>{throw Error('SECRET');}})).status,'unavailable');const out=await locatePassportMrz(p,{recognize:()=>new Promise(()=>{}),timeoutMs:20});assert.equal(out.status,'timeout');assert.doesNotMatch(JSON.stringify(out),/SECRET/);});
test('invalid page metadata does not invoke OCR',async()=>{let calls=0;const out=await locatePassportMrz([{pageNumber:1,bytes:Buffer.from('x')},{pageNumber:1,bytes:Buffer.from('x')}],{recognize:()=>{calls++;return '';}});assert.equal(out.status,'invalid_input');assert.equal(calls,0);});
test('isolated detector waits for child cleanup, discards matches if cleanup is unconfirmed',async()=>{let closed=0;const out=await detectPassportPage(await pages(),{engineFactory:()=>({recognize:async()=>false,close:async()=>{closed++;return false;}})});assert.equal(out.status,'cleanup_unconfirmed');assert.equal(closed,1);assert.equal((await detectPassportPage(await pages(),{engineFactory:()=>{throw Error('SECRET');}})).status,'unavailable');});
test('timed-out native image rotation settles before the detector reports cleanup',async()=>{
 let finish,started,closed=0,calls=0,settled=false;
 const entered=new Promise(resolve=>{started=resolve;});
 const pending=detectPassportPage(await pages(),{timeoutMs:10,rotate:()=>{started();return new Promise(resolve=>{finish=resolve;});},engineFactory:()=>({recognize:async()=>{calls++;return false;},close:async()=>{closed++;return true;}})}).then(value=>{settled=true;return value;});
 await entered;await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(settled,false);assert.equal(closed,0);assert.equal(calls,1);
 finish(Buffer.from('synthetic'));const out=await pending;
 assert.equal(out.status,'timeout');assert.equal(closed,1);assert.equal(calls,1);
});
