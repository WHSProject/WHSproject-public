import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { Orchestrator } from '../dist/application/orchestrator/orchestrator.js';
import { ScanService } from '../dist/application/scan-service/scan.service.js';
import { GuardDogAnalyzer } from '../dist/analyzers/guarddog/guarddog.analyzer.js';
import { DockerExternalGuardDogRunner } from '../dist/analyzers/guarddog/docker-external-guarddog.runner.js';
import { CustomRuleAnalyzer } from '../dist/analyzers/custom-rule/custom-rule.analyzer.js';
import { DockerExternalCustomRuleRunner } from '../dist/analyzers/custom-rule/docker-external-custom-rule.runner.js';
import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { ObfuscationAnalyzer } from '../dist/analyzers/obfuscation/obfuscation.analyzer.js';
import { ArtifactHasher } from '../dist/artifact/hasher/artifact-hasher.js';
import { EvidenceNormalizer } from '../dist/evidence/normalizer/evidence-normalizer.js';
import { AgentInputV0_3Builder } from '../dist/llm-agent/artifact/agent-input-v0_3.builder.js';
import { AgentOutputValidatorService } from '../dist/llm-agent/agent-output-validator.service.js';
import { LlmAgentRunnerService } from '../dist/llm-agent/agent-runner.service.js';
import { LlmEvidenceAdapter } from '../dist/llm-agent/llm-evidence.adapter.js';
import { LlmAgentToolsService } from '../dist/llm-agent/llm-agent-tools.service.js';
import { loadLlmAgentEnvironment } from '../dist/config/scanner-environment.js';

const scannerRoot = resolve(import.meta.dirname, '..');
const pilotRoot = join(scannerRoot, 'guarddog-pilot-selection');
const args = parseArgs(process.argv.slice(2));
if (!args.output || args.consent !== '--static-integration-pilot') {
  throw new Error('Usage: node scripts/agent-planning-policy-integration-pilot.mjs --output <new-dir> --static-integration-pilot');
}
const outputRoot = resolve(args.output);
await assertNewDirectory(outputRoot);
await mkdir(join(outputRoot, 'samples'), { recursive: true });
await mkdir(join(outputRoot, 'work'), { recursive: true });

process.env.OBFUSCATION_GPT_MODE = 'off';
process.env.LLM_AGENT_ENABLED = 'true';
process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS';
process.env.LLM_AGENT_MODEL = 'integration-mock';
process.env.OPENAI_API_KEY = 'integration-mock-not-a-secret';
process.env.LLM_AGENT_MAX_RETRIES = '0';
process.env.LLM_AGENT_TIMEOUT_MS = '30000';
process.env.SCANNER_PACKAGE_TIMEOUT_MS = '900000';

const imageDigest = 'sha256:6c9b0e051011000600036ecacd0209081f58754eec65b13255d87cf2881e9640';
const rulesetPath = join(scannerRoot, 'rules/custom-rule-analyzer.yml');
const rulesetHash = await sha256File(rulesetPath);
const guardRunner = new DockerExternalGuardDogRunner({ runtime: 'docker', image: imageDigest,
  expectedImageDigest: imageDigest, user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1',
  tmpfsSize: '64m', timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
const customRunner = new DockerExternalCustomRuleRunner({ runtime: 'docker', image: imageDigest,
  expectedImageDigest: imageDigest, expectedSemgrepVersion: '1.172.0', expectedRulesetSha256: rulesetHash,
  user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m',
  timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
const guardDog = new GuardDogAnalyzer({ executable: 'guarddog', toolVersion: '3.1.0', workspaceRoot: outputRoot,
  timeoutMs: 120_000, killGraceMs: 1_000, sandboxMode: 'DISABLED', maxOutputBytes: 4 * 1024 * 1024 },
{ externalProcessRunner: guardRunner });
const customRule = new CustomRuleAnalyzer({ semgrepBin: 'semgrep', ruleConfigPath: rulesetPath,
  timeoutMs: 120_000, ruleVersion: rulesetHash }, customRunner);
const metadata = new MetadataAnalyzer();
let tier2GptCalls = 0;
const deniedTier2Assistant = { async analyze() { tier2GptCalls += 1; throw new Error('TIER2_LLM_CALL_FORBIDDEN'); } };
const staticGuardDog = { name: guardDog.name, version: guardDog.version,
  analyzeResult(input, context, signal) { return guardDog.analyzeResult({ ...input,
    artifactBoundary: { mode: 'EXTERNAL_READ_ONLY_ARTIFACT', allowedArtifactRoot: outputRoot },
    networkIsolation: { mode: 'VERIFIED_NETWORK_NONE' } }, context, signal); } };
const obfuscation = new ObfuscationAnalyzer(customRule, staticGuardDog, 'off', deniedTier2Assistant);

const manifestPath = join(pilotRoot, 'guarddog-pilot-samples.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const samples = [];
for (const sample of manifest.samples) {
  if (sample.label !== 'CONFIRMED_MALICIOUS' || !sample.archivePath) continue;
  const archivePath = join(pilotRoot, sample.archivePath);
  const packageRoot = await findPackageRoot(join(pilotRoot, 'artifacts/extracted', basename(sample.archivePath, '.zip')));
  samples.push({ ...sample, archivePath, packageRoot });
}
if (samples.length !== 15) throw new Error(`EXPECTED_15_LOCAL_SAMPLES:${samples.length}`);
const [guardPreflight, customPreflight] = await Promise.all([
  guardRunner.preflight(samples[0].packageRoot), customRunner.preflight(samples[0].packageRoot),
]);
if (!guardPreflight.verified || !customPreflight.verified) throw new Error('STATIC_SANDBOX_PREFLIGHT_FAILED');

const runManifest = { schemaVersion: '1.0.0', purpose: 'OPERATING_INTEGRATION_NOT_ACCURACY',
  createdAt: new Date().toISOString(), sampleCount: samples.length,
  sourceManifest: relative(scannerRoot, manifestPath), sourceManifestSha256: await sha256File(manifestPath),
  samples: samples.map(sampleIdentity), runtime: { node: process.version, requiredNode: '>=24.0.0 <25',
    platform: `${process.platform}/${process.arch}`, filterRuleVersion: '0.4.0', planningSchemaVersion: '0.1.0',
    guarddogTool: '3.1.0', semgrepTool: '1.172.0', rulesetSha256: rulesetHash },
  mocks: { registryInput: true, download: true, extraction: true, llmProvider: true, policyTransport: true,
    historyStorage: true, evidenceStorage: true, artifactCleanup: true },
  safety: { externalLlmCalls: 0, externalPolicyCalls: 0, tier2GptMode: 'off', packageInstall: false,
    lifecycleExecution: false, packageImportOrEntryPointExecution: false, analyzerNetwork: 'DOCKER_NETWORK_NONE' },
  preflight: { guardDog: guardPreflight, customRule: customPreflight } };
await jsonFile(join(outputRoot, 'run-manifest.json'), runManifest);

const records = [];
for (const sample of samples) {
  const started = Date.now();
  try { records.push(await runSample(sample, started)); }
  catch (error) {
    const record = { sampleId: sample.sampleId, subject: sampleIdentity(sample), artifactSha256: sample.archiveSha256,
      status: 'RESULT_NOT_CREATED', error: safeError(error), durationMs: Date.now() - started };
    records.push(record); await jsonFile(join(outputRoot, 'samples', `${sample.sampleId}.json`), record);
  }
}
if (tier2GptCalls !== 0) throw new Error(`TIER2_LLM_CALL_GUARD_TRIGGERED:${tier2GptCalls}`);
const aggregate = aggregateRecords(records);
await jsonFile(join(outputRoot, 'aggregate.json'), aggregate);
await jsonFile(join(outputRoot, 'comparison-to-pilot-v8.json'), comparePilotV8(records));
await jsonFile(join(outputRoot, 'summary.json'), { selected: samples.length,
  completed: records.filter((record) => record.status === 'COMPLETED').length,
  resultNotCreated: records.filter((record) => record.status !== 'COMPLETED').length,
  ...aggregate, externalLlmCalls: 0, externalPolicyCalls: 0, tier2GptCalls });
await rm(join(outputRoot, 'work'), { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ outputRoot, aggregate }, null, 2)}\n`);

async function runSample(sample, started) {
  if (await sha256File(sample.archivePath) !== sample.archiveSha256) throw new Error('ARCHIVE_HASH_MISMATCH');
  const workRoot = join(outputRoot, 'work', sample.sampleId);
  const extractedPath = join(workRoot, 'extracted');
  await mkdir(workRoot, { recursive: true });
  const packageJson = JSON.parse((await readFile(join(sample.packageRoot, 'package.json'), 'utf8')).replace(/^\uFEFF/u, ''));
  let providerRequests = 0;
  const provider = { async generate(prompt) {
    providerRequests += 1;
    const match = prompt.match(/"analysisRequestId":"([^"]+)"/u);
    if (!match) throw new Error('MOCK_PROVIDER_REQUEST_ID_MISSING');
    return { text: JSON.stringify({ requestId: match[1], schemaVersion: '0.2.0', status: 'COMPLETED',
      assessments: [], summary: { verdict: 'INCONCLUSIVE', confidence: 0, reasonCodes: ['MOCK_INTEGRATION'] },
      limitations: ['MOCK_PROVIDER_NO_SEMANTIC_ASSESSMENT'], missingContext: [] }),
      model: 'integration-mock', providerRequestId: `mock-${sample.sampleId}-${providerRequests}`, usage: {}, durationMs: 1 };
  } };
  const runner = new LlmAgentRunnerService(provider, new LlmAgentToolsService(),
    new AgentOutputValidatorService(), loadLlmAgentEnvironment());
  const policyRequests = []; const savedResults = []; let cleanupCalls = 0; let evidenceSaveCalls = 0;
  const orchestrator = new Orchestrator(
    { query: async () => ({ registryId: 'npmjs', metadataUrl: 'mock://metadata', tarballUrl: 'mock://artifact',
      registryIntegrity: undefined, registryMetadata: {} }) },
    { download: async ({ scanId }) => ({ scanId, artifactPath: sample.archivePath, scanDir: workRoot,
      calculatedIntegrity: `sha256-${sample.archiveSha256}`, finalUrl: 'mock://artifact', receivedBytes: 0, sha256: sample.archiveSha256 }) },
    { extract: async () => { await cp(sample.packageRoot, extractedPath, { recursive: true, dereference: false,
      errorOnExist: true }); return { extractedPath, files: 0, bytes: 0 }; } },
    new ArtifactHasher(),
    { verify: async () => packageJson }, metadata, customRule, staticGuardDog, obfuscation,
    new EvidenceNormalizer(),
    { query: async ({ packageName, packageVersion }) => ({ source: 'OSV', feedStatus: 'SUCCESS',
      query: { ecosystem: 'npm', packageName, packageVersion }, advisories: [], complete: true, pagesFetched: 1,
      collectedAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T00:00:00.001Z', errorCode: null, skippedReason: null }) },
    runner, new LlmEvidenceAdapter(), undefined, new AgentInputV0_3Builder());
  const service = new ScanService(orchestrator,
    { save: async (result) => { savedResults.push(result); return result; } },
    { evaluate: async (request) => { policyRequests.push(request); } },
    { cleanupByScanId: async () => { cleanupCalls += 1; await rm(workRoot, { recursive: true, force: true }); } },
    { saveAll: async () => { evidenceSaveCalls += 1; } });
  const result = await service.scan({ requestId: `integration-${sample.sampleId}`,
    packageName: sample.packageName, version: sample.packageVersion, registryId: 'npmjs' });
  const executionRecord = savedResults[0]; const policy = policyRequests[0];
  if (!executionRecord || !policy) throw new Error('POST_PROCESSING_RESULT_MISSING');
  const tier3 = executionRecord.shadowAnalyses?.find((item) => item.analyzer === 'tier3-agent-v0.3');
  // staticFilterResult is internal and not serialized into ScanResult. Recomputing it in the harness would
  // duplicate production routing, so the report uses the production Tier 3 observation's trigger reason.
  const tier3Data = tier3?.data && typeof tier3.data === 'object' ? tier3.data : {};
  const triggerReason = tier3Data.triggerReason;
  const filterStatus = triggerReason === 'STATIC_FILTER_MALICIOUS' ? 'STATIC_MALICIOUS'
    : triggerReason === 'NO_THREAT_FINDING' ? 'NO_ESCALATION_SIGNAL'
      : typeof triggerReason === 'string' && triggerReason.startsWith('STATIC_FILTER_')
        ? triggerReason.slice('STATIC_FILTER_'.length) : 'UNKNOWN';
  const record = { sampleId: sample.sampleId, subject: sampleIdentity(sample), artifactSha256: sample.archiveSha256,
    status: 'COMPLETED', filterStatus, triggerReason,
    tier3Status: typeof tier3Data.status === 'string' ? tier3Data.status : 'MISSING',
    runnerCalls: providerRequests > 0 ? 1 : 0, providerRequests, legacyCalls: 0, tier2GptCalls,
    llmEvidenceCount: result.evidences.filter((item) => item.kind === 'LLM_ASSESSMENT').length,
    policyLlmEvidenceCount: policy.evidences.filter((item) => item.kind === 'LLM_ASSESSMENT').length,
    staticEvidenceCount: result.evidences.filter((item) => item.kind !== 'LLM_ASSESSMENT').length,
    policyCalls: policyRequests.length, historySaveCalls: savedResults.length, evidenceSaveCalls, cleanupCalls,
    scanStatus: result.status, durationMs: Date.now() - started };
  await jsonFile(join(outputRoot, 'samples', `${sample.sampleId}.json`), record);
  return record;
}

function aggregateRecords(records) {
  const completed = records.filter((record) => record.status === 'COMPLETED');
  const count = (key) => Object.fromEntries([...new Set(completed.map((item) => item[key]))].sort()
    .map((value) => [value, completed.filter((item) => item[key] === value).length]));
  return { denominator: { selected: records.length, completed: completed.length,
    resultNotCreated: records.length - completed.length }, finalStatusDistribution: count('filterStatus'),
    tier3StatusDistribution: count('tier3Status'), routing: {
      skipCandidates: completed.filter((item) => ['STATIC_MALICIOUS', 'NO_ESCALATION_SIGNAL'].includes(item.filterStatus)).length,
      analysisCandidates: completed.filter((item) => ['STATIC_INCOMPLETE', 'AMBIGUOUS'].includes(item.filterStatus)).length,
      runnerExecutions: completed.reduce((sum, item) => sum + item.runnerCalls, 0),
      providerRequests: completed.reduce((sum, item) => sum + item.providerRequests, 0),
      legacyCalls: completed.reduce((sum, item) => sum + item.legacyCalls, 0), tier2GptCalls },
    postProcessing: { policyCalls: completed.reduce((sum, item) => sum + item.policyCalls, 0),
      historySaveCalls: completed.reduce((sum, item) => sum + item.historySaveCalls, 0),
      evidenceSaveCalls: completed.reduce((sum, item) => sum + item.evidenceSaveCalls, 0),
      cleanupCalls: completed.reduce((sum, item) => sum + item.cleanupCalls, 0),
      llmEvidenceGenerated: completed.reduce((sum, item) => sum + item.llmEvidenceCount, 0),
      llmEvidenceInPolicy: completed.reduce((sum, item) => sum + item.policyLlmEvidenceCount, 0) },
    failures: records.filter((item) => item.status !== 'COMPLETED').map(({ sampleId, error }) => ({ sampleId, error })) };
}
function comparePilotV8(records) {
  const malicious = new Set(['DD-NPM-003', 'DD-NPM-010', 'DD-NPM-015']);
  const noEscalation = new Set(['DD-NPM-006', 'DD-NPM-007', 'DD-NPM-013']);
  const samples = records.map((record) => {
    const expected = malicious.has(record.sampleId) ? 'STATIC_MALICIOUS'
      : noEscalation.has(record.sampleId) ? 'NO_ESCALATION_SIGNAL' : 'STATIC_INCOMPLETE';
    return { sampleId: record.sampleId, artifactSha256: record.artifactSha256,
      pilotV8Status: expected, integrationStatus: record.filterStatus ?? 'RESULT_NOT_CREATED',
      matches: record.filterStatus === expected };
  });
  return { baseline: 'pilot-v8 documented sample/status mapping', sampleCount: samples.length,
    mismatchCount: samples.filter((sample) => !sample.matches).length, samples };
}
function sampleIdentity(sample) { return { sampleId: sample.sampleId, ecosystem: 'npm', packageName: sample.packageName,
  packageVersion: sample.packageVersion }; }
function parseArgs(values) { const parsed = { output: '', consent: '' }; for (let index = 0; index < values.length; index += 1) {
  if (values[index] === '--output') parsed.output = values[++index] ?? '';
  else if (values[index] === '--static-integration-pilot') parsed.consent = values[index]; } return parsed; }
async function assertNewDirectory(path) { try { await stat(path); throw new Error(`OUTPUT_ALREADY_EXISTS:${path}`); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; } }
async function findPackageRoot(root) { const queue = [root]; while (queue.length > 0) { const current = queue.shift();
  for (const entry of await readdir(current, { withFileTypes: true })) { const path = join(current, entry.name);
    if (entry.isDirectory()) queue.push(path); else if (entry.isFile() && entry.name === 'package.json') return dirname(path); } }
  throw new Error(`PACKAGE_ROOT_NOT_FOUND:${root}`); }
async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
async function jsonFile(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
function safeError(error) { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }
