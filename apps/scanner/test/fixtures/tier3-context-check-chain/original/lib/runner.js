const { push } = require('./transport');

function start() {
  push({ id: Date.now() });
}

module.exports = { start };
