'use strict';
const APPLICATION_TTL=30*60*1000;
function beginApplicationWindow(job,{now=Date.now,close,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if(!job||typeof close!=='function'||typeof now!=='function')return false;
 const at=now();if(!Number.isFinite(at)||job.expires<=at||job.controller?.signal.aborted||['closing','cleanup_unconfirmed'].includes(job.stage)||job.verificationStatus!=='submitted'||job.applicationWindowStartedAt!==undefined)return false;
 try{const u=new URL(job.page.url());if(u.origin!=='https://visa.mofa.gov.sa'||u.pathname!=='/SmartForm/TraditionalApp'||u.username||u.password)return false;}catch{return false;}
 clearTimer(job.timer);job.applicationWindowStartedAt=at;job.expires=at+APPLICATION_TTL;job.timer=setTimer(()=>{void close();},APPLICATION_TTL);job.timer?.unref?.();return true;
}
module.exports={beginApplicationWindow,APPLICATION_TTL};
