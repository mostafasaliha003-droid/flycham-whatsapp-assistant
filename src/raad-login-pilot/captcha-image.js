'use strict';
// Transfer the already loaded bitmap, never OCR/read/solve it or refetch it.
async function readLoadedBitmap(el){
 const u=new URL(el.currentSrc||el.src,location.href);
 if(u.origin!=='https://visa.mofa.gov.sa'||u.pathname!=='/Base/GetRandomCaptchaImage')throw Error('UNTRUSTED_IMAGE');
 if(!el.complete||!el.naturalWidth||!el.naturalHeight)throw Error('IMAGE_NOT_READY');
 if(el.naturalWidth>2048||el.naturalHeight>2048||el.naturalWidth*el.naturalHeight>1000000)throw Error('IMAGE_TOO_LARGE');
 const canvas=document.createElement('canvas');canvas.width=el.naturalWidth;canvas.height=el.naturalHeight;
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('IMAGE_UNAVAILABLE');ctx.drawImage(el,0,0);return canvas.toDataURL('image/png');
}
async function captureCaptcha(page){
 const image=page.locator('#myform #imgCaptcha');if(await image.count()!==1||!await image.isVisible())throw Error('IMAGE_UNAVAILABLE');
 await page.waitForFunction(()=>{const img=document.querySelector('#myform #imgCaptcha');return img&&img.complete&&img.naturalWidth>0&&img.naturalHeight>0;},undefined,{timeout:10000});
 const data=await image.evaluate(readLoadedBitmap);
 if(typeof data!=='string'||data.length>280000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data))throw Error('IMAGE_INVALID');
 const bytes=Buffer.from(data.slice('data:image/png;base64,'.length),'base64');if(bytes.length<8||bytes.length>200000||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('IMAGE_INVALID');return bytes;
}
module.exports={captureCaptcha,readLoadedBitmap};
