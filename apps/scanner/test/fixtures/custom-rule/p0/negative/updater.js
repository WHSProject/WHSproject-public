const axios = require('axios');

async function checkForUpdate() {
  const response = await axios.get('[REDACTED_ENDPOINT]');
  return response.data.version;
}

module.exports = { checkForUpdate };
