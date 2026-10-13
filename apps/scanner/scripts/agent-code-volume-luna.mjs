import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { loadLlmAgentEnvironment } from '../dist/config/scanner-environment.js';
import { LlmAgentRunnerService } from '../dist/llm-agent/agent-runner.service.js';
import { AgentOutputValidatorService } from '../dist/llm-agent/agent-output-validator.service.js';
import { LlmAgentToolsService } from '../dist/llm-agent/llm-agent-tools.service.js';
import { LlmEvidenceAdapter, agentSummary } from '../dist/llm-agent/llm-evidence.adapter.js';
import { OpenAiProviderClient } from '../dist/llm-agent/openai-provider.client.js';
import { buildAgentPromptV0_3, AGENT_PROMPT_VERSION_V0_3 } from '../dist/llm-agent/artifact/agent-prompt-v0_3.js';
import { AGENT_OUTPUT_API_SCHEMA_V0_3 } from '../dist/llm-agent/artifact/agent-output-v0_3.api-schema.js';
import { AGENT_OUTPUT_SCHEMA_VERSION_V0_3, parseAgentOutputV0_3 } from '../dist/llm-agent/artifact/agent-output-v0_3.contract.js';
import { InMemoryCodeSliceRegistry } from '../dist/llm-agent/artifact/code-slice.registry.js';
import { RuntimeArtifactResolver } from '../dist/llm-agent/artifact/runtime-artifact-resolver.js';

const scannerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(scannerRoot, '../..');
const defaultInputRoot = join(scannerRoot, 'experiments/agent-code-volume/2026-10-04-input-v1');
const args = parseArgs(process.argv.slice(2));
const config = Object.freeze({
  schemaVersion: '1.0.0', model: 'gpt-5.6-luna', reasoningEffort: 'medium', endpoint: 'https://api.openai.com',
  maxOutputTokens: args.maxOutputTokens ?? 32_768, timeoutMs: args.timeoutMs ?? 180_000, maxRetries: 0, maxProviderRequests: args.maxCalls ?? 2,
  contextWindowTokens: 1_050_000, modelMaxOutputTokens: 128_000,
  promptVersion: AGENT_PROMPT_VERSION_V0_3, outputSchemaVersion: AGENT_OUTPUT_SCHEMA_VERSION_V0_3,
  jev: 'DISABLED', additionalCodeRequests: 'DISABLED', store: false,
});

if (!args.output || (args.conditions.length === 0 && (args.samples.length === 0 || args.levels.length === 0))) {
  throw new Error('Usage: node scripts/agent-code-volume-luna.mjs --output <new-dir> --condition DD-NPM-010:L2 [--live] [--max-calls 1]');
}
if (args.live && args.mock) throw new Error('LIVE_AND_MOCK_ARE_MUTUALLY_EXCLUSIVE');
if (args.live && !process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY_REQUIRED_FOR_LIVE');

const inputRoot = resolve(args.input ?? defaultInputRoot);
const outputRoot = resolve(args.output);
const privateRoot = join(outputRoot, 'private');
const resultsRoot = join(outputRoot, 'results');
await mkdir(privateRoot, { recursive: true });
await mkdir(resultsRoot, { recursive: true });
await ensurePrivateIgnored(outputRoot);

const inputManifest = await readJson(join(inputRoot, 'manifest.json'));
const configHash = hashJson(config);
const selections = selectConditions(inputManifest, args.samples, args.levels, args.conditions);
const runManifest = {
  schemaVersion: '1.0.0', purpose: 'CODE_VOLUME_LUNA_SMOKE_NOT_ACCURACY_EVALUATION',
  createdAt: new Date().toISOString(), mode: args.live ? 'LIVE' : args.mock ? 'MOCK' : 'DRY_RUN',
  scannerCommit: git('rev-parse', 'HEAD'), scannerBranch: git('branch', '--show-current'),
  inputManifest: relative(scannerRoot, join(inputRoot, 'manifest.json')), inputManifestSha256: await sha256File(join(inputRoot, 'manifest.json')),
  config, configHash, requestedConditionCount: selections.length, providerRequestLimit: config.maxProviderRequests,
  keyConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
  officialModelReference: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
  pricingAsOf: '2026-10-04', pricingUsdPerMillionTokens: { input: 0.20, cachedInput: 0.02, outputIncludingReasoning: 1.20 },
  results: [],
};
await atomicJson(join(outputRoot, 'run.json'), runManifest);

let providerRequests = 0;
let stopReason;
const completedByReuseKey = new Map();
for (const selection of selections) {
  const resultPath = join(resultsRoot, `${selection.experimentId}-${selection.level}.json`);
  const existing = await optionalJson(resultPath);
  let prepared;
  try { prepared = await prepareCondition(inputRoot, selection, config); }
  catch (error) {
    const failed = sharedFailure(selection, 'INPUT_PREPARATION_FAILED', safeError(error));
    await atomicJson(resultPath, failed); runManifest.results.push(failed); continue;
  }
  if (existing?.reuseKey && existing.reuseKey !== prepared.reuseKey) {
    runManifest.results.push({ ...prepared.shared, status: 'RESULT_CONFIG_CONFLICT', terminal: false,
      reason: 'Existing result uses a different request/config key; use a new output directory.',
      providerRequests: 0, runnerCalls: 0, usage: null });
    continue;
  }
  if (existing?.terminal === true && existing.reuseKey === prepared.reuseKey) {
    runManifest.results.push({ ...existing, resumed: true, currentProviderRequests: 0, currentRunnerCalls: 0 });
    completedByReuseKey.set(existing.reuseKey, existing);
    continue;
  }
  if (existing?.status === 'UNKNOWN_AFTER_SEND' && existing.reuseKey === prepared.reuseKey) {
    runManifest.results.push({ ...existing, resumed: true, automaticRetrySuppressed: true,
      currentProviderRequests: 0, currentRunnerCalls: 0 });
    continue;
  }
  const duplicate = completedByReuseKey.get(prepared.reuseKey);
  if (duplicate) {
    const shared = { ...prepared.shared, status: duplicate.status, terminal: true, sharedResultOf: duplicate.conditionId,
      reuseKey: prepared.reuseKey, providerRequests: 0, runnerCalls: 0, usage: duplicate.usage, durationMs: 0 };
    await atomicJson(resultPath, shared); runManifest.results.push(shared); continue;
  }
  if (!args.live && !args.mock) {
    const dry = { ...prepared.shared, status: 'DRY_RUN_VALIDATED', terminal: true, reuseKey: prepared.reuseKey,
      providerRequests: 0, runnerCalls: 0, usage: null, durationMs: 0 };
    await atomicJson(resultPath, dry); runManifest.results.push(dry); completedByReuseKey.set(prepared.reuseKey, dry); continue;
  }
  if (providerRequests >= config.maxProviderRequests) {
    const limited = { ...prepared.shared, status: 'NOT_RUN_CALL_LIMIT', terminal: false, reuseKey: prepared.reuseKey,
      providerRequests: 0, runnerCalls: 0, usage: null, durationMs: 0 };
    await atomicJson(resultPath, limited); runManifest.results.push(limited); continue;
  }

  const conditionPrivate = join(privateRoot, selection.experimentId, selection.level);
  await mkdir(conditionPrivate, { recursive: true });
  await atomicJson(join(conditionPrivate, 'request.json'), prepared.requestBody);
  const sentState = { ...prepared.shared, status: 'UNKNOWN_AFTER_SEND', terminal: false, reuseKey: prepared.reuseKey,
    sentAt: new Date().toISOString(), providerRequests: 1, runnerCalls: 1, usage: null, durationMs: null };
  await atomicJson(resultPath, sentState);

  let capturedResponse;
  let capturedStatus;
  const offlineController = new AbortController();
  const fetcher = async (url, init) => {
    providerRequests += 1;
    if (providerRequests > config.maxProviderRequests) throw new Error('EXPERIMENT_PROVIDER_CALL_LIMIT_EXCEEDED');
    const actualRequest = JSON.parse(String(init?.body));
    if (hashJson(actualRequest) !== hashJson(prepared.requestBody)) throw new Error('FINAL_PROVIDER_REQUEST_MISMATCH');
    const response = args.mock
      ? mockResponse(args.mock, prepared.input)
      : await fetch(url, init);
    capturedStatus = response.status;
    try { capturedResponse = await response.clone().json(); }
    catch { capturedResponse = { unreadableResponseBody: true }; }
    await atomicJson(join(conditionPrivate, 'response.json'), capturedResponse);
    const capturedText = extractOutputText(capturedResponse);
    if (parseAdditionalCode(capturedText, prepared.input.request.analysisRequestId)) offlineController.abort();
    return response;
  };
  const settings = experimentSettings(config, args.mock ? 'mock-credential-not-sent' : process.env.OPENAI_API_KEY);
  const provider = new OpenAiProviderClient(settings, fetcher, { reasoningEffort: config.reasoningEffort, maxOutputTokens: config.maxOutputTokens });
  const runner = new LlmAgentRunnerService(provider, new LlmAgentToolsService(), new AgentOutputValidatorService(), settings);
  const evidenceAdapter = new LlmEvidenceAdapter();
  const started = performance.now();
  const beforeHash = hashJson(prepared.input);
  const run = await runner.executeV0_3(prepared.input,
    { resolver: prepared.resolver, registry: prepared.registry, signal: offlineController.signal },
    { prompt: { additionalCodeRequests: 'DISABLED' } });
  if (hashJson(prepared.input) !== beforeHash) throw new Error('FROZEN_INPUT_MUTATED');
  const conversion = evidenceAdapter.toEvidencesV0_3(prepared.input, run, prepared.resolver);
  const summary = agentSummary(run, conversion, 'CODE_VOLUME_EXPERIMENT');
  const rawOutput = extractOutputText(capturedResponse);
  const additionalCodeNeeded = parseAdditionalCode(rawOutput, prepared.input.request.analysisRequestId);
  const status = experimentStatus(run, conversion, additionalCodeNeeded, capturedResponse);
  const usage = usageRecord(hasUsage(run.usage) ? run.usage : usageFromPayload(capturedResponse));
  const shared = {
    ...prepared.shared, status, terminal: true, reuseKey: prepared.reuseKey,
    providerRequests: 1, runnerCalls: 1, httpStatus: capturedStatus ?? null,
    runnerStatus: run.status, failureReason: run.failureReason ?? null, additionalCodeNeeded,
    assessmentCount: run.validated?.assessments.length ?? 0,
    validatorStatusCounts: countBy(run.validated?.assessments.map((item) => item.status) ?? []),
    generatedEvidenceCount: conversion.evidences.length, evidenceConversionFailureCount: conversion.failures.length,
    usage, estimatedCostUsd: cost(usage), durationMs: Math.round(performance.now() - started),
    summary: { status: summary.status, assessmentCount: summary.assessmentCount,
      verifiedAssessmentCount: summary.verifiedAssessmentCount, generatedEvidenceCount: summary.generatedEvidenceCount,
      rejectedAssessmentCount: summary.rejectedAssessmentCount, limitationCount: summary.limitations.length },
  };
  await atomicJson(join(conditionPrivate, 'validated-result.json'), { run, conversion, summary });
  await atomicJson(resultPath, shared); runManifest.results.push(shared); completedByReuseKey.set(prepared.reuseKey, shared);
  if (capturedStatus && [400, 401, 403, 404].includes(capturedStatus)) { stopReason = `COMMON_PROVIDER_HTTP_${capturedStatus}`; break; }
}

runManifest.providerRequestCount = providerRequests;
runManifest.stopReason = stopReason ?? null;
runManifest.completedAt = new Date().toISOString();
await atomicJson(join(outputRoot, 'run.json'), runManifest);
process.stdout.write(`${JSON.stringify({ output: relative(repositoryRoot, outputRoot), mode: runManifest.mode,
  conditions: runManifest.results.map((item) => ({ conditionId: item.conditionId, status: item.status,
    providerRequests: item.providerRequests, runnerCalls: item.runnerCalls, usage: item.usage })),
  providerRequestCount: providerRequests, stopReason: runManifest.stopReason }, null, 2)}\n`);

async function prepareCondition(root, selection, experimentConfig) {
  const inputPath = join(root, 'private', selection.experimentId, `${selection.level}-input.json`);
  const input = await readJson(inputPath);
  const inputHash = hashJson(input);
  const slices = input.initialCodeSlices.map(sliceIdentity);
  const codeHash = hashJson(slices);
  if (codeHash !== selection.codeHash) throw new Error('CODE_HASH_MISMATCH');
  const sample = inputManifest.samples.find((item) => item.experimentId === selection.experimentId);
  const baseInput = await readJson(join(root, 'private', selection.experimentId, 'L0-input.json'));
  if (hashJson(fixedProjection(input, baseInput.analysisPlan.targets)) !== sample.fixedContractHash) throw new Error('FIXED_CONTRACT_HASH_MISMATCH');
  const prompt = buildAgentPromptV0_3(input, [], [], { additionalCodeRequests: 'DISABLED' });
  const frozenRequest = await readJson(join(root, 'private', selection.experimentId, `${selection.level}-provider-request.json`));
  if (frozenRequest.input !== prompt) throw new Error('FROZEN_PROMPT_MISMATCH');
  const requestBody = { model: experimentConfig.model, input: prompt, store: false,
    reasoning: { effort: experimentConfig.reasoningEffort }, max_output_tokens: experimentConfig.maxOutputTokens,
    text: { format: { type: 'json_schema', name: 'scanner_agent_analysis', schema: AGENT_OUTPUT_API_SCHEMA_V0_3, strict: false } } };
  const requestText = JSON.stringify(requestBody);
  const estimatedInputTokens = selection.estimatedTokens;
  if (estimatedInputTokens + experimentConfig.maxOutputTokens > experimentConfig.contextWindowTokens) throw new Error('INPUT_LIMIT_EXCEEDED');
  const roots = [];
  for (const descriptor of input.artifactContext.artifacts) {
    const original = descriptor.representation === 'ORIGINAL';
    const runtimeRoot = original
      ? resolve(scannerRoot, sample.source.originalRoot)
      : join(root, 'private', selection.experimentId, 'work', 'derived', 'obfuscation');
    if (!await exists(runtimeRoot)) throw new Error(original ? 'ORIGINAL_ROOT_UNAVAILABLE' : 'RESTORED_ROOT_UNAVAILABLE');
    roots.push({ descriptor, root: runtimeRoot });
  }
  const resolver = new RuntimeArtifactResolver(roots);
  const registry = new InMemoryCodeSliceRegistry(); input.initialCodeSlices.forEach((slice) => registry.register(slice));
  const versions = { runner: 'LlmAgentRunnerService.executeV0_3', validator: 'ArtifactOutputValidator', evidenceAdapter: 'LlmEvidenceAdapter.toEvidencesV0_3' };
  const reuseKey = hashJson({ requestBody, config: experimentConfig, promptVersion: AGENT_PROMPT_VERSION_V0_3,
    outputSchemaVersion: AGENT_OUTPUT_SCHEMA_VERSION_V0_3, versions });
  return { input, resolver, registry, requestBody, reuseKey, shared: {
    conditionId: `${selection.experimentId}:${selection.level}`, experimentId: selection.experimentId, sourceSampleId: selection.sourceSampleId,
    level: selection.level, inputHash, fixedContractHash: sample.fixedContractHash, codeHash,
    configHash, promptHash: sha256(prompt), requestHash: hashJson(requestBody), reuseKey,
    inputSize: { findings: input.findings.length, evidences: input.atomicEvidences.length,
      codeSlices: input.initialCodeSlices.length, codeBytes: input.initialCodeSlices.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0),
      promptBytes: Buffer.byteLength(prompt), requestBytes: Buffer.byteLength(requestText), requestCharacters: requestText.length,
      estimatedInputTokens },
    modelContextCheck: { contextWindowTokens: experimentConfig.contextWindowTokens, reservedMaxOutputTokens: experimentConfig.maxOutputTokens,
      estimatedTotalTokens: estimatedInputTokens + experimentConfig.maxOutputTokens, fits: true },
    sameInputAsPrevious: selection.sameInputAsPrevious, sharedResultOf: null,
  } };
}

function experimentSettings(experimentConfig, apiKey) {
  return loadLlmAgentEnvironment({
    LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: experimentConfig.model,
    OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: experimentConfig.endpoint,
    LLM_AGENT_TIMEOUT_MS: String(experimentConfig.timeoutMs), LLM_AGENT_MAX_RETRIES: String(experimentConfig.maxRetries),
    LLM_AGENT_MAX_FILE_SIZE_BYTES: String(12 * 1024 * 1024),
    LLM_AGENT_CONTEXT_CHECK_ENABLED: 'false',
  });
}

function selectConditions(manifest, samples, levels, conditions) {
  const selected = [];
  if (conditions.length > 0) {
    for (const condition of conditions) {
      const separator = condition.lastIndexOf(':');
      if (separator < 1) throw new Error(`INVALID_CONDITION:${condition}`);
      const sourceSampleId = condition.slice(0, separator), level = condition.slice(separator + 1);
      const sample = manifest.samples.find((item) => item.sourceSampleId === sourceSampleId);
      if (!sample) throw new Error(`SAMPLE_NOT_PREPARED:${sourceSampleId}`);
      const item = sample.levels.find((candidate) => candidate.level === level);
      if (!item) throw new Error(`LEVEL_NOT_PREPARED:${sourceSampleId}:${level}`);
      selected.push({ sourceSampleId, experimentId: sample.experimentId, ...item });
    }
    return selected;
  }
  for (const sourceSampleId of samples) {
    const sample = manifest.samples.find((item) => item.sourceSampleId === sourceSampleId);
    if (!sample) throw new Error(`SAMPLE_NOT_PREPARED:${sourceSampleId}`);
    for (const level of levels) {
      const item = sample.levels.find((candidate) => candidate.level === level);
      if (!item) throw new Error(`LEVEL_NOT_PREPARED:${sourceSampleId}:${level}`);
      selected.push({ sourceSampleId, experimentId: sample.experimentId, ...item });
    }
  }
  return selected;
}
function experimentStatus(run, conversion, additionalCodeNeeded, payload) {
  if (record(payload)?.status === 'incomplete') return 'OUTPUT_TRUNCATED';
  if (additionalCodeNeeded) return 'ADDITIONAL_CODE_NEEDED';
  if (run.status === 'TIMEOUT') return 'TIMEOUT';
  if (run.status === 'FAILED') {
    if (run.failureReason === 'OUTPUT_SCHEMA_VALIDATION_FAILED') return 'SCHEMA_VALIDATION_FAILED';
    if (run.failureReason === 'INVALID_RESPONSE' || run.failureReason === 'EMPTY_RESPONSE') return run.failureReason;
    if (run.failureReason === 'OUTPUT_TRUNCATED') return 'OUTPUT_TRUNCATED';
    return 'PROVIDER_OR_RUNNER_FAILED';
  }
  if (conversion.failures.length > 0) return conversion.evidences.length > 0 ? 'EVIDENCE_CONVERSION_PARTIAL' : 'EVIDENCE_CONVERSION_FAILED';
  if (additionalCodeNeeded) return 'ADDITIONAL_CODE_NEEDED';
  if ((run.validated?.assessments.length ?? 0) === 0 && conversion.evidences.length === 0) return 'COMPLETED_NO_ASSESSMENT_OR_EVIDENCE';
  if (conversion.evidences.length === 0) return 'COMPLETED_NO_VERIFIED_EVIDENCE';
  return 'COMPLETED_WITH_VERIFIED_EVIDENCE';
}
function mockResponse(scenario, input) {
  if (scenario === 'provider-error') return new Response(JSON.stringify({ error: { type: 'mock' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  if (scenario === 'truncated') return response({ id: 'mock-truncated', model: config.model, status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: mockUsage() });
  if (scenario === 'invalid') return response({ id: 'mock-invalid', model: config.model,
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{' }] }], usage: mockUsage() });
  if (scenario === 'additional') return response({ id: 'mock-additional', model: config.model,
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      requestId: input.request.analysisRequestId, schemaVersion: '0.3.0', status: 'NEEDS_ADDITIONAL_CODE',
      requests: [{ id: 'mock-request', type: 'GET_FILE_RANGE', target: { artifactId: input.initialCodeSlices[0].artifactId,
        filePath: input.initialCodeSlices[0].filePath, startLine: 1, endLine: 1 }, reasonCode: 'MOCK_MISSING_CONTEXT' }],
    }) }] }], usage: mockUsage() });
  const assessments = scenario === 'completed-valid' ? [mockAssessment(input)] : [];
  return response({ id: `mock-${scenario}`, model: config.model,
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      requestId: input.request.analysisRequestId, schemaVersion: '0.3.0', status: 'COMPLETED', assessments,
      summary: { verdict: assessments.length ? 'SUSPICIOUS' : 'INCONCLUSIVE', confidence: assessments.length ? 0.7 : 0,
        reasonCodes: [assessments.length ? 'MOCK_GROUNDED' : 'MOCK_NO_ASSESSMENT'] }, limitations: [], missingContext: [],
    }) }] }], usage: mockUsage() });
}
function mockAssessment(input) {
  const slice = input.initialCodeSlices[0], finding = input.findings[0], evidence = input.atomicEvidences[0];
  return { id: 'mock-assessment', type: 'CORRELATED_BEHAVIOR', signal: 'MOCK_SIGNAL', category: 'MOCK', basis: 'PATTERN_MATCH',
    ...(finding ? { findingIds: [finding.findingId] } : {}), ...(evidence ? { atomicEvidenceIds: [evidence.evidenceId] } : {}),
    refs: [{ id: 'mock-ref', sliceId: slice.sliceId, lines: [slice.startLine, slice.startLine], role: 'CONTEXT' }],
    flow: { conditions: ['mock-ref'] }, reachability: { status: 'POSSIBLE' }, verification: { status: 'UNVERIFIED', method: 'NONE' },
    confidence: 0.7, reasonCodes: ['MOCK_GROUNDED'], intentAssessment: 'SUSPICIOUS', claimScope: 'CODE_BEHAVIOR', limitations: [], alternatives: [{ type: 'MOCK_BENIGN', plausibility: 'UNKNOWN', reasonCodes: ['MOCK_UNKNOWN'] }] };
}
function mockUsage() { return { input_tokens: 100, input_tokens_details: { cached_tokens: 10 }, output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 }; }
function response(value) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }
function parseAdditionalCode(text, requestId) {
  if (!text) return false;
  try { return parseAgentOutputV0_3(JSON.parse(text), requestId).status === 'NEEDS_ADDITIONAL_CODE'; }
  catch { return false; }
}
function extractOutputText(payload) {
  const value = record(payload); if (!Array.isArray(value?.output)) return '';
  return value.output.flatMap((item) => Array.isArray(record(item)?.content) ? record(item).content : [])
    .map(record).filter((item) => item?.type === 'output_text' && typeof item.text === 'string').map((item) => item.text).join('');
}
function usageRecord(usage) {
  return { inputTokens: usage.inputTokens ?? null, cachedInputTokens: usage.cachedInputTokens ?? null,
    outputTokens: usage.outputTokens ?? null, reasoningTokens: usage.reasoningTokens ?? null, totalTokens: usage.totalTokens ?? null,
    note: 'reasoningTokens is a subset of outputTokens and is not added again.' };
}
function hasUsage(usage) { return usage && Object.values(usage).some((value) => typeof value === 'number'); }
function usageFromPayload(payload) {
  const usage = record(record(payload)?.usage) ?? {}, input = record(usage.input_tokens_details) ?? {}, output = record(usage.output_tokens_details) ?? {};
  return { inputTokens: numberOrUndefined(usage.input_tokens), cachedInputTokens: numberOrUndefined(input.cached_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens), reasoningTokens: numberOrUndefined(output.reasoning_tokens), totalTokens: numberOrUndefined(usage.total_tokens) };
}
function numberOrUndefined(value) { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function cost(usage) {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const cached = usage.cachedInputTokens ?? 0, uncached = Math.max(0, usage.inputTokens - cached);
  const multiplier = usage.inputTokens > 272_000 ? { input: 2, output: 1.5 } : { input: 1, output: 1 };
  return Number(((uncached * 0.20 * multiplier.input + cached * 0.02 * multiplier.input + usage.outputTokens * 1.20 * multiplier.output) / 1_000_000).toFixed(8));
}
function fixedProjection(input, baseTargets) { const clone = structuredClone(input); clone.initialCodeSlices = []; clone.analysisPlan.targets = structuredClone(baseTargets); return clone; }
function sliceIdentity(slice) { return { artifactId: slice.artifactId, filePath: slice.filePath, startLine: slice.startLine, endLine: slice.endLine, contentSha256: slice.contentSha256 }; }
function sharedFailure(selection, status, reason) { return { conditionId: `${selection.experimentId}:${selection.level}`,
  experimentId: selection.experimentId, sourceSampleId: selection.sourceSampleId, level: selection.level,
  status, reason, terminal: true, providerRequests: 0, runnerCalls: 0, usage: null }; }
function countBy(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])); }
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function hashJson(value) { return sha256(JSON.stringify(value)); }
async function sha256File(path) { return sha256(await readFile(path)); }
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function optionalJson(path) { try { return await readJson(path); } catch { return undefined; } }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function atomicJson(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }
async function ensurePrivateIgnored(root) { const path = join(root, '.gitignore'); if (!await exists(path)) await writeFile(path, 'private/\n');
  else if (!(await readFile(path, 'utf8')).split(/\r?\n/u).includes('private/')) throw new Error('PRIVATE_OUTPUT_NOT_IGNORED'); }
function safeError(error) { return error instanceof Error ? error.message.replaceAll(repositoryRoot, '<REPO>') : String(error); }
function git(...argv) { return execFileSync('git', argv, { cwd: repositoryRoot, encoding: 'utf8' }).trim(); }
function parseArgs(argv) { const parsed = { samples: [], levels: [], conditions: [] }; for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index]; if (value === '--live') parsed.live = true; else if (value === '--mock') parsed.mock = argv[++index]; else if (value === '--output') parsed.output = argv[++index];
  else if (value === '--input') parsed.input = argv[++index]; else if (value === '--sample') parsed.samples.push(...argv[++index].split(','));
  else if (value === '--condition') parsed.conditions.push(...argv[++index].split(','));
  else if (value === '--level') parsed.levels.push(...argv[++index].split(',')); else if (value === '--max-calls') parsed.maxCalls = Number(argv[++index]);
  else if (value === '--max-output-tokens') parsed.maxOutputTokens = Number(argv[++index]); else if (value === '--timeout-ms') parsed.timeoutMs = Number(argv[++index]);
  else throw new Error(`Unknown argument: ${value}`); }
  if (parsed.mock && !['completed-empty','completed-valid','additional','invalid','truncated','provider-error'].includes(parsed.mock)) throw new Error('INVALID_MOCK_SCENARIO');
  if (!Number.isSafeInteger(parsed.maxCalls ?? 2) || (parsed.maxCalls ?? 2) < 1) throw new Error('INVALID_MAX_CALLS');
  if (!Number.isSafeInteger(parsed.maxOutputTokens ?? 32_768) || (parsed.maxOutputTokens ?? 32_768) < 1 || (parsed.maxOutputTokens ?? 32_768) > 128_000) throw new Error('INVALID_MAX_OUTPUT_TOKENS');
  if (!Number.isSafeInteger(parsed.timeoutMs ?? 180_000) || (parsed.timeoutMs ?? 180_000) < 1) throw new Error('INVALID_TIMEOUT_MS');
  return parsed; }
