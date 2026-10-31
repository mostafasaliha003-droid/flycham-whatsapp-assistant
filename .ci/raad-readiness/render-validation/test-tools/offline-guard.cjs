'use strict';
const fs=require('node:fs');function blocked(kind){if(process.env.OFFLINE_GUARD_LOG)fs.appendFileSync(process.env.OFFLINE_GUARD_LOG,JSON.stringify({kind})+'\n');throw Object.assign(Error('OFFLINE_GUARD_BLOCKED:'+kind),{code:'OFFLINE_GUARD_BLOCKED'});}
globalThis.fetch=()=>blocked('fetch');const net=require('node:net');net.Socket.prototype.connect=()=>blocked('socket');
for(const name of ['http','https']){const mod=require('node:'+name);for(const key of ['get','request'])mod[key]=()=>blocked(name);}
for(const object of [require('node:dns'),require('node:dns').promises])for(const key of Object.keys(object))if(/^(lookup|resolve|reverse)/.test(key)&&typeof object[key]==='function')object[key]=()=>blocked('dns');
const cp=require('node:child_process');for(const key of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])cp[key]=()=>blocked('child-process');require('node:dgram').createSocket=()=>blocked('udp');
