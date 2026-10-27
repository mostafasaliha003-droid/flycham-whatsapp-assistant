'use strict';

// One process-wide permit protects the small service from concurrent PDF and
// image processing. Queuing and retry policy belong to the caller, not the lock.
let held=false;
const listeners=new Set();
function isBusy(){return held;}
function tryAcquire(){if(held)return false;held=true;return true;}
function release(){
 if(!held)return;
 held=false;
 for(const listener of listeners)queueMicrotask(()=>{try{listener();}catch{}});
}
function onRelease(listener){if(typeof listener!=='function')throw TypeError('listener required');listeners.add(listener);return()=>listeners.delete(listener);}
module.exports={isBusy,tryAcquire,release,onRelease};
