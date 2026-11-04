'use strict';
const {normalize}=require('./arabic-dates');
function urgentMessage(message){
 return Boolean(message?.serviceChoice||message?.requestChoice)||/^(?:خلص[،, ]*(?:ابحث|ابدا)(?: هلق)?|ابدا هلق|وقف البحث|اوقف البحث|الغاء|احذف بياناتي|امسح بياناتي|حذف بياناتي|القائمة|القائمه|الخدمات|شو خدماتكم|شو صار|وين وصلت|وين وصلتوا|المزيد|باقي العروض|باقي الخيارات|(?:الخيار|العرض)\s*\d+|ثبتلي|بدي ثبت|حولني للموظف|شوف سعر شخص واحد|حسابكم البنكي|عنوان المكتب)[.!؟?]*$/.test(normalize(message?.text||'').replace(/\s+([.!؟?])/g,'$1'));
}
// One quiet window per customer. Webhook acknowledgement must never await it.
class MessageBatcher{
 constructor(handler,{delay=35000,maxWait=180000,now=Date.now,store=null,prepare=null,prepareDelay=10000,onError=()=>{}}={}){
  this.handler=handler;this.prepare=prepare;this.prepareDelay=prepareDelay;this.delay=delay;this.maxWait=Math.max(delay,maxWait);this.now=now;this.store=store;this.onError=onError;this.pending=new Map();this.running=new Map();this.active=new Map();this.flushing=new Map();
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
 serial(id,messages){const work=(this.running.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.handler(id,messages));this.running.set(id,work);return work.finally(()=>{if(this.running.get(id)===work)this.running.delete(id);});}
 async settled(id){for(;;){const item=this.pending.get(id);if(item)await new Promise(resolve=>item.waiters.push({resolve,reject:resolve}));const running=this.flushing.get(id)||this.running.get(id);if(running)await running.catch(()=>{});if(!this.pending.has(id)&&!this.running.has(id)&&!this.flushing.has(id))return;}}
 busy(id){return this.pending.has(id)||this.running.has(id)||this.flushing.has(id);}
 close(){for(const item of this.pending.values()){clearTimeout(item.timer);clearTimeout(item.prepareTimer);}this.persist();}
}
module.exports={MessageBatcher,urgentMessage};
