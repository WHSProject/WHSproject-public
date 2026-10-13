'use strict';

// Synthetic context-check fixture: value collector required by install.js. Never executed.
function collect() {
  return { home: process.env.HOME, user: process.env.USER };
}

module.exports = collect;
