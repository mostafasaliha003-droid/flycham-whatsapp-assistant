'use strict';
const {rasterizePdfPages,cleanupStalePdfTemps}=require('./raad-pdf');
const {preparePortalImage}=require('./raad-attachments');
const sharedLock=require('./raad-preparation-lock');
const {safeOcrAdvisory}=require('./raad-ocr-advisory');

// A durable marker lives on the already-encrypted source record. The in-memory
// worker holds at most one job: further work is discovered from the bounded
// existing media index, not buffered as file bytes or an unbounded queue.
class VisaPdfAutoPreparer{
 constructor({media,store,lock=sharedLock,rasterize=rasterizePdfPages,prepare=preparePortalImage,cleanup=cleanupStalePdfTemps,detect=(pages,options)=>require('./raad-mrz-locator').detectPassportPage(pages,options),env=process.env,ocrWatchdogMs=60000,now=Date.now,report=()=>{}}={}){
  Object.assign(this,{media,store,lock,rasterize,prepare,cleanup,detect,now,report});this.ocrEnabled=env.RAAD_PDF_OCR_ENABLED==='true';this.ocrWatchdogMs=Number.isInteger(ocrWatchdogMs)&&ocrWatchdogMs>0&&ocrWatchdogMs<=60000?ocrWatchdogMs:60000;this.started=false;this.active=false;this.scheduled=false;this.unsubscribe=null;this.retryTimer=null;this.cleanupReady=false;this.needsRecovery=false;this.generation=0;
 }
 state(record,status,reason,advisory){const previous=record.pdfPreparation,attempts=Number.isSafeInteger(previous?.attempts)&&previous.attempts>=0?Math.min(previous.attempts,3):0;record.pdfPreparation={status,attempts:status==='running'?Math.min(attempts+1,3):attempts,...(reason?{reason}:{}),...(status==='ready'&&advisory?{advisory:safeOcrAdvisory(advisory)}:{}),updatedAt:this.now()};try{this.store.save();}catch{if(previous===undefined)delete record.pdfPreparation;else record.pdfPreparation=previous;throw Error('PDF_AUTO_STATE_FAILED');}}
 recover(){this.needsRecovery=false;for(const r of Object.values(this.media.records)){if(r?.mimeType==='application/pdf'&&r.expiresAt>this.now()&&r.pdfPreparation?.status==='running'){try{if((r.pdfPreparation.attempts||0)>=3)this.state(r,'failed','PDF_AUTO_RETRY_LIMIT');else this.state(r,'queued');}catch{this.needsRecovery=true;this.report('PDF_AUTO_STATE_FAILED');}}}return !this.needsRecovery;}
 start(){if(this.started)return;this.started=true;this.cleanupReady=false;const generation=++this.generation;this.unsubscribe=this.lock.onRelease(()=>this.wake());this.recover();Promise.resolve().then(()=>this.cleanup()).catch(()=>this.report('PDF_AUTO_CLEANUP_FAILED')).finally(()=>{if(this.started&&this.generation===generation){this.cleanupReady=true;this.wake();}});}
 stop(){this.started=false;this.generation++;this.unsubscribe?.();this.unsubscribe=null;if(this.retryTimer)clearTimeout(this.retryTimer);this.retryTimer=null;}
 enqueue(customer,id){
  const source=this.media.get(id,{customer});if(source.mimeType!=='application/pdf')return false;
  const record=this.media.records[id],status=record?.pdfPreparation?.status;
  if(['queued','running','ready','unsupported'].includes(status)||status==='failed'&&(record.pdfPreparation.attempts||0)>=3)return false;
  this.state(record,'queued');this.wake();return true;
 }
 nextQueued(){return Object.values(this.media.records).filter(r=>r?.mimeType==='application/pdf'&&r.expiresAt>this.now()&&r.pdfPreparation?.status==='queued').sort((a,b)=>(a.receivedAt||0)-(b.receivedAt||0))[0]||null;}
 wake(){if(!this.started||!this.cleanupReady||this.scheduled||this.active||this.retryTimer)return;if(this.needsRecovery&&!this.recover()){this.retry();return;}if(!this.nextQueued())return;this.scheduled=true;const handle=setImmediate(()=>{this.scheduled=false;if(!this.started)return;this.processOne().then(did=>{if(did)this.wake();}).catch(()=>{this.report('PDF_AUTO_WORKER_FAILED');this.retry();});});handle.unref?.();}
 retry(){if(!this.started||this.retryTimer)return;this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.wake();},5000);this.retryTimer.unref?.();}
 current(id,customer,epoch,generation){const r=this.media.records[id];if(!r||r.customer!==customer||(this.media.epochs.get(customer)||0)!==epoch||generation!==this.generation||r.expiresAt<=this.now()||r.mimeType!=='application/pdf')return null;return r;}
 async processOne(){
  if(this.active||!this.nextQueued()||!this.lock.tryAcquire())return false;
  this.active=true;let record,id,customer,epoch,retainLock=false,lateDetector=null;const generation=this.generation;
  try{
   record=this.nextQueued();
   if(!record)return false;id=record.id;customer=record.customer;epoch=this.media.epochs.get(customer)||0;
   if(!this.current(id,customer,epoch,generation))return false;
   this.state(record,'running');
   const source=this.media.read(id,{customer});const result=await this.rasterize(source.bytes);
   if(!Array.isArray(result.pages)||result.pages.length<1||result.pages.length>2)throw Error('PDF_PAGE_COUNT_UNSUPPORTED');
   let advisory;if(this.ocrEnabled){const detection=Promise.resolve().then(()=>this.detect(result.pages,{timeoutMs:55000}));let timer;const watchdog=new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),this.ocrWatchdogMs);});let outcome;try{outcome=await Promise.race([detection.then(value=>({value}),()=>({failed:true})),watchdog]);}finally{clearTimeout(timer);}const settled=['matched','ambiguous','not_found','unavailable','timeout','invalid_input'];if(outcome.timedOut||outcome.failed||!settled.includes(outcome.value?.status)){retainLock=true;if(outcome.timedOut)lateDetector=detection;this.report('PDF_AUTO_OCR_CLEANUP_UNCONFIRMED');record=this.current(id,customer,epoch,generation);if(record)this.state(record,'failed','PDF_AUTO_OCR_CLEANUP_UNCONFIRMED');return true;}advisory=safeOcrAdvisory(outcome.value,result.pages.map(page=>page.pageNumber));if(!this.current(id,customer,epoch,generation))return true;}
   for(const page of result.pages){
    if(!this.current(id,customer,epoch,generation))return true;
    if(!Number.isInteger(page.pageNumber)||page.pageNumber<1||page.pageNumber>2)throw Error('PDF_AUTO_RESULT_INVALID');
    const prepared=await this.prepare(page.bytes,{mimeType:'image/png',kind:'document'});
    if(!this.current(id,customer,epoch,generation))return true;
    this.media.storePdfPreview(customer,{sourceId:id,page:page.pageNumber,bytes:prepared.bytes,mimeType:prepared.mimeType});
   }
   record=this.current(id,customer,epoch,generation);if(record)this.state(record,'ready',undefined,advisory);return true;
  }catch(error){
   record=id&&this.current(id,customer,epoch,generation);if(record){const unsupported=error?.code==='PDF_PAGE_COUNT_UNSUPPORTED';try{this.state(record,unsupported?'unsupported':'failed',unsupported?'PDF_PAGE_COUNT_UNSUPPORTED':'PDF_AUTO_PREPARATION_FAILED');}catch{this.needsRecovery=true;this.report('PDF_AUTO_STATE_FAILED');this.retry();}}
   else if(!id)this.report('PDF_AUTO_WORKER_FAILED');return true;
  }finally{this.active=false;if(!retainLock)this.lock.release();else if(lateDetector)lateDetector.then(value=>{if(['matched','ambiguous','not_found','unavailable','timeout','invalid_input'].includes(value?.status))this.lock.release();},()=>{});}
 }
}
module.exports={VisaPdfAutoPreparer};
