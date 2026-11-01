'use strict';
// JavaScript transport instrumentation for these tests, not OS network isolation.
let blocked=0;
const deny=()=>{blocked++;throw Error('GATEWAY_TEST_EGRESS_FORBIDDEN');};
globalThis[Symbol.for('remal.gateway.test.network')]=()=>blocked;
globalThis.fetch=deny;
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
require('node:net').Socket.prototype.connect=deny;
const dns=require('node:dns');dns.lookup=deny;dns.resolve=deny;
dns.promises.lookup=async()=>deny();dns.promises.resolve=async()=>deny();
