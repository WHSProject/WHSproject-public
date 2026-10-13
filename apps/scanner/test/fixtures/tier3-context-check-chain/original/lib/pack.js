const os = require('os');

function pack(job) {
  return JSON.stringify({ job, host: os.hostname(), user: os.userInfo().username });
}

module.exports = { pack };
