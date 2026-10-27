'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {scanWidths}=require('../src/raad-ocr-scan-widths');

test('stops after a verified match at the first scale',async()=>{
 const widths=[];
 assert.equal(await scanWidths(async width=>{widths.push(width);return true;}),true);
 assert.deepEqual(widths,[1000]);
});

test('falls back once and returns a strict boolean only on verified match',async()=>{
 const widths=[];
 assert.equal(await scanWidths(async width=>{widths.push(width);return width===1800;}),true);
 assert.deepEqual(widths,[1000,1800]);
 assert.equal(await scanWidths(async()=>false),false);
 assert.equal(await scanWidths(async()=>({matched:true})),false);
});

test('does not conceal a failed OCR process',async()=>{
 await assert.rejects(scanWidths(async()=>{throw Error('unavailable');}),/unavailable/);
});
