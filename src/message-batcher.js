'use strict';
const {normalize}=require('./arabic-dates');
function urgentMessage(message){
 return Boolean(message?.serviceChoice||message?.requestChoice)||/^(?:خلص[،, ]*(?:ابحث|ابدا)(?: هلق)?|ابدا هلق|وقف البحث|اوقف البحث|الغاء|احذف بياناتي|امسح بياناتي|حذف بياناتي|القائمة|القائمه|الخدمات|شو خدماتكم|شو صار|وين وصلت|وين وصلتوا|المزيد|باقي العروض|باقي الخيارات|(?:الخيار|العرض)\s*\d+|ثبتلي|بدي ثبت|حولني للموظف|شوف سعر شخص واحد|حسابكم البنكي|عنوان المكتب)[.!؟?]*$/.test(normalize(message?.text||'').replace(/\s+([.!؟?])/g,'$1'));
}
// One quiet window per customer. Webhook acknowledgement must never await it.
class MessageBatcher{
 constructor(handler,{delay=35000,maxWait=180000,now=Date.now,store=null,prepare=null,prepareDelay=10000,onError=()=>{}}={}){
  this.handler=handler;this.prepare=prepare;this.prepareDelay=prepareDelay;this.delay=delay;this.maxWait=Math.max(delay,maxWait);this.now=now;this.store=store;this.onError=onError;this.pending=new Map();this.running=new Map();this.active=new Map();this.flushing=new Map();this.voiceCarry=new WeakMap();
  for(const [id,item] of Object.entries(store?.data?.inbox||{})){if(Array.isArray(item.messages)&&item.messages.length)this.restore(id,item);}
 }
 persist(){if(this.store){const all=new Map();const add=(id,item)=>{const old=all.get(id);all.set(id,old?{firstAt:Math.min(old.firstAt,item.firstAt),lastAt:Math.max(old.lastAt,item.lastAt),messages:[...old.messages,...item.messages]}:item);};for(const [id,batches]of this.active)for(const item of batches.values())add(id,item);for(const [id,item]of this.pending)add(id,item);this.store.data.inbox=Object.fromEntries([...all].map(([id,i])=>[id,{messages:i.messages,firstAt:i.firstAt,lastAt:i.lastAt}]));this.store.save();}}
 restore(id,saved){const item={...saved,waiters:[]};this.pending.set(id,item);this.schedule(id,item);}
 schedule(id,item,flush=false){clearTimeout(item.timer);clearTimeout(item.prepareTimer);if(this.prepare&&!flush&&this.delay>this.prepareDelay)item.prepareTimer=setTimeout(()=>{Promise.resolve(this.prepare(id,item.messages.slice())).catch(()=>{});},this.prepareDelay);const wait=flush?0:Math.max(0,Math.min(item.lastAt+this.delay,item.firstAt+this.maxWait)-this.now());item.timer=setTimeout(()=>this.flush(id),wait);}
 push(id,message){if(this.delay===0)return this.serial(id,[message]);return new Promise((resolve,reject)=>{
  let item=this.pending.get(id);if(!item){item={messages:[],waiters:[],firstAt:this.now()};this.pending.set(id,item);}
  item.messages.push(message);item.messages=item.messages.slice(-50);item.waiters.push({resolve,reject});item.lastAt=this.now();this.persist();
  const urgent=urgentMessage(message);
  this.schedule(id,item,urgent);
 });}
 flush(id){const item=this.pending.get(id);if(!item)return Promise.resolve();clearTimeout(item.timer);clearTimeout(item.prepareTimer);const token=Symbol('batch');if(!this.active.has(id))this.active.set(id,new Map());this.active.get(id).set(token,item);this.pending.delete(id);this.persist();
  // Keep the durable inbox until the handler succeeds; remove only this batch.
  const work=this.serial(id,item.messages).then(v=>{const batches=this.active.get(id);batches?.delete(token);if(!batches?.size)this.active.delete(id);this.persist();item.waiters.forEach(w=>w.resolve(v));return v;},e=>{item.waiters.forEach(w=>w.reject(e));this.onError(e);throw e;});this.flushing.set(id,work);work.finally(()=>{if(this.flushing.get(id)===work)this.flushing.delete(id);}).catch(()=>{});work.catch(()=>{});return work;
 }
 serial(id,messages){const work=(this.running.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.handler(id,messages.map(message=>{
  const cached=this.voiceCarry.get(message);if(!cached)return message;this.voiceCarry.delete(message);
  const hydrated={...message,voiceDeferredEarlier:true};
  if(cached.transcript!==undefined){hydrated.text=cached.transcript;hydrated.voiceTranscript=true;delete hydrated.media;}
  return hydrated;
 })));this.running.set(id,work);return work.finally(()=>{if(this.running.get(id)===work)this.running.delete(id);});}
 // Move a wholly unprocessed turn to the next already-arrived compatible turn.
 // The caller may use this only before domain actions; queued arrays retain
 // their identity because serial() can already be waiting on that exact array.
 hasFollowingUnprocessed(id,messages){
  if(!Array.isArray(messages)||!messages.length)return false;
  const ids=messages.map(message=>message?.id),active=[...(this.active.get(id)?.values()||[])];
  const index=active.findIndex(item=>item.messages.length===ids.length&&item.messages.every(message=>ids.includes(message.id)));
  return index>=0&&Boolean(active[index+1]||this.pending.get(id));
 }
 deferUnprocessed(id,messages,{canMerge}={}){
  if(typeof canMerge!=='function'||!Array.isArray(messages)||!messages.length||messages.length>50)return false;
  const ids=messages.map(message=>message?.id);
  if(ids.some(value=>typeof value!=='string'||!value)||new Set(ids).size!==ids.length)return false;
  const active=[...(this.active.get(id)?.values()||[])];
  const sourceIndex=active.findIndex(item=>item.messages.length===ids.length&&item.messages.every(message=>ids.includes(message.id)));
  if(sourceIndex<0)return false;
  const source=active[sourceIndex],target=active[sourceIndex+1]||this.pending.get(id);
  if(!target||target===source||messages.length+target.messages.length>50||target.messages.some(message=>ids.includes(message.id))||!canMerge(messages,target.messages))return false;
  const sourceMessages=source.messages.slice(),targetMessages=target.messages.slice(),targetFirstAt=target.firstAt;
  // Persist only the original queue metadata. Completed, already-redacted
  // transcripts live in a WeakMap bounded by those original queued objects;
  // a restart safely retries their original audio instead of retaining speech.
  const priorCache=sourceMessages.map(message=>this.voiceCarry.get(message));
  for(const original of sourceMessages){const processed=messages.find(message=>message.id===original.id);this.voiceCarry.set(original,processed.voiceTranscript===true&&typeof processed.text==='string'&&processed.text.length<=4000?{transcript:processed.text}:{});}
  source.messages.splice(0);target.messages.unshift(...sourceMessages);target.firstAt=Math.min(source.firstAt,target.firstAt);
  try{this.persist();}catch(error){
   source.messages.splice(0,source.messages.length,...sourceMessages);target.messages.splice(0,target.messages.length,...targetMessages);target.firstAt=targetFirstAt;
   sourceMessages.forEach((message,index)=>{if(priorCache[index])this.voiceCarry.set(message,priorCache[index]);else this.voiceCarry.delete(message);});throw error;
  }
  if(this.pending.get(id)===target)this.schedule(id,target);
  return true;
 }
 async settled(id){for(;;){const item=this.pending.get(id);if(item)await new Promise(resolve=>item.waiters.push({resolve,reject:resolve}));const running=this.flushing.get(id)||this.running.get(id);if(running)await running.catch(()=>{});if(!this.pending.has(id)&&!this.running.has(id)&&!this.flushing.has(id))return;}}
 busy(id){return this.pending.has(id)||this.running.has(id)||this.flushing.has(id);}
 close(){for(const item of this.pending.values()){clearTimeout(item.timer);clearTimeout(item.prepareTimer);}this.persist();}
}
module.exports={MessageBatcher,urgentMessage};
