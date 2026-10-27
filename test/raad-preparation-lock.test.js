'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const lock=require('../src/raad-preparation-lock');
const {handleRaadRequest}=require('../src/raad-http');

test('exclusive permit notifies queue after release and supports unsubscribe',async()=>{
 lock.release();let notifications=0;const off=lock.onRelease(()=>notifications++);
 assert.equal(lock.tryAcquire(),true);assert.equal(lock.isBusy(),true);assert.equal(lock.tryAcquire(),false);
 lock.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(notifications,1);assert.equal(lock.isBusy(),false);
 off();assert.equal(lock.tryAcquire(),true);lock.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(notifications,1);
});

test('manual preparation rejects while background holds permit, without reading media',async()=>{
 lock.release();assert.equal(lock.tryAcquire(),true);let status,data,reads=0;
 const response={writeHead(value){status=value;return this},end(value){data=JSON.parse(value);}};
 const body={action:'prepare_image',confirm:true,kind:'passport',sourceIds:['synthetic']};
 try{await handleRaadRequest({method:'POST'},response,new URL('https://example.test/internal/assistant/raad/971500000001'),{
  readBody:async()=>Buffer.from(JSON.stringify(body)),inbox:{requireCustomer(){},isOperatorOwned(){return true}},mediaStore:{read(){reads++;}},workflow:{}
 });assert.equal(status,409);assert.equal(data.error,'RAAD_PREPARATION_BUSY');assert.equal(reads,0);assert.equal(lock.isBusy(),true);}
 finally{lock.release();}
});

test('manual failed preparation releases permit for future work',async()=>{
 lock.release();let status;const response={writeHead(value){status=value;return this},end(){}};
 const body={action:'prepare_image',confirm:true,kind:'passport',sourceIds:['synthetic']};
 await handleRaadRequest({method:'POST'},response,new URL('https://example.test/internal/assistant/raad/971500000001'),{
  readBody:async()=>Buffer.from(JSON.stringify(body)),inbox:{requireCustomer(){},isOperatorOwned(){return true}},mediaStore:{read(){throw Error('MEDIA_NOT_FOUND');}},workflow:{}
 });assert.equal(status,404);assert.equal(lock.isBusy(),false);
});
