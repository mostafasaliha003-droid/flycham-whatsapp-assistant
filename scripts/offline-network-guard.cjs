'use strict';
const net = require('node:net');
const connect = net.Socket.prototype.connect;
const loopback = new Set(['127.0.0.1', '::1', 'localhost']);

// The suite uses injected provider transports and numeric loopback servers.
// Cover both public connect arguments and Node's normalized internal form.
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = first && typeof first === 'object' ? first : {};
  const host = options.host || (typeof normalized[1] === 'string' ? normalized[1] : 'localhost');
  if (options.path || typeof first === 'string' || !loopback.has(host)) {
    throw Error('TEST_EXTERNAL_NETWORK_DENIED');
  }
  return connect.apply(this, args);
};
const nativeFetch = global.fetch;
global.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw Error('TEST_EXTERNAL_NETWORK_DENIED');
  }
  return nativeFetch(input, options);
};
