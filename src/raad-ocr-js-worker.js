'use strict';
// Optional isolated child: local language data only. OCR text never leaves this
// process; the parent receives only a boolean. Never print errors or identity.
const sharp=require('sharp');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {td3InText}=require('./raad-mrz-locator');
const {scanWidths}=require('./raad-ocr-scan-widths');
let workerPromise,busy=false;
const guard=setInterval(()=>{if(process.memoryUsage().rss>350*1024*1024)process.exit(86);},100);guard.unref();
function getWorker(){
 if(!workerPromise)workerPromise=Promise.resolve().then(()=>{const {createWorker}=require('tesseract.js'),dir=path.join(__dirname,'..','assets','ocr'),file=path.join(dir,'mrz.traineddata.gz');const compressed=fs.readFileSync(file);if(compressed.length>2000000)throw Error('OFFLINE_DATA_INVALID');const model=zlib.gunzipSync(compressed,{maxOutputLength:2000000});if(crypto.createHash('sha256').update(model).digest('hex')!=='ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01')throw Error('OFFLINE_DATA_INVALID');return createWorker('mrz',1,{langPath:dir,gzip:true,cacheMethod:'none',logger:()=>{}});});
 return workerPromise;
}
process.on('message',async msg=>{
 if(!msg||msg.type!=='recognize'||!Number.isSafeInteger(msg.id)||!Buffer.isBuffer(msg.png)||msg.png.length>10*1024*1024||busy)return;
 busy=true;try{
  const meta=await sharp(msg.png,{limitInputPixels:20000000}).metadata();if(!meta.width||!meta.height)throw Error('INVALID_IMAGE');
  const height=Math.max(1,Math.floor(meta.height*.20));
  const w=await getWorker();await w.setParameters({tessedit_pageseg_mode:'6',tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'});
  const match=await scanWidths(async width=>{
   const crop=await sharp(msg.png,{limitInputPixels:20000000}).extract({left:0,top:meta.height-height,width:meta.width,height}).greyscale().normalise().resize({width,withoutEnlargement:false}).png().toBuffer();
   const recognized=await w.recognize(crop);
   return td3InText(recognized?.data?.text);
  });
  if(process.connected)process.send({id:msg.id,ok:true,match});
 }catch{if(process.connected)process.send({id:msg.id,ok:false});}finally{busy=false;}
});
process.on('disconnect',()=>{clearInterval(guard);process.exit(0);});
