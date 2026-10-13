import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, stat, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { detect } from '../dist/analyzers/obfuscation/detector.js';
import { runRestorePipeline } from '../dist/analyzers/obfuscation/restore.pipeline.js';

const [baselineDetector, corpus, auditPath, output] = process.argv.slice(2);
if (!baselineDetector || !corpus || !auditPath || !output) {
  throw new Error('Usage: tier2-cff-controls-and-restore.mjs BASELINE_DETECTOR_JS CORPUS AUDIT_JSON NEW_OUTPUT');
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const before = require(resolve(baselineDetector)).detect;
const auditBytes = await readFile(auditPath);
const audit = JSON.parse(auditBytes);
for (const [path, hash] of Object.entries(audit.implementation)) {
  assert.equal(sha(await readFile(new URL(`../${path}`, import.meta.url))), hash, `Implementation changed: ${path}`);
}
const files = [];
async function walk(path) {
  const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) await walk(next);
    else if (entry.isFile() && entry.name.endsWith('.js') && (await stat(next)).size <= 1048576) files.push(next);
  }
}
for (const path of ['@babel/parser/lib', '@babel/types/lib', 'semver']) {
  await walk(join('node_modules', path));
}
const controls = [];
let beforeMs = 0, afterMs = 0;
for (const path of files) {
  const bytes = await readFile(path), source = bytes.toString('utf8');
  let start = performance.now();
  const a = before(path, source); beforeMs += performance.now() - start;
  start = performance.now();
  const b = detect(path, source); afterMs += performance.now() - start;
  controls.push({ path, sha256: sha(bytes), before: a.obfuscated, after: b.obfuscated });
}
const added = audit.rows.filter((row) => !row.before && row.after);
assert.equal(added.length, 2, 'This follow-up is scoped to the two audited synthetic files');
const originals = await Promise.all(added.map(async (row) => {
  const bytes = await readFile(join(corpus, row.path));
  assert.equal(sha(bytes), row.sha256);
  return bytes;
}));
const outputRoot = await mkdtemp(join(tmpdir(), 'whs-cff-restore-'));
const restored = await runRestorePipeline({ extractedPath: resolve(corpus), outputRoot,
  targets: added.map((row, index) => detect(row.path, originals[index].toString('utf8'))),
  budget: { maxFilesScanned: 20, maxTargets: 20, maxFileBytes: 1048576,
    perFileTimeoutMs: 5000, totalRestoreTimeoutMs: 30000 },
});
const unchanged = await Promise.all(added.map(async (row, index) =>
  sha(await readFile(join(corpus, row.path))) === sha(originals[index])));
assert.ok(unchanged.every(Boolean));
const restorationRows = restored.restored.map((row) => ({
  path: row.path, status: row.status, appliedStages: row.appliedStages,
  limitations: row.limitations, validation: row.validation,
  stageResults: row.stageResults.map(({ stage, status, changed, reason }) => ({ stage, status, changed, reason })),
}));
const result = { measuredAt: new Date().toISOString(), node: process.version,
  baselineDetectorSha256: sha(await readFile(baselineDetector)), auditSha256: sha(auditBytes),
  packageEntrypointExecuted: false, llmCalls: 0,
  controlSummary: { files: controls.length, before: controls.filter((row) => row.before).length,
    after: controls.filter((row) => row.after).length,
    added: controls.filter((row) => !row.before && row.after).length },
  singlePassTimingMs: { before: beforeMs, after: afterMs }, controls,
  restoration: { selectedPaths: added.map((row) => row.path), rows: restorationRows,
    unresolved: restored.unresolved, originalUnchanged: unchanged,
    durationMs: restored.durationMs, budgetExceeded: restored.budgetExceeded, outputRoot },
  limitations: ['Installed dependency controls are not a representative benign holdout.',
    'Single cold sequential timing run; no production latency claim.',
    'Existing restoration can evaluate decoder fragments in isolated-vm. No dataset entrypoint executed.',
    'RESTORED is a pipeline status, not proof of semantic equivalence or threat detection.'],
};
await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ controlSummary: result.controlSummary, singlePassTimingMs: result.singlePassTimingMs,
  restored: restorationRows.map(({ path, status }) => ({ path, status })), originalUnchanged: unchanged }, null, 2));
