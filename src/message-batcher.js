'use strict';
class MessageBatcher{
 constructor(handler,{delay=4000}={}){this.handler=handler;this.delay=delay;this.pending=new Map();this.running=new Map();}
 push(id,message){if(this.delay===0)return this.serial(id,[message]);return new Promise((resolve,reject)=>{let item=this.pending.get(id);if(!item){item={messages:[],waiters:[]};this.pending.set(id,item);}clearTimeout(item.timer);item.messages.push(message);item.waiters.push({resolve,reject});item.timer=setTimeout(()=>{this.pending.delete(id);this.serial(id,item.messages).then(v=>item.waiters.forEach(w=>w.resolve(v)),e=>item.waiters.forEach(w=>w.reject(e)));},this.delay);});}
 serial(id,messages){const work=(this.running.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.handler(id,messages));this.running.set(id,work);return work.finally(()=>{if(this.running.get(id)===work)this.running.delete(id);});}
}
module.exports={MessageBatcher};
