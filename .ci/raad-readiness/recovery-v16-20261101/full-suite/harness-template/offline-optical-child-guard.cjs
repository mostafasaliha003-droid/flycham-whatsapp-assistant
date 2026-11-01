'use strict';
const fs=require('node:fs'),{isMainThread,threadId}=require('node:worker_threads');
const {blocked}=require('./offline-loopback-guard.cjs');
// The optical process needs only IPC, local files and its local WASM thread.
const deny=method=>()=>blocked('optical-child-network',method);
globalThis.fetch=deny('fetch');
const net=require('node:net');net.Socket.prototype.connect=deny('net.connect');net.Server.prototype.listen=deny('net.listen');
for(const name of ['node:http','node:https'])for(const method of ['get','request'])require(name)[method]=deny(name+'.'+method);
require('node:tls').connect=deny('tls.connect');require('node:dgram').createSocket=deny('dgram.createSocket');
for(const object of [require('node:dns'),require('node:dns').promises])for(const key of Object.keys(object))if(/^(lookup|resolve|reverse)/.test(key)&&typeof object[key]==='function')object[key]=deny('dns.'+key);
if(process.env.ISOLATED_OPTICAL_BOOT_LOG)fs.appendFileSync(process.env.ISOLATED_OPTICAL_BOOT_LOG,JSON.stringify({kind:'optical-child-fence-loaded',isMainThread,threadId,execArgvFence:process.execArgv.includes(__filename)})+'\n');
