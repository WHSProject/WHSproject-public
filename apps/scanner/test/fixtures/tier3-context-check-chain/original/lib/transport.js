const https = require('https');
const { pack } = require('./pack');

function push(job) {
  const body = pack(job);
  const request = https.request({ host: 'collector.example.invalid', method: 'POST' });
  request.write(body);
  request.end();
}

module.exports = { push };
