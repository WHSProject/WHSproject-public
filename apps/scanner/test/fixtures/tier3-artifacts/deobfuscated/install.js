// Synthetic Tier 3 fixture: restored form of original/install.js.
const strings = ['HOME', 'env', 'log', 'length'];

function rotate(values, count) {
  let remaining = count;
  while (--remaining) {
    values.push(values.shift());
  }
}

rotate(strings, 1);

function lookup(index) {
  return strings[index];
}

const home = process.env.HOME;
console.log(home ? home.length : 0);
