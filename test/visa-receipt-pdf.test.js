'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {receiptText,isReceiptPdf}=require('../src/visa-receipt-pdf');
const {pdf,lines}=require('./helpers/receipt-pdf');
test('receipt identification requires an explicit title, reference and financial labels, excluding identity documents',()=>{assert.equal(receiptText(lines.join('\n')),true);for(const t of ['passport '+lines.join(' '),'Transfer Details Amount AED 700','Reference Number x Amount 700',lines.join(' ').repeat(2000)])assert.equal(receiptText(t),false);});
test('a digital PDF receipt is identified locally without OCR or exposing extracted values',async()=>{assert.equal(await isReceiptPdf(pdf(lines)),true);assert.equal(await isReceiptPdf(pdf(['SYRIAN PASSPORT','Name SYNTHETIC','Date of Birth 1990'])),false);assert.equal(await isReceiptPdf(Buffer.from('not a PDF')),false);});

