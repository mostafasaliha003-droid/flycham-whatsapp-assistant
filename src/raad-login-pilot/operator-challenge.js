'use strict';
const {randomUUID,createHash}=require('node:crypto');
const fail=code=>Object.assign(Error(code),{code});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function createOperatorGate({capture,checkLease,now=Date.now,ttlMs=300000}){
 const active=r=>{const o=r.operator;if(!o||r.cancelled||r.controller.signal.aborted||r.stage!=='waiting_operator'||o.expiresAt<=now()||o.claimed)throw fail('OPERATOR_CHALLENGE_STALE');return o;};
 return {
  wait(r,kind){
   if(!['login','form'].includes(kind)||r.operator)throw fail('OPERATOR_CHALLENGE_INVALID');
   return new Promise((resolve,reject)=>{
    const o={id:randomUUID(),kind,expiresAt:now()+ttlMs,imageId:null,claimed:false};r.operator=o;r.stage='waiting_operator';
    let timer;const finish=(error,value)=>{clearTimeout(timer);r.controller.signal.removeEventListener('abort',abort);if(r.operator===o)delete r.operator;if(!r.cancelled)r.stage='running';error?reject(error):resolve(value);};
    const abort=()=>finish(fail('JOB_CANCELLED'));o.resolve=value=>finish(null,value);o.reject=finish;
    r.controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>finish(fail('OPERATOR_CHALLENGE_EXPIRED')),ttlMs);timer.unref?.();if(r.controller.signal.aborted)abort();
   });
  },
  async image(r){const o=active(r);await checkLease(r);const bytes=await capture(r,o.kind);try{await checkLease(r);if(active(r)!==o||!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>200000||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fail('OPERATOR_IMAGE_UNCONFIRMED');o.imageId=hash(bytes);return{challengeId:o.id,kind:o.kind,expiresAt:o.expiresAt,imageId:o.imageId,image:'data:image/png;base64,'+bytes.toString('base64')};}finally{bytes?.fill(0);}},
  async submit(r,input){
   const o=active(r);if(!input||Object.keys(input).sort().join(',')!=='challengeId,imageId,value'||input.challengeId!==o.id||!o.imageId||input.imageId!==o.imageId||typeof input.value!=='string'||!/^[A-Za-z0-9]{1,32}$/.test(input.value))throw fail('OPERATOR_INPUT_INVALID');
   await checkLease(r);const bytes=await capture(r,o.kind);try{await checkLease(r);if(active(r)!==o||hash(bytes)!==input.imageId)throw fail('OPERATOR_IMAGE_CHANGED');o.claimed=true;let value=input.value;input.value='';o.resolve({value,imageId:o.imageId});value='';return{accepted:true};}finally{bytes?.fill(0);input.value='';}
  }
 };
}
module.exports={createOperatorGate};
