import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { CustomRuleAnalyzer } from '../dist/analyzers/custom-rule/custom-rule.analyzer.js';
import { DockerExternalCustomRuleRunner } from '../dist/analyzers/custom-rule/docker-external-custom-rule.runner.js';
import { AtomicSmokeInvocationBudget } from '../dist/application/local-static-analysis/smoke-invocation-budget.js';
import { ArtifactHasher } from '../dist/artifact/hasher/artifact-hasher.js';
import { PackageIdentityVerifier } from '../dist/artifact/identity/package-identity-verifier.js';
import { EvidenceNormalizer } from '../dist/evidence/normalizer/evidence-normalizer.js';

const SAMPLE_IDS = Object.freeze(['NPM-MAL-013754', 'NPM-MAL-002841', 'NPM-MAL-012617']);
const IMAGE = 'whs-scanner-external-guarddog';
const labRoot = process.argv[2];
const imageDigest = process.argv[3];
if (!labRoot || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? '') || process.argv[4] !== '--execute-sealed-custom-rule-manifest') {
  throw new Error('Usage: custom-rule-only-three-sample-smoke.mjs <lab-root> <sha256:image-digest> --execute-sealed-custom-rule-manifest');
}
const scannerRoot = resolve(import.meta.dirname, '../../..');
const datasetRoot = join(labRoot, 'malware-agent-dataset');
const rulesetPath = join(scannerRoot, 'apps/scanner/rules/custom-rule-analyzer.yml');
const rulesetHash = await sha256File(rulesetPath);
const features = await readJsonl(join(datasetRoot, 'curated/pilot-v1/qc-v1.1/sample-features.jsonl'));
const featureById = new Map(features.map((row) => [row.sampleId, row]));
const outputRoot = await mkdtemp(join(tmpdir(), 'scanner-custom-rule-smoke-'));
const ledger = new AtomicSmokeInvocationBudget(join(outputRoot, 'invocation-ledger.json'), {
  runId: `custom-rule-only-${imageDigest.slice(7, 19)}`,
  executionPurpose: 'CUSTOM_RULE_ONLY_SMOKE', approvedSampleIds: SAMPLE_IDS,
  maxUniqueSamples: 3, maxCallsPerSampleAnalyzer: 1, maxTotalCalls: 3,
  maxCallsByAnalyzer: { guarddog: 0, metadata: 0, 'custom-rule': 3 },
  retryLimit: 0, executionMode: 'REAL',
});
await ledger.initialize();
const sealed = await ledger.sealManifest(SAMPLE_IDS);
const runner = new DockerExternalCustomRuleRunner({
  runtime: 'docker', image: IMAGE, expectedImageDigest: imageDigest,
  expectedSemgrepVersion: '1.172.0', expectedRulesetSha256: rulesetHash,
  user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m',
  timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024,
});
const analyzer = new CustomRuleAnalyzer({
  semgrepBin: 'semgrep', ruleConfigPath: rulesetPath, timeoutMs: 120_000, ruleVersion: rulesetHash,
}, runner);
const identityVerifier = new PackageIdentityVerifier();
const artifactHasher = new ArtifactHasher();
let evidenceSequence = 0;
const normalizer = new EvidenceNormalizer(undefined,
  () => `custom-rule-smoke-evidence-${String(++evidenceSequence).padStart(6, '0')}`,
  () => new Date(0));
const records = [];

for (const sampleId of sealed.sampleIds) {
  const feature = featureById.get(sampleId);
  if (!feature) throw new Error(`FEATURE_NOT_FOUND:${sampleId}`);
  const allowedRoot = join(datasetRoot, feature.extraction.outputPath);
  const packageRoot = join(allowedRoot, 'files', feature.structure.packageRoot);
  const archivePath = join(datasetRoot, 'raw/datadog/archives/encrypted', sampleId, basename(feature.identity.archivePath));
  if (await artifactHasher.hash(archivePath) !== feature.identity.archiveSha256) throw new Error(`ARCHIVE_HASH_MISMATCH:${sampleId}`);
  const packageJson = await identityVerifier.verifyPackageRoot(packageRoot, {
    name: feature.identity.packageName, version: feature.identity.packageVersion,
  });
  const before = await directoryDigest(packageRoot);
  const sandbox = await runner.preflight(packageRoot);
  if (!sandbox.verified || sandbox.mode !== 'VERIFIED_NETWORK_NONE') throw new Error(`CUSTOM_RULE_PREFLIGHT_FAILED:${sampleId}:${sandbox.reasonCode}`);
  await ledger.reserve(sampleId, 'custom-rule', 'VERIFIED_EXTERNAL_CONTAINER');
  const started = performance.now();
  const result = await analyzer.analyzeResult({ extractedPath: packageRoot, packageJson }, {
    requestId: sampleId, scanId: `custom-rule-only-${sampleId}`,
  });
  const durationMs = Math.max(0, performance.now() - started);
  const after = await directoryDigest(packageRoot);
  if (before !== after) throw new Error(`PACKAGE_ROOT_WRITE_DETECTED:${sampleId}`);
  await validateFindings(result.findings, packageRoot, sampleId);
  const normalization = normalizer.normalize({
    requestId: sampleId, scanId: `custom-rule-only-${sampleId}`,
    subject: { ecosystem: 'npm', packageName: feature.identity.packageName,
      packageVersion: feature.identity.packageVersion, artifactHash: feature.identity.archiveSha256 },
    artifactRoot: packageRoot, analyzerResults: [result],
  });
  validateEvidence(result.findings, normalization.atomicEvidences, sampleId);
  const record = {
    sampleId, packageIdentity: { name: feature.identity.packageName, version: feature.identity.packageVersion,
      archiveSha256: feature.identity.archiveSha256 },
    status: result.status, findings: result.findings, atomicEvidences: normalization.atomicEvidences,
    ruleDistribution: distribution(result.findings.map(({ ruleId }) => ruleId)), durationMs,
    process: { exitCode: result.rawResult?.exitCode ?? null, timedOut: result.status === 'TIMEOUT',
      stdoutTruncated: result.rawResult?.outputLimitExceeded === true,
      stderrTruncated: result.rawResult?.outputLimitExceeded === true },
    sandbox, packageTreeDigestBefore: before, packageTreeDigestAfter: after,
  };
  const serialized = JSON.stringify(record);
  if ([packageRoot, allowedRoot, '/analysis/package', '/Users/', '/private/tmp/', '/app/apps/scanner/rules'].some((path) => serialized.includes(path))) {
    throw new Error(`PATH_LEAK:${sampleId}`);
  }
  await writeFile(join(outputRoot, `${sampleId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  records.push(record);
}
const invocationLedger = await ledger.read();
if (invocationLedger.calls.length !== 3 || invocationLedger.calls.some(({ analyzer: name }) => name !== 'custom-rule')) {
  throw new Error('INVOCATION_LEDGER_INVALID');
}
const summary = { outputRoot, imageDigest, semgrepVersion: '1.172.0', rulesetHash,
  attemptedUniqueSamples: invocationLedger.attemptedSampleIds, calls: invocationLedger.calls,
  guardDogCalls: 0, metadataCalls: 0,
  samples: records.map(({ sampleId, status, findings, atomicEvidences, ruleDistribution, durationMs,
    packageTreeDigestBefore, packageTreeDigestAfter }) => ({ sampleId, status, findingCount: findings.length,
    atomicEvidenceCount: atomicEvidences.length, ruleDistribution, durationMs,
    packageTreeDigestBefore, packageTreeDigestAfter })),
};
await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

async function readJsonl(file) { return (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse); }
async function sha256File(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
function distribution(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])); }
async function directoryDigest(root) {
  const hash = createHash('sha256');
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(directory, entry.name); const name = relative(root, absolute);
      hash.update(name); hash.update('\0');
      if (entry.isSymbolicLink()) throw new Error('PACKAGE_ROOT_SYMLINK_NOT_ALLOWED');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) { hash.update(await readFile(absolute)); hash.update('\0'); }
      else throw new Error('PACKAGE_ROOT_SPECIAL_FILE_NOT_ALLOWED');
    }
  }
  if (!(await stat(root)).isDirectory()) throw new Error('PACKAGE_ROOT_INVALID');
  await walk(root); return hash.digest('hex');
}
async function validateFindings(findings, packageRoot, sampleId) {
  const ids = new Set();
  for (const finding of findings) {
    if (ids.has(finding.findingId)) throw new Error(`DUPLICATE_FINDING:${sampleId}`); ids.add(finding.findingId);
    const locations = finding.data?.locations ?? [finding.location];
    for (const location of locations) {
      if (location?.type !== 'SOURCE_FILE') continue;
      if (typeof location.path !== 'string' || location.path.startsWith('/') || location.path.includes('..')) throw new Error(`INVALID_FINDING_PATH:${sampleId}`);
      const absolute = resolve(packageRoot, location.path);
      if (!absolute.startsWith(`${resolve(packageRoot)}/`)) throw new Error(`FINDING_PATH_ESCAPE:${sampleId}`);
      if (location.startLine !== undefined && location.endLine !== undefined && location.startLine > location.endLine) throw new Error(`INVALID_FINDING_RANGE:${sampleId}`);
      let source;
      try { source = await readFile(absolute, 'utf8'); } catch { throw new Error(`FINDING_FILE_MISSING:${sampleId}`); }
      const lineCount = source.split('\n').length;
      if (location.startLine !== undefined && (location.startLine < 1 || location.startLine > lineCount)) throw new Error(`FINDING_RANGE_MISSING:${sampleId}`);
      if (location.endLine !== undefined && (location.endLine < 1 || location.endLine > lineCount)) throw new Error(`FINDING_RANGE_MISSING:${sampleId}`);
    }
  }
}
function validateEvidence(findings, evidences, sampleId) {
  const findingIds = new Set(findings.map(({ findingId }) => findingId)); const evidenceIds = new Set();
  for (const evidence of evidences) {
    if (evidenceIds.has(evidence.evidenceId)) throw new Error(`DUPLICATE_EVIDENCE:${sampleId}`); evidenceIds.add(evidence.evidenceId);
    for (const source of evidence.sources) if (!findingIds.has(source.rawFindingId)) throw new Error(`DANGLING_EVIDENCE:${sampleId}`);
  }
}
