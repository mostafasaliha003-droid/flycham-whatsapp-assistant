'use strict';
const fs=require('node:fs');
function deny(kind){if(process.env.STATE_COMPAT_GUARD_LOG)fs.appendFileSync(process.env.STATE_COMPAT_GUARD_LOG,JSON.stringify({kind})+'\n');throw Error('STATE_COMPAT_EXTERNAL_ACTION_FORBIDDEN:'+kind);}
globalThis.fetch=()=>deny('fetch');
for(const n of ['node:http','node:https'])for(const k of ['get','request'])require(n)[k]=()=>deny(n+'.'+k);
require('node:net').Socket.prototype.connect=()=>deny('net.connect');require('node:net').Server.prototype.listen=()=>deny('net.listen');
require('node:tls').connect=()=>deny('tls.connect');require('node:dgram').createSocket=()=>deny('dgram');
for(const obj of [require('node:dns'),require('node:dns').promises])for(const k of Object.keys(obj))if(/^(lookup|resolve|reverse)/.test(k)&&typeof obj[k]==='function')obj[k]=()=>deny('dns.'+k);
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[k]=()=>deny('child_process.'+k);
require('node:worker_threads').Worker=class{constructor(){deny('worker_threads.Worker');}};
