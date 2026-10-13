const axios = require('axios');
const fs = require('node:fs');

async function refreshCache() {
  const response = await axios.get('[REDACTED_ENDPOINT]');
  fs.writeFileSync('./fixture-cache.json', response.data);
}

module.exports = { refreshCache };
