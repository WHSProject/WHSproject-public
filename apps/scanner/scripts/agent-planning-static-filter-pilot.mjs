import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { GuardDogAnalyzer } from '../dist/analyzers/guarddog/guarddog.analyzer.js';
import { DockerExternalGuardDogRunner } from '../dist/analyzers/guarddog/docker-external-guarddog.runner.js';
import { CustomRuleAnalyzer } from '../dist/analyzers/custom-rule/custom-rule.analyzer.js';
import { DockerExternalCustomRuleRunner } from '../dist/analyzers/custom-rule/docker-external-custom-rule.runner.js';
import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { ObfuscationAnalyzer } from '../dist/analyzers/obfuscation/obfuscation.analyzer.js';
import { EvidenceNormalizer } from '../dist/evidence/normalizer/evidence-normalizer.js';
import { buildAgentPlanningInput } from '../dist/application/planning/agent-planning-input.adapter.js';
import { evaluateStaticFilter } from '../dist/application/planning/static-filter.js';

const scannerRoot = resolve(import.meta.dirname, '..');
const pilotRoot = join(scannerRoot, 'guarddog-pilot-selection');
const args = parseArgs(process.argv.slice(2));
if (!args.output || !['smoke', 'all'].includes(args.mode) || args.consent !== '--static-only-pilot') {
  throw new Error('Usage: node scripts/agent-planning-static-filter-pilot.mjs --mode smoke|all --output <new-dir> --static-only-pilot');
}
const outputRoot = resolve(args.output);
await assertNewDirectory(outputRoot);
await mkdir(join(outputRoot, 'samples'), { recursive: true });
await mkdir(join(outputRoot, 'work'), { recursive: true });

const imageDigest = 'sha256:6c9b0e051011000600036ecacd0209081f58754eec65b13255d87cf2881e9640';
const rulesetPath = join(scannerRoot, 'rules/custom-rule-analyzer.yml');
const rulesetHash = await sha256File(rulesetPath);
const guardRunner = new DockerExternalGuardDogRunner({
  runtime: 'docker', image: imageDigest, expectedImageDigest: imageDigest, user: '65532:65532',
  pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m', timeoutMs: 120_000,
  maxOutputBytes: 4 * 1024 * 1024,
});
const customRunner = new DockerExternalCustomRuleRunner({
  runtime: 'docker', image: imageDigest, expectedImageDigest: imageDigest,
  expectedSemgrepVersion: '1.172.0', expectedRulesetSha256: rulesetHash, user: '65532:65532',
  pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m', timeoutMs: 120_000,
  maxOutputBytes: 4 * 1024 * 1024,
});
const guardDog = new GuardDogAnalyzer({
  executable: 'guarddog', toolVersion: '3.1.0', workspaceRoot: outputRoot,
  timeoutMs: 120_000, killGraceMs: 1_000, sandboxMode: 'DISABLED', maxOutputBytes: 4 * 1024 * 1024,
}, { externalProcessRunner: guardRunner });
const customRule = new CustomRuleAnalyzer({
  semgrepBin: 'semgrep', ruleConfigPath: rulesetPath, timeoutMs: 120_000, ruleVersion: rulesetHash,
}, customRunner);
const metadata = new MetadataAnalyzer();
let llmCalls = 0;
const deniedAssistant = { async analyze() { llmCalls += 1; throw new Error('LLM_CALL_FORBIDDEN'); } };

// Tier 2 calls the GuardDog analyzer without an external-artifact boundary. This harness-only
// facade forces every original and derived invocation through the verified network-none runner.
const staticGuardDog = {
  name: guardDog.name, version: guardDog.version,
  analyzeResult(input, context, signal) {
    return guardDog.analyzeResult({
      ...input,
      artifactBoundary: { mode: 'EXTERNAL_READ_ONLY_ARTIFACT', allowedArtifactRoot: outputRoot },
      networkIsolation: { mode: 'VERIFIED_NETWORK_NONE' },
    }, context, signal);
  },
};
const obfuscation = new ObfuscationAnalyzer(customRule, staticGuardDog, 'off', deniedAssistant);

const manifestPath = join(pilotRoot, 'guarddog-pilot-samples.json');
const pilotManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const acquired = [];
const unavailable = [];
for (const sample of pilotManifest.samples) {
  if (sample.label !== 'CONFIRMED_MALICIOUS' || !sample.archivePath) {
    unavailable.push({ sampleId: sample.sampleId, packageName: sample.packageName,
      packageVersion: sample.packageVersion, reason: 'ORIGINAL_ARTIFACT_NOT_ACQUIRED' });
    continue;
  }
  const archivePath = join(pilotRoot, sample.archivePath);
  const extractionRoot = join(pilotRoot, 'artifacts/extracted', basename(sample.archivePath, '.zip'));
  const packageRoot = await findPackageRoot(extractionRoot);
  acquired.push({ ...sample, archivePath, packageRoot });
}
const selected = args.mode === 'smoke'
  ? ['DD-NPM-002', 'DD-NPM-010'].map((id) => acquired.find((sample) => sample.sampleId === id)).filter(Boolean)
  : acquired;
if (selected.length === 0) throw new Error('No acquired pilot samples were found');

const preflightRoot = selected[0].packageRoot;
const [guardPreflight, customPreflight] = await Promise.all([
  guardRunner.preflight(preflightRoot), customRunner.preflight(preflightRoot),
]);
if (!guardPreflight.verified || !customPreflight.verified) {
  throw new Error(`STATIC_SANDBOX_PREFLIGHT_FAILED:${JSON.stringify({ guardPreflight, customPreflight })}`);
}

const runManifest = {
  schemaVersion: '1.0.0', purpose: 'EVIDENCE_AVAILABILITY_NOT_ACCURACY', mode: args.mode,
  createdAt: new Date().toISOString(), sourceManifest: relative(scannerRoot, manifestPath),
  sourceManifestSha256: await sha256File(manifestPath), acquiredCount: acquired.length,
  selectedCount: selected.length, unavailable, selected: selected.map(sampleIdentity),
  reusedAnalysisCount: 0, newAnalysisCount: selected.length,
  reasonExistingResultsNotReused: 'Existing pilot outputs contain GuardDog 3.1.0 raw output only; current Tier 2, relation candidates, normalization, Planning input, and filter result are absent.',
  runtime: {
    node: process.version, requiredNode: '>=24.0.0 <25', platform: `${process.platform}/${process.arch}`,
    scannerCommit: git('rev-parse', 'HEAD'), scannerBranch: git('branch', '--show-current'),
    dockerImageDigest: imageDigest, guarddogTool: '3.1.0', semgrepTool: '1.172.0',
    rulesetSha256: rulesetHash, filterRuleVersion: '0.4.0', planningSchemaVersion: '0.1.0',
  },
  safety: {
    network: 'DOCKER_NETWORK_NONE', packageRootMount: 'READ_ONLY', containerRootFilesystem: 'READ_ONLY',
    tier2GptMode: 'off', llmGuard: 'THROW_ON_INVOCATION', packageInstall: false,
    lifecycleExecution: false, packageImportOrEntryPointExecution: false,
    tier3LegacyPolicyHistoryReachable: false,
  },
  preflight: { guardDog: guardPreflight, customRule: customPreflight },
};
await jsonFile(join(outputRoot, 'run-manifest.json'), runManifest);

const records = [];
for (const sample of selected) {
  const started = Date.now();
  try {
    records.push(await analyzeSample(sample, started));
  } catch (error) {
    const record = {
      sampleId: sample.sampleId, subject: sampleIdentity(sample), artifactSha256: sample.archiveSha256,
      analysisSource: 'NEW_STATIC_ANALYSIS', status: 'RESULT_NOT_CREATED',
      error: safeError(error), durationMs: Date.now() - started,
      safety: { llmCalls, packageExecutions: 0, lifecycleExecutions: 0 },
    };
    records.push(record);
    await jsonFile(join(outputRoot, 'samples', `${sample.sampleId}.json`), record);
  }
}
if (llmCalls !== 0) throw new Error(`LLM_CALL_GUARD_TRIGGERED:${llmCalls}`);
const aggregate = buildAggregate(records, acquired.length, selected.length);
await jsonFile(join(outputRoot, 'aggregate.json'), aggregate);
await jsonFile(join(outputRoot, 'code-review-candidates.json'), buildReviewCandidates(records));
await jsonFile(join(outputRoot, 'confirmed-malicious-cases.json'), buildConfirmedCases(records));
const baselineRoot = join(scannerRoot, 'experiments/agent-planning-static-filter/2026-10-02-pilot-v7');
if (args.mode === 'all') {
  await jsonFile(join(outputRoot, 'comparison-v0.3.0-to-v0.4.0.json'),
    await compareWithBaseline(records, aggregate, baselineRoot));
}
await jsonFile(join(outputRoot, 'summary.json'), {
  outputRoot, mode: args.mode, selected: selected.length,
  completed: records.filter((record) => record.status === 'COMPLETED').length,
  resultNotCreated: records.filter((record) => record.status !== 'COMPLETED').length,
  llmCalls, packageExecutions: 0, lifecycleExecutions: 0,
  finalStatusDistribution: aggregate.finalStatusDistribution,
});
// Planning/restore paths have Scanner artifact lifetime only. Per-sample JSON retains the
// evidence snapshots; copied package trees are removed so Jest and package tooling cannot
// discover or execute pilot manifests from the experiment output.
await rm(join(outputRoot, 'work'), { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ outputRoot, aggregate, llmCalls }, null, 2)}\n`);

async function analyzeSample(sample, started) {
  const archiveSha256 = await sha256File(sample.archivePath);
  if (archiveSha256 !== sample.archiveSha256) throw new Error('ARCHIVE_HASH_MISMATCH');
  const workRoot = join(outputRoot, 'work', sample.sampleId);
  const packageRoot = join(workRoot, 'package');
  await mkdir(workRoot, { recursive: true });
  await cp(sample.packageRoot, packageRoot, { recursive: true, dereference: false, errorOnExist: true });
  const beforeDigest = await treeDigest(packageRoot);
  const packageJsonText = await readFile(join(packageRoot, 'package.json'), 'utf8');
  const packageJson = JSON.parse(packageJsonText.replace(/^\uFEFF/u, ''));
  if (packageJson.name !== sample.packageName || packageJson.version !== sample.packageVersion) {
    throw new Error('PACKAGE_IDENTITY_MISMATCH');
  }
  const context = {
    requestId: `pilot-${sample.sampleId}`, scanId: `pilot-${sample.sampleId}`,
    package: { name: sample.packageName, version: sample.packageVersion },
    artifact: { tarballPath: sample.archivePath, extractedPath: packageRoot, hash: archiveSha256 },
    metadata: { registryMetadata: {}, packageJson },
  };
  const analyzerContext = { requestId: context.requestId, scanId: context.scanId };
  const tier1 = [];
  tier1.push(await measured(() => metadata.analyzeResult({ registryMetadata: {}, packageJson }, analyzerContext)));
  tier1.push(await measured(() => customRule.analyzeResult({ extractedPath: packageRoot, packageJson }, analyzerContext)));
  tier1.push(await measured(() => staticGuardDog.analyzeResult({ context }, analyzerContext)));
  const tier2Started = Date.now();
  const tier2 = await obfuscation.analyze(context, tier1);
  tier2.analyzerResult.execution = execution(tier2Started, Date.now());
  const evidenceIds = { value: 0 };
  const normalization = new EvidenceNormalizer(undefined,
    () => `${sample.sampleId}-evidence-${String(++evidenceIds.value).padStart(5, '0')}`,
    () => new Date('2026-10-01T00:00:00.000Z')).normalize({
    requestId: context.requestId, scanId: context.scanId,
    subject: { ecosystem: 'npm', packageName: sample.packageName,
      packageVersion: sample.packageVersion, artifactHash: archiveSha256 },
    artifactRoot: packageRoot, analyzerResults: tier1,
    ...(tier2.evidenceCandidates.length === 0 ? {} : { tier2Candidates: tier2.evidenceCandidates }),
  });
  const planningInput = buildAgentPlanningInput({ context, tier1Results: tier1,
    tier2Result: tier2, normalizationResult: normalization });
  const filterResult = evaluateStaticFilter(planningInput);
  const afterDigest = await treeDigest(packageRoot);
  if (afterDigest !== beforeDigest) throw new Error('PACKAGE_ROOT_MUTATED');
  const record = {
    sampleId: sample.sampleId, subject: sampleIdentity(sample), artifactSha256: archiveSha256,
    analysisSource: 'NEW_STATIC_ANALYSIS', existingResultReused: false, status: 'COMPLETED',
    versions: runManifest.runtime,
    analyzerSummary: [...planningInput.tier1.analyzers, planningInput.tier2.analyzer,
      ...planningInput.tier2.derivedAnalyzers].map((result) => ({ analyzer: result.analyzer,
      analyzerVersion: result.analyzerVersion, status: result.status, errors: result.errors,
      execution: result.execution, findingCount: result.findings.length })),
    planningInput, filterResult, relationIntegrity: relationIntegrity(planningInput),
    safety: { llmCalls, packageExecutions: 0, lifecycleExecutions: 0,
      sourceTreeDigestBefore: beforeDigest, sourceTreeDigestAfter: afterDigest },
    durationMs: Date.now() - started,
  };
  await jsonFile(join(outputRoot, 'samples', `${sample.sampleId}.json`), record);
  return record;
}

async function measured(run) {
  const started = Date.now();
  const result = await run();
  return { ...result, execution: execution(started, Date.now()) };
}
function execution(started, completed) {
  return { startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(),
    durationMs: completed - started };
}
function relationIntegrity(input) {
  const analyzers = [...input.tier1.analyzers, ...input.tier2.derivedAnalyzers];
  return analyzers.flatMap((analyzer) => (analyzer.customRule?.relationCandidates ?? []).map((candidate) => {
    const ids = new Set(analyzer.findings.map((finding) => finding.findingId));
    const refs = [...candidate.sourceFindingIds, ...candidate.sinkFindingIds];
    return { analyzer: analyzer.analyzer, relationId: candidate.relationId,
      sourceFindingIds: candidate.sourceFindingIds, sinkFindingIds: candidate.sinkFindingIds,
      allFindingRefsPresent: refs.every((id) => ids.has(id)), missingFindingIds: refs.filter((id) => !ids.has(id)),
      semanticLinkProvenByCandidate: false,
      note: 'CANDIDATE status and referential integrity do not prove data/execution/call linkage.',
    };
  }));
}

function buildAggregate(records, acquiredCount, selectedCount) {
  const completed = records.filter((record) => record.status === 'COMPLETED');
  const distribution = (values) => Object.fromEntries([...new Set(values)].sort().map((value) =>
    [value, values.filter((candidate) => candidate === value).length]));
  const rules = {};
  for (const id of ['M01','M02','M03','M04','M05','M06','M07','M08']) {
    const diagnostics = completed.map((record) => ({ sampleId: record.sampleId,
      diagnostic: record.filterResult.diagnostics.find((item) => item.ruleId === id) }));
    const combinations = diagnostics.filter(({ diagnostic }) => diagnostic?.outcome !== 'NOT_APPLICABLE');
    rules[id] = {
      denominatorCompleted: completed.length,
      requiredCombinationDetected: combinations.length,
      validConfirmed: combinations.filter(({ diagnostic }) => diagnostic?.conditions.some((c) => c.condition === 'VALID' && c.status === 'SATISFIED')).length,
      sameFileConfirmed: combinations.filter(({ diagnostic }) => diagnostic?.conditions.some((c) => c.condition === 'SAME_FILE' && c.status === 'SATISFIED')).length,
      sameFileCombinationSatisfied: combinations.filter(({ diagnostic }) => diagnostic?.conditions.some((c) => c.condition === 'SAME_FILE_COMBINATION' && c.status === 'SATISFIED')).length,
      directCommandMatchSatisfied: combinations.filter(({ diagnostic }) => diagnostic?.conditions.some((c) => c.condition === 'DIRECT_COMMAND_MATCH' && c.status === 'SATISFIED')).length,
      linkedConfirmed: combinations.filter(({ diagnostic }) => diagnostic?.linked.status === 'CONFIRMED').length,
      linkedUnverified: combinations.filter(({ diagnostic }) => diagnostic?.linked.status === 'UNVERIFIED').length,
      finalSatisfied: combinations.filter(({ diagnostic }) => diagnostic?.outcome === 'SATISFIED').length,
      samplesWithCombination: combinations.map(({ sampleId }) => sampleId),
      blockingConditions: distribution(combinations.flatMap(({ diagnostic }) => diagnostic?.blockingConditions ?? [])),
    };
  }
  const relationRows = completed.flatMap((record) => record.relationIntegrity);
  return {
    denominators: { manifestEntries: acquiredCount + unavailable.length, acquiredDevelopmentSamples: acquiredCount,
      selectedForRun: selectedCount, completedResults: completed.length },
    finalStatusDistribution: distribution(completed.map((record) => record.filterResult.status)),
    threatPresence: distribution(completed.map((record) => record.filterResult.threat.present ? 'PRESENT' : 'ABSENT')),
    routingCandidates: {
      maliciousRuleSkip: completed.filter((record) => record.filterResult.status === 'STATIC_MALICIOUS').length,
      noThreatSkip: completed.filter((record) => record.filterResult.status === 'NO_ESCALATION_SIGNAL').length,
      secondStage: completed.filter((record) => ['STATIC_INCOMPLETE', 'AMBIGUOUS'].includes(record.filterResult.status)).length,
    },
    noEscalationDiagnostics: {
      withAmbiguity: completed.filter((record) => record.filterResult.status === 'NO_ESCALATION_SIGNAL'
        && record.filterResult.appliedRuleIds.some((id) => id.startsWith('A'))).length,
      withIncomplete: completed.filter((record) => record.filterResult.status === 'NO_ESCALATION_SIGNAL'
        && record.filterResult.appliedRuleIds.some((id) => id.startsWith('I'))).length,
    },
    appliedAmbiguousRules: distribution(completed.flatMap((record) => record.filterResult.appliedRuleIds.filter((id) => id.startsWith('A')))),
    appliedIncompleteRules: distribution(completed.flatMap((record) => record.filterResult.appliedRuleIds.filter((id) => id.startsWith('I')))),
    reasonCodes: distribution(completed.flatMap((record) => record.filterResult.reasonCodes)),
    analyzerStatuses: distribution(completed.flatMap((record) => record.analyzerSummary.map((item) => `${item.analyzer}:${item.status}`))),
    resultNotCreated: records.filter((record) => record.status !== 'COMPLETED').map(({ sampleId, error }) => ({ sampleId, error })),
    staticDurationMs: { total: records.reduce((sum, record) => sum + record.durationMs, 0),
      bySample: Object.fromEntries(records.map((record) => [record.sampleId, record.durationMs])) },
    maliciousRules: rules,
    relations: { candidates: relationRows.length,
      allReferencesPresent: relationRows.filter((row) => row.allFindingRefsPresent).length,
      semanticLinkProven: relationRows.filter((row) => row.semanticLinkProvenByCandidate).length },
    unclassifiedThreatRules: distribution(completed.flatMap((record) => {
      if (!record.filterResult.reasonCodes.includes('UNCLASSIFIED_THREAT_REVIEW_REQUIRED')) return [];
      const known = new Set(['threat-network-reverse-shell','threat-filesystem-destruction','threat-filesystem-read','threat-runtime-environment-read','threat-network-dns-exfil','threat-network-exfil-messenger','threat-process-download-exec','threat-process-hooks','threat-npm-preinstall-script','threat-runtime-self-propagation','threat-network-exfil-sysinfo','threat-network-exfiltration','threat-runtime-keylogging','threat-runtime-screencapture','threat-process-memory','threat-process-cryptomining','threat-filesystem-autostart','threat-process-injection-dll']);
      return [...record.planningInput.tier1.analyzers, record.planningInput.tier2.analyzer,
        ...record.planningInput.tier2.derivedAnalyzers].flatMap((analyzer) => analyzer.findings
        .map((finding) => finding.ruleId).filter((id) => id.startsWith('threat-') && !known.has(id)));
    })),
  };
}

function buildReviewCandidates(records) {
  return records.filter((record) => record.status === 'COMPLETED').map((record) => {
    const relevant = record.filterResult.diagnostics.filter((diagnostic) =>
      diagnostic.ruleId.startsWith('M') && diagnostic.outcome !== 'NOT_APPLICABLE');
    return { sampleId: record.sampleId, subject: record.subject,
      selectionReasons: [...(relevant.length > 0 ? ['M_REQUIRED_COMBINATION'] : []),
        ...(record.relationIntegrity.length > 0 ? ['RELATION_CANDIDATE'] : [])],
      diagnostics: relevant, relations: record.relationIntegrity,
      findingLocations: relevant.flatMap((diagnostic) => diagnostic.findingRefs.map((ref) => {
        const analyzer = [...record.planningInput.tier1.analyzers, record.planningInput.tier2.analyzer,
          ...record.planningInput.tier2.derivedAnalyzers].find((item) => item.analyzer === ref.analyzer);
        const finding = analyzer?.findings.find((item) => item.findingId === ref.findingId);
        return { ...ref, ruleId: finding?.ruleId, location: finding?.location, data: finding?.data };
      })),
    };
  }).filter((item) => item.selectionReasons.length > 0).slice(0, 5);
}

function buildConfirmedCases(records) {
  return records.filter((record) => record.status === 'COMPLETED').flatMap((record) =>
    record.filterResult.diagnostics.filter((diagnostic) =>
      diagnostic.category === 'MALICIOUS' && diagnostic.outcome === 'SATISFIED')
      .map((diagnostic) => ({
        sampleId: record.sampleId, subject: record.subject, artifactSha256: record.artifactSha256,
        ruleId: diagnostic.ruleId, findingRefs: diagnostic.findingRefs,
        evidenceRefs: diagnostic.evidenceRefs, judgmentBasis: diagnostic.conditions
          .filter((item) => ['SAME_FILE_COMBINATION', 'DIRECT_COMMAND_MATCH'].includes(item.condition)),
        linked: diagnostic.linked,
        conditions: diagnostic.conditions,
        findings: diagnostic.findingRefs.map((ref) => {
          const analyzer = [...record.planningInput.tier1.analyzers, record.planningInput.tier2.analyzer,
            ...record.planningInput.tier2.derivedAnalyzers].find((item) => item.analyzer === ref.analyzer);
          const finding = analyzer?.findings.find((item) => item.findingId === ref.findingId);
          return { ...ref, ruleId: finding?.ruleId, location: finding?.location, data: finding?.data };
        }),
      })));
}

async function compareWithBaseline(records, aggregate, baselineRoot) {
  const baselineAggregate = JSON.parse(await readFile(join(baselineRoot, 'aggregate.json'), 'utf8'));
  const samples = [];
  for (const record of records.filter((item) => item.status === 'COMPLETED')) {
    const baseline = JSON.parse(await readFile(join(baselineRoot, 'samples', `${record.sampleId}.json`), 'utf8'));
    const malicious = (result) => Object.fromEntries(result.diagnostics
      .filter((item) => item.category === 'MALICIOUS')
      .map((item) => [item.ruleId, { outcome: item.outcome, linked: item.linked.status,
        blockingConditions: item.blockingConditions }]));
    samples.push({ sampleId: record.sampleId, artifactSha256: record.artifactSha256,
      before: { ruleVersion: baseline.filterResult.ruleVersion, status: baseline.filterResult.status,
        threat: baseline.filterResult.threat, reasonCodes: baseline.filterResult.reasonCodes,
        appliedAmbiguousRules: baseline.filterResult.appliedRuleIds.filter((id) => id.startsWith('A')),
        appliedIncompleteRules: baseline.filterResult.appliedRuleIds.filter((id) => id.startsWith('I')),
        maliciousRules: malicious(baseline.filterResult) },
      after: { ruleVersion: record.filterResult.ruleVersion, status: record.filterResult.status,
        threat: record.filterResult.threat, reasonCodes: record.filterResult.reasonCodes,
        appliedAmbiguousRules: record.filterResult.appliedRuleIds.filter((id) => id.startsWith('A')),
        appliedIncompleteRules: record.filterResult.appliedRuleIds.filter((id) => id.startsWith('I')),
        maliciousRules: malicious(record.filterResult) } });
  }
  return {
    schemaVersion: '1.0.0', sameSampleCount: samples.length,
    before: { ruleVersion: '0.3.0', finalStatusDistribution: baselineAggregate.finalStatusDistribution,
      maliciousRules: baselineAggregate.maliciousRules,
      i08Applied: baselineAggregate.appliedIncompleteRules.I08 ?? 0 },
    after: { ruleVersion: '0.4.0', finalStatusDistribution: aggregate.finalStatusDistribution,
      maliciousRules: aggregate.maliciousRules,
      i08Applied: aggregate.appliedIncompleteRules.I08 ?? 0 },
    samples,
  };
}

function sampleIdentity(sample) { return { sampleId: sample.sampleId, ecosystem: 'npm',
  packageName: sample.packageName, packageVersion: sample.packageVersion }; }
function parseArgs(values) {
  const result = { mode: '', output: '', consent: '' };
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === '--mode') result.mode = values[++i] ?? '';
    else if (values[i] === '--output') result.output = values[++i] ?? '';
    else if (values[i] === '--static-only-pilot') result.consent = values[i];
  }
  return result;
}
async function assertNewDirectory(path) {
  try { await stat(path); throw new Error(`OUTPUT_ALREADY_EXISTS:${path}`); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
async function findPackageRoot(root) {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name === 'package.json') return dirname(path);
    }
  }
  throw new Error(`PACKAGE_ROOT_NOT_FOUND:${root}`);
}
async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
async function treeDigest(root) {
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name); const rel = relative(root, full);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(`${rel}\0${await sha256File(full)}`);
      else if (entry.isSymbolicLink()) files.push(`${rel}\0SYMLINK`);
    }
  }
  await visit(root); return createHash('sha256').update(files.join('\n')).digest('hex');
}
async function jsonFile(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
function git(...gitArgs) { return execFileSync('git', gitArgs, { cwd: scannerRoot, encoding: 'utf8' }).trim(); }
function safeError(error) { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }
