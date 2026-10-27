'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const fail=code=>Object.assign(Error(code),{code,statusCode:422});
async function rasterizePdf(bytes,{kind,page,rotation=0}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length>25*1024*1024||!bytes.subarray(0,1024).toString('latin1').trimStart().startsWith('%PDF-'))throw fail('PDF_INVALID');
 if(page!==undefined&&(!Number.isInteger(page)||page<1||page>10)||![0,90,180,270].includes(rotation))throw fail('PDF_INVALID');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'raad-pdf-'));
 try{
  const input=path.join(dir,'source.pdf');await fs.writeFile(input,bytes,{mode:0o600});
  let info;try{info=await run('pdfinfo',[input],{timeout:10000,maxBuffer:65536});}catch{throw fail('PDF_UNREADABLE');}
  const count=Number(info.stdout.match(/^Pages:\s*(\d+)\s*$/m)?.[1]);
  if(!Number.isSafeInteger(count)||count<1||count>10||kind==='residence'&&count>2)throw fail('PDF_PAGE_COUNT_UNSUPPORTED');
  if(page!==undefined&&(kind==='residence'||page>count))throw fail('PDF_INVALID');
  if(kind!=='residence'&&count!==1&&page===undefined)throw fail('PDF_PAGE_SELECTION_REQUIRED');
  const first=page||1,last=page||count;
  try{await run('pdftoppm',['-png','-scale-to','1800','-f',String(first),'-l',String(last),input,path.join(dir,'page')],{timeout:20000,maxBuffer:65536});}catch{throw fail('PDF_RENDER_FAILED');}
  const files=(await fs.readdir(dir)).filter(x=>/^page-\d+\.png$/.test(x)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  if(files.length!==last-first+1)throw fail('PDF_RENDER_FAILED');
  return await Promise.all(files.map(async f=>{let bytes=await fs.readFile(path.join(dir,f));if(rotation)bytes=await require('sharp')(bytes,{limitInputPixels:20000000}).rotate(rotation).png().toBuffer();return{bytes,mimeType:'image/png'};}));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
module.exports={rasterizePdf};
