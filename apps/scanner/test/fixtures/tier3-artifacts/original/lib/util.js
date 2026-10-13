'use strict';

// Synthetic Tier 3 fixture: plain helper module.
function homeLength(env) {
  const home = env.HOME;
  return home ? home.length : 0;
}

module.exports = { homeLength };
