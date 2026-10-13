import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalStaticAnalysisService } from '../dist/application/local-static-analysis/local-static-analysis.service.js';
import { EvidenceNormalizer } from '../dist/evidence/normalizer/evidence-normalizer.js';
import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { CustomRuleAnalyzer } from '../dist/analyzers/custom-rule/custom-rule.analyzer.js';
import { GuardDogAnalyzer } from '../dist/analyzers/guarddog/guarddog.analyzer.js';
import { DockerExternalGuardDogRunner } from '../dist/analyzers/guarddog/docker-external-guarddog.runner.js';
import { DockerExternalCustomRuleRunner } from '../dist/analyzers/custom-rule/docker-external-custom-rule.runner.js';
import { PackageIdentityVerifier } from '../dist/artifact/identity/package-identity-verifier.js';
import { ArtifactHasher } from '../dist/artifact/hasher/artifact-hasher.js';
import { ObfuscationAnalyzer } from '../dist/analyzers/obfuscation/obfuscation.analyzer.js';
import { buildTier2Handoff } from '../dist/analyzers/obfuscation/tier2-handoff.js';
import { evaluateTier3Escalation } from '../dist/llm-agent/tier3-escalation-gate.js';
import { loadLlmAgentEnvironment } from '../dist/config/scanner-environment.js';
import { LlmAgentTriggerService } from '../dist/llm-agent/llm-agent-trigger.service.js';
import { LlmAgentInputBuilderService, projectPackageContext } from '../dist/llm-agent/llm-agent-input-builder.service.js';
import { LlmAgentCodeSliceService } from '../dist/llm-agent/llm-agent-code-slice.service.js';
import { AgentInputV0_3Builder, toPackageContextV0_3 } from '../dist/llm-agent/artifact/agent-input-v0_3.builder.js';
import { RuntimeArtifactResolver, originalArtifactDescriptor } from '../dist/llm-agent/artifact/runtime-artifact-resolver.js';
import { buildTier3ExecutionInput } from '../dist/llm-agent/artifact/tier3-runtime.js';
import { summarizeRestoreDiagnostics } from '../dist/performance/tier2-omcbench-aggregation.js';
import { extractZipCodeOnly } from './tier2-omcbench-archive.mjs';
import { verifyScannerRuntime } from '../dist/performance/scanner-runtime-preflight.js';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const scannerRoot = resolve(scriptRoot, '..');
const repositoryRoot = resolve(scannerRoot, '../..');
const scannerPackage = JSON.parse(await readFile(join(scannerRoot, 'package.json'), 'utf8'));
const runtimePreflight = verifyScannerRuntime(scannerPackage.engines?.node);
const sourceReport = process.env.OMC_SOURCE_REPORT
  ?? join(repositoryRoot, 'reports', 'validation', 'tier2-omcbench-2026-09-23.json');
const outputPath = process.env.OMC_PILOT_OUTPUT
  ?? join(repositoryRoot, 'reports', 'validation', 'omc-tier1-tier2-pilot-2026-09-28.json');
const archiveDir = process.env.OMC_ARCHIVE_DIR;
const expectedCases = Number(process.env.OMC_EXPECTED_CASES ?? '40');
const image = process.env.OMC_EXTERNAL_IMAGE ?? 'whs-scanner-external-guarddog:local';
const imageDigest = process.env.OMC_EXTERNAL_IMAGE_DIGEST;
const revision = 'f0722971eddb654c308106c9086ff69da5b0484b';
const repository = 'False-Positive-Community/open-malicious-code-benchmark';

if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? '')) {
  throw new Error('OMC_EXTERNAL_IMAGE_DIGEST must be a sha256 digest');
}

const source = JSON.parse(await readFile(sourceReport, 'utf8'));
const cases = source.cases ?? [];
if (!Number.isInteger(expectedCases) || expectedCases < 1 || cases.length !== expectedCases
  || new Set(cases.map(({ name }) => name)).size !== expectedCases
  || cases.some(({ name, archiveSha256 }) => basename(name) !== name || (archiveDir !== undefined && !/^([a-f0-9]{64})$/u.test(archiveSha256 ?? '')))) {
  throw new Error(`Expected ${expectedCases} unique OMC cases, received ${cases.length} cases`);
}

const scannerCommitSha = git('rev-parse', 'HEAD');
const scannerBranch = git('branch', '--show-current');
const scannerVersion = scannerPackage.version;
const findingSchemaHash = await shaFile(join(scannerRoot, 'src/domain/analysis.types.ts'));
const evidenceSchemaHash = await shaFile(join(scannerRoot, 'src/evidence/normalizer/evidence-normalizer.types.ts'));
const rulesetHash = await shaFile(join(scannerRoot, 'rules/custom-rule-analyzer.yml'));
const artifactHasher = new ArtifactHasher();
const packageIdentityVerifier = new PackageIdentityVerifier();
const metadataAnalyzer = new MetadataAnalyzer();
const agentSettings = loadLlmAgentEnvironment({});
const agentTrigger = new LlmAgentTriggerService();
const legacyInputBuilder = new LlmAgentInputBuilderService(new LlmAgentCodeSliceService());
const tier3InputBuilder = new AgentInputV0_3Builder();

const sandbox = new DockerExternalGuardDogRunner({
  runtime: 'docker', image, expectedImageDigest: imageDigest,
  user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m',
  timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024,
});
const customSandbox = new DockerExternalCustomRuleRunner({
  runtime: 'docker', image, expectedImageDigest: imageDigest,
  expectedSemgrepVersion: '1.172.0', expectedRulesetSha256: rulesetHash,
  user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m',
  timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024,
});

const pilotRoot = await mkdtemp(join(tmpdir(), 'omc-tier1-tier2-pilot-'));
const variants = {};
try {
  const preflightRoot = join(pilotRoot, 'preflight');
  await mkdir(preflightRoot, { recursive: true });
  await writeFile(join(preflightRoot, 'package.json'), '{"name":"preflight","version":"1.0.0"}\n');
  const guardPreflight = await sandbox.preflight(preflightRoot);
  if (!guardPreflight.verified) throw new Error(`GUARDDOG_PREFLIGHT_FAILED:${guardPreflight.reasonCode ?? 'UNKNOWN'}`);
  const customPreflight = await customSandbox.preflight(preflightRoot);
  if (!customPreflight.verified) throw new Error(`CUSTOM_RULE_PREFLIGHT_FAILED:${customPreflight.reasonCode ?? 'UNKNOWN'}`);

  variants.guarddogOn = await runVariant('guarddog-on', true);
  variants.guarddogOff = await runVariant('guarddog-off', false);
} finally {
  try {
    await rm(pilotRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch (error) {
    console.warn(`PILOT_CLEANUP_DEFERRED:${error instanceof Error ? error.message : String(error)}`);
  }
}

const report = {
  schemaVersion: '1.0.0',
  runType: 'REAL_TIER1_TIER2_PIPELINE_PILOT',
  source: { repository, revision, report: sourceReport, cases: cases.length },
  execution: {
    scannerCommitSha, scannerBranch, scannerVersion,
    runtimePreflight,
    image, imageDigest, guardDogVersion: '3.1.0', semgrepVersion: '1.172.0', rulesetHash,
    networkMode: 'NONE', packageExecuted: false, lifecycleExecuted: false,
    llmCalls: 0, tier3Mode: 'GATE_DECISION_AND_INITIAL_INPUT_BUILD',
    codeSliceBudget: {
      maxInitialSlices: agentSettings.LLM_AGENT_MAX_INITIAL_SLICES,
      maxLinesPerSlice: agentSettings.LLM_AGENT_MAX_LINES_PER_SLICE,
      maxInitialCodeLines: agentSettings.LLM_AGENT_MAX_INITIAL_CODE_LINES,
      maxTotalCodeLines: agentSettings.LLM_AGENT_MAX_TOTAL_CODE_LINES,
      maxFileSizeBytes: agentSettings.LLM_AGENT_MAX_FILE_SIZE_BYTES,
    },
  },
  variants,
  ablation: buildAblation(variants.guarddogOn.samples, variants.guarddogOff.samples),
  limitations: [
    'Ground truth is package-level OMC benign/malicious labeling, not file-level obfuscation ground truth.',
    'Tier3 provider was not called; escalation rate is based on production gate input and decision only.',
    'Code bytes describe extracted JavaScript and initial Agent slices, not actual provider tokens or runtime code re-requests.',
    'The legacy Agent trigger and Tier3 Shadow gate are independent execution paths.',
  ],
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
await writeFile(outputPath.replace(/\.json$/u, '.md'), markdownReport(report), 'utf8');
console.log(JSON.stringify({ outputPath, variants: Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, value.summary])), ablation: report.ablation.summary }, null, 2));

async function runVariant(variantId, guardDogEnabled) {
  const outputRoot = join(pilotRoot, variantId);
  await mkdir(outputRoot, { recursive: true });
  const evidenceIds = { value: 0 };
  const archiveByPackageRoot = new Map();

  const guardDog = guardDogEnabled
    ? createGuardDogAnalyzer(outputRoot)
    : createDisabledGuardDogAnalyzer();
  const customRule = new CustomRuleAnalyzer({
    semgrepBin: 'semgrep',
    ruleConfigPath: join(scannerRoot, 'rules/custom-rule-analyzer.yml'),
    timeoutMs: 120_000,
    ruleVersion: rulesetHash,
  }, customSandbox);
  const evidenceNormalizer = new EvidenceNormalizer(undefined,
    () => `${variantId}-evidence-${String(++evidenceIds.value).padStart(6, '0')}`,
    () => new Date(0));
  const service = new LocalStaticAnalysisService({
    guardDogAnalyzer: guardDog,
    customRuleAnalyzer: customRule,
    metadataAnalyzer,
    packageIdentityVerifier,
    integrityVerifier: { verify: async (request) => archiveByPackageRoot.get(request.packageRoot) === request.subject.artifactSha256 },
    evidenceNormalizer,
    semgrepAvailability: async () => ({ available: true }),
    guardDogSandbox: guardDogEnabled ? sandbox : disabledSandbox(),
    customRuleSandbox: customSandbox,
  }, {
    scannerRepositoryRoot: scannerRoot,
    projectRoot: repositoryRoot,
    scannerCommitSha, scannerBranch, scannerVersion,
    guardDogToolVersion: '3.1.0', findingSchemaHash, evidenceSchemaHash, rulesetHash,
  });
  const obfuscation = new ObfuscationAnalyzer(customRule, guardDog, 'off');
  const samples = [];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const sampleId = caseId(item);
    const started = performance.now();
    let record;
    try {
      record = await runCase({ item, sampleId, index, outputRoot, service, obfuscation, evidenceNormalizer, archiveByPackageRoot });
    } catch (error) {
      record = {
        sampleId, name: item.name, truth: item.label === 'malicious' ? 'MALICIOUS' : 'BENIGN',
        status: 'FAILED', error: error instanceof Error ? error.message : String(error),
        totalMs: performance.now() - started,
      };
    }
    samples.push({ ...record, totalMs: Number((performance.now() - started).toFixed(2)) });
    await writeFile(join(outputRoot, 'samples.json'), JSON.stringify(samples, null, 2), 'utf8');
    console.log(`${variantId} ${index + 1}/${cases.length} ${item.name}: ${record.status}`);
  }
  const summary = summarizeVariant(samples);
  await writeFile(join(outputRoot, 'variant-result.json'), JSON.stringify({ variantId, guardDogEnabled, summary, samples }, null, 2), 'utf8');
  return { variantId, guardDogEnabled, summary, samples };
}

async function runCase({ item, sampleId, index, outputRoot, service, obfuscation, evidenceNormalizer, archiveByPackageRoot }) {
  const caseRoot = join(outputRoot, sampleId);
  const archivePath = join(caseRoot, basename(item.name));
  const rawRoot = join(caseRoot, 'raw');
  const packageRoot = join(caseRoot, 'extracted');
  await mkdir(rawRoot, { recursive: true });
  const bytes = archiveDir === undefined
    ? await downloadBytes(`https://raw.githubusercontent.com/${repository}/${revision}/packages/${encodeURIComponent(item.name)}`)
    : await readFile(join(archiveDir, item.name));
  if (item.archiveSha256 && createHash('sha256').update(bytes).digest('hex') !== item.archiveSha256) {
    throw new Error(`ARCHIVE_HASH_MISMATCH:${item.name}`);
  }
  await writeFile(archivePath, bytes);
  await extractArchiveCodeOnly(archivePath, rawRoot);
  await flattenPackageRoot(rawRoot, packageRoot);
  const sourceCode = await sourceCodeStats(packageRoot);
  const packageJson = await readPackageJson(packageRoot);
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  if (typeof packageName !== 'string' || typeof packageVersion !== 'string') {
    throw new Error('PACKAGE_IDENTITY_UNAVAILABLE');
  }
  const artifactSha256 = await shaFile(archivePath);
  archiveByPackageRoot.set(packageRoot, artifactSha256);
  const scanContext = {
    requestId: sampleId, scanId: sampleId,
    package: { name: packageName, version: packageVersion },
    artifact: { tarballPath: archivePath, extractedPath: packageRoot, hash: artifactSha256 },
    metadata: { registryMetadata: {}, packageJson },
  };
  const tier1Started = performance.now();
  const tier1 = await service.analyze({
    scanId: sampleId, sampleId,
    packageRoot, allowedArtifactRoot: caseRoot,
    subject: { ecosystem: 'npm', name: packageName, version: packageVersion, artifactSha256 },
  });
  const tier1Ms = performance.now() - tier1Started;
  const tier2Started = performance.now();
  const tier2 = await obfuscation.analyze(scanContext, tier1.analyzerResults.map(({ result }) => result));
  const normalized = evidenceNormalizer.normalize({
    requestId: sampleId, scanId: sampleId,
    subject: { ecosystem: 'npm', packageName, packageVersion, artifactHash: artifactSha256 },
    artifactRoot: packageRoot,
    analyzerResults: tier1.analyzerResults.map(({ result }) => result),
    ...(tier2.evidenceCandidates.length === 0 ? {} : { tier2Candidates: tier2.evidenceCandidates }),
  });
  const handoff = tier2.restore.restored.length === 0 ? undefined : buildTier2Handoff({
    context: scanContext,
    restore: tier2.restore,
    derivedAnalyzerResults: tier2.derivedAnalyzerResults,
    atomicEvidences: normalized.atomicEvidences,
    contentSha256: await artifactHasher.hashDirectory(tier2.restore.outputRoot),
  });
  let decisionMs = 0;
  const decision = handoff === undefined ? undefined : (() => {
    const started = performance.now();
    const value = evaluateTier3Escalation({
      tier1Results: tier1.analyzerResults.map(({ result }) => result),
      tier1Evidences: normalized.atomicEvidences,
      tier2Handoff: handoff,
      restore: tier2.restore,
    });
    decisionMs = performance.now() - started;
    return value;
  })();
  const agentInputs = await measureAgentInputs(scanContext, packageRoot, artifactSha256,
    tier1.analyzerResults.map(({ result }) => result), normalized.atomicEvidences, handoff, decision);
  const tier2Ms = performance.now() - tier2Started;
  const analyzerRows = tier1.analyzerResults.map(({ name, status, reasonCode, durationMs, result }) => ({
    name, status, reasonCode: reasonCode ?? null, durationMs: Number(durationMs.toFixed(2)),
    findingCount: result.findings.length, errorCount: result.errors.length,
    ruleIds: [...new Set(result.findings.map(({ ruleId }) => ruleId))].sort(),
  }));
  const derivedRows = tier2.derivedAnalyzerResults.map((result) => ({
    analyzer: result.analyzer, status: result.status, findingCount: result.findings.length,
    errorCount: result.errors.length,
    ruleIds: [...new Set(result.findings.map(({ ruleId }) => ruleId))].sort(),
  }));
  const tier2Evidence = normalized.atomicEvidences.filter((evidence) => evidence.analysisPass === 'TIER2');
  return {
    sampleId, name: item.name, truth: item.label === 'malicious' ? 'MALICIOUS' : 'BENIGN', status: tier1.status,
    analyzerRows, derivedRows,
    tier1FindingCount: tier1.findings.length,
    tier1EvidenceCount: tier1.atomicEvidences.length,
    normalizedEvidenceCount: normalized.atomicEvidences.length,
    tier1EvidenceSignals: [...new Set(tier1.atomicEvidences.map(({ signal }) => signal.id))].sort(),
    tier2EvidenceCount: tier2Evidence.length,
    tier2EvidenceSignals: [...new Set(tier2Evidence.map(({ signal }) => signal.id))].sort(),
    unmappedFindingCount: normalized.unmappedFindings.length,
    normalizationErrorCount: normalized.errors.length,
    tier2: {
      selectedFiles: tier2.summary.selectedFiles,
      restoredFiles: tier2.summary.restoredFiles,
      partialRestoredFiles: tier2.summary.partialRestoredFiles,
      unresolvedFiles: tier2.summary.unresolvedFiles,
      candidateCount: tier2.evidenceCandidates.length,
      restoreStatus: tier2.restore.restored.map(({ path, status, limitations }) => ({ path, status, limitations })),
      restoreDiagnostics: summarizeRestoreDiagnostics(tier2.restore),
      derived: derivedRows,
    },
    tier2Entry: handoff !== undefined,
    gate: decision === undefined ? null : {
      profile: decision.profile, shouldEscalate: decision.shouldEscalate,
      confidence: decision.confidence, reasons: decision.reasons, decisionMs: Number(decisionMs.toFixed(4)),
    },
    sourceCode,
    agentInputs,
    tier1Ms: Number(tier1Ms.toFixed(2)), tier2Ms: Number(tier2Ms.toFixed(2)),
    detection: {
      metadata: analyzerRows.find(({ name }) => name === 'metadata')?.findingCount > 0,
      customRule: analyzerRows.find(({ name }) => name === 'custom-rule')?.findingCount > 0,
      guardDog: analyzerRows.find(({ name }) => name === 'guarddog')?.findingCount > 0,
      tier2: tier2.analyzerResult.findings.length > 0 || tier2Evidence.length > 0,
    },
  };
}

async function sourceCodeStats(root) {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.(?:js|cjs|mjs)$/iu.test(entry.name)) {
        files += 1;
        bytes += (await stat(path)).size;
      }
    }
  }
  return { files, bytes };
}

function inputSize(input) {
  return {
    sliceCount: input.initialCodeSlices.length,
    codeBytes: input.initialCodeSlices.reduce((total, slice) => total + Buffer.byteLength(slice.content, 'utf8'), 0),
    payloadBytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
    sectionBytes: Object.fromEntries(Object.entries(input).map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value), 'utf8')])),
  };
}

async function measureAgentInputs(context, packageRoot, archiveSha256, analyzerResults, evidences, handoff, gate) {
  const packageContext = projectPackageContext(context.metadata.packageJson);
  const trigger = agentTrigger.decide('RISK_BASED', packageContext, analyzerResults, evidences);
  let legacy = { status: 'SKIPPED', conditions: trigger.matchedConditions, sliceCount: 0, codeBytes: 0, payloadBytes: 0 };
  if (trigger.shouldExecute) {
    try {
      const input = await legacyInputBuilder.build({
        context, calculatedIntegrity: '', analyzerResults, atomicEvidences: evidences,
        triggerDecision: trigger, settings: agentSettings,
      });
      legacy = { status: 'BUILT', conditions: trigger.matchedConditions, ...inputSize(input), missingDataCount: input.missingData.length };
    } catch (error) {
      legacy = { status: 'FAILED', conditions: trigger.matchedConditions, error: String(error) };
    }
  }
  let shadow = { status: handoff === undefined ? 'NO_HANDOFF' : 'SKIPPED_GATE', sliceCount: 0, codeBytes: 0, payloadBytes: 0 };
  if (handoff !== undefined && gate?.shouldEscalate) {
    try {
      const resolver = new RuntimeArtifactResolver([
        { descriptor: originalArtifactDescriptor(archiveSha256, await artifactHasher.hashDirectory(packageRoot)), root: packageRoot },
        { descriptor: handoff.artifact, root: handoff.artifactRoot },
      ]);
      const execution = buildTier3ExecutionInput(handoff, toPackageContextV0_3(packageContext), resolver);
      if (!execution.validatedPlan.shouldExecute) {
        shadow = { status: 'NO_TARGETS', sliceCount: 0, codeBytes: 0, payloadBytes: 0 };
      } else {
        const built = await tier3InputBuilder.build(execution, {
          scanId: context.scanId, packageName: context.package.name,
          packageVersion: context.package.version, archiveSha256,
        }, {
          codeSlices: reportCodeSliceBudget(),
          maxToolCalls: agentSettings.LLM_AGENT_MAX_TOOL_CALLS,
          maxAdditionalCodeRequests: agentSettings.LLM_AGENT_MAX_ADDITIONAL_CODE_REQUESTS,
        });
        shadow = { status: 'BUILT', ...inputSize(built.input), targetCount: execution.validatedPlan.targets.length,
          missingDataCount: built.input.missingData.length };
      }
    } catch (error) {
      shadow = { status: 'FAILED', error: String(error) };
    }
  }
  return { legacy, shadow };
}

function reportCodeSliceBudget() {
  return {
    maxInitialSlices: agentSettings.LLM_AGENT_MAX_INITIAL_SLICES,
    maxLinesPerSlice: agentSettings.LLM_AGENT_MAX_LINES_PER_SLICE,
    maxInitialCodeLines: agentSettings.LLM_AGENT_MAX_INITIAL_CODE_LINES,
    maxTotalCodeLines: agentSettings.LLM_AGENT_MAX_TOTAL_CODE_LINES,
    maxFileSizeBytes: agentSettings.LLM_AGENT_MAX_FILE_SIZE_BYTES,
  };
}

function markdownReport(result) {
  const rows = result.variants.guarddogOn.samples;
  const total = (items, pick) => items.reduce((sum, item) => sum + pick(item), 0);
  const routed = rows.filter((item) => item.agentInputs?.legacy.status === 'BUILT');
  const shadow = rows.filter((item) => item.agentInputs?.shadow.status === 'BUILT');
  const rawBytes = total(rows, (item) => item.sourceCode?.bytes ?? 0);
  const legacyBytes = total(routed, (item) => item.agentInputs.legacy.codeBytes);
  const shadowBytes = total(shadow, (item) => item.agentInputs.shadow.codeBytes);
  const legacyPayloadBytes = total(routed, (item) => item.agentInputs.legacy.payloadBytes);
  const shadowPayloadBytes = total(shadow, (item) => item.agentInputs.shadow.payloadBytes);
  const combined = rows.filter((item) => item.agentInputs?.legacy.status === 'BUILT' || item.agentInputs?.shadow.status === 'BUILT');
  const lines = [
    '# Tier 1·Tier 2 이후 코드 입력량 실측', '',
    `- Scanner: ${result.execution.scannerCommitSha} (${result.execution.scannerBranch})`,
    `- 데이터셋: ${result.source.repository}@${result.source.revision}, ${rows.length}개`,
    '- 패키지 실행: 없음. GuardDog/Semgrep: 격리 Docker. LLM 호출: 없음.',
    '- 기준 코드량: 안전 추출된 `.js`·`.cjs`·`.mjs` 파일의 UTF-8 바이트 합계.',
    '- 전달 코드량: 초기 Slice의 `content` UTF-8 바이트 합계. 프롬프트·실행 중 재요청은 제외.', '',
    '| 경로 | 대상 패키지 | 대상 패키지의 전체 코드 | 초기 Slice 코드 | 입력 JSON | 전체 표본 대비 코드 감소율 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| 기존 Agent RISK_BASED | ${routed.length}/${rows.length} | ${total(routed, (item) => item.sourceCode.bytes)} | ${legacyBytes} | ${legacyPayloadBytes} | ${rawBytes === 0 ? '계산 불가' : `${((1 - legacyBytes / rawBytes) * 100).toFixed(2)}%`} |`,
    `| Tier 3 Shadow Gate | ${shadow.length}/${rows.length} | ${total(shadow, (item) => item.sourceCode.bytes)} | ${shadowBytes} | ${shadowPayloadBytes} | ${rawBytes === 0 ? '계산 불가' : `${((1 - shadowBytes / rawBytes) * 100).toFixed(2)}%`} |`,
    `| 현재 두 경로 동시 활성화 가정 | ${combined.length}/${rows.length} | ${total(combined, (item) => item.sourceCode.bytes)} | ${legacyBytes + shadowBytes} | ${legacyPayloadBytes + shadowPayloadBytes} | ${rawBytes === 0 ? '계산 불가' : `${((1 - (legacyBytes + shadowBytes) / rawBytes) * 100).toFixed(2)}%`} |`,
    '', `전체 표본의 추출 코드량: ${rawBytes}바이트. 실제 Provider 토큰·비용은 측정하지 않았다.`, '',
    '| 샘플 | 정답 | 원본 코드 바이트 | 기존 경로 상태·Slice 바이트 | 새 경로 상태·Slice 바이트 |',
    '| --- | --- | ---: | --- | --- |',
    ...rows.map((item) => `| ${item.name} | ${item.truth} | ${item.sourceCode?.bytes ?? '실패'} | ${item.agentInputs?.legacy.status ?? '실패'}·${item.agentInputs?.legacy.codeBytes ?? 0} | ${item.agentInputs?.shadow.status ?? '실패'}·${item.agentInputs?.shadow.codeBytes ?? 0} |`),
    '', '## 측정 한계', '',
    '- Policy의 실제 판정은 이 실행에 포함되지 않았다. 신호 유무를 오탐·미탐으로 해석하지 않는다.',
    '- 기존 Agent와 새 Shadow 경로는 독립적이므로 새 게이트 비율을 전체 LLM 호출률로 해석하지 않는다.',
    '- 입력 JSON 바이트는 원본 JSON의 `agentInputs`에 기록했다. 토큰 수는 모델별 직렬화와 도구 재요청에 따라 달라진다.',
  ];
  return `${lines.join('\n')}\n`;
}

function createGuardDogAnalyzer(workspaceRoot) {
  const processRunner = {
    run: (request) => sandbox.run({
      ...request,
      externalArtifact: {
        packageRoot: request.externalArtifact?.packageRoot ?? String(request.args[2]),
        containerPackageRoot: '/analysis/package',
      },
    }),
  };
  return new GuardDogAnalyzer({
    executable: 'guarddog', toolVersion: '3.1.0', workspaceRoot,
    timeoutMs: 120_000, killGraceMs: 1_000, sandboxMode: 'DISABLED', maxOutputBytes: 4 * 1024 * 1024,
  }, { externalProcessRunner: sandbox, processRunner });
}

function createDisabledGuardDogAnalyzer() {
  return {
    name: 'guarddog', version: '0.1.0',
    analyzeResult: async (_input, context) => ({
      ...context, analyzer: 'guarddog', analyzerVersion: '0.1.0', status: 'SKIPPED', findings: [], errors: [],
    }),
  };
}

function disabledSandbox() {
  return { preflight: async () => ({
    verified: false, mode: 'UNVERIFIED', mechanism: 'DOCKER_NETWORK_NONE', imageDigest: 'disabled',
    runtimeVersion: 'disabled', policyVersion: 'disabled', mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT',
    rootFilesystem: 'READ_ONLY', resourceLimits: { pids: 0, memory: '0', cpus: '0', tmpfsSize: '0', timeoutMs: 0 },
    reasonCode: 'ANALYZER_DISABLED',
  }) };
}

function buildAblation(onSamples, offSamples) {
  const combos = [
    ['metadataOnly', ['metadata']],
    ['customRuleOnly', ['customRule']],
    ['guardDogOnly', ['guardDog']],
    ['metadataAndCustomRule', ['metadata', 'customRule']],
    ['metadataAndGuardDog', ['metadata', 'guardDog']],
    ['customRuleAndGuardDog', ['customRule', 'guardDog']],
    ['allTier1', ['metadata', 'customRule', 'guardDog']],
  ];
  const rows = {};
  for (const [name, analyzers] of combos) {
    rows[name] = metricsFor(onSamples, analyzers, false);
    rows[`${name}PlusTier2`] = metricsFor(onSamples, analyzers, true);
  }
  const guardDogOnOff = {
    on: metricsFor(onSamples, ['metadata', 'customRule', 'guardDog'], false),
    off: metricsFor(offSamples, ['metadata', 'customRule'], false),
    onLatency: latency(onSamples),
    offLatency: latency(offSamples),
  };
  return { summary: { corpus: onSamples.length, criterion: 'package-level OMC label; any selected analyzer finding is positive' }, combinations: rows, guardDogOnOff };
}

function metricsFor(samples, analyzers, includeTier2) {
  const predicted = samples.map((sample) => analyzers.some((analyzer) => sample.detection?.[analyzer])
    || (includeTier2 && sample.detection?.tier2));
  const truth = samples.map((sample) => sample.truth === 'MALICIOUS');
  const tp = predicted.filter((value, index) => value && truth[index]).length;
  const fp = predicted.filter((value, index) => value && !truth[index]).length;
  const tn = predicted.filter((value, index) => !value && !truth[index]).length;
  const fn = predicted.filter((value, index) => !value && truth[index]).length;
  return { tp, fp, tn, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn), fpr: ratio(fp, fp + tn), fnr: ratio(fn, fn + tp), latency: latency(samples) };
}

function summarizeVariant(samples) {
  const tier2 = samples.filter((sample) => sample.tier2Entry === true).length;
  const escalated = samples.filter((sample) => sample.gate?.shouldEscalate === true).length;
  return {
    corpus: samples.length, completed: samples.filter((sample) => sample.status !== 'FAILED').length,
    failed: samples.filter((sample) => sample.status === 'FAILED').length,
    tier1CompletionRate: (samples.length - tier2) / samples.length,
    tier2EntryRate: tier2 / samples.length,
    tier3EscalationRate: escalated / samples.length,
    llmFreeCompletionRate: (samples.length - escalated) / samples.length,
    gateBeforeRate: tier2 / samples.length,
    gateReduction: (tier2 - escalated) / samples.length,
    tier1EvidenceCount: samples.reduce((sum, sample) => sum + (sample.tier1EvidenceCount ?? 0), 0),
    tier2EvidenceCount: samples.reduce((sum, sample) => sum + (sample.tier2EvidenceCount ?? 0), 0),
    tier1Latency: latency(samples.map((sample) => ({ tier1Ms: sample.tier1Ms })), 'tier1Ms'),
    tier2Latency: latency(samples.map((sample) => ({ tier2Ms: sample.tier2Ms })), 'tier2Ms'),
    totalLatency: latency(samples),
    gateDecisionLatency: latency(samples.filter((sample) => Number.isFinite(sample.gate?.decisionMs)).map((sample) => ({ gateMs: sample.gate.decisionMs })), 'gateMs'),
  };
}

function latency(samples, key = 'totalMs') {
  const values = samples.map((sample) => Number(sample[key])).filter(Number.isFinite).sort((a, b) => a - b);
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return Number(values[Math.max(0, Math.ceil(values.length * fraction) - 1)].toFixed(2));
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function caseId(item) {
  return `OMC-${item.label}-${item.name.replace(/[^A-Za-z0-9]+/gu, '-').slice(0, 80)}`;
}

async function extractArchiveCodeOnly(archivePath, outputRoot) {
  if (archivePath.endsWith('.zip')) {
    await extractZipCodeOnly(archivePath, outputRoot);
    return;
  }
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 10_000, maxBuffer: 5_000_000 })
    .split(/\r?\n/u).filter(Boolean);
  for (const entry of entries) {
    if (!/\.(?:js|cjs|mjs|json)$/iu.test(entry)) continue;
    if (entry.startsWith('/') || entry.includes('\\') || entry.includes('\0')) continue;
    const normalized = posix.normalize(entry.replace(/^\.\//u, ''));
    if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) continue;
    const content = execFileSync('tar', ['-xOzf', archivePath, entry], { timeout: 10_000, maxBuffer: 600_000 });
    if (content.length > 512_000) continue;
    const destination = join(outputRoot, normalized);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

async function flattenPackageRoot(rawRoot, packageRoot) {
  const packageJsonPath = await findFile(rawRoot, 'package.json');
  if (packageJsonPath === undefined) throw new Error('PACKAGE_JSON_NOT_FOUND');
  await mkdir(packageRoot, { recursive: true });
  await cp(dirname(packageJsonPath), packageRoot, { recursive: true, force: true });
}

async function findFile(root, filename) {
  const direct = join(root, filename);
  try { await readFile(direct, 'utf8'); return direct; } catch { /* continue */ }
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === filename) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function readPackageJson(packageRoot) {
  return JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
}

async function downloadBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`DOWNLOAD_HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function shaFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function git(...args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}
