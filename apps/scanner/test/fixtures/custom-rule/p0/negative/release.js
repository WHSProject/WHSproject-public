const fs = require('node:fs');

const manifest = { name: 'fixture-negative', version: '1.0.1' };
fs.writeFileSync('./package.json', JSON.stringify(manifest));
