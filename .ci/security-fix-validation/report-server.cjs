'use strict';
const http = require('node:http');
const fs = require('node:fs');
const result = fs.readFileSync('/report/results.json');
console.log('REMAL_VALIDATION_LIVE ' + result.toString('utf8'));
http.createServer((request, response) => {
  if (!['/', '/health'].includes(request.url) || request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'}).end(result);
}).listen(Number(process.env.PORT || 10000), '0.0.0.0');
