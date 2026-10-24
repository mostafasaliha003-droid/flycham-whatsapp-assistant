'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {defaultStateFile,persistentMount}=require('./state-storage');
// Optional encrypted snapshot. An ephemeral path is NOT durable Render storage.
class AssistantState{
 constructor({file=defaultStateFile(),key=process.env.ASSISTANT_STATE_KEY||process.env.WHATSAPP_APP_SECRET,now=Date.now}={}){this.file=file;this.now=now;this.data={customers:{},handoffs:[],deliveries:[]};this.key=key?crypto.createHash('sha256').update(key).digest():null;if(file&&!this.key)throw Error('STATE_ENCRYPTION_KEY_REQUIRED');if(file&&fs.existsSync(file)){const b=fs.readFileSync(file),d=crypto.createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));this.data=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}this.prune();}
 prune(){const cutoff=this.now()-30*86400000;for(const [k,v]of Object.entries(this.data.customers))if(v.at<cutoff)delete this.data.customers[k];this.data.deliveries=this.data.deliveries.slice(-1000);this.data.handoffs=this.data.handoffs.filter(h=>h.at>=cutoff).slice(-100);}
 get(id){return this.data.customers[id];}
 set(id,value){this.data.customers[id]={...value,at:this.now()};this.save();}
 delete(id){delete this.data.customers[id];if(Array.isArray(this.data.outbox))this.data.outbox=this.data.outbox.filter(x=>x.recipient!==id);this.data.handoffs=this.data.handoffs.filter(h=>h.customer!==id);this.save();}
 save(){this.prune();if(!this.file)return;fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',this.key,iv);const encrypted=Buffer.concat([c.update(JSON.stringify(this.data)),c.final()]);const tmp=this.file+'.tmp';fs.writeFileSync(tmp,Buffer.concat([iv,c.getAuthTag(),encrypted]),{mode:0o600,flush:true});fs.renameSync(tmp,this.file);if(process.platform==='linux'){const fd=fs.openSync(path.dirname(this.file),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
 delivery(id,state){this.data.deliveries.push({id:crypto.createHash('sha256').update(id).digest('hex'),state,at:this.now()});this.save();}
 handoff(customer,summary){const id=crypto.randomUUID();this.data.handoffs.push({id,customer,summary,state:'pending',at:this.now()});this.save();return id;}
 status(){return{storage:this.file?'encrypted-file':'memory',durableStorageConfirmed:persistentMount(this.file),customers:Object.keys(this.data.customers).length,pendingHandoffs:this.data.handoffs.filter(h=>h.state==='pending').length};}
}
module.exports={AssistantState};
