'use strict';
// Test-only transport fence. Only explicitly numeric local fake HTTP is allowed.
const fs=require('node:fs');
function blocked(kind){if(process.env.OFFLINE_GUARD_LOG)fs.appendFileSync(process.env.OFFLINE_GUARD_LOG,JSON.stringify({kind})+'\n');throw Object.assign(Error('OFFLINE_GUARD_BLOCKED:'+kind),{code:'OFFLINE_GUARD_BLOCKED'});}
const validPort=(value,listen=false)=>/^[0-9]{1,5}$/.test(String(value))&&Number(value)>=(listen?0:1)&&Number(value)<=65535;
function endpoint(args,listen=false){let first=args[0];if(Array.isArray(first))return endpoint(first,listen);if(first&&typeof first==='object')return !first.path&&!first.fd&&first.host==='127.0.0.1'&&validPort(first.port,listen);return validPort(first,listen)&&args[1]==='127.0.0.1';}
const net=require('node:net'),connect=net.Socket.prototype.connect,listen=net.Server.prototype.listen;
net.Socket.prototype.connect=function(...args){if(!endpoint(args))return blocked('socket');return connect.apply(this,args);};
net.Server.prototype.listen=function(...args){if(!endpoint(args,true))return blocked('listen');return listen.apply(this,args);};
const nativeFetch=globalThis.fetch;
globalThis.fetch=function(input,options){const raw=typeof input==='string'?input:input instanceof URL?input.href:input?.url;if(typeof raw!=='string'||!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}(?:\/|$)/.test(raw))return blocked('fetch');const u=new URL(raw);if(u.username||u.password||u.hostname!=='127.0.0.1'||!validPort(u.port))return blocked('fetch');return nativeFetch(input,options);};
const http=require('node:http');for(const method of ['get','request']){const native=http[method];http[method]=function(input,...rest){if(typeof input==='string'||input instanceof URL){const raw=String(input);if(!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}(?:\/|$)/.test(raw))return blocked('http');}else if(!input||input.hostname!=='127.0.0.1'&&input.host!=='127.0.0.1'||!validPort(input.port)||input.socketPath)return blocked('http');return native.call(this,input,...rest);};}
for(const method of ['get','request'])require('node:https')[method]=()=>blocked('https');require('node:tls').connect=()=>blocked('tls');
for(const object of [require('node:dns'),require('node:dns').promises])for(const key of Object.keys(object))if(/^(lookup|resolve|reverse)/.test(key)&&typeof object[key]==='function')object[key]=()=>blocked('dns');
const cp=require('node:child_process');for(const key of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])cp[key]=()=>blocked('child-process');require('node:dgram').createSocket=()=>blocked('udp');
// Node calls lookup even for a numeric listen address; answer locally without DNS.
require('node:dns').lookup=(host,options,callback)=>{if(host!=='127.0.0.1')return blocked('dns');if(typeof options==='function'){callback=options;options={};}if(typeof callback!=='function')throw TypeError('CALLBACK_REQUIRED');process.nextTick(()=>options?.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4));};
require('node:dns').promises.lookup=async(host,options)=>{if(host!=='127.0.0.1')return blocked('dns');return options?.all?[{address:'127.0.0.1',family:4}]:{address:'127.0.0.1',family:4};};

