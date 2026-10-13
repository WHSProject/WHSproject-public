import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const scannerSchema = path.resolve(import.meta.dirname, '../src/contracts/agent-analysis/agent-analysis-request.v0.3.schema.json');
const labSchema = path.resolve(import.meta.dirname, '../../../../lab/malware_detection_lab/schemas/agent-analysis-request.v0.3.schema.json');

test('Scanner and Lab request 0.3 schemas are byte-identical when the Lab checkout is available', { skip: !existsSync(labSchema) }, () => {
  assert.deepEqual(readFileSync(scannerSchema), readFileSync(labSchema));
});
