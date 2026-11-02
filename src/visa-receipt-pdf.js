'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
function receiptText(value){
 if(typeof value!=='string'||value.length>65536)return false;
 const t=value.normalize('NFKC').replace(/[\s_-]+/g,' ').toLowerCase();
 if(/passport|resident identity card|emirates identity card/.test(t))return false;
 return /transaction ?receipt|transfer ?details|transfer ?receipt|payment ?receipt|إيصال (?:تحويل|دفع)/.test(t)&&/amount|aed|مبلغ/.test(t)&&/(?:transaction|transfer|payment|reference)\s*(?:reference|number|no\b|id\b)|reference\s*(?:number|no\b|id\b)|beneficiary|transfer status|credit(?:ed)? account|المستفيد/.test(t);
}
async function isReceiptPdf(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>10*1024*1024||!bytes.subarray(0,1024).toString('latin1').trimStart().startsWith('%PDF-'))return false;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'raad-receipt-'));
 try{const input=path.join(dir,'receipt.pdf');await fs.writeFile(input,bytes,{mode:0o600});const result=await run('pdftotext',['-f','1','-l','2','-layout',input,'-'],{timeout:4000,maxBuffer:65536,windowsHide:true});return receiptText(result.stdout);}finally{await fs.rm(dir,{recursive:true,force:true});}
}
module.exports={isReceiptPdf,receiptText};
