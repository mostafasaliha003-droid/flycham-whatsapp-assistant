'use strict';

// Optional local OCR. This is a locator only: never returns recognized identity
// text, and never confirms applicant identity, dates or document authenticity.
const sharp=require('sharp');
const {parseTD3MRZ}=require('./raad-document-validation');
const rotations=Object.freeze([0,90,180,270]);
const checks=['documentNumber','birthDate','expiryDate','optionalData','composite'];
const result=(status,more={})=>({status,needsVisualReview:true,...more});

function td3InText(text){
 if(typeof text!=='string'||text.length>65536)return false;
 const lines=text.split(/\r?\n/).map(line=>line.trim().replace(/[ \t]/g,'').toUpperCase());
 for(let i=0;i<lines.length-1;i++){
  if(!/^P[A-Z<][A-Z0-9<]{42}$/.test(lines[i])||!/^[A-Z0-9<]{44}$/.test(lines[i+1]))continue;
  const parsed=parseTD3MRZ([lines[i],lines[i+1]]);
  if(parsed.format==='TD3'&&checks.every(name=>parsed.checks[name]?.ok===true)&&parsed.issues.every(issue=>issue.code==='ambiguous_century'))return true;
 }
 return false;
}

function bounded(promise,signal){
 if(signal.aborted)return Promise.reject(Error('OCR_TIMEOUT'));
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('OCR_TIMEOUT'));};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});});
}

// libvips work cannot be cancelled by aborting its JavaScript Promise. Await
// its settlement even after the deadline; the caller's watchdog retains the
// shared lock until this function and child cleanup have actually completed.
function rotatePage(bytes,rotation){return sharp(bytes,{limitInputPixels:20000000}).rotate(rotation).png().toBuffer();}

async function locatePassportMrz(pages,{recognize,timeoutMs=60000,rotate=rotatePage}={}){
 if(!Array.isArray(pages)||pages.length<1||pages.length>2||pages.some(p=>!p||!Number.isInteger(p.pageNumber)||p.pageNumber<1||p.pageNumber>2||!Buffer.isBuffer(p.bytes)||p.bytes.length>10*1024*1024)||new Set(pages.map(p=>p.pageNumber)).size!==pages.length||typeof recognize!=='function')return result('invalid_input');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||typeof rotate!=='function')return result('invalid_input');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),matches=[];
 try{
  for(const page of pages)for(const rotation of rotations){
   if(controller.signal.aborted)return result('timeout');
   const image=rotation?await rotate(page.bytes,rotation):page.bytes;
   if(controller.signal.aborted)return result('timeout');
   const text=await bounded(Promise.resolve().then(()=>recognize(image,{signal:controller.signal,pageNumber:page.pageNumber,rotation})),controller.signal);
   if(controller.signal.aborted)return result('timeout');
   if(text===true||td3InText(text))matches.push({page:page.pageNumber,rotation});
  }
  if(matches.length===1)return result('matched',{...matches[0]});
  return result(matches.length?'ambiguous':'not_found');
 }catch{return result(controller.signal.aborted?'timeout':'unavailable');}finally{clearTimeout(timer);controller.abort();}
}
async function detectPassportPage(pages,{timeoutMs=55000,engineFactory,rotate}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>55000)return result('invalid_input');
 let engine;try{engine=(engineFactory||require('./raad-ocr-js-process').createLocalOcrProcess)();if(!engine||typeof engine.recognize!=='function'||typeof engine.close!=='function')return result('unavailable');}catch{return result('unavailable');}
 let located;try{located=await locatePassportMrz(pages,{recognize:engine.recognize,timeoutMs,rotate});}catch{located=result('unavailable');}
 let cleaned=false;try{cleaned=await engine.close();}catch{}
 return cleaned===true?located:result('cleanup_unconfirmed');
}
module.exports={locatePassportMrz,detectPassportPage,td3InText};
