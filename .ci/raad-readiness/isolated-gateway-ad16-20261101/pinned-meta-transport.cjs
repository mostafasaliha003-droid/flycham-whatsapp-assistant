'use strict';
// Low-level future adapter only. No listener, automatic activation or credential loader.
const https=require('node:https');
const {OWNER,TEXT}=require('./owner-test-boundary.cjs');
function fail(code){throw Object.assign(Error(code),{code});}
function createPinnedMetaTransport({enabled=false,allowNetwork=false,config={},requestImpl,now=Date.now,timeoutMs=10000}={}){
  const c=Object.freeze({...config}),att=Object.freeze({...config.attestation});
  const injected=typeof requestImpl==='function';
  const request=injected?requestImpl:https.request;
  let attempts=0;
  const ready=enabled===true&&(injected||allowNetwork===true)&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=10000
    &&/^v[1-9][0-9]\.[0-9]+$/.test(c.graphVersion||'')&&/^[0-9]{5,30}$/.test(c.phoneNumberId||'')
    &&typeof c.accessToken==='string'&&c.accessToken.length>=32&&c.accessToken.length<=4096&&!/[\r\n]/.test(c.accessToken)
    &&att.kind==='operator_verified_dedicated_test_identity'&&att.owner===OWNER&&att.phoneNumberId===c.phoneNumberId
    &&att.zeroCostEligible===true&&Number.isSafeInteger(att.verifiedAt)&&Number.isSafeInteger(att.expiresAt)
    &&att.expiresAt>att.verifiedAt&&att.expiresAt-att.verifiedAt<=300000;
  async function sendOwnerText(input){
    if(!ready)fail('META_TEST_TRANSPORT_DISABLED');
    const validTime=()=>{const at=now();return Number.isSafeInteger(at)&&at>=att.verifiedAt&&at<att.expiresAt;};
    if(!validTime())fail('META_TEST_ATTESTATION_EXPIRED');
    if(input?.owner!==OWNER||!Object.hasOwn(TEXT,input?.purpose)||input.text!==TEXT[input.purpose])fail('META_TEST_MESSAGE_SCOPE_INVALID');
    if(attempts>=2)fail('META_TEST_MESSAGE_LIMIT');
    attempts++;
    const body=Buffer.from(JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:OWNER,type:'text',text:{preview_url:false,body:TEXT[input.purpose]}}));
    return new Promise((resolve,reject)=>{
      let settled=false,req,res;
      const end=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){req?.destroy?.();res?.destroy?.();reject(Object.assign(Error(error),{code:error}));}else resolve(value);};
      const timer=setTimeout(()=>end('META_TEST_REQUEST_UNCERTAIN'),timeoutMs);
      const options={protocol:'https:',hostname:'graph.facebook.com',port:443,
        path:'/'+c.graphVersion+'/'+c.phoneNumberId+'/messages',method:'POST',
        rejectUnauthorized:true,minVersion:'TLSv1.2',timeout:timeoutMs,
        headers:{Authorization:'Bearer '+c.accessToken,'Content-Type':'application/json','Content-Length':body.length}};
      try{req=request(options,response=>{
        res=response;
        if(res.statusCode!==200){end('META_TEST_RESPONSE_UNCONFIRMED');return;}
        let bytes=0,parts=[];
        res.on('data',chunk=>{if(settled)return;if(!Buffer.isBuffer(chunk)){end('META_TEST_RESPONSE_UNCONFIRMED');return;}bytes+=chunk.length;if(bytes>16384){end('META_TEST_RESPONSE_TOO_LARGE');return;}parts.push(chunk);});
        res.on('error',()=>end('META_TEST_RESPONSE_UNCONFIRMED'));
        res.on('aborted',()=>end('META_TEST_RESPONSE_UNCONFIRMED'));
        res.on('close',()=>{if(!settled)end('META_TEST_RESPONSE_UNCONFIRMED');});
        res.on('end',()=>{
          if(!validTime()){end('META_TEST_ATTESTATION_EXPIRED');return;}
          let value;try{value=JSON.parse(Buffer.concat(parts).toString());}catch{end('META_TEST_RESPONSE_UNCONFIRMED');return;}
          const id=Array.isArray(value?.messages)&&value.messages.length===1?value.messages[0]?.id:null;
          if(value?.messaging_product!=='whatsapp'||!Array.isArray(value.contacts)||value.contacts.length!==1||value.contacts[0]?.wa_id!==OWNER
              ||typeof id!=='string'||!/^[A-Za-z0-9._=+/-]{8,256}$/.test(id)){end('META_TEST_RESPONSE_UNCONFIRMED');return;}
          end(null,Object.freeze({recipient:OWNER,messageId:id}));
        });
      });
      req.on('error',()=>end('META_TEST_REQUEST_UNCERTAIN'));
      req.on('timeout',()=>{req.destroy?.();end('META_TEST_REQUEST_UNCERTAIN');});
      req.end(body);
      }catch{end('META_TEST_REQUEST_UNCERTAIN');}
    });
  }
  return Object.freeze({kind:injected?'offline_injected':'native_https_unwired',sendOwnerText,
    status:()=>Object.freeze({enabled:ready,attempts,maximumAttempts:2,automaticRetries:false,
      actualProviderIdentityVerifiedByThisModule:false,attestationSource:'operator',
      nativeHttps:!injected,applicationHandoffImplemented:false})});
}
module.exports={createPinnedMetaTransport};
