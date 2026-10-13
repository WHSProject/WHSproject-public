import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { CustomRuleAnalyzer } from '../dist/analyzers/custom-rule/custom-rule.analyzer.js';
import { DockerExternalCustomRuleRunner } from '../dist/analyzers/custom-rule/docker-external-custom-rule.runner.js';
import { GuardDogAnalyzer } from '../dist/analyzers/guarddog/guarddog.analyzer.js';
import { DockerExternalGuardDogRunner } from '../dist/analyzers/guarddog/docker-external-guarddog.runner.js';
import { ObfuscationAnalyzer } from '../dist/analyzers/obfuscation/obfuscation.analyzer.js';
import { buildTier2ArtifactDescriptor } from '../dist/analyzers/obfuscation/tier2-handoff.js';
import { ArtifactHasher } from '../dist/artifact/hasher/artifact-hasher.js';
import { buildAgentPlanningInput } from '../dist/application/planning/agent-planning-input.adapter.js';
import { evaluateStaticFilter } from '../dist/application/planning/static-filter.js';
import { EvidenceNormalizer } from '../dist/evidence/normalizer/evidence-normalizer.js';
import { AgentInputV0_3Builder } from '../dist/llm-agent/artifact/agent-input-v0_3.builder.js';
import { validateAgentAnalysisInputV0_3 } from '../dist/llm-agent/artifact/agent-input-v0_3.validator.js';
import { buildAgentPromptV0_2 } from '../dist/llm-agent/artifact/agent-prompt-v0_2.js';
import { AGENT_OUTPUT_API_SCHEMA_V0_2 } from '../dist/llm-agent/artifact/agent-output-v0_2.api-schema.js';
import { buildPlanningTier3ExecutionInput } from '../dist/llm-agent/artifact/planning-tier3-execution-input.js';
import { readArtifactSource, registerCodeSlice, sha256Hex } from '../dist/llm-agent/artifact/code-slice.factory.js';
import { InMemoryCodeSliceRegistry } from '../dist/llm-agent/artifact/code-slice.registry.js';

const traverse = traverseModule.default ?? traverseModule;
const scannerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(scannerRoot, '../..');
const selectionRoot = join(scannerRoot, 'guarddog-pilot-selection');
const baselineRoot = join(scannerRoot, 'experiments/agent-planning-static-filter/2026-10-01-pilot-v2');
const args = parseArgs(process.argv.slice(2));
const targetIds = ['DD-NPM-003', 'DD-NPM-010', 'DD-NPM-013', 'DD-NPM-015', 'DD-NPM-001'];
const reusedIds = new Set(['DD-NPM-003', 'DD-NPM-010', 'DD-NPM-013']);
const rerunIds = new Set(['DD-NPM-001', 'DD-NPM-015']);
const productionPolicy = {
  codeSlices: { maxInitialSlices: 10, maxLinesPerSlice: 120, maxInitialCodeLines: 800, maxTotalCodeLines: 1040, maxFileSizeBytes: 1024 * 1024 },
  maxToolCalls: 4, maxAdditionalCodeRequests: 2,
};
const experimentMaxCodeFileBytes = args.maxCodeFileBytes ?? 12 * 1024 * 1024;
const providerRequestLimitBytes = args.maxProviderRequestBytes ?? 4 * 1024 * 1024;

if (!args.output || args.consent !== '--offline-code-volume-inputs') {
  throw new Error('Usage: node scripts/agent-code-volume-input.mjs --output <new-or-existing-dir> --offline-code-volume-inputs [--reuse-frozen] [--max-provider-request-bytes N]');
}
if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) {
  // Presence is allowed in the parent shell, but the harness intentionally removes access.
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
}
process.env.OBFUSCATION_GPT_MODE = 'off';
process.env.LLM_AGENT_ENABLED = 'false';

const outputRoot = resolve(args.output);
const privateRoot = join(outputRoot, 'private');
const samplesRoot = join(outputRoot, 'samples');
await mkdir(privateRoot, { recursive: true });
await mkdir(samplesRoot, { recursive: true });
await ensureIgnored(outputRoot);

const sourceManifestPath = join(selectionRoot, 'guarddog-pilot-samples.json');
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
const sourceById = new Map(sourceManifest.samples.map((sample) => [sample.sampleId, sample]));
const runStartedAt = new Date().toISOString();
const records = [];
let llmCalls = 0;
let staticRuntime;

for (let index = 0; index < targetIds.length; index += 1) {
  const sourceId = targetIds[index];
  const experimentId = `sample-${String(index + 1).padStart(3, '0')}`;
  const sample = sourceById.get(sourceId);
  const started = Date.now();
  try {
    if (!sample) throw new Error('SAMPLE_NOT_IN_MANIFEST');
    const archivePath = join(selectionRoot, sample.archivePath);
    const archiveHash = await sha256File(archivePath);
    if (archiveHash !== sample.archiveSha256) throw new Error('ARCHIVE_HASH_MISMATCH');
    const extractedRoot = join(selectionRoot, 'artifacts/extracted', basename(sample.archivePath, '.zip'));
    const originalRoot = await findPackageRoot(extractedRoot);
    const packageJson = await readJson(join(originalRoot, 'package.json'));
    if (packageJson.name !== sample.packageName || packageJson.version !== sample.packageVersion) throw new Error('PACKAGE_IDENTITY_MISMATCH');

    const frozenPath = join(privateRoot, experimentId, 'frozen.json');
    let prepared;
    if (args.reuseFrozen && await exists(frozenPath)) {
      prepared = await loadFrozen(frozenPath, originalRoot);
    } else if (reusedIds.has(sourceId)) {
      prepared = await reusePlanningSnapshot({ sample, sourceId, experimentId, archivePath, originalRoot, packageJson });
    } else if (rerunIds.has(sourceId)) {
      staticRuntime ??= await createStaticRuntime(outputRoot, () => { llmCalls += 1; });
      prepared = await rerunStatic({ sample, sourceId, experimentId, archivePath, originalRoot, packageJson, runtime: staticRuntime });
    } else {
      throw new Error('UNSUPPORTED_PREPARATION_MODE');
    }

    const generated = await generateLevels(prepared, experimentId);
    await jsonFile(frozenPath, freezeForDisk(prepared));
    for (const level of generated.levels) {
      await jsonFile(join(privateRoot, experimentId, `${level.level}-input.json`), level.input);
      await jsonFile(join(privateRoot, experimentId, `${level.level}-provider-request.json`), level.providerRequest);
    }
    const record = {
      experimentId, sourceSampleId: sourceId,
      preparation: prepared.preparation,
      subject: { packageName: sample.packageName, packageVersion: sample.packageVersion, archiveSha256: archiveHash },
      source: { archive: relative(scannerRoot, archivePath), originalRoot: relative(scannerRoot, originalRoot) },
      versions: prepared.versions,
      staticFilter: prepared.filterResult === undefined ? null : {
        status: prepared.filterResult.status, ruleVersion: prepared.filterResult.ruleVersion,
        reasonCodes: prepared.filterResult.reasonCodes,
      },
      fixedContractHash: generated.fixedContractHash,
      levels: generated.levels.map(sharedLevelRecord),
      limitations: [...new Set([...prepared.limitations, ...generated.limitations])],
      validation: generated.validation,
      status: generated.levels.some((level) => level.status === 'INPUT_LIMIT_EXCEEDED') ? 'PREPARED_WITH_LIMIT' : 'PREPARED',
      durationMs: Date.now() - started,
    };
    records.push(record);
    await jsonFile(join(samplesRoot, `${experimentId}.json`), record);
  } catch (error) {
    const record = { experimentId, sourceSampleId: sourceId, status: 'PREPARATION_FAILED', reason: safeError(error), durationMs: Date.now() - started };
    records.push(record);
    await jsonFile(join(samplesRoot, `${experimentId}.json`), record);
  }
}

if (llmCalls !== 0) throw new Error(`LLM_CALL_GUARD_TRIGGERED:${llmCalls}`);
const manifest = {
  schemaVersion: '1.0.0', purpose: 'CODE_VOLUME_INPUT_COMPARISON_NOT_MODEL_EVALUATION',
  createdAt: runStartedAt, scannerCommit: git('rev-parse', 'HEAD'), scannerBranch: git('branch', '--show-current'),
  sourceManifest: relative(scannerRoot, sourceManifestPath), sourceManifestSha256: await sha256File(sourceManifestPath),
  baseline: relative(scannerRoot, baselineRoot), targetCount: targetIds.length,
  preparedCount: records.filter((record) => record.status?.startsWith('PREPARED')).length,
  failedCount: records.filter((record) => record.status === 'PREPARATION_FAILED').length,
  configuration: {
    productionL0Policy: productionPolicy, experimentMaxCodeFileBytes, providerRequestLimitBytes,
    tokenizer: 'CHARACTERS_DIVIDED_BY_4_CEILING_ESTIMATE', additionalCodeRequests: 'DISABLED',
    jev: 'DISABLED', llmCalls, registryDownloads: 0, packageInstall: false, packageExecution: false, lifecycleExecution: false,
  },
  preparation: { reusedPilotV2: [...reusedIds], rerunCurrentStatic: [...rerunIds] },
  samples: records,
};
await jsonFile(join(outputRoot, 'manifest.json'), manifest);
process.stdout.write(`${JSON.stringify({ outputRoot: relative(repositoryRoot, outputRoot), preparedCount: manifest.preparedCount, failedCount: manifest.failedCount, llmCalls }, null, 2)}\n`);

async function reusePlanningSnapshot(input) {
  const record = await readJson(join(baselineRoot, 'samples', `${input.sourceId}.json`));
  if (!record.planningInput) throw new Error('BASELINE_PLANNING_INPUT_MISSING');
  const planningInput = neutralizePlanningInput(record.planningInput, input.experimentId);
  const context = analysisContext(input, planningInput.subject.requestId, planningInput.subject.scanId, input.originalRoot);
  const originalContentSha256 = await new ArtifactHasher().hashDirectory(input.originalRoot);
  const execution = buildPlanningTier3ExecutionInput({ planningInput, context, originalContentSha256 });
  return {
    preparation: 'REUSED_PILOT_V2_STATIC_RESULTS', planningInput, context, execution,
    filterResult: evaluateStaticFilter(planningInput), roots: rootsForExecution(execution),
    versions: { source: record.versions ?? record.runtime ?? 'pilot-v2', currentScannerCommit: git('rev-parse', 'HEAD') },
    limitations: ['RESTORED_ARTIFACT_NOT_REUSED:PILOT_V2_RUNTIME_PATH_CLEANED'],
  };
}

async function rerunStatic(input) {
  const workRoot = join(privateRoot, input.experimentId, 'work');
  const packageRoot = join(workRoot, 'package');
  await mkdir(workRoot, { recursive: true });
  if (!await exists(packageRoot)) await cp(input.originalRoot, packageRoot, { recursive: true, dereference: false, errorOnExist: true });
  if (!input.runtime.preflightVerified) {
    const [guardDog, customRule] = await Promise.all([
      input.runtime.guardRunner.preflight(packageRoot), input.runtime.customRunner.preflight(packageRoot),
    ]);
    if (!guardDog.verified || !customRule.verified) {
      throw new Error(`STATIC_SANDBOX_PREFLIGHT_FAILED:${guardDog.reasonCode ?? 'GUARDDOG'}:${customRule.reasonCode ?? 'CUSTOM_RULE'}`);
    }
    input.runtime.preflightVerified = true;
  }
  const context = analysisContext({ ...input, originalRoot: packageRoot }, `${input.experimentId}-request`, `${input.experimentId}-scan`, packageRoot);
  const analyzerContext = { requestId: context.requestId, scanId: context.scanId };
  const tier1 = [];
  tier1.push(await input.runtime.metadata.analyzeResult({ registryMetadata: {}, packageJson: input.packageJson }, analyzerContext));
  tier1.push(await input.runtime.customRule.analyzeResult({ extractedPath: packageRoot, packageJson: input.packageJson }, analyzerContext));
  tier1.push(await input.runtime.staticGuardDog.analyzeResult({ context }, analyzerContext));
  const tier2 = await input.runtime.obfuscation.analyze(context, tier1);
  const ids = { value: 0 };
  const normalization = new EvidenceNormalizer(undefined,
    () => `${input.experimentId}-evidence-${String(++ids.value).padStart(5, '0')}`,
    () => new Date('2026-10-04T00:00:00.000Z')).normalize({
    requestId: context.requestId, scanId: context.scanId,
    subject: { ecosystem: 'npm', packageName: input.sample.packageName, packageVersion: input.sample.packageVersion, artifactHash: input.sample.archiveSha256 },
    artifactRoot: packageRoot, analyzerResults: tier1,
    ...(tier2.evidenceCandidates.length === 0 ? {} : { tier2Candidates: tier2.evidenceCandidates }),
  });
  const planningInput = buildAgentPlanningInput({ context, tier1Results: tier1, tier2Result: tier2, normalizationResult: normalization });
  const originalContentSha256 = await new ArtifactHasher().hashDirectory(packageRoot);
  let restoredArtifact;
  const limitations = [];
  if (tier2.restore?.restored?.length > 0 && await exists(tier2.restore.outputRoot)) {
    try {
      const contentSha256 = await new ArtifactHasher().hashDirectory(tier2.restore.outputRoot);
      restoredArtifact = { descriptor: buildTier2ArtifactDescriptor(context, tier2.restore, contentSha256), root: tier2.restore.outputRoot };
    } catch { limitations.push('RESTORED_ARTIFACT_HASH_FAILED'); }
  }
  const execution = buildPlanningTier3ExecutionInput({
    planningInput, context, originalContentSha256, ...(restoredArtifact ? { restoredArtifact } : {}),
    ...(!restoredArtifact && tier2.restore?.restored?.length > 0 ? { restoredArtifactUnavailableReason: 'RESTORED_ARTIFACT_PREPARATION_FAILED' } : {}),
  });
  return {
    preparation: 'RERUN_CURRENT_STATIC_PIPELINE', planningInput, context, execution,
    filterResult: evaluateStaticFilter(planningInput), roots: rootsForExecution(execution),
    versions: {
      currentScannerCommit: git('rev-parse', 'HEAD'), node: process.version,
      guarddog: '3.1.0', semgrep: '1.172.0', rulesetSha256: input.runtime.rulesetHash,
      planningSchemaVersion: planningInput.schemaVersion,
      analyzers: [...planningInput.tier1.analyzers, planningInput.tier2.analyzer, ...planningInput.tier2.derivedAnalyzers]
        .map((item) => ({ analyzer: item.analyzer, analyzerVersion: item.analyzerVersion, status: item.status })),
    },
    limitations,
  };
}

async function generateLevels(prepared, experimentId) {
  const builder = new AgentInputV0_3Builder();
  const built = await builder.build(prepared.execution, {
    scanId: prepared.context.scanId, packageName: prepared.context.package.name,
    packageVersion: prepared.context.package.version, archiveSha256: prepared.context.artifact.hash, createdAt: null,
  }, productionPolicy);
  const base = disableTools(built.input);
  const baseTargets = structuredClone(base.analysisPlan.targets);
  const fixedContractHash = stableHash(fixedProjection(base, baseTargets));
  const levels = [];
  const limitations = [];
  let sourceHashesVerified = true;
  const ranges = rangesFromSlices(base.initialCodeSlices);
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
    if (level === 'L1') await addLevel1Ranges(ranges, prepared.execution, limitations);
    if (level === 'L2') await addFindingFiles(ranges, prepared.execution, limitations);
    if (level === 'L3') await addLevel3Files(ranges, prepared.execution, base.packageContext, limitations);
    if (level === 'L4') await addLevel4Files(ranges, prepared.execution, base.packageContext, limitations);
    let input = level === 'L0' ? structuredClone(base) : await materializeInput(base, baseTargets, ranges, prepared.execution, level, experimentId, limitations);
    const candidateCodeHash = stableHash(input.initialCodeSlices.map(sliceIdentity));
    const previous = levels.at(-1);
    // A comparison condition with the same code scope must be byte-identical to
    // the preceding request; level labels never enter the model input.
    if (previous?.codeHash === candidateCodeHash) input = structuredClone(previous.input);
    const roots = await Promise.all(prepared.execution.artifacts.list().map((artifact) => prepared.execution.artifacts.resolveRoot(artifact.artifactId)));
    const errors = validateAgentAnalysisInputV0_3(input, { forbiddenSubstrings: roots });
    if (errors.length > 0) throw new Error(`EXPERIMENT_INPUT_INVALID:${level}:${errors.join('|')}`);
    sourceHashesVerified = sourceHashesVerified && await verifySlicesAgainstSources(input, prepared.execution);
    if (stableHash(fixedProjection(input, baseTargets)) !== fixedContractHash) throw new Error(`FIXED_FIELDS_CHANGED:${level}`);
    const prompt = buildAgentPromptV0_2(input, [], [], { additionalCodeRequests: 'DISABLED' });
    const providerRequest = { model: 'MODEL_SET_AT_PAID_RUN_TIME', input: prompt, store: false,
      text: { format: { type: 'json_schema', name: 'scanner_agent_analysis', schema: AGENT_OUTPUT_API_SCHEMA_V0_2, strict: false } } };
    const requestText = JSON.stringify(providerRequest);
    const codeHash = stableHash(input.initialCodeSlices.map(sliceIdentity));
    levels.push({
      level, input, providerRequest, codeHash, sameInputAsPrevious: previous?.codeHash === codeHash,
      status: Buffer.byteLength(requestText) > providerRequestLimitBytes ? 'INPUT_LIMIT_EXCEEDED' : 'READY',
      providerRequestBytes: Buffer.byteLength(requestText), providerRequestCharacters: requestText.length,
      estimatedTokens: Math.ceil(requestText.length / 4),
      codeBytes: input.initialCodeSlices.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0),
      codeLines: input.initialCodeSlices.reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0),
      fileCount: new Set(input.initialCodeSlices.map((item) => `${item.artifactId}\0${item.filePath}`)).size,
      sliceCount: input.initialCodeSlices.length,
      ranges: input.initialCodeSlices.map((item) => ({ artifactId: item.artifactId, representation: descriptor(input, item.artifactId)?.representation,
        filePath: item.filePath, startLine: item.startLine, endLine: item.endLine, contentSha256: item.contentSha256,
        sourceSha256: item.sourceSha256, bytes: Buffer.byteLength(item.content), selectionReason: item.selectionReason })),
    });
  }
  return {
    fixedContractHash, levels, limitations,
    validation: { fixedFieldsIdentical: true, cumulative: assertCumulative(levels), sourceHashesVerified,
      representationSeparated: assertRepresentationSeparation(levels, prepared.execution), noHostPaths: true,
      noGroundTruthLabels: levels.every(({ providerRequest }) => !containsForbiddenModelLabel(providerRequest)), additionalCodeRequestsDisabled: true },
  };
}

function disableTools(input) {
  const clone = structuredClone(input);
  clone.analysisPolicy.maxToolCalls = 0;
  clone.analysisPolicy.maxAdditionalCodeRequests = 0;
  clone.toolResponseCatalog = clone.toolResponseCatalog.map((tool) => ({ ...tool, status: 'UNAVAILABLE', reason: 'Disabled for offline code-volume experiment.' }));
  return clone;
}

async function addLevel1Ranges(ranges, execution, limitations) {
  for (const binding of execution.bindings.findingBindings) {
    if (binding.startLine === undefined) continue;
    try {
      const source = await readArtifactSource(execution.artifacts, binding.artifactId, binding.filePath, experimentMaxCodeFileBytes);
      const selected = syntaxBoundary(source, binding.startLine, binding.endLine ?? binding.startLine);
      addRange(ranges, binding.artifactId, binding.filePath, selected.startLine, selected.endLine);
      for (const dependency of selected.directDeclarations) addRange(ranges, binding.artifactId, binding.filePath, dependency.startLine, dependency.endLine);
    } catch (error) {
      limitations.push(`L1_SYNTAX_OR_READ_FAILED:${safeRef(binding.artifactId, binding.filePath)}:${safeError(error)}`);
    }
  }
}

async function addFindingFiles(ranges, execution, limitations) {
  for (const binding of execution.bindings.findingBindings) {
    try {
      const source = await readArtifactSource(execution.artifacts, binding.artifactId, binding.filePath, experimentMaxCodeFileBytes);
      if (source.lineCount > 0) addRange(ranges, binding.artifactId, binding.filePath, 1, source.lineCount);
    } catch (error) { limitations.push(`L2_FINDING_FILE_UNAVAILABLE:${safeRef(binding.artifactId, binding.filePath)}:${safeError(error)}`); }
  }
}

async function addLevel3Files(ranges, execution, packageContext, limitations) {
  const queue = [];
  for (const [key] of ranges) queue.push({ ...parseKey(key), depth: 0 });
  for (const filePath of packageSeedFiles(packageContext)) {
    for (const artifact of execution.artifacts.list()) queue.push({ artifactId: artifact.artifactId, filePath, depth: 0 });
  }
  const seen = new Set();
  while (queue.length > 0) {
    const item = queue.shift();
    const key = rangeKey(item.artifactId, item.filePath);
    if (seen.has(key) || item.depth > 2) continue;
    seen.add(key);
    try {
      const source = await readArtifactSource(execution.artifacts, item.artifactId, item.filePath, experimentMaxCodeFileBytes);
      if (source.lineCount > 0) addRange(ranges, item.artifactId, item.filePath, 1, source.lineCount);
      if (item.depth === 2) continue;
      for (const specifier of staticRelativeImports(source.lines.join('\n'))) {
        const resolved = await resolveLocalModule(execution, item.artifactId, item.filePath, specifier);
        if (resolved) queue.push({ artifactId: item.artifactId, filePath: resolved, depth: item.depth + 1 });
        else limitations.push(`L3_IMPORT_UNRESOLVED:${safeRef(item.artifactId, item.filePath)}:${specifier}`);
      }
    } catch (error) { limitations.push(`L3_FILE_UNAVAILABLE:${safeRef(item.artifactId, item.filePath)}:${safeError(error)}`); }
  }
}

async function addLevel4Files(ranges, execution, packageContext, limitations) {
  const executableScripts = new Set(packageSeedFiles(packageContext).filter((file) => ['.sh', '.py'].includes(extname(file))));
  for (const artifact of execution.artifacts.list()) {
    const root = await execution.artifacts.resolveRoot(artifact.artifactId);
    const walked = await walkPackage(root);
    for (const item of walked) {
      if (item.reason) { limitations.push(`L4_EXCLUDED:${artifact.representation}:${item.path}:${item.reason}`); continue; }
      const supported = isJsTs(item.path) || executableScripts.has(item.path);
      if (!supported) { limitations.push(`L4_EXCLUDED:${artifact.representation}:${item.path}:UNSUPPORTED_NON_JS_TS`); continue; }
      try {
        const source = await readArtifactSource(execution.artifacts, artifact.artifactId, item.path, experimentMaxCodeFileBytes);
        if (source.lineCount > 0) addRange(ranges, artifact.artifactId, item.path, 1, source.lineCount);
      } catch (error) { limitations.push(`L4_FILE_UNAVAILABLE:${artifact.representation}:${item.path}:${safeError(error)}`); }
    }
  }
}

async function materializeInput(base, baseTargets, ranges, execution, level, experimentId, limitations) {
  const input = structuredClone(base);
  const registry = new InMemoryCodeSliceRegistry();
  const baseByRange = new Map(base.initialCodeSlices.map((slice) => [sliceRangeKey(slice), slice]));
  const slices = [];
  const targets = structuredClone(baseTargets);
  let sequence = 0;
  for (const [key, fileRanges] of [...ranges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { artifactId, filePath } = parseKey(key);
    let source;
    try { source = await readArtifactSource(execution.artifacts, artifactId, filePath, experimentMaxCodeFileBytes); }
    catch (error) { limitations.push(`${level}_MATERIALIZE_FAILED:${safeRef(artifactId, filePath)}:${safeError(error)}`); continue; }
    for (const range of mergeRanges(fileRanges)) {
      const baseSlice = baseByRange.get(`${artifactId}\0${filePath}\0${range.startLine}\0${range.endLine}`);
      if (baseSlice) { registry.register(baseSlice); slices.push(registry.get(baseSlice.sliceId)); continue; }
      sequence += 1;
      const targetId = `code-volume-${level.toLowerCase()}-${String(sequence).padStart(4, '0')}`;
      const refs = relatedRefs(execution, artifactId, filePath, range);
      targets.push({ targetId, artifactId, filePath, preferredRange: range, priority: 'LOW',
        findingRefs: refs.findings, evidenceRefs: refs.evidences, reasonCodes: [`EXPERIMENT_${level}_CODE_SCOPE`] });
      slices.push(registerCodeSlice(registry, source, range, {
        sliceId: `${experimentId}-${level.toLowerCase()}-${String(sequence).padStart(4, '0')}`,
        origin: 'INITIAL', boundaryConfidence: level === 'L1' ? 'MEDIUM' : 'HIGH', planningTargetId: targetId,
        additionalCodeRequestId: null, agentRequestId: null, selectionReason: `EXPERIMENT_${level}_CODE_SCOPE`,
        relatedFindingIds: refs.findings, relatedEvidenceIds: refs.evidences,
      }));
    }
  }
  input.initialCodeSlices = slices.filter(Boolean);
  input.analysisPlan.targets = targets;
  return input;
}

function syntaxBoundary(source, startLine, endLine) {
  const code = source.lines.join('\n');
  const ast = parse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: parserPlugins(source.filePath) });
  let best;
  const candidates = [];
  traverse(ast, {
    enter(path) {
      const loc = path.node.loc;
      if (!loc || loc.start.line > startLine || loc.end.line < endLine) return;
      if (path.isFunction() || path.isStatement() || path.isVariableDeclaration()) {
        const span = loc.end.line - loc.start.line;
        candidates.push({ path, startLine: loc.start.line, endLine: loc.end.line, span, function: path.isFunction() });
      }
    },
  });
  best = candidates.filter((item) => item.function).sort((a, b) => a.span - b.span)[0]
    ?? candidates.sort((a, b) => a.span - b.span)[0]
    ?? { startLine, endLine, path: undefined };
  const directDeclarations = [];
  if (best.path) {
    best.path.traverse({
      ReferencedIdentifier(path) {
        const binding = path.scope.getBinding(path.node.name);
        const parent = binding?.path.findParent((candidate) => candidate.isImportDeclaration() || candidate.isVariableDeclaration() || candidate.isFunctionDeclaration() || candidate.isClassDeclaration()) ?? binding?.path;
        const loc = parent?.node.loc;
        if (loc && !(loc.start.line >= best.startLine && loc.end.line <= best.endLine)) directDeclarations.push({ startLine: loc.start.line, endLine: loc.end.line });
      },
    });
  }
  return { startLine: best.startLine, endLine: best.endLine, directDeclarations: mergeRanges(directDeclarations) };
}

function neutralizePlanningInput(value, experimentId) {
  const clone = structuredClone(value);
  clone.subject.requestId = `${experimentId}-request`;
  clone.subject.scanId = `${experimentId}-scan`;
  const evidenceIdMap = new Map();
  clone.normalization.atomicEvidences.forEach((item, index) => {
    const next = `${experimentId}-evidence-${String(index + 1).padStart(5, '0')}`;
    evidenceIdMap.set(item.evidenceId, next); item.evidenceId = next;
    item.provenance.scanId = clone.subject.scanId;
  });
  // Normalizer summaries contain counts only. Unmapped findings/errors are kept verbatim.
  return clone;
}

function analysisContext(input, requestId, scanId, packageRoot) {
  return {
    requestId, scanId, package: { name: input.sample.packageName, version: input.sample.packageVersion },
    artifact: { tarballPath: input.archivePath, extractedPath: packageRoot, hash: input.sample.archiveSha256 },
    metadata: { registryMetadata: {}, packageJson: input.packageJson },
  };
}

async function createStaticRuntime(output) {
  const imageDigest = 'sha256:6c9b0e051011000600036ecacd0209081f58754eec65b13255d87cf2881e9640';
  const rulesetPath = join(scannerRoot, 'rules/custom-rule-analyzer.yml');
  const rulesetHash = await sha256File(rulesetPath);
  const guardRunner = new DockerExternalGuardDogRunner({ runtime: 'docker', image: imageDigest, expectedImageDigest: imageDigest,
    user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m', timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
  const customRunner = new DockerExternalCustomRuleRunner({ runtime: 'docker', image: imageDigest, expectedImageDigest: imageDigest,
    expectedSemgrepVersion: '1.172.0', expectedRulesetSha256: rulesetHash, user: '65532:65532', pidsLimit: 64,
    memory: '512m', cpus: '1', tmpfsSize: '64m', timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
  const guardDog = new GuardDogAnalyzer({ executable: 'guarddog', toolVersion: '3.1.0', workspaceRoot: output,
    timeoutMs: 120_000, killGraceMs: 1_000, sandboxMode: 'DISABLED', maxOutputBytes: 4 * 1024 * 1024 }, { externalProcessRunner: guardRunner });
  const staticGuardDog = { name: guardDog.name, version: guardDog.version, analyzeResult(input, context, signal) {
    return guardDog.analyzeResult({ ...input, artifactBoundary: { mode: 'EXTERNAL_READ_ONLY_ARTIFACT', allowedArtifactRoot: output },
      networkIsolation: { mode: 'VERIFIED_NETWORK_NONE' } }, context, signal);
  } };
  const customRule = new CustomRuleAnalyzer({ semgrepBin: 'semgrep', ruleConfigPath: rulesetPath, timeoutMs: 120_000, ruleVersion: rulesetHash }, customRunner);
  const deniedAssistant = { async analyze() { throw new Error('LLM_CALL_FORBIDDEN'); } };
  return { rulesetHash, guardRunner, customRunner, preflightVerified: false, metadata: new MetadataAnalyzer(), customRule, staticGuardDog,
    obfuscation: new ObfuscationAnalyzer(customRule, staticGuardDog, 'off', deniedAssistant) };
}

function rangesFromSlices(slices) {
  const map = new Map();
  for (const slice of slices) addRange(map, slice.artifactId, slice.filePath, slice.startLine, slice.endLine);
  return map;
}
function addRange(map, artifactId, filePath, startLine, endLine) {
  const key = rangeKey(artifactId, filePath); const values = map.get(key) ?? [];
  values.push({ startLine, endLine }); map.set(key, mergeRanges(values));
}
function mergeRanges(ranges) {
  const sorted = ranges.filter((item) => item.startLine > 0 && item.endLine >= item.startLine).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const result = [];
  for (const item of sorted) {
    const last = result.at(-1);
    if (last && item.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, item.endLine);
    else result.push({ ...item });
  }
  return result;
}
function rangeKey(artifactId, filePath) { return `${artifactId}\0${filePath}`; }
function parseKey(key) { const [artifactId, filePath] = key.split('\0'); return { artifactId, filePath }; }
function sliceRangeKey(slice) { return `${slice.artifactId}\0${slice.filePath}\0${slice.startLine}\0${slice.endLine}`; }
function relatedRefs(execution, artifactId, filePath, range) {
  const overlaps = (item) => item.artifactId === artifactId && item.filePath === filePath
    && (item.startLine === undefined || item.endLine === undefined || (item.startLine <= range.endLine && item.endLine >= range.startLine));
  return { findings: execution.bindings.findingBindings.filter(overlaps).map((item) => item.findingId),
    evidences: execution.bindings.evidenceBindings.filter(overlaps).map((item) => item.evidenceId) };
}

function staticRelativeImports(code) {
  const results = new Set();
  const pattern = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|require\s*\(|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/gu;
  for (const match of code.matchAll(pattern)) results.add(match[1]);
  return [...results];
}
async function resolveLocalModule(execution, artifactId, importer, specifier) {
  const base = normalizeRelative(join(dirname(importer), specifier));
  if (!base) return undefined;
  const candidates = [base, ...['.js','.cjs','.mjs','.jsx','.ts','.tsx'].map((suffix) => `${base}${suffix}`),
    ...['index.js','index.cjs','index.mjs','index.jsx','index.ts','index.tsx'].map((name) => join(base, name))];
  for (const candidate of candidates) {
    try { await readArtifactSource(execution.artifacts, artifactId, candidate, experimentMaxCodeFileBytes); return candidate; } catch { /* next */ }
  }
  return undefined;
}
function packageSeedFiles(context) {
  const candidates = [context.main, ...context.entryPoints.map((item) => item.value),
    ...context.lifecycleScripts.flatMap((item) => shellFileTokens(item.command))].filter((value) => typeof value === 'string');
  return [...new Set(candidates.map(normalizeRelative).filter(Boolean))];
}
function shellFileTokens(command) {
  return command.split(/\s+/u).map((token) => token.replace(/^['"]|['";,]$/gu, '')).filter((token) => /\.(?:js|cjs|mjs|ts|tsx|sh|py)$/iu.test(token));
}
function normalizeRelative(value) {
  if (!value || value.startsWith('/') || value.includes('\0')) return undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}
async function walkPackage(root) {
  const output = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { output.push({ path, reason: 'SYMLINK' }); continue; }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') output.push({ path, reason: 'EXCLUDED_DIRECTORY' });
        else await visit(join(directory, entry.name), path);
      } else if (entry.isFile()) output.push({ path, ...(path.endsWith('.map') ? { reason: 'SOURCE_MAP' } : {}) });
      else output.push({ path, reason: 'NON_REGULAR_FILE' });
    }
  }
  await visit(root); return output;
}
function isJsTs(path) { return ['.js','.cjs','.mjs','.jsx','.ts','.tsx'].includes(extname(path).toLowerCase()); }
function parserPlugins(path) {
  const ext = extname(path).toLowerCase();
  return [...(['.ts','.tsx'].includes(ext) ? ['typescript'] : []), ...(['.jsx','.tsx'].includes(ext) ? ['jsx'] : [])];
}

function fixedProjection(input, baseTargets) {
  const clone = structuredClone(input); clone.initialCodeSlices = []; clone.analysisPlan.targets = structuredClone(baseTargets); return clone;
}
function sliceIdentity(slice) { return { artifactId: slice.artifactId, filePath: slice.filePath, startLine: slice.startLine, endLine: slice.endLine, contentSha256: slice.contentSha256 }; }
function assertCumulative(levels) {
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1].input.initialCodeSlices;
    const current = levels[index].input.initialCodeSlices;
    for (const slice of previous) {
      const covered = current.some((candidate) => candidate.artifactId === slice.artifactId && candidate.filePath === slice.filePath
        && candidate.startLine <= slice.startLine && candidate.endLine >= slice.endLine);
      if (!covered) throw new Error(`NON_CUMULATIVE:${levels[index].level}:${safeRef(slice.artifactId, slice.filePath)}`);
    }
  }
  return true;
}
async function verifySlicesAgainstSources(input, execution) {
  for (const slice of input.initialCodeSlices) {
    const source = await readArtifactSource(execution.artifacts, slice.artifactId, slice.filePath, experimentMaxCodeFileBytes);
    const content = source.lines.slice(slice.startLine - 1, slice.endLine).join('\n');
    if (sha256Hex(content) !== slice.contentSha256 || content !== slice.content) return false;
  }
  return true;
}
function assertRepresentationSeparation(levels, execution) {
  const descriptors = new Map(execution.artifacts.list().map((item) => [item.artifactId, item.representation]));
  for (const level of levels) {
    for (const slice of level.input.initialCodeSlices) if (!descriptors.has(slice.artifactId)) throw new Error(`UNKNOWN_SLICE_ARTIFACT:${slice.artifactId}`);
    const byPath = new Map();
    for (const slice of level.input.initialCodeSlices) {
      const values = byPath.get(slice.filePath) ?? new Set(); values.add(slice.artifactId); byPath.set(slice.filePath, values);
    }
    for (const values of byPath.values()) {
      if (values.size > 1 && new Set([...values].map((id) => descriptors.get(id))).size !== values.size) {
        throw new Error('REPRESENTATION_ARTIFACT_COLLISION');
      }
    }
  }
  return true;
}
function containsForbiddenModelLabel(value) {
  const text = JSON.stringify(value);
  return /DD-NPM-|ground[-_ ]?truth|confirmed[_ -]?malicious|manual-ground-truth/iu.test(text) || text.includes(repositoryRoot);
}
function descriptor(input, artifactId) { return input.artifactContext.artifacts.find((item) => item.artifactId === artifactId); }
function sharedLevelRecord(level) {
  return { level: level.level, status: level.status, sameInputAsPrevious: level.sameInputAsPrevious,
    codeHash: level.codeHash, fileCount: level.fileCount, sliceCount: level.sliceCount, codeBytes: level.codeBytes,
    codeLines: level.codeLines, providerRequestBytes: level.providerRequestBytes, providerRequestCharacters: level.providerRequestCharacters,
    estimatedTokens: level.estimatedTokens, ranges: level.ranges };
}
function freezeForDisk(prepared) {
  return { preparation: prepared.preparation, planningInput: prepared.planningInput, context: { ...prepared.context,
    artifact: { ...prepared.context.artifact, tarballPath: '<RUNTIME_ARCHIVE_PATH>', extractedPath: '<RUNTIME_ORIGINAL_ROOT>' } },
    artifactDescriptors: prepared.execution.artifacts.list(), limitations: prepared.limitations, versions: prepared.versions };
}
async function loadFrozen(path, originalRoot) {
  const frozen = await readJson(path);
  const context = { ...frozen.context, artifact: { ...frozen.context.artifact, tarballPath: '', extractedPath: originalRoot } };
  // Restored runtime roots cannot be reconstructed from JSON unless preserved beside the frozen input.
  const restoredDescriptor = frozen.artifactDescriptors.find((item) => item.representation === 'DEOBFUSCATED');
  const restoredRoot = join(dirname(path), 'work', 'derived', 'obfuscation');
  const restoredArtifact = restoredDescriptor && await exists(restoredRoot) ? { descriptor: restoredDescriptor, root: restoredRoot } : undefined;
  const execution = buildPlanningTier3ExecutionInput({ planningInput: frozen.planningInput, context,
    originalContentSha256: frozen.artifactDescriptors.find((item) => item.representation === 'ORIGINAL')?.contentSha256,
    ...(restoredArtifact ? { restoredArtifact } : {}), ...(!restoredArtifact && restoredDescriptor ? { restoredArtifactUnavailableReason: 'RESTORED_ARTIFACT_UNAVAILABLE' } : {}) });
  const preparation = `${frozen.preparation.replace(/(?::FROZEN_REUSE)+$/u, '')}:FROZEN_REUSE`;
  return { preparation, planningInput: frozen.planningInput, context, execution,
    roots: rootsForExecution(execution), limitations: frozen.limitations ?? [], versions: frozen.versions,
    filterResult: evaluateStaticFilter(frozen.planningInput) };
}
function rootsForExecution(execution) { return execution.artifacts.list().map((item) => ({ descriptor: item })); }

async function ensureIgnored(root) {
  const ignorePath = join(root, '.gitignore');
  if (!await exists(ignorePath)) await writeFile(ignorePath, 'private/\n', { flag: 'wx' });
  else if (!(await readFile(ignorePath, 'utf8')).split(/\r?\n/u).includes('private/')) throw new Error('OUTPUT_PRIVATE_DIRECTORY_NOT_IGNORED');
}
async function findPackageRoot(root) {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name === 'package.json') return dirname(path);
    }
  }
  throw new Error('PACKAGE_ROOT_NOT_FOUND');
}
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function jsonFile(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function stableHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safeRef(artifactId, filePath) { return `${createHash('sha256').update(artifactId).digest('hex').slice(0, 8)}:${filePath}`; }
function safeError(error) { return error instanceof Error ? error.message.replaceAll(repositoryRoot, '<REPO>') : String(error); }
function git(...argv) { return execFileSync('git', argv, { cwd: repositoryRoot, encoding: 'utf8' }).trim(); }
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--offline-code-volume-inputs') parsed.consent = value;
    else if (value === '--reuse-frozen') parsed.reuseFrozen = true;
    else if (value === '--output') parsed.output = argv[++index];
    else if (value === '--max-provider-request-bytes') parsed.maxProviderRequestBytes = Number(argv[++index]);
    else if (value === '--max-code-file-bytes') parsed.maxCodeFileBytes = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}
