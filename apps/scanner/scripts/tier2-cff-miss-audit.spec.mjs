import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMiss, summarizeRows } from './tier2-cff-miss-audit.mjs';

test('existing detected files are not classified as misses', () => {
  assert.equal(classifyMiss({ detected: true }, {}, true), null);
});
test('dispatch without helpers is distinct from sparse helpers and unknown structure', () => {
  const old = { detected: false };
  const current = (n) => ({ features: { controlFlowIndirectionCount: n } });
  assert.equal(classifyMiss(old, current(0), true), 'STATIC_REORDERED_DISPATCH_WITHOUT_HELPERS');
  assert.equal(classifyMiss(old, current(2), false), 'SPARSE_HELPERS_RETAINED');
  assert.equal(classifyMiss(old, current(0), false), 'NO_DISPATCH_OR_HELPER_PATTERN_CONFIRMED');
});
test('reports added and removed predictions without collapsing controls into positives', () => {
  assert.deepEqual(summarizeRows([
    { technique: 'control-flow-flattening', before: false, after: true },
    { technique: 'control-flow-flattening', before: true, after: true },
    { technique: 'original', before: false, after: false },
    { technique: 'code-compact', before: true, after: false },
  ]), {
    'control-flow-flattening': { files: 2, before: 1, after: 2, added: 1, removed: 0 },
    original: { files: 1, before: 0, after: 0, added: 0, removed: 0 },
    'code-compact': { files: 1, before: 1, after: 0, added: 0, removed: 1 },
  });
});
