import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { detect } from '../dist/analyzers/obfuscation/detector.js';
import { restoreStructure } from '../dist/analyzers/obfuscation/structure-restorer.js';

const [rootArg, auditArg, output] = process.argv.slice(2);
if (!rootArg || !auditArg || !output) throw new Error('Usage: CORPUS AUDIT_JSON NEW_OUTPUT_JSON');
const root = resolve(rootArg), auditBytes = await readFile(auditArg), audit = JSON.parse(auditBytes);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [path, hash] of Object.entries(audit.implementation)) {
  assert.equal(sha(await readFile(new URL(`../${path}`, import.meta.url))), hash, path);
}
const rows = [];
for (const row of audit.rows.filter((r) => r.missClassification === 'SPARSE_HELPERS_RETAINED'
  || r.missClassification === 'STATIC_REORDERED_DISPATCH_WITHOUT_HELPERS')) {
  const file = resolve(root, row.path), rel = relative(root, file);
  assert.ok(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
  const bytes = await readFile(file);
  assert.equal(sha(bytes), row.sha256);
  const source = bytes.toString('utf8'), verdict = detect(row.path, source);
  // Forced diagnostic calls on the seven unselected files are NOT production candidate results.
  const restored = await restoreStructure(source);
  assert.equal(sha(await readFile(file)), row.sha256);
  rows.push({ path: row.path, sha256: row.sha256, automaticallySelected: verdict.obfuscated,
    diagnosticOnly: !verdict.obfuscated, status: restored.status, reason: restored.reason ?? null,
    diagnostics: restored.diagnostics, inputBytes: bytes.length,
    outputBytes: restored.code === undefined ? null : Buffer.byteLength(restored.code),
    originalUnchanged: true });
}
assert.equal(rows.length, 9);
const result = { measuredAt: new Date().toISOString(), node: process.version,
  auditSha256: sha(auditBytes), implementation: audit.implementation,
  runnerSha256: sha(await readFile(new URL(import.meta.url))),
  packageEntrypointExecuted: false, llmCalls: 0, rows,
  limitations: ['Fixed previously examined regression set, not an independent holdout.',
    'Seven files are forced restoration diagnostics, not newly selected candidates.',
    'Residual-structure metrics are not semantic-equivalence or maliciousness proofs.',
    'Library decoding can evaluate isolated fragments; package entrypoints are never invoked.'] };
await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(rows, null, 2));
