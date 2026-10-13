import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parse } from '@babel/parser';
import { detect } from '../dist/analyzers/obfuscation/detector.js';
import { hasStaticOrderDispatch } from '../dist/analyzers/obfuscation/static-order-dispatch.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function classifyMiss(before, after, orderDispatch) {
  if (before.detected) return null;
  if (orderDispatch) return 'STATIC_REORDERED_DISPATCH_WITHOUT_HELPERS';
  if (after.features.controlFlowIndirectionCount > 0
    && after.features.controlFlowIndirectionCount < 3) return 'SPARSE_HELPERS_RETAINED';
  return 'NO_DISPATCH_OR_HELPER_PATTERN_CONFIRMED';
}

export function summarizeRows(rows) {
  const summary = {};
  for (const row of rows) {
    const group = summary[row.technique] ??= { files: 0, before: 0, after: 0, added: 0, removed: 0 };
    group.files++;
    group.before += Number(row.before);
    group.after += Number(row.after);
    group.added += Number(!row.before && row.after);
    group.removed += Number(row.before && !row.after);
  }
  return summary;
}

/** Reads source text only; never imports or executes dataset files. */
export async function audit(datasetRoot, baselinePath) {
  const root = resolve(datasetRoot);
  const baselineBytes = await readFile(baselinePath);
  const baseline = JSON.parse(baselineBytes);
  assert.equal(baseline.rows.length, 363, 'Unexpected fixed regression corpus');
  const seen = new Set();
  const rows = [];
  for (const old of baseline.rows) {
    assert.equal(seen.has(old.path), false, 'Duplicate baseline path');
    seen.add(old.path);
    const absolute = resolve(root, old.path);
    const rel = relative(root, absolute);
    assert.ok(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'Path escapes corpus');
    const bytes = await readFile(absolute);
    assert.equal(sha(bytes), old.sha256, `Changed corpus file: ${old.path}`);
    const source = bytes.toString('utf8');
    parse(source, { sourceType: 'unambiguous', errorRecovery: false });
    assert.equal(old.parseError, null, 'Baseline parse failure needs a separate comparison');
    const start = performance.now();
    const after = detect(old.path, source);
    const durationMs = performance.now() - start;
    const orderDispatch = hasStaticOrderDispatch(source);
    rows.push({ path: old.path, sha256: old.sha256, technique: old.technique,
      expectedObfuscated: old.expectedObfuscated, before: old.detected, after: after.obfuscated,
      beforeSignals: old.signals, afterSignals: after.signals, durationMs,
      observations: { legacyLoopPattern: after.features.hasControlFlowFlattening,
        helperCount: after.features.controlFlowIndirectionCount, orderDispatch },
      missClassification: old.technique === 'control-flow-flattening'
        ? classifyMiss(old, after, orderDispatch) : null,
    });
  }
  const implementation = {};
  for (const path of ['src/analyzers/obfuscation/detector.ts',
    'src/analyzers/obfuscation/static-order-dispatch.ts',
    'src/analyzers/obfuscation/helper-analysis.ts',
    'src/analyzers/obfuscation/structure-quality.ts',
    'src/analyzers/obfuscation/structure-restorer.ts',
    'src/analyzers/obfuscation/restore.pipeline.ts',
    'src/analyzers/obfuscation/features.ts', 'dist/analyzers/obfuscation/detector.js',
    'dist/analyzers/obfuscation/static-order-dispatch.js']) {
    implementation[path] = sha(await readFile(new URL(`../${path}`, import.meta.url)));
  }
  return { schemaVersion: 1, measuredAt: new Date().toISOString(), node: process.version,
    baselineSha256: sha(baselineBytes), datasetSha256: baseline.datasetSha256,
    implementation, runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    packageExecuted: false, llmCalls: 0, summary: summarizeRows(rows),
    missClassifications: rows.filter((row) => row.missClassification !== null)
      .reduce((counts, row) => { counts[row.missClassification] = (counts[row.missClassification] ?? 0) + 1; return counts; }, {}),
    rows,
    limitations: [
      'Fixed previously inspected regression corpus, not an independent holdout.',
      'Technique group labels are not proof of a particular transformed structure in each file.',
      'NO_DISPATCH_OR_HELPER_PATTERN_CONFIRMED is limited to the inspected patterns, not proof of no obfuscation.',
      'File-only candidate detection; no restoration, maliciousness, Tier3 or production-cost evaluation.',
      'One sequential timing observation per file, including cold-start effects; not a performance comparison.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, baseline, output] = process.argv.slice(2);
  if (!root || !baseline || !output) throw new Error('Usage: tier2-cff-miss-audit.mjs CORPUS BASELINE_JSON NEW_OUTPUT_JSON');
  const result = await audit(root, baseline);
  await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ summary: result.summary, missClassifications: result.missClassifications }, null, 2));
}
