'use strict';
// Standalone fixture fence. This is JavaScript instrumentation, not an OS sandbox.
const fs=require('node:fs');
function deny(kind){return function(){if(process.env.SLICE_GUARD_LOG)fs.appendFileSync(process.env.SLICE_GUARD_LOG,JSON.stringify({kind})+'\n');throw Object.assign(Error('SLICE_EXTERNAL_ACTION_FORBIDDEN'),{code:'SLICE_EXTERNAL_ACTION_FORBIDDEN'});};}
globalThis.fetch=deny('global.fetch');
for(const name of ['node:http','node:https'])for(const key of ['get','request'])require(name)[key]=deny(name+'.'+key);
const net=require('node:net');net.Socket.prototype.connect=deny('net.connect');net.Server.prototype.listen=deny('net.listen');
require('node:tls').connect=deny('tls.connect');require('node:dgram').createSocket=deny('dgram.createSocket');
for(const object of [require('node:dns'),require('node:dns').promises])for(const key of Object.keys(object))if(/^(lookup|resolve|reverse)/.test(key)&&typeof object[key]==='function')object[key]=deny('dns.'+key);
for(const key of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'])require('node:child_process')[key]=deny('child_process.'+key);
