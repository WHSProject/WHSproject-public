import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPair } from './tier2-cff-paired-audit.mjs';

test('surface normalization accepts only documented syntactic differences', () => {
  const r = classifyPair('while(true){console.log(26," ");break;}',
    '/* comment */ while(!![]){console["log"](0x1a,"\\x20");break;}');
  assert.equal(r.classification, 'SURFACE_ONLY');
});
test('different values are not ignored', () => {
  assert.equal(classifyPair('console.log(26)', 'console.log(27)').classification, 'UNRESOLVED');
});
test('statement order is not ignored', () => {
  assert.equal(classifyPair('a();b();', 'b();a();').classification, 'UNRESOLVED');
});
test('array effects are not swallowed as a boolean expression', () => {
  assert.equal(classifyPair('while(true)break;', 'while(!![a()])break;').classification, 'UNRESOLVED');
});
test('introduced and actually used helper is separated from dispatcher flattening', () => {
  const r = classifyPair('console.log(a+b);', 'var h={x:function(a,b){return a+b;}};console.log(h.x(a,b));');
  assert.equal(r.classification, 'HELPER_ONLY');
  assert.equal(r.after.helpers[0].callLines.length, 1);
});
test('unused helper is not enough for positive classification', () => {
  assert.equal(classifyPair('a();', 'var h={x:function(a,b){return a+b;}};a();').classification, 'UNRESOLVED');
});
test('shadowed object calls do not count as using a helper', () => {
  assert.equal(classifyPair('a();', 'var h={x:function(a,b){return a+b;}};function f(h){h.x(1,2);}a();').classification, 'UNRESOLVED');
});
test('preexisting helper is not a new transformation', () => {
  const s = 'var h={x:function(a,b){return a+b;}};h.x(1,2);';
  assert.equal(classifyPair(s, s).classification, 'SURFACE_ONLY');
});
test('new loop-switch dispatch is classified separately', () => {
  const r = classifyPair('a();b();', 'var q=[1,0],i=0;while(true){switch(q[i++]){case 0:b();continue;case 1:a();continue;}break;}');
  assert.equal(r.classification, 'DISPATCHER');
});
test('ordinary switch alone is not classified as a dispatcher', () => {
  assert.equal(classifyPair('a();', 'switch(x){case 0:a();break;case 1:b();break;}').classification, 'UNRESOLVED');
});
test('helper-stored order table is resolved without executing the source', () => {
  const r = classifyPair('a();b();', 'var h={q:"1|0"};var q=h.q.split("|"),i=0;while(true){switch(q[i++]){case "0":b();continue;case "1":a();continue;}break;}');
  assert.equal(r.classification, 'DISPATCHER');
  assert.deepEqual(r.after.switches[0].order, ['1', '0']);
});
test('unknown order is left unresolved', () => {
  assert.equal(classifyPair('a();b();', 'var q=getOrder(),i=0;while(true){switch(q[i++]){case 0:b();continue;case 1:a();continue;}break;}').classification, 'UNRESOLVED');
});
test('parse errors fail closed rather than reclassifying a file as surface-only', () => {
  assert.throws(() => classifyPair('a();', 'function {'));
});
