import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { ArtifactOutputValidator } from '../dist/llm-agent/artifact/artifact-output.validator.js';
import { InMemoryCodeSliceRegistry } from '../dist/llm-agent/artifact/code-slice.registry.js';
import { RuntimeArtifactResolver } from '../dist/llm-agent/artifact/runtime-artifact-resolver.js';
import { agentSummary, LlmEvidenceAdapter } from '../dist/llm-agent/llm-evidence.adapter.js';

const scannerRoot = resolve(import.meta.dirname, '..');
const inputRoot = resolve(scannerRoot, 'experiments/agent-code-volume/2026-10-04-structured-limitations-input-v1');
const liveRoot = resolve(scannerRoot, 'experiments/agent-code-volume/2026-10-04-structured-limitations-live-v1');
const outputRoot = resolve(scannerRoot, 'experiments/agent-code-volume/2026-10-04-structured-limitations-integrity-replay-v1');
const conditions = [
  ['sample-002', 'DD-NPM-010', 'L2'],
  ['sample-003', 'DD-NPM-013', 'L1'],
  ['sample-003', 'DD-NPM-013', 'L3'],
  ['sample-001', 'DD-NPM-003', 'L4'],
];
const manifest = await json(join(inputRoot, 'manifest.json'));
const validator = new ArtifactOutputValidator();
const adapter = new LlmEvidenceAdapter();
const results = [];

for (const [experimentId, sourceSampleId, level] of conditions) {
  const sample = manifest.samples.find((item) => item.experimentId === experimentId);
  if (!sample || sample.sourceSampleId !== sourceSampleId) throw new Error(`MISSING_SAMPLE:${sourceSampleId}`);
  const inputPath = join(inputRoot, 'private', experimentId, `${level}-input.json`);
  const priorPath = join(liveRoot, 'private', experimentId, level, 'validated-result.json');
  const inputText = await readFile(inputPath, 'utf8');
  const priorText = await readFile(priorPath, 'utf8');
  const input = JSON.parse(inputText);
  const prior = JSON.parse(priorText);
  if (prior.run?.output?.schemaVersion !== '0.3.0') throw new Error(`NOT_OUTPUT_0_3:${sourceSampleId}:${level}`);

  const roots = input.artifactContext.artifacts.map((descriptor) => {
    if (descriptor.representation !== 'ORIGINAL') throw new Error(`REPLAY_RESTORED_ROOT_NOT_CONFIGURED:${sourceSampleId}:${level}`);
    return { descriptor, root: resolve(scannerRoot, sample.source.originalRoot) };
  });
  const resolver = new RuntimeArtifactResolver(roots);
  const registry = new InMemoryCodeSliceRegistry();
  for (const slice of prior.run.slices) registry.register(slice);
  const validated = await validator.validate(input, prior.run.output, { registry, resolver, maxFileSizeBytes: 12 * 1024 * 1024 });
  const runnerStatus = validated.assessments.some(({ status }) => status !== 'VERIFIED') ? 'PARTIAL' : 'COMPLETED';
  const preservedLimitations = validated.assessments.flatMap(({ evidenceIntegrity }) =>
    (evidenceIntegrity?.analysisLimitations ?? []).map(({ source, kind, detail }) => `[${source}][${kind}] ${detail}`));
  const run = { ...prior.run, status: runnerStatus, limitations: [...new Set([...prior.run.limitations, ...preservedLimitations])], validated };
  const conversion = adapter.toEvidencesV0_3(input, run, resolver);
  const summary = agentSummary(run, conversion, 'OFFLINE_REPLAY');
  const replay = {
    replayCriteriaVersion: 'EVIDENCE_INTEGRITY_V1',
    source: { inputSha256: sha256(inputText), priorValidatedResultSha256: sha256(priorText) },
    run,
    conversion,
    summary,
  };
  await output(join(outputRoot, 'private', experimentId, level, 'replay-result.json'), replay);
  const beforeCounts = counts(prior.run.validated.assessments.map(({ status }) => status));
  const afterCounts = counts(validated.assessments.map(({ status }) => status));
  results.push({
    conditionId: `${sourceSampleId}:${level}`,
    experimentId,
    sourceSampleId,
    level,
    source: replay.source,
    before: { runnerStatus: prior.run.status, validatorStatusCounts: beforeCounts, evidenceCount: prior.conversion.evidences.length },
    after: { runnerStatus, validatorStatusCounts: afterCounts, evidenceCount: conversion.evidences.length, conversionFailureCount: conversion.failures.length },
    assessments: validated.assessments.map(({ assessment, status, issues, evidenceIntegrity }) => ({
      assessmentId: assessment.id,
      projectedStatus: status,
      integrityStatus: evidenceIntegrity?.status ?? null,
      integrityErrors: [...issues],
      claimScope: assessment.claimScope,
      assessmentLimitationKinds: assessment.limitations.map(({ kind }) => kind),
      applicableGlobalLimitationKinds: (evidenceIntegrity?.analysisLimitations ?? [])
        .filter(({ source }) => source === 'GLOBAL_MISSING_CONTEXT').map(({ kind }) => kind),
      evidenceGenerated: conversion.evidences.some(({ provenance }) => provenance.assessmentId === assessment.id),
    })),
  });
}

const aggregation = {
  schemaVersion: '1.0.0',
  createdAt: new Date().toISOString(),
  mode: 'OFFLINE_REPLAY_NO_PROVIDER_CALLS',
  criteriaVersion: 'EVIDENCE_INTEGRITY_V1',
  sourceInputManifest: relative(scannerRoot, join(inputRoot, 'manifest.json')),
  sourceLiveResults: relative(scannerRoot, liveRoot),
  conditionCount: results.length,
  providerRequests: 0,
  totals: {
    assessments: results.reduce((sum, item) => sum + item.assessments.length, 0),
    before: total(results.map(({ before }) => before)),
    after: total(results.map(({ after }) => after)),
  },
  results,
  interpretation: 'Integrity-passed means deterministic structure, reference, artifact, lineage, slice, line, and source-content checks passed. It does not independently prove semantic data flow, reachability, malicious intent, or runtime success.',
};
await output(join(outputRoot, 'aggregation.json'), aggregation);
await output(join(outputRoot, '.gitignore'), 'private/\n', false);
process.stdout.write(`${JSON.stringify(aggregation.totals, null, 2)}\n`);

function counts(statuses) {
  return Object.fromEntries(['VERIFIED', 'PARTIALLY_VERIFIED', 'REJECTED'].map((status) => [status, statuses.filter((item) => item === status).length]));
}
function total(items) {
  return {
    validatorStatusCounts: Object.fromEntries(['VERIFIED', 'PARTIALLY_VERIFIED', 'REJECTED'].map((status) => [status, items.reduce((sum, item) => sum + item.validatorStatusCounts[status], 0)])),
    evidenceCount: items.reduce((sum, item) => sum + item.evidenceCount, 0),
    conversionFailureCount: items.reduce((sum, item) => sum + (item.conversionFailureCount ?? 0), 0),
  };
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function output(path, value, encode = true) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encode ? `${JSON.stringify(value, null, 2)}\n` : value);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
