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
// Neutral previews never choose a passport page or assert that a scanned page
// is upright. The same bounded, private rasterizer supports one or two pages.
async function rasterizePdfPages(bytes){
 const rendered=await rasterizePdf(bytes,{kind:'residence'});
 return {pageCount:rendered.length,pages:rendered.map((part,index)=>({pageNumber:index+1,bytes:part.bytes,mimeType:part.mimeType,orientationVerified:false,needsVisualReview:true}))};
}
// On restart, discard only old private rasterizer workspaces we own. Never
// follow links, recurse into unknown content, or disclose paths in reports.
async function cleanupStalePdfTemps({directory=os.tmpdir(),now=Date.now}={}){
 const uid=typeof process.getuid==='function'?process.getuid():null;
 if(uid===null)return{scanned:0,removed:0};
 const started=Date.now();let scanned=0,removed=0,root;
 try{
  root=await fs.opendir(directory);
  while(scanned<512&&Date.now()-started<2000){
   const item=await root.read();if(!item)break;scanned++;
   if(!item.isDirectory()||!/^raad-pdf-[A-Za-z0-9]+$/.test(item.name))continue;
   const target=path.join(directory,item.name);
   try{
    const info=await fs.lstat(target);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid||!Number.isFinite(info.mtimeMs)||now()-info.mtimeMs<30*60000)continue;
    const children=[];let sub;try{sub=await fs.opendir(target);while(children.length<=16&&Date.now()-started<2000){const c=await sub.read();if(!c)break;children.push(c);}}finally{try{await sub?.close();}catch{}}
    if(Date.now()-started>=2000||children.length>16||children.some(c=>!c.isFile()||!(/^(?:source\.pdf|page-\d+\.png)$/.test(c.name))))continue;
    let safe=true;for(const child of children){const s=await fs.lstat(path.join(target,child.name));if(!s.isFile()||s.isSymbolicLink()||s.uid!==uid){safe=false;break;}}
    if(!safe)continue;
    for(const child of children)await fs.unlink(path.join(target,child.name));
    await fs.rmdir(target);removed++;
   }catch{/* best effort: preserve unknown or concurrently changed entries */}
  }
 }catch{/* missing/unreadable temp root is not fatal */}
 finally{try{await root?.close();}catch{}}
 return{scanned,removed};
}
module.exports={rasterizePdf,rasterizePdfPages,cleanupStalePdfTemps};
