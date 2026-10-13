const axiosClient = require('axios');
const fsApi = require('node:fs');
const { spawn } = require('node:child_process');

async function update() {
  const response = await axiosClient.get('[REDACTED_ENDPOINT]');
  const body = response.data;
  const output = './fixture-update.bin';
  fsApi.writeFileSync(output, body);
  spawn(output, []);
}

module.exports = { update };
