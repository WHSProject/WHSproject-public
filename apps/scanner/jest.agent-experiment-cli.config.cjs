const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testRegex: '.*\\.cli-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
