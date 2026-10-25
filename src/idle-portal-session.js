'use strict';

// The controller can release an idle browser without stopping the queue
// consumer. Its factory owns authentication and complete runtime cleanup.
class IdlePortalSession{
 constructor({open,now=Date.now,idleMs=5*60*1000,report=()=>{}}={}){
  if(typeof open!=='function'||typeof now!=='function'||!Number.isSafeInteger(idleMs)||idleMs<0)throw Error('PORTAL_IDLE_CONFIGURATION_INVALID');
  this.open=open;this.now=now;this.idleMs=idleMs;this.report=report;this.lastCompletedWorkAt=null;
  this._runtime=null;this._opening=null;this._closing=null;this._wakeAfterClose=null;this._stopPromise=null;this._stopping=false;this._authBlocked=false;this._state='dormant';this._inFlight=0;this._runs=new Set();this._beforeClose=null;
 }
 emit(code){try{this.report(code);}catch{}}
 get closed(){return this._stopping;}
 get authBlocked(){return this._authBlocked||this._runtime?.session?.authBlocked===true;}
 get dormant(){return !this._stopping&&!this.authBlocked&&!this._runtime&&!this._opening&&!this._closing&&this._state==='dormant';}
 get adapter(){return !this._closing&&!this._stopping?this._runtime?.session?.adapter||null:null;}
 block(){if(this._stopping)return;this._authBlocked=true;this._state='blocked';this.emit('PORTAL_IDLE_SESSION_BLOCKED');}
 setBeforeClose(callback){if(callback!==null&&typeof callback!=='function')throw Error('PORTAL_IDLE_CONFIGURATION_INVALID');this._beforeClose=callback;}
 isReady(){
  if(this._stopping||this.authBlocked||this._opening||this._closing||!this._runtime)return false;
  try{return this._runtime.session.closed!==true&&this._runtime.session.isReady()===true;}catch{return false;}
 }
 healthStatus(){
  let state=this._stopping?'closed':this.authBlocked?'blocked':this._opening?'starting':this.isReady()?'ready':this.dormant?'dormant':'unavailable';
  let inner;try{inner=this._runtime?.session?.healthStatus?.();}catch{}
  const at=Number.isFinite(inner?.lastSuccessfulActivityAt)?inner.lastSuccessfulActivityAt:null;
  return {state,authBlocked:this.authBlocked,closed:this.closed,lastSuccessfulActivityAt:at,lastSuccessfulActivityAgeMs:at===null?null:Math.max(0,this.now()-at),lastCompletedWorkAt:this.lastCompletedWorkAt,idleMs:this.idleMs};
 }
 ensureAwake(){
  if(this._stopping)return Promise.reject(Error('PORTAL_IDLE_SESSION_CLOSED'));
  if(this.authBlocked)return Promise.reject(Error('PORTAL_IDLE_SESSION_BLOCKED'));
  if(this._closing){
   if(!this._wakeAfterClose){
    let wake;wake=this._closing.then(()=>this.ensureAwake()).finally(()=>{if(this._wakeAfterClose===wake)this._wakeAfterClose=null;});this._wakeAfterClose=wake;
   }
   return this._wakeAfterClose;
  }
  if(this._opening)return this._opening;
  if(this._runtime)return this.isReady()?Promise.resolve(this._runtime.session):Promise.reject(Error('PORTAL_IDLE_SESSION_UNAVAILABLE'));
  this._state='starting';this.emit('PORTAL_IDLE_OPEN_STARTED');
  let opening;
  opening=Promise.resolve().then(async()=>{
   let candidate,cleanupAttempted=false;
   try{
    candidate=await this.open();
    if(!candidate||typeof candidate.close!=='function'||!candidate.session||typeof candidate.session.run!=='function'||typeof candidate.session.isReady!=='function')throw Error('PORTAL_IDLE_RUNTIME_INVALID');
    this._runtime=candidate;
    if(this._stopping){cleanupAttempted=true;await this.closeRuntime(candidate);throw Error('PORTAL_IDLE_SESSION_CLOSED');}
    if(this._authBlocked||candidate.session.closed===true||candidate.session.authBlocked===true||candidate.session.isReady()!==true){cleanupAttempted=true;await this.closeRuntime(candidate);throw Error('PORTAL_IDLE_RUNTIME_NOT_READY');}
    this.lastCompletedWorkAt=this.now();this._state='ready';this.emit('PORTAL_IDLE_OPEN_READY');return candidate.session;
   }catch{
    // Partial resources thrown by the factory are its responsibility. A
    // returned but invalid runtime is closed here whenever that is possible.
    if(candidate&&typeof candidate.close==='function'&&!cleanupAttempted){try{await this.closeRuntime(candidate);}catch{}}
    if(this._stopping){this._state='closed';throw Error('PORTAL_IDLE_SESSION_CLOSED');}
    this._authBlocked=true;this._state='blocked';this.emit('PORTAL_IDLE_OPEN_BLOCKED');throw Error('PORTAL_IDLE_SESSION_BLOCKED');
   }
  }).finally(()=>{if(this._opening===opening)this._opening=null;});
  this._opening=opening;return opening;
 }
 run(task,options){
  if(this._stopping)return Promise.reject(Error('PORTAL_IDLE_SESSION_CLOSED'));
  if(typeof task!=='function')return Promise.reject(Error('PORTAL_IDLE_TASK_INVALID'));
  this._inFlight++;
  let work;work=Promise.resolve().then(async()=>{const session=await this.ensureAwake();return session.run(task,options);}).finally(()=>{
   this._inFlight--;this._runs.delete(work);this.lastCompletedWorkAt=this.now();if(this._runtime?.session?.authBlocked===true){this._authBlocked=true;this._state='blocked';}
  });
  this._runs.add(work);return work;
 }
 closeRuntime(runtime){
  if(this._closing)return this._closing;
  this._authBlocked ||=runtime.session?.authBlocked===true;this._state='unavailable';this.emit('PORTAL_IDLE_CLOSE_STARTED');
  let closing;closing=Promise.resolve().then(async()=>{
   let failed=false;
   try{if(this._beforeClose)await this._beforeClose();}catch{failed=true;}
   try{await runtime.close();}catch{failed=true;}
   if(failed){this._authBlocked=true;this._state=this._stopping?'closed':'blocked';this.emit('PORTAL_IDLE_CLOSE_FAILED');throw Error('PORTAL_IDLE_SESSION_CLOSE_FAILED');}
   if(this._runtime===runtime)this._runtime=null;
   this._state=this._stopping?'closed':this._authBlocked?'blocked':'dormant';this.emit('PORTAL_IDLE_CLOSED');return true;
  }).finally(()=>{if(this._closing===closing)this._closing=null;});
  this._closing=closing;return closing;
 }
 closeIfIdle(){
  if(this._stopping||this._opening||this._inFlight)return Promise.resolve(false);
  if(this._closing)return this._closing;
  const runtime=this._runtime;if(!runtime||runtime.session.pending>0||this.lastCompletedWorkAt===null||this.now()-this.lastCompletedWorkAt<this.idleMs)return Promise.resolve(false);
  return this.closeRuntime(runtime);
 }
 stop(){
  if(this._stopPromise)return this._stopPromise;
  this._stopping=true;this._state='closed';
  this._stopPromise=Promise.resolve().then(async()=>{
   if(this._opening)await this._opening.catch(()=>{});
   await Promise.allSettled([...this._runs]);
   if(this._closing)await this._closing;
   if(this._runtime)await this.closeRuntime(this._runtime);
   this._state='closed';
  });return this._stopPromise;
 }
}
module.exports={IdlePortalSession};
