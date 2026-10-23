'use strict';
const {run}=require('./airarabia-worker');
const {runFlyCham}=require('./flycham-worker');
// Separate browser sessions and queues, within the existing compute allocation.
Promise.allSettled([run(),runFlyCham()]).then(results=>{if(results.some(r=>r.status==='rejected')){console.error('PORTAL_WORKER_STOPPED');process.exitCode=1;}});
