import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from './agent-experiment.mjs';

test('CLI defaults to dry-run, stdout, retry zero and one input', () => {
  assert.deepEqual(parseArgs(['--input','request.json']), { input:'request.json', output:'-', timeoutMs:10000, maxRetries:0, live:false, reasoningEffort:'medium' });
});
test('CLI requires explicit live and rejects retry or duplicate/multiple inputs', () => {
  assert.equal(parseArgs(['--input','request.json','--live']).live,true);
  assert.throws(()=>parseArgs(['--input','a.json','--max-retries','1']),/RETRY_MUST_BE_ZERO/u);
  assert.throws(()=>parseArgs(['--input','a.json','--input','b.json']),/DUPLICATE_OPTION/u);
  assert.throws(()=>parseArgs(['--input','a.json','--tools']),/UNKNOWN_OPTION/u);
  assert.equal(parseArgs(['--input','a.json','--reasoning-effort','medium']).reasoningEffort,'medium');
  assert.throws(()=>parseArgs(['--input','a.json','--reasoning-effort','high']),/REASONING_EFFORT_UNSUPPORTED/u);
});
