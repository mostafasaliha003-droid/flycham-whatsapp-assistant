'use strict';
const {createHash}=require('node:crypto');
const ORIGIN='https://visa.mofa.gov.sa';
const MAX_BYTES=500000;
const REDACTION='input, textarea, select, [contenteditable="true"], iframe, [data-secret]';
function fail(){throw Object.assign(Error('LIVE_VIEW_UNAVAILABLE'),{code:'LIVE_VIEW_UNAVAILABLE'});}
async function captureLiveFrame(page,{guard,phase,now=Date.now}={}){
 await guard();const url=new URL(page.url());if(url.origin!==ORIGIN||url.username||url.password||page.isClosed())fail();
 const viewport=page.viewportSize();if(!viewport||!Number.isInteger(viewport.width)||!Number.isInteger(viewport.height)||viewport.width<1||viewport.width>1920||viewport.height<1||viewport.height>1200)fail();
 let bytes;
 try{
  // Screenshot-only: no navigation, field writes, clicks, script evaluation,
  // persistent screenshots or unmasked form/iframe content.
  bytes=await page.screenshot({type:'jpeg',quality:50,fullPage:false,timeout:3500,caret:'hide',mask:[page.locator(REDACTION)],maskColor:'#152137'});
  await guard();const after=new URL(page.url());if(after.origin!==ORIGIN||after.username||after.password||page.isClosed()||!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>MAX_BYTES||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail();
  return {active:true,readOnly:true,redacted:true,phase,capturedAt:now(),width:viewport.width,height:viewport.height,mimeType:'image/jpeg',sha256:createHash('sha256').update(bytes).digest('hex'),image:'data:image/jpeg;base64,'+bytes.toString('base64')};
 }finally{bytes?.fill(0);}
}
module.exports={captureLiveFrame,MAX_BYTES,REDACTION};
