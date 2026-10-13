import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { LocalStaticAnalysisService } from '../dist/application/local-static-analysis/local-static-analysis.service.js';
import { AtomicSmokeInvocationBudget } from '../dist/application/local-static-analysis/smoke-invocation-budget.js';
import { DockerExternalGuardDogRunner } from '../dist/analyzers/guarddog/docker-external-guarddog.runner.js';
import { GuardDogAnalyzer } from '../dist/analyzers/guarddog/guarddog.analyzer.js';
import { CustomRuleAnalyzer } from '../dist/analyzers/custom-rule/custom-rule.analyzer.js';
import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { PackageIdentityVerifier } from '../dist/artifact/identity/package-identity-verifier.js';
import { ArtifactHasher } from '../dist/artifact/hasher/artifact-hasher.js';
import { EvidenceNormalizer } from '../dist/evidence/normalizer/evidence-normalizer.js';

const scannerRoot = resolve(import.meta.dirname, '../../..');
const projectRoot = dirname(scannerRoot);
const labRoot = process.argv[2];
const imageDigest = process.argv[3];
const executionConsent = process.argv[4];
if (!labRoot || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? '') || executionConsent !== '--execute-sealed-manifest') {
  throw new Error('Usage: local-static-three-sample-smoke.mjs <lab-root> <sha256:image-digest> --execute-sealed-manifest');
}
const datasetRoot = join(labRoot, 'malware-agent-dataset');
const readJsonl = async (file) => (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
const split = await readJsonl(join(datasetRoot, 'curated/pilot-v1/dataset-v1/split-manifest.jsonl'));
const slices = await readJsonl(join(datasetRoot, 'curated/pilot-v1/dataset-v1/code-slices-v1.2/manifest.jsonl'));
const features = await readJsonl(join(datasetRoot, 'curated/pilot-v1/qc-v1.1/sample-features.jsonl'));
const splitById = new Map(split.map((row) => [row.sampleId, row]));
const featureById = new Map(features.map((row) => [row.sampleId, row]));
const selected = [];
const selectedGroups = new Set();
for (const status of ['COMPLETE', 'PARTIAL', 'NO_VALID_SLICE']) {
  const candidates = slices.filter((row) => row.split === 'DEVELOPMENT' && row.status === status)
    .sort((a, b) => deterministicRank(a.sampleId).localeCompare(deterministicRank(b.sampleId)));
  const choice = candidates.find((row) => !selectedGroups.has(splitById.get(row.sampleId)?.leakageGroupId));
  selected.push(choice);
  if (choice) selectedGroups.add(splitById.get(choice.sampleId)?.leakageGroupId);
}
if (selected.some((row) => !row)) throw new Error('Unable to select all three slicing cohorts');
if (new Set(selected.map(({ sampleId }) => splitById.get(sampleId)?.leakageGroupId)).size !== 3) {
  throw new Error('Selected smoke samples do not have distinct leakage groups');
}

const outputRoot = await mkdtemp(join(tmpdir(), 'scanner-local-static-smoke-'));
const syntheticPreflightRoot = join(outputRoot, 'sandbox-preflight-fixture');
await mkdir(syntheticPreflightRoot);
await writeFile(join(syntheticPreflightRoot, 'package.json'), '{"name":"sandbox-preflight-fixture","version":"1.0.0"}\n');
const sandbox = new DockerExternalGuardDogRunner({
  runtime: 'docker', image: 'whs-scanner-external-guarddog', expectedImageDigest: imageDigest,
  user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m',
  timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024,
});
// PRELIGHT: this may inspect the approved backend but must never invoke an analyzer.
const sandboxPreflight = await sandbox.preflight(syntheticPreflightRoot);
if (!sandboxPreflight.verified) throw new Error(`SMOKE_PREFLIGHT_FAILED:${sandboxPreflight.reasonCode ?? 'UNVERIFIED'}`);
const guardDog = new GuardDogAnalyzer({
  executable: 'guarddog', toolVersion: '3.1.0', workspaceRoot: tmpdir(),
  timeoutMs: 120_000, killGraceMs: 1_000, sandboxMode: 'DISABLED', maxOutputBytes: 4 * 1024 * 1024,
}, { externalProcessRunner: sandbox });
const customRule = new CustomRuleAnalyzer({
  semgrepBin: 'semgrep', ruleConfigPath: join(scannerRoot, 'apps/scanner/rules/custom-rule-analyzer.yml'), timeoutMs: 10_000,
});
let evidenceSequence = 0;
const hasher = new ArtifactHasher();
const packageVersion = JSON.parse(await readFile(join(scannerRoot, 'apps/scanner/package.json'), 'utf8')).version;
const shaFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const integrityVerifier = {
  async verify(request) {
    const feature = featureById.get(request.sampleId);
    if (!feature || feature.identity.archiveSha256 !== request.subject.artifactSha256) return false;
    const archive = join(datasetRoot, 'raw/datadog/archives/encrypted', request.sampleId,
      basename(feature.identity.archivePath));
    return await hasher.hash(archive) === request.subject.artifactSha256;
  },
};
const invocationBudget = new AtomicSmokeInvocationBudget(join(outputRoot, 'invocation-ledger.json'), {
  runId: `local-static-three-sample-${imageDigest.slice(7, 19)}`,
  executionPurpose: 'THREE_SAMPLE_STATIC_SMOKE',
  approvedSampleIds: selected.map(({ sampleId }) => sampleId),
  maxUniqueSamples: 3, maxCallsPerSampleAnalyzer: 1, maxTotalCalls: 9,
  retryLimit: 0, executionMode: 'REAL',
});
await invocationBudget.initialize();
// SEAL-MANIFEST: after this point the cohort cannot be changed.
await invocationBudget.sealManifest(selected.map(({ sampleId }) => sampleId));

const service = new LocalStaticAnalysisService({
  guardDogAnalyzer: guardDog, customRuleAnalyzer: customRule, metadataAnalyzer: new MetadataAnalyzer(),
  packageIdentityVerifier: new PackageIdentityVerifier(), integrityVerifier,
  evidenceNormalizer: new EvidenceNormalizer(undefined,
    () => `local-smoke-evidence-${String(++evidenceSequence).padStart(6, '0')}`),
  semgrepAvailability: async () => ({
    available: false, reasonCode: 'SEMGREP_RUNTIME_CONFIG_UNWRITABLE',
  }),
  guardDogSandbox: sandbox,
  invocationBudget,
  invocationBackendAttestation: 'VERIFIED_EXTERNAL_CONTAINER',
}, {
  scannerRepositoryRoot: scannerRoot, projectRoot,
  scannerCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scannerRoot, encoding: 'utf8' }).trim(),
  scannerBranch: execFileSync('git', ['branch', '--show-current'], { cwd: scannerRoot, encoding: 'utf8' }).trim(),
  scannerVersion: packageVersion, guardDogToolVersion: '3.1.0',
  findingSchemaHash: await shaFile(join(scannerRoot, 'apps/scanner/src/domain/analysis.types.ts')),
  evidenceSchemaHash: await shaFile(join(scannerRoot, 'apps/scanner/src/evidence/normalizer/evidence-normalizer.types.ts')),
  rulesetHash: await shaFile(join(scannerRoot, 'apps/scanner/rules/custom-rule-analyzer.yml')),
});

const outputs = [];
for (const slice of selected) {
  const feature = featureById.get(slice.sampleId);
  const allowedArtifactRoot = join(datasetRoot, feature.extraction.outputPath);
  const packageRoot = join(allowedArtifactRoot, 'files', feature.structure.packageRoot);
  const result = await service.analyze({
    scanId: `local-smoke-${slice.sampleId}`, sampleId: slice.sampleId,
    packageRoot, allowedArtifactRoot,
    subject: { ecosystem: 'npm', name: feature.identity.packageName,
      version: feature.identity.packageVersion, artifactSha256: feature.identity.archiveSha256 },
  });
  validateResult(result, packageRoot, slice.sampleId);
  const record = { sampleId: slice.sampleId, slicingStatus: slice.status,
    leakageGroupId: splitById.get(slice.sampleId).leakageGroupId, result };
  await writeFile(join(outputRoot, `${slice.sampleId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  outputs.push(record);
}
const summary = { outputRoot, selected: outputs.map(({ sampleId, slicingStatus, leakageGroupId, result }) => ({
  sampleId, slicingStatus, leakageGroupId, status: result.status,
  analyzers: result.analyzerResults.map(({ name, status }) => ({ name, status })),
  findings: result.findings.length, atomicEvidences: result.atomicEvidences.length,
  packageTreeDigest: result.provenance.packageTreeDigest,
})) };
await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function validateResult(result, packageRoot, sampleId) {
  if (result.provenance.networkIsolationMode !== 'VERIFIED_NETWORK_NONE') throw new Error(`NETWORK_NOT_VERIFIED:${sampleId}`);
  if (JSON.stringify(result).includes(packageRoot) || JSON.stringify(result).includes('/analysis/package')) throw new Error(`PATH_LEAK:${sampleId}`);
  const findingIds = new Set();
  for (const finding of result.findings) {
    if (findingIds.has(finding.findingId)) throw new Error(`DUPLICATE_FINDING:${sampleId}`);
    findingIds.add(finding.findingId);
  }
  const evidenceIds = new Set();
  for (const evidence of result.atomicEvidences) {
    if (evidenceIds.has(evidence.evidenceId)) throw new Error(`DUPLICATE_EVIDENCE:${sampleId}`);
    evidenceIds.add(evidence.evidenceId);
    for (const source of evidence.sources) if (!findingIds.has(source.rawFindingId)) throw new Error(`DANGLING_EVIDENCE:${sampleId}`);
  }
}

function deterministicRank(sampleId) {
  return createHash('sha256').update(`local-static-smoke-v1:${sampleId}`).digest('hex');
}
