import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  Orchestrator,
  type ScanExecutionRequest,
} from '../src/application/orchestrator/orchestrator';
import { ScanService } from '../src/application/scan-service/scan.service';
import { PackageDeadline } from '../src/application/package-deadline';
import type {
  AnalysisContext,
  AnalyzerResult,
  Finding,
} from '../src/domain/analysis.types';
import { EvidenceNormalizer } from '../src/evidence/normalizer/evidence-normalizer';
import { PolicyEvaluationClient } from '../src/policy/policy-evaluation.client';
import { ArtifactProcessingError } from '../src/artifact/artifact.types';
import { ArtifactStorageError } from '../src/artifact/storage/artifact-storage.error';
import { ArtifactFileManager } from '../src/artifact/storage/artifact-file-manager';
import { CustomRuleAnalyzer } from '../src/analyzers/custom-rule/custom-rule.analyzer';
import { GuardDogAnalyzer } from '../src/analyzers/guarddog/guarddog.analyzer';
import { parseGuardDogOutput } from '../src/analyzers/guarddog/guarddog-output.parser';
import { MetadataAnalyzer } from '../src/analyzers/metadata/metadata.analyzer';
import { ObfuscationAnalyzer } from '../src/analyzers/obfuscation/obfuscation.analyzer';
import { ArtifactHasher } from '../src/artifact/hasher/artifact-hasher';
import { PackageIdentityVerifier } from '../src/artifact/identity/package-identity-verifier';
import { TarballDownloader } from '../src/artifact/downloader/tarball-downloader';
import { SafeExtractor } from '../src/artifact/extractor/safe-extractor';
import { IntegrityVerifier } from '../src/artifact/integrity/integrity-verifier';
import { RegistryMetadataClient } from '../src/registry/metadata-client/registry-metadata-client';
import { ScanHistoryService } from '../src/history/scan-history.service';
import { OsvFeedClient } from '../src/osv/osv-feed-client';
import type { OsvFeedResult } from '../src/osv/osv-feed.types';
import { LlmAgentRunnerService } from '../src/llm-agent/agent-runner.service';
import { LlmEvidenceAdapter } from '../src/llm-agent/llm-evidence.adapter';
import { AgentOutputValidatorService } from '../src/llm-agent/agent-output-validator.service';
import { LlmAgentToolsService } from '../src/llm-agent/llm-agent-tools.service';
import { AgentInputV0_3Builder } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import { loadLlmAgentEnvironment } from '../src/config/scanner-environment';
import * as contextCheckService from '../src/llm-agent/context-check/context-check.service';
import { planFindingGroups } from '../src/llm-agent/context-check/context-questions';
import { buildPolicyEvaluationRequest } from '../src/policy/policy-evaluation.request';
import * as agentPlanningAdapter from '../src/application/planning/agent-planning-input.adapter';
import * as staticFilter from '../src/application/planning/static-filter';
import type { StaticFilterResult, StaticFilterStatus } from '../src/application/planning/static-filter.types';

const ARTIFACT_HASH =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CALCULATED_INTEGRITY =
  'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';
const EXPECTED_INTEGRITY =
  'sha512-AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg==';

function analyzerResult(
  analyzer: string,
  findings: Finding[] = [],
): AnalyzerResult {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    analyzer,
    analyzerVersion: '0.1.0',
    status: 'SUCCESS',
    findings,
    errors: [],
  };
}

function osvFeedResult(
  feedStatus: OsvFeedResult['feedStatus'] = 'SUCCESS',
): OsvFeedResult {
  return {
    source: 'OSV',
    feedStatus,
    query: { ecosystem: 'npm', packageName: 'example', packageVersion: '1.0.0' },
    advisories: feedStatus === 'SUCCESS' ? [{ id: 'OSV-TEST' }] : [],
    complete: feedStatus === 'SUCCESS',
    pagesFetched: feedStatus === 'SUCCESS' ? 1 : 0,
    collectedAt: feedStatus === 'SKIPPED' ? null : '2026-09-17T00:00:00.000Z',
    completedAt: feedStatus === 'SUCCESS' ? '2026-09-17T00:00:00.001Z' : null,
    errorCode: feedStatus === 'FAILED'
      ? 'NETWORK_ERROR'
      : feedStatus === 'TIMEOUT' ? 'PARENT_ABORTED' : null,
    skippedReason: feedStatus === 'SKIPPED' ? 'PROVENANCE_UNCONFIRMED' : null,
  };
}

function finding(
  ruleId: string,
  data: Record<string, unknown> = {},
  location?: Finding['location'],
): Finding {
  return {
    findingId: `${ruleId}:finding`,
    ruleId,
    type: 'TEST_FINDING',
    message: `Finding for ${ruleId}`,
    ...(location === undefined ? {} : { location }),
    data,
  };
}

function guardDogFinding(
  ruleId: string,
  type: 'CAPABILITY' | 'THREAT_INDICATOR' | 'UNKNOWN',
  occurrenceIndex = 0,
  data: Record<string, unknown> = {},
  location?: Finding['location'],
): Finding {
  return {
    ...finding(ruleId, data, location),
    findingId: `guarddog:${ruleId}:${occurrenceIndex}`,
    type,
  };
}

function request() {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    registryId: 'npmjs',
    packageName: 'example',
    packageVersion: '1.0.0',
  };
}

function staticDecision(status: StaticFilterStatus): StaticFilterResult {
  return {
    status, ruleVersion: '0.4.0', threat: { present: status !== 'NO_ESCALATION_SIGNAL', findingRefs: [] },
    appliedRuleIds: [], reasonCodes: status === 'NO_ESCALATION_SIGNAL' ? ['NO_THREAT_FINDING'] : [],
    findingRefs: [], evidenceRefs: [], diagnostics: [],
  };
}

function orchestrator(overrides: Partial<Record<string, unknown>> = {}): Orchestrator {
  const dependencies = {
    registryMetadataClient: {
      query: jest.fn().mockResolvedValue({
        registryId: 'npmjs',
        metadataUrl: 'https://registry.npmjs.org/example/1.0.0',
        tarballUrl: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        registryIntegrity: 'sha512-integrity',
        registryMetadata: { name: 'example', version: '1.0.0' },
      }),
    },
    tarballDownloader: {
      download: jest.fn().mockResolvedValue({
        scanId: 'scan-1',
        artifactPath: '/tmp/scan-1/artifact.tgz',
        bytes: 10,
        scanDir: '/tmp/scan-1',
        calculatedIntegrity: CALCULATED_INTEGRITY,
        finalUrl: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        receivedBytes: 10,
        sha256: ARTIFACT_HASH,
      }),
    },
    safeExtractor: { extract: jest.fn().mockResolvedValue({ extractedPath: '/tmp/scan-1/extracted', files: 1, bytes: 10 }) },
    artifactHasher: {
      hash: jest.fn().mockResolvedValue(ARTIFACT_HASH),
      hashDirectory: jest.fn().mockResolvedValue('b'.repeat(64)),
    },
    packageIdentityVerifier: {
      verify: jest.fn().mockResolvedValue({ name: 'example', version: '1.0.0', scripts: {} }),
    },
    metadataAnalyzer: {
      name: 'metadata',
      version: '0.1.0',
      analyzeResult: jest.fn().mockReturnValue(analyzerResult('metadata')),
    },
    customRuleAnalyzer: {
      name: 'custom-rule',
      version: '0.1.0',
      analyzeResult: jest.fn().mockResolvedValue(analyzerResult('custom-rule')),
    },
    guardDogAnalyzer: {
      name: 'guarddog',
      version: '0.1.0',
      analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog')),
    },
    obfuscationAnalyzer: {
      analyze: jest.fn().mockResolvedValue({
        analyzerResult: analyzerResult('obfuscation'),
        derivedAnalyzerResults: [],
        summary: {
          gptMode: 'off',
          scannedFiles: 0,
          selectedFiles: 0,
          restoredFiles: 0,
          partialRestoredFiles: 0,
          unresolvedFiles: 0,
          newRuleIds: [],
          derivedAnalyzerStatuses: [],
          evidenceBundles: [],
          gpt: { status: 'NOT_REQUESTED', durationMs: 0 },
        },
      }),
    },
    evidenceNormalizer: new EvidenceNormalizer(),
    osvFeedClient: {
      query: jest.fn().mockResolvedValue(osvFeedResult()),
    },
    ...overrides,
  };

  return new Orchestrator(
    dependencies.registryMetadataClient as unknown as RegistryMetadataClient,
    dependencies.tarballDownloader as unknown as TarballDownloader,
    dependencies.safeExtractor as unknown as SafeExtractor,
    dependencies.artifactHasher as unknown as ArtifactHasher,
    dependencies.packageIdentityVerifier as unknown as PackageIdentityVerifier,
    dependencies.metadataAnalyzer as unknown as MetadataAnalyzer,
    dependencies.customRuleAnalyzer as unknown as CustomRuleAnalyzer,
    dependencies.guardDogAnalyzer as unknown as GuardDogAnalyzer,
    dependencies.obfuscationAnalyzer as unknown as ObfuscationAnalyzer,
    dependencies.evidenceNormalizer as unknown as EvidenceNormalizer,
    dependencies.osvFeedClient as unknown as OsvFeedClient,
    overrides.agentRunner as LlmAgentRunnerService | undefined,
    overrides.llmEvidenceAdapter as LlmEvidenceAdapter | undefined,
    undefined,
    overrides.tier3InputBuilder as import('../src/llm-agent/artifact/agent-input-v0_3.builder').AgentInputV0_3Builder | undefined,
    overrides.contextCheckProvider as import('../src/llm-agent/context-check/jev-provider.client').JevProviderClient | undefined,
  );
}

describe('Scanner LLM Agent orchestration', () => {
  const original = { enabled: process.env.LLM_AGENT_ENABLED, mode: process.env.LLM_AGENT_TRIGGER_MODE, model: process.env.LLM_AGENT_MODEL, key: process.env.OPENAI_API_KEY };
  afterEach(() => {
    for (const [name, value] of Object.entries({ LLM_AGENT_ENABLED: original.enabled, LLM_AGENT_TRIGGER_MODE: original.mode, LLM_AGENT_MODEL: original.model, OPENAI_API_KEY: original.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  it('keeps the inactive path and skips the provider', async () => {
    process.env.LLM_AGENT_ENABLED = 'false';
    const runner = { execute: jest.fn(), executeV0_3: jest.fn() };
    const execution = await orchestrator({ agentRunner: runner }).execute(request(), new PackageDeadline(30_000));
    expect(execution.agentAnalysisSummary?.status).toBe('SKIPPED');
    expect(execution.agentAnalysisSummary?.triggerReason).toBe('NO_THREAT_FINDING');
    expect(runner.executeV0_3).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
    expect(execution.scanResult.evidences).toEqual([]);
  });
  it('merges verified LLM evidence after normalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-agent-integration-'));
    await mkdir(join(root, 'extracted'));
    await writeFile(join(root, 'extracted', 'index.js'), 'exec(x);');
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
    const runner = { execute: jest.fn(), executeV0_3: jest.fn().mockImplementation(async (agentRequest: import('../src/llm-agent/artifact/agent-analysis-input.contract').AgentAnalysisInputV0_3, runtime: import('../src/llm-agent/agent-runner.service').AgentExecutionContextV0_3) => {
      const slice = agentRequest.initialCodeSlices[0]!;
      const findingId = agentRequest.findings.find(({ ruleId }) => ruleId === 'threat-network-exfiltration')!.findingId;
      const assessment: import('../src/llm-agent/output.contract').AgentAssessment = { id: 'assessment', type: 'CORRELATED_BEHAVIOR', signal: 'NETWORK_EXFILTRATION', category: 'NETWORK', basis: 'PATTERN_MATCH', findingIds: [findingId], refs: [{ id: 'ref', sliceId: slice.sliceId, lines: [1, 1], role: 'SINK' }], flow: { sink: 'ref' }, reachability: { status: 'POSSIBLE' }, verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.7, reasonCodes: ['CODE'] };
      return { status: 'COMPLETED', analysisId: 'analysis', validated: { output: { status: 'COMPLETED', requestId: agentRequest.request.analysisRequestId, schemaVersion: '0.2.0', assessments: [assessment], summary: { verdict: 'SUSPICIOUS', confidence: 0.7, reasonCodes: ['CODE'] }, limitations: [], missingContext: [] }, assessments: [{ assessment, status: 'VERIFIED', issues: [] }] }, model: 'mock', promptVersion: 'p', outputSchemaVersion: '0.2.0', providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1, limitations: [], slices: runtime.registry.list(), codeRequests: [] };
    }) };
    try {
      const execution = await orchestrator({
        tarballDownloader: { download: jest.fn().mockResolvedValue({ scanId: 'scan-1', artifactPath: join(root, 'artifact.tgz'), scanDir: root, calculatedIntegrity: CALCULATED_INTEGRITY }) },
        safeExtractor: { extract: jest.fn().mockResolvedValue({ extractedPath: join(root, 'extracted'), files: 1, bytes: 10 }) },
        guardDogAnalyzer: { name: 'guarddog', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog', [guardDogFinding('threat-network-exfiltration', 'THREAT_INDICATOR', 0, { match: 'send(data)' }, { type: 'SOURCE_FILE', path: 'index.js', startLine: 1, endLine: 1 })])) },
        agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(),
      }).execute(request(), new PackageDeadline(30_000));
      expect(runner.executeV0_3).toHaveBeenCalledTimes(1);
      expect(runner.execute).not.toHaveBeenCalled();
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED', generatedEvidenceCount: 1 });
      expect(execution.scanResult.evidences.some((item) => item.kind === 'LLM_ASSESSMENT')).toBe(true);
      expect(execution.scanResult.evidences.some((item) => item.kind === 'ATOMIC')).toBe(true);
      expect(execution.calculatedIntegrity).toBe(CALCULATED_INTEGRITY);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  describe('Agent context check (Jev)', () => {
    const saved = { enabled: process.env.LLM_AGENT_CONTEXT_CHECK_ENABLED, key: process.env.TYPESAFE_API_KEY };
    afterEach(() => {
      for (const [name, value] of Object.entries({ LLM_AGENT_CONTEXT_CHECK_ENABLED: saved.enabled, TYPESAFE_API_KEY: saved.key })) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    });
    const agentResult = (agentRequest: import('../src/llm-agent/artifact/agent-analysis-input.contract').AgentAnalysisInputV0_3, runtime: import('../src/llm-agent/agent-runner.service').AgentExecutionContextV0_3) => ({
      status: 'COMPLETED', analysisId: 'analysis', validated: { output: { status: 'COMPLETED', requestId: agentRequest.request.analysisRequestId, schemaVersion: '0.2.0', assessments: [], summary: { verdict: 'SUSPICIOUS', confidence: 0.7, reasonCodes: ['CODE'] }, limitations: [], missingContext: [] }, assessments: [] },
      model: 'mock', promptVersion: 'p', outputSchemaVersion: '0.2.0', providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1, limitations: [], slices: runtime.registry.list(), codeRequests: [],
    });
    /** One scan whose Tier 3 runs; `check` is the Jev provider handed to the Orchestrator. */
    async function scan(check: jest.Mock | undefined, contextCheckEnabled: boolean) {
      const root = await mkdtemp(join(tmpdir(), 'scanner-context-check-'));
      await mkdir(join(root, 'extracted'));
      await writeFile(join(root, 'extracted', 'index.js'), 'exec(x);');
      process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
      if (contextCheckEnabled) { process.env.LLM_AGENT_CONTEXT_CHECK_ENABLED = 'true'; process.env.TYPESAFE_API_KEY = 'dummy'; }
      else { process.env.LLM_AGENT_CONTEXT_CHECK_ENABLED = 'false'; delete process.env.TYPESAFE_API_KEY; }
      const runner = { execute: jest.fn(), executeV0_3: jest.fn().mockImplementation(async (agentRequest, runtime) => agentResult(agentRequest, runtime)) };
      try {
        const execution = await orchestrator({
          tarballDownloader: { download: jest.fn().mockResolvedValue({ scanId: 'scan-1', artifactPath: join(root, 'artifact.tgz'), scanDir: root, calculatedIntegrity: CALCULATED_INTEGRITY }) },
          safeExtractor: { extract: jest.fn().mockResolvedValue({ extractedPath: join(root, 'extracted'), files: 1, bytes: 10 }) },
          guardDogAnalyzer: { name: 'guarddog', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog', [guardDogFinding('threat-network-exfiltration', 'THREAT_INDICATOR', 0, { match: 'send(data)' }, { type: 'SOURCE_FILE', path: 'index.js', startLine: 1, endLine: 1 })])) },
          agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(),
          ...(check === undefined ? {} : { contextCheckProvider: { check } }),
        }).execute(request(), new PackageDeadline(30_000));
        const shadow = execution.scanResult.shadowAnalyses?.find((record) => record.analyzer === 'tier3-agent-v0.3')?.data as { status: string; contextCheck?: Record<string, unknown> };
        return { execution, runner, shadow };
      } finally { await rm(root, { recursive: true, force: true }); }
    }
    const visible = () => jest.fn(async (jevRequest: { questions: Record<string, unknown> }) => ({
      model: 'jev-test', answers: Object.fromEntries(Object.keys(jevRequest.questions).map((key) => [key, { score: 2, confidence: 1 }])), usage: { inputTokens: 10, outputTokens: 2 },
    }));

    it('asks the provider once between slicing and the Agent, and records a summary in the Tier 3 Shadow record', async () => {
      const check = visible();
      const { runner, shadow, execution } = await scan(check, true);
      expect(check).toHaveBeenCalledTimes(1);
      expect(runner.executeV0_3).toHaveBeenCalledTimes(1);
      expect(check.mock.invocationCallOrder[0]).toBeLessThan(runner.executeV0_3.mock.invocationCallOrder[0]!);
      const jevRequest = check.mock.calls[0]![0] as { state: { groups: Array<{ filePath: string }> }; questions: Record<string, unknown> };
      expect(jevRequest.state.groups.map((group) => group.filePath)).toEqual(['index.js']);
      expect(shadow.contextCheck).toMatchObject({
        // LINK has no complete path in this one-line file, so its VISIBLE answer does not stand and there is no code to add.
        status: 'NO_CANDIDATE', groupCount: 1, questionCount: Object.keys(jevRequest.questions).length, addedSliceCount: 0, unresolvedContextCount: 1, model: 'jev-test', inputTokens: 10, outputTokens: 2,
      });
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED' });
    });

    it('does not call the provider and records nothing while the check is off', async () => {
      const check = visible();
      const { runner, shadow } = await scan(check, false);
      expect(check).not.toHaveBeenCalled();
      expect(runner.executeV0_3).toHaveBeenCalledTimes(1);
      expect(shadow).not.toHaveProperty('contextCheck');
    });

    describe('whole Scanner flow', () => {
      const SOURCE = ["const https = require('https');", 'function send(data) {', '  https.request(endpoint).end(data);', '}', 'send(secret);', ''].join('\n');
      /** Answers VISIBLE except for the contexts named in `missing`, which it rates as absent. */
      const jev = (missing: readonly string[] = []) => jest.fn(async (jevRequest: { questions: Record<string, unknown> }) => ({
        model: 'jev-test', usage: { inputTokens: 10, outputTokens: 2 },
        answers: Object.fromEntries(Object.keys(jevRequest.questions).map((key) => [key, missing.some((context) => key.endsWith(`__${context}`)) ? { score: 0, confidence: 1 } : { score: 2, confidence: 1 }])),
      }));
      /** The real Agent Runner with a mock model that cites the first slice; records every input it is given. */
      function realRunner() {
        const inputs: Array<import('../src/llm-agent/artifact/agent-analysis-input.contract').AgentAnalysisInputV0_3> = [];
        const generate = jest.fn().mockImplementation(async (prompt: string) => {
          const serialized = prompt.match(/<analysis_request>\n(.+)\n<\/analysis_request>/u)?.[1];
          if (serialized === undefined) throw new Error('Analysis request missing');
          const input = JSON.parse(serialized) as import('../src/llm-agent/artifact/agent-analysis-input.contract').AgentAnalysisInputV0_3;
          inputs.push(input);
          const slice = input.initialCodeSlices[0]!;
          const findingId = input.findings.find(({ ruleId }) => ruleId === 'threat-network-exfiltration')!.findingId;
          return { text: JSON.stringify({ requestId: input.request.analysisRequestId, schemaVersion: '0.3.0', status: 'COMPLETED',
            assessments: [{ id: 'assessment', type: 'CORRELATED_BEHAVIOR', signal: 'NETWORK_EXFILTRATION', category: 'NETWORK',
              basis: 'PATTERN_MATCH', findingIds: [findingId], refs: [{ id: 'ref', sliceId: slice.sliceId, lines: [slice.startLine, slice.startLine], role: 'SINK' }], flow: { sink: 'ref' },
              reachability: { status: 'POSSIBLE' }, verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.7, reasonCodes: ['CODE'],
              claimScope: 'CODE_BEHAVIOR', limitations: [] }],
            summary: { verdict: 'SUSPICIOUS', confidence: 0.7, reasonCodes: ['CODE'] }, limitations: [], missingContext: [] }),
            model: 'integration-mock', providerRequestId: 'mock-request', usage: {}, durationMs: 1 };
        });
        return { inputs, generate, runner: new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), new AgentOutputValidatorService(), loadLlmAgentEnvironment()) };
      }
      async function withPackage<T>(run: (root: string) => Promise<T>): Promise<T> {
        const root = await mkdtemp(join(tmpdir(), 'scanner-whole-flow-'));
        await mkdir(join(root, 'extracted'));
        await writeFile(join(root, 'extracted', 'index.js'), SOURCE);
        process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS'; process.env.LLM_AGENT_MODEL = 'integration-mock'; process.env.OPENAI_API_KEY = 'integration-mock';
        process.env.LLM_AGENT_MAX_RETRIES = '0'; process.env.LLM_AGENT_CONTEXT_CHECK_ENABLED = 'true'; process.env.TYPESAFE_API_KEY = 'dummy';
        try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
      }
      const tier1 = (root: string) => ({
        tarballDownloader: { download: jest.fn().mockResolvedValue({ scanId: 'scan-1', artifactPath: join(root, 'artifact.tgz'), scanDir: root, calculatedIntegrity: CALCULATED_INTEGRITY }) },
        safeExtractor: { extract: jest.fn().mockResolvedValue({ extractedPath: join(root, 'extracted'), files: 1, bytes: SOURCE.length }) },
        packageIdentityVerifier: { verify: jest.fn().mockResolvedValue({ name: 'example', version: '1.0.0', scripts: { postinstall: 'node index.js' } }) },
        guardDogAnalyzer: { name: 'guarddog', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog', [
          guardDogFinding('threat-network-exfiltration', 'THREAT_INDICATOR', 0, { match: 'https.request(endpoint)' }, { type: 'SOURCE_FILE', path: 'index.js', startLine: 3 }),
        ])) },
      });

      it('takes a Tier 1 Finding through the static filter, the context check and the real Agent Runner to Policy-ready Evidence', async () => {
        await withPackage(async (root) => {
          const check = jev(['LINK']);
          const agent = realRunner();
          const execution = await orchestrator({ ...tier1(root), agentRunner: agent.runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(), contextCheckProvider: { check } })
            .execute(request(), new PackageDeadline(30_000));
          // LINK is settled by the path that was added and the other answers stand, so nothing is asked a second time.
          expect(check).toHaveBeenCalledTimes(1);
          expect(agent.generate).toHaveBeenCalledTimes(1);
          // The Agent gets the slices as built plus the ones the context check added, and the plan names them.
          const input = agent.inputs[0]!;
          const ranges = input.initialCodeSlices.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`);
          expect(ranges[0]).toBe('index.js:3-3');
          // `send(secret);` on line 5 is the confirmed call from the top level to the function holding the Finding.
          expect(ranges).toContain('index.js:5-5');
          expect(input.initialCodeSlices.every((slice) => slice.origin === 'INITIAL')).toBe(true);
          const added = input.analysisPlan.targets.filter((target) => target.reasonCodes.includes('CONTEXT_EXPANSION'));
          expect(added.length).toBeGreaterThan(0);
          expect(added.some((target) => target.reasonCodes.includes('EXECUTION_PATH'))).toBe(true);
          // The supplemented input passes the Runner's validation and its Evidence reaches Policy.
          expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED', generatedEvidenceCount: 1 });
          const policyRequest = buildPolicyEvaluationRequest(execution.scanResult, execution, CALCULATED_INTEGRITY);
          expect(policyRequest.evidences.filter((item) => (item as { kind?: string }).kind === 'LLM_ASSESSMENT')).toHaveLength(1);
          const shadow = execution.scanResult.shadowAnalyses?.find((record) => record.analyzer === 'tier3-agent-v0.3')?.data as { status: string; initialSliceCount: number; contextCheck: { status: string; addedSliceCount: number } };
          expect(shadow).toMatchObject({ status: 'COMPLETED', contextCheck: { status: 'EXPANDED' } });
          expect(shadow.contextCheck.addedSliceCount).toBe(input.initialCodeSlices.length - 1);
          expect(shadow.initialSliceCount).toBe(input.initialCodeSlices.length);
          // Nothing Scanner-internal leaves: no local path in the Jev request or the Agent input.
          expect(JSON.stringify(check.mock.calls[0]![0])).not.toContain(root);
          expect(JSON.stringify(input)).not.toContain(root);
        });
      });

      it('hands the scan\'s own static filter result to the context check, and the questions follow it', async () => {
        await withPackage(async (root) => {
          const spy = jest.spyOn(contextCheckService, 'runContextCheck');
          try {
            const check = jev();
            const agent = realRunner();
            const execution = await orchestrator({ ...tier1(root), agentRunner: agent.runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(), contextCheckProvider: { check } })
              .execute(request(), new PackageDeadline(30_000));
            expect(spy).toHaveBeenCalledTimes(1);
            const given = spy.mock.calls[0]![0];
            expect(execution.staticFilterResult).toBeDefined();
            expect(given.staticFilter).toBe(execution.staticFilterResult);
            expect(given.enabled).toBe(true);
            // Every Finding the filter's diagnostics name is a Finding of the Tier 3 input, under the same analyzer and ID.
            const known = new Set(given.execution.findings.map((item) => `${item.analyzer}\u0000${item.findingId}`));
            const referenced = execution.staticFilterResult!.diagnostics.flatMap((diagnostic) => diagnostic.findingRefs);
            expect(referenced.length).toBeGreaterThan(0);
            expect(referenced.every((ref) => known.has(`${ref.analyzer}\u0000${ref.findingId}`))).toBe(true);
            // The questions asked are exactly the active contexts planned from those diagnostics.
            const planned = planFindingGroups(given.execution, given.built.input.initialCodeSlices, execution.staticFilterResult!.diagnostics);
            const expected = planned.groups.flatMap((group) => group.contexts.map((context) => `${group.groupId}__${context}`));
            expect(Object.keys((check.mock.calls[0]![0] as { questions: Record<string, unknown> }).questions)).toEqual(expected);
          } finally { spy.mockRestore(); }
        });
      });

      it('checks the restored code of Tier 2 together with the original', async () => {
        await withPackage(async (root) => {
          await mkdir(join(root, 'derived'));
          await writeFile(join(root, 'derived', 'index.js'), SOURCE);
          const derived = finding('custom.network-outbound', { code: 'https.request(endpoint)' }, { type: 'SOURCE_FILE', path: 'index.js', startLine: 3, representation: 'DEOBFUSCATED' });
          const snapshot = { parse: { valid: true }, bytes: SOURCE.length, identifierCount: 6, hexIdentifierCount: 0, hexIdRatio: 0, score: 0, signals: [] };
          // The restored file as the Tier 2 restore reports it: same lines as the original, mapped one to one.
          const restoredFile = {
            path: 'index.js', outputPath: 'index.js', status: 'RESTORED', limitations: [], stageResults: [], appliedStages: [], payloads: [],
            originalBytes: SOURCE.length, restoredBytes: SOURCE.length, verifyAfter: { score: 0, hexIdRatio: 0 }, durationMs: 1,
            validation: { original: snapshot, restored: snapshot, byteDelta: 0, byteRatio: 1, identifierDelta: 0, hexIdentifierDelta: 0, scoreDelta: 0, addedSignals: [], removedSignals: [],
              capability: { before: [], after: [], status: 'PRESERVED', lost: [] } },
            lineMapping: { version: '0.1.0', sourcePath: 'index.js', derivedPath: 'index.js', status: 'MAPPED',
              entries: [1, 2, 3, 4, 5].map((line) => ({ derivedLine: line, sourceLine: line, confidence: 'EXACT' })), derivedLineCount: 5, mappedLineCount: 5, limitations: [] },
          };
          const check = jev();
          const agent = realRunner();
          const execution = await orchestrator({
            ...tier1(root), agentRunner: agent.runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(), contextCheckProvider: { check },
            obfuscationAnalyzer: { analyze: jest.fn().mockResolvedValue({
              analyzerResult: analyzerResult('obfuscation'),
              derivedAnalyzerResults: [analyzerResult('custom-rule-deobfuscated', [derived])],
              restore: { outputRoot: join(root, 'derived'), restored: [restoredFile], unresolved: [], durationMs: 1, budgetExceeded: false },
              summary: { gptMode: 'off', scannedFiles: 1, selectedFiles: 1, restoredFiles: 1, partialRestoredFiles: 0, unresolvedFiles: 0, newRuleIds: [], derivedAnalyzerStatuses: [], evidenceBundles: [], gpt: { status: 'NOT_REQUESTED', durationMs: 0 } },
            }) },
          }).execute(request(), new PackageDeadline(30_000));
          expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED' });
          expect(check).toHaveBeenCalledTimes(1);
          const jevRequest = check.mock.calls[0]![0] as unknown as { state: { groups: Array<{ filePath: string; representation: string; behavior: string }>; slices: Array<{ representation: string }> } };
          expect(jevRequest.state.groups.map((group) => `${group.representation} ${group.filePath} ${group.behavior}`).sort()).toEqual([
            'DEOBFUSCATED index.js NETWORK_SEND', 'ORIGINAL index.js NETWORK_SEND',
          ]);
          expect(new Set(jevRequest.state.slices.map((slice) => slice.representation))).toEqual(new Set(['ORIGINAL', 'DEOBFUSCATED']));
          expect(agent.generate).toHaveBeenCalledTimes(1);
          expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED' });
          const shadow = execution.scanResult.shadowAnalyses?.find((record) => record.analyzer === 'tier3-agent-v0.3')?.data as { contextCheck: { status: string; groupCount: number } };
          expect(shadow.contextCheck).toMatchObject({ groupCount: 2 });
          expect(['SUFFICIENT', 'EXPANDED']).toContain(shadow.contextCheck.status);
          // Each added slice comes from the artifact of the group it was added for.
          const artifacts = new Set(agent.inputs[0]!.artifactContext.artifacts.map((artifact) => artifact.artifactId));
          expect(agent.inputs[0]!.initialCodeSlices.every((slice) => artifacts.has(slice.artifactId))).toBe(true);
        });
      });
    });

    it('runs Tier 3 with the input as built when the provider fails or is not injected', async () => {
      const failing = jest.fn(async () => { throw new Error('provider down'); });
      const failed = await scan(failing, true);
      expect(failing).toHaveBeenCalledTimes(1);
      expect(failed.runner.executeV0_3).toHaveBeenCalledTimes(1);
      expect(failed.shadow).toMatchObject({ status: 'COMPLETED', contextCheck: { status: 'UNAVAILABLE', failureReason: 'INTERNAL_ERROR' } });
      const missing = await scan(undefined, true);
      expect(missing.runner.executeV0_3).toHaveBeenCalledTimes(1);
      expect(missing.shadow).not.toHaveProperty('contextCheck');
    });
  });

  it('runs the real V0.3 Runner with a mock Provider and produces Policy-compatible Evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-agent-runner-integration-'));
    await mkdir(join(root, 'extracted'));
    await writeFile(join(root, 'extracted', 'index.js'), 'send(secret);\n');
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS';
    process.env.LLM_AGENT_MODEL = 'integration-mock'; process.env.OPENAI_API_KEY = 'integration-mock';
    process.env.LLM_AGENT_MAX_RETRIES = '0';
    const generate = jest.fn().mockImplementation(async (prompt: string) => {
      const serialized = prompt.match(/<analysis_request>\n(.+)\n<\/analysis_request>/u)?.[1];
      if (serialized === undefined) throw new Error('Analysis request missing');
      const input = JSON.parse(serialized) as import('../src/llm-agent/artifact/agent-analysis-input.contract').AgentAnalysisInputV0_3;
      const slice = input.initialCodeSlices[0]!;
      const findingId = input.findings.find(({ ruleId }) => ruleId === 'threat-network-exfiltration')!.findingId;
      return { text: JSON.stringify({ requestId: input.request.analysisRequestId, schemaVersion: '0.3.0', status: 'COMPLETED',
        assessments: [{ id: 'assessment', type: 'CORRELATED_BEHAVIOR', signal: 'NETWORK_EXFILTRATION', category: 'NETWORK',
          basis: 'PATTERN_MATCH', findingIds: [findingId], refs: [{ id: 'ref', sliceId: slice.sliceId,
            lines: [slice.startLine, slice.startLine], role: 'SINK' }], flow: { sink: 'ref' },
          reachability: { status: 'POSSIBLE' }, verification: { status: 'UNVERIFIED', method: 'NONE' },
          confidence: 0.7, reasonCodes: ['CODE'], claimScope: 'CODE_BEHAVIOR', limitations: [] }],
        summary: { verdict: 'SUSPICIOUS', confidence: 0.7, reasonCodes: ['CODE'] }, limitations: [], missingContext: [] }),
        model: 'integration-mock', providerRequestId: 'mock-request', usage: {}, durationMs: 1 };
    });
    const runner = new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(),
      new AgentOutputValidatorService(), loadLlmAgentEnvironment());
    try {
      const execution = await orchestrator({
        tarballDownloader: { download: jest.fn().mockResolvedValue({ scanId: 'scan-1', artifactPath: join(root, 'artifact.tgz'),
          scanDir: root, calculatedIntegrity: CALCULATED_INTEGRITY }) },
        safeExtractor: { extract: jest.fn().mockResolvedValue({ extractedPath: join(root, 'extracted'), files: 1, bytes: 14 }) },
        guardDogAnalyzer: { name: 'guarddog', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog', [
          guardDogFinding('threat-network-exfiltration', 'THREAT_INDICATOR', 0, { match: 'send(secret)' },
            { type: 'SOURCE_FILE', path: 'index.js', startLine: 1, endLine: 1 }),
        ])) }, agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(),
      }).execute(request(), new PackageDeadline(30_000));
      expect(generate).toHaveBeenCalledTimes(1);
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED', generatedEvidenceCount: 1 });
      const policyRequest = buildPolicyEvaluationRequest(execution.scanResult, execution, CALCULATED_INTEGRITY);
      expect(policyRequest.evidences.filter((item) => (item as { kind?: string }).kind === 'LLM_ASSESSMENT')).toHaveLength(1);
      expect(policyRequest.agentAnalysisSummary).toMatchObject({ generatedEvidenceCount: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not let RISK_BASED or ALWAYS bypass a static-filter skip', async () => {
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'RISK_BASED'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
    const runner = { execute: jest.fn(), executeV0_3: jest.fn() };
    for (const mode of ['RISK_BASED', 'ALWAYS'] as const) {
      process.env.LLM_AGENT_TRIGGER_MODE = mode;
      const execution = await orchestrator({ agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter() }).execute(request(), new PackageDeadline(30_000));
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'SKIPPED', triggerReason: 'NO_THREAT_FINDING' });
    }
    expect(runner.executeV0_3).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
  });
  it.each([
    ['STATIC_MALICIOUS', 'STATIC_FILTER_MALICIOUS'],
    ['NO_ESCALATION_SIGNAL', 'NO_THREAT_FINDING'],
  ] as const)('skips all Agent preparation for %s', async (status, triggerReason) => {
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
    const evaluate = jest.spyOn(staticFilter, 'evaluateStaticFilter').mockReturnValue(staticDecision(status));
    const hashDirectory = jest.fn();
    const runner = { execute: jest.fn(), executeV0_3: jest.fn() };
    try {
      const execution = await orchestrator({ artifactHasher: { hash: jest.fn().mockResolvedValue(ARTIFACT_HASH), hashDirectory },
        agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter() })
        .execute(request(), new PackageDeadline(30_000));
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'SKIPPED', triggerReason });
      expect(hashDirectory).not.toHaveBeenCalled();
      expect(runner.executeV0_3).not.toHaveBeenCalled();
      expect(runner.execute).not.toHaveBeenCalled();
    } finally { evaluate.mockRestore(); }
  });

  it('routes AMBIGUOUS through V0.3 once and ignores the legacy trigger path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-agent-ambiguous-'));
    await mkdir(join(root, 'extracted')); await writeFile(join(root, 'extracted', 'index.js'), 'send(value);\n');
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'RISK_BASED'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
    const evaluate = jest.spyOn(staticFilter, 'evaluateStaticFilter').mockReturnValue(staticDecision('AMBIGUOUS'));
    const runner = { execute: jest.fn(), executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => ({
      status: 'COMPLETED', analysisId: 'ambiguous', promptVersion: 'p', outputSchemaVersion: '0.2.0', providerRequestIds: [], usage: {},
      modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1, limitations: [], slices: runtime.registry.list(), codeRequests: [],
    })) };
    try {
      const execution = await orchestrator({
        tarballDownloader: { download: jest.fn().mockResolvedValue({ scanId: 'scan-1', artifactPath: join(root, 'artifact.tgz'), scanDir: root, calculatedIntegrity: CALCULATED_INTEGRITY }) },
        safeExtractor: { extract: jest.fn().mockResolvedValue({ extractedPath: join(root, 'extracted'), files: 1, bytes: 12 }) },
        customRuleAnalyzer: { name: 'custom-rule', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('custom-rule', [finding('custom.network', {}, { type: 'SOURCE_FILE', path: 'index.js', startLine: 1 })])) },
        agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(),
      }).execute(request(), new PackageDeadline(30_000));
      expect(runner.executeV0_3).toHaveBeenCalledTimes(1);
      expect(runner.execute).not.toHaveBeenCalled();
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED', triggerReason: 'STATIC_FILTER_AMBIGUOUS' });
    } finally { evaluate.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it('does not execute an incomplete package when Agent settings are disabled', async () => {
    process.env.LLM_AGENT_ENABLED = 'false'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS';
    const evaluate = jest.spyOn(staticFilter, 'evaluateStaticFilter').mockReturnValue(staticDecision('STATIC_INCOMPLETE'));
    const hashDirectory = jest.fn(); const runner = { execute: jest.fn(), executeV0_3: jest.fn() };
    try {
      const execution = await orchestrator({ artifactHasher: { hash: jest.fn().mockResolvedValue(ARTIFACT_HASH), hashDirectory }, agentRunner: runner })
        .execute(request(), new PackageDeadline(30_000));
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'SKIPPED', triggerReason: 'AGENT_DISABLED' });
      expect(hashDirectory).not.toHaveBeenCalled();
      expect(runner.executeV0_3).not.toHaveBeenCalled();
    } finally { evaluate.mockRestore(); }
  });

  it('isolates original artifact preparation failure and preserves the static result', async () => {
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
    const evaluate = jest.spyOn(staticFilter, 'evaluateStaticFilter').mockReturnValue(staticDecision('STATIC_INCOMPLETE'));
    const runner = { execute: jest.fn(), executeV0_3: jest.fn() };
    try {
      const execution = await orchestrator({
        artifactHasher: { hash: jest.fn().mockResolvedValue(ARTIFACT_HASH), hashDirectory: jest.fn().mockRejectedValue(new Error('hash failed')) },
        agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(),
      }).execute(request(), new PackageDeadline(30_000));
      expect(execution.staticFilterResult?.status).toBe('STATIC_INCOMPLETE');
      expect(execution.agentAnalysisSummary).toMatchObject({ status: 'FAILED', failureReason: 'INPUT_BUILD_FAILED' });
      expect(execution.scanResult.evidences).toEqual([]);
      expect(execution.policyEligible).toBe(true);
      expect(runner.executeV0_3).not.toHaveBeenCalled();
    } finally { evaluate.mockRestore(); }
  });
  it('keeps atomic evidence when Agent execution fails', async () => {
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
    const runner = { execute: jest.fn(), executeV0_3: jest.fn().mockRejectedValue(new Error('provider failed')) };
    const execution = await orchestrator({
      guardDogAnalyzer: { name: 'guarddog', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog', [guardDogFinding('threat-network-exfiltration', 'THREAT_INDICATOR', 0, {}, { type: 'SOURCE_FILE', path: 'index.js', startLine: 1 })])) },
      agentRunner: runner, tier3InputBuilder: new AgentInputV0_3Builder(), llmEvidenceAdapter: new LlmEvidenceAdapter(),
    }).execute(request(), new PackageDeadline(30_000));
    expect(execution.agentAnalysisSummary?.status).toBe('FAILED');
    expect(execution.scanResult.evidences.some((item) => item.kind === 'ATOMIC')).toBe(true);
    expect(execution.policyEligible).toBe(true);
  });
  it('records input construction failure with the fixed reason', async () => {
    process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'ALWAYS'; process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
    const execution = await orchestrator({
      customRuleAnalyzer: { name: 'custom-rule', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('custom-rule', [finding('threat-network-exfiltration', {}, { type: 'SOURCE_FILE', path: 'index.js', startLine: 1 })])) },
      tier3InputBuilder: { build: jest.fn().mockRejectedValue(new Error('private failure detail')) },
      agentRunner: { execute: jest.fn(), executeV0_3: jest.fn() }, llmEvidenceAdapter: new LlmEvidenceAdapter(),
    }).execute(request(), new PackageDeadline(30_000));
    expect(execution.agentAnalysisSummary).toMatchObject({ status: 'FAILED', failureReason: 'INPUT_BUILD_FAILED', generatedEvidenceCount: 0 });
    expect(JSON.stringify(execution.agentAnalysisSummary)).not.toContain('private failure detail');
  });

  it.each(['exception', 'no-restored-files'] as const)(
    'uses the original-only V0.3 route when restoration has %s', async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'scanner-restore-failure-'));
      const extractedPath = join(root, 'extracted');
      await mkdir(extractedPath);
      // Authored, harmless source is read by the input builder, never executed.
      await writeFile(join(extractedPath, 'index.js'), 'const fixture = "source context";\n');
      process.env.LLM_AGENT_ENABLED = 'true'; process.env.LLM_AGENT_TRIGGER_MODE = 'RISK_BASED';
      process.env.LLM_AGENT_MODEL = 'mock'; process.env.OPENAI_API_KEY = 'dummy';
      const analyze = failure === 'exception'
        ? jest.fn().mockRejectedValue(new Error('fixture native module unavailable'))
        : jest.fn().mockResolvedValue({
          analyzerResult: analyzerResult('obfuscation'), derivedAnalyzerResults: [], evidenceCandidates: [],
          restore: { outputRoot: join(root, 'derived'), restored: [], unresolved: [{ path: 'index.js', reason: 'TOOL_FAILED', limitations: [] }],
            skipped: [], durationMs: 1, budgetExceeded: false },
          summary: { gptMode: 'off', scannedFiles: 1, selectedFiles: 1, restoredFiles: 0, partialRestoredFiles: 0,
            unresolvedFiles: 1, newRuleIds: [], derivedAnalyzerStatuses: [], evidenceBundles: [],
            gpt: { status: 'NOT_REQUESTED', durationMs: 0 } },
        });
      const runner = {
        execute: jest.fn(),
        executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => ({ status: 'COMPLETED', analysisId: 'mock-analysis', promptVersion: 'p',
          outputSchemaVersion: '0.2.0', providerRequestIds: [], usage: {}, modelCalls: 0, toolCalls: 0,
          additionalCodeRequests: 0, durationMs: 0, limitations: [], slices: runtime.registry.list(), codeRequests: [] })),
      };
      const inputBuilder = new AgentInputV0_3Builder();
      let buildError: unknown;
      const originalBuild = inputBuilder.build.bind(inputBuilder);
      const build = jest.spyOn(inputBuilder, 'build').mockImplementation(async (...args) => {
        try { return await originalBuild(...args); } catch (error) { buildError = error; throw error; }
      });
      try {
        const execution = await orchestrator({
          tarballDownloader: { download: jest.fn().mockResolvedValue({ scanId: 'scan-1', artifactPath: join(root, 'artifact.tgz'),
            scanDir: root, calculatedIntegrity: CALCULATED_INTEGRITY }) },
          safeExtractor: { extract: jest.fn().mockResolvedValue({ extractedPath, files: 1, bytes: 34 }) },
          guardDogAnalyzer: { name: 'guarddog', version: '1', analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog', [
            guardDogFinding('threat-network-exfiltration', 'THREAT_INDICATOR', 0, {},
              { type: 'SOURCE_FILE', path: 'index.js', startLine: 1, endLine: 1 }),
          ])) },
          obfuscationAnalyzer: { analyze }, tier3InputBuilder: inputBuilder,
          agentRunner: runner, llmEvidenceAdapter: new LlmEvidenceAdapter(),
        }).execute(request(), new PackageDeadline(30_000));
        expect(execution.staticFilterResult?.status).toBe('STATIC_INCOMPLETE');
        expect(buildError).toBeUndefined();
        expect(runner.executeV0_3).toHaveBeenCalledTimes(1);
        expect(build).toHaveBeenCalledTimes(1);
        expect(runner.execute).not.toHaveBeenCalled();
        const input = runner.executeV0_3.mock.calls[0]![0] as import('../src/llm-agent/artifact/agent-analysis-input.contract').AgentAnalysisInputV0_3;
        expect(input.findings).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'threat-network-exfiltration' })]));
        expect(input.initialCodeSlices.length).toBeGreaterThan(0);
        expect(input.atomicEvidences.length).toBeGreaterThan(0);
        for (const evidence of input.atomicEvidences) {
          expect(execution.scanResult.evidences.find((item) => item.evidenceId === evidence.evidenceId))
            .toMatchObject({ kind: 'ATOMIC', signal: evidence.signal, sources: evidence.sources,
              assertion: evidence.assertion, limitations: evidence.limitations,
              locations: evidence.locations });
        }
        expect(execution.agentAnalysisSummary).toMatchObject({ status: 'COMPLETED', triggerReason: 'STATIC_FILTER_STATIC_INCOMPLETE' });
        expect(execution.policyEligible).toBe(true);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  it('passes active Agent summary and merged evidence to Policy', async () => {
    const saved = { schemaVersion: '0.1', requestId: 'request-1', scanId: 'scan-1', subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' as const }, artifactHash: ARTIFACT_HASH,
      status: 'COMPLETED' as const, evidences: [{ evidenceId: 'atomic', kind: 'ATOMIC' }, { evidenceId: 'llm:analysis:assessment', kind: 'LLM_ASSESSMENT', verificationStatus: 'VERIFIED', relatedFindingIds: ['finding'], relatedAtomicEvidenceIds: ['atomic'], provenance: { producerType: 'LLM_AGENT', analysisId: 'analysis', assessmentId: 'assessment' } }], analyzerSummaries: [], errors: [] };
    const evaluate = jest.fn().mockResolvedValue(undefined);
    const service = new ScanService({ execute: jest.fn().mockResolvedValue({ scanResult: saved, calculatedIntegrity: CALCULATED_INTEGRITY, policyEligible: true, osvFeed: osvFeedResult(), agentFindingIds: ['finding'], agentAnalysisSummary: { status: 'COMPLETED', analysisId: 'analysis', assessmentCount: 1, verifiedAssessmentCount: 1, generatedEvidenceCount: 1, rejectedAssessmentCount: 0, limitations: [], triggerReason: 'ALWAYS_MODE' } }) } as unknown as Orchestrator,
      { save: jest.fn().mockResolvedValue(saved) } as unknown as ScanHistoryService, { evaluate } as unknown as PolicyEvaluationClient,
      { cleanupByScanId: jest.fn().mockResolvedValue(undefined) } as unknown as ArtifactFileManager);
    await service.scan({ requestId: 'request-1', packageName: 'example', version: '1.0.0' });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ evidences: saved.evidences, agentAnalysisSummary: expect.objectContaining({ status: 'COMPLETED', generatedEvidenceCount: 1 }), subject: expect.objectContaining({ artifactHash: ARTIFACT_HASH, integrity: CALCULATED_INTEGRITY }) }));
  });
});

async function executeScan(
  overrides: Partial<Record<string, unknown>> = {},
  executionRequest: ScanExecutionRequest = request(),
) {
  const execution = await orchestrator(overrides).execute(
    executionRequest,
    new PackageDeadline(30_000),
  );
  return execution.scanResult;
}

describe('Scanner application orchestration', () => {
  it('normalizes validated Tier2 candidates without normalizing raw shadow results', async () => {
    const previousAgentEnabled = process.env.LLM_AGENT_ENABLED;
    process.env.LLM_AGENT_ENABLED = 'false';
    const tier2Finding = finding(
      'custom.process-execution',
      { code: 'exec(decoded)' },
      { type: 'SOURCE_FILE', path: 'package/decoded.js', startLine: 3 },
    );
    const tier2Candidate = {
      analyzer: 'custom-rule-deobfuscated' as const,
      analyzerVersion: 'custom-v1',
      finding: tier2Finding,
      ruleId: tier2Finding.ruleId,
      rawFindingId: tier2Finding.findingId,
      requestId: 'request-1',
      scanId: 'scan-1',
      artifactHash: ARTIFACT_HASH,
      path: 'package/decoded.js',
      paths: ['package/decoded.js'],
      originalPath: 'package/index.js',
      originalPaths: ['package/index.js'],
      derivedPath: 'package/decoded.js',
      derivedPaths: ['package/decoded.js'],
      derivedOutputPath: '/tmp/scan-1/derived/obfuscation/package/decoded.js',
      derivedOutputPaths: ['/tmp/scan-1/derived/obfuscation/package/decoded.js'],
      locations: [{ type: 'SOURCE_FILE' as const, path: 'package/decoded.js', startLine: 3 }],
      limitations: [],
      restoreStatus: 'RESTORED' as const,
    };
    try {
      const execution = await orchestrator({
        obfuscationAnalyzer: {
          analyze: jest.fn().mockResolvedValue({
            analyzerResult: analyzerResult('obfuscation'),
            derivedAnalyzerResults: [analyzerResult('custom-rule-deobfuscated', [tier2Finding])],
            evidenceCandidates: [tier2Candidate],
            restore: {
              outputRoot: '/tmp/scan-1/derived/obfuscation',
              restored: [{ path: 'package/decoded.js', limitations: [] }],
              unresolved: [],
              durationMs: 1,
              budgetExceeded: false,
            },
            summary: {
              gptMode: 'off', scannedFiles: 1, selectedFiles: 1, restoredFiles: 1,
              partialRestoredFiles: 0, unresolvedFiles: 0, newRuleIds: [],
              derivedAnalyzerStatuses: [], evidenceBundles: [],
              gpt: { status: 'NOT_REQUESTED', durationMs: 0 },
            },
          }),
        },
      }).execute(request(), new PackageDeadline(30_000));

      expect(execution.scanResult.evidences).toHaveLength(1);
      expect(execution.scanResult.evidences[0]).toMatchObject({
        kind: 'ATOMIC',
        analysisPass: 'TIER2',
        sources: [{ analyzer: 'custom-rule-deobfuscated', rawFindingId: tier2Finding.findingId }],
      });
      expect(execution.staticFilterResult).toBeDefined();
    } finally {
      if (previousAgentEnabled === undefined) delete process.env.LLM_AGENT_ENABLED;
      else process.env.LLM_AGENT_ENABLED = previousAgentEnabled;
    }
  });

  it('connects Registry, Artifact, and all analyzers into a ScanResult', async () => {
    const legacyFileVerification = jest.spyOn(
      IntegrityVerifier.prototype,
      'verify',
    );
    const execution = await orchestrator().execute({
      requestId: 'request-1',
      scanId: 'scan-1',
      registryId: 'npmjs',
      packageName: 'example',
      packageVersion: '1.0.0',
      expectedIntegrity: EXPECTED_INTEGRITY,
    }, new PackageDeadline(30_000));
    const result = execution.scanResult;

    expect(execution.calculatedIntegrity).toBe(CALCULATED_INTEGRITY);
    expect(execution.osvFeed).toEqual(osvFeedResult());
    expect(execution.calculatedIntegrity).not.toBe(EXPECTED_INTEGRITY);
    expect(execution.calculatedIntegrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    expect(legacyFileVerification).not.toHaveBeenCalled();
    legacyFileVerification.mockRestore();

    expect(result).toMatchObject({
      schemaVersion: '0.1',
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' },
      artifactHash: ARTIFACT_HASH,
      status: 'COMPLETED',
      evidences: [],
      analyzerSummaries: [
        {
          name: 'metadata',
          version: '0.1.0',
          status: 'SUCCESS',
          findingCount: 0,
          errorCount: 0,
        },
        {
          name: 'custom-rule',
          version: '0.1.0',
          status: 'SUCCESS',
          findingCount: 0,
          errorCount: 0,
        },
        {
          name: 'guarddog',
          version: '0.1.0',
          status: 'SUCCESS',
          findingCount: 0,
          errorCount: 0,
        },
        {
          name: 'obfuscation',
          version: '0.1.0',
          status: 'SUCCESS',
          findingCount: 0,
          errorCount: 0,
        },
      ],
      errors: [],
    });
    expect(result.artifactHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result).not.toHaveProperty('calculatedIntegrity');
    expect(execution.performance).toMatchObject({
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'REGISTRY' }),
        expect.objectContaining({ stage: 'DOWNLOAD' }),
        expect.objectContaining({ stage: 'EXTRACT' }),
        expect.objectContaining({ stage: 'HASH' }),
        expect.objectContaining({ stage: 'IDENTITY' }),
        expect.objectContaining({ stage: 'ANALYZER' }),
        expect.objectContaining({ stage: 'OBFUSCATION' }),
        expect.objectContaining({ stage: 'NORMALIZATION' }),
      ]),
      analyzers: expect.arrayContaining([
        expect.objectContaining({ analyzer: 'metadata', status: 'SUCCESS' }),
        expect.objectContaining({ analyzer: 'custom-rule', status: 'SUCCESS' }),
        expect.objectContaining({ analyzer: 'guarddog', status: 'SUCCESS' }),
      ]),
      memory: expect.objectContaining({
        start: expect.objectContaining({ rssBytes: expect.any(Number) }),
        peakObserved: expect.objectContaining({ rssBytes: expect.any(Number) }),
      }),
    });
  });

  it('queries OSV with the verified package identity and current scan budget', async () => {
    const query = jest.fn().mockResolvedValue(osvFeedResult());
    const deadline = new PackageDeadline(30_000);

    try {
      await orchestrator({
        packageIdentityVerifier: {
          verify: jest.fn().mockResolvedValue({
            name: '@scope/actual-package',
            version: '2.3.4',
          }),
        },
        osvFeedClient: { query },
      }).execute({
        ...request(),
        packageName: 'requested-alias',
        packageVersion: 'latest',
      }, deadline);

      expect(query).toHaveBeenCalledWith({
        ecosystem: 'npm',
        packageName: '@scope/actual-package',
        packageVersion: '2.3.4',
        permission: { allowed: true, basis: 'VERIFIED_PUBLIC_NPM' },
        remainingMs: expect.any(Number),
        signal: deadline.signal,
      });
      expect(query.mock.calls[0]?.[0].remainingMs).toBeGreaterThan(0);
      expect(query.mock.calls[0]?.[0].remainingMs).toBeLessThanOrEqual(30_000);
    } finally {
      deadline.dispose();
    }
  });

  it('starts OSV collection in parallel with the existing analyzers', async () => {
    let analyzerStarted!: () => void;
    let osvStarted!: () => void;
    const analyzerStartedPromise = new Promise<void>((resolve) => { analyzerStarted = resolve; });
    const osvStartedPromise = new Promise<void>((resolve) => { osvStarted = resolve; });
    const analyzeResult = jest.fn(async () => {
      analyzerStarted();
      await osvStartedPromise;
      return analyzerResult('metadata');
    });
    const query = jest.fn(async () => {
      osvStarted();
      await analyzerStartedPromise;
      return osvFeedResult();
    });

    const execution = await orchestrator({
      metadataAnalyzer: { analyzeResult },
      osvFeedClient: { query },
    }).execute(request(), new PackageDeadline(30_000));

    expect(analyzeResult).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(execution.scanResult.status).toBe('COMPLETED');
  });

  it('runs obfuscation after Tier 1 and keeps its failure in shadow mode', async () => {
    const analyze = jest.fn().mockRejectedValue(new Error('restore failed'));

    const execution = await orchestrator({
      obfuscationAnalyzer: { analyze },
    }).execute(request(), new PackageDeadline(30_000));

    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({
          extractedPath: join('/tmp', 'scan-1', 'extracted'),
          hash: ARTIFACT_HASH,
        }),
      }),
      expect.arrayContaining([
        expect.objectContaining({ analyzer: 'metadata' }),
        expect.objectContaining({ analyzer: 'custom-rule' }),
        expect.objectContaining({ analyzer: 'guarddog' }),
      ]),
      expect.any(AbortSignal),
    );
    expect(execution.scanResult.status).toBe('COMPLETED');
    expect(execution.scanResult.evidences).toEqual([]);
    expect(execution.scanResult.shadowAnalyses).toEqual([
      expect.objectContaining({
        analyzer: 'obfuscation',
        mode: 'SHADOW',
      }),
      expect.objectContaining({
        analyzer: 'tier3-agent-v0.3',
        analyzerVersion: '0.3.0',
        mode: 'SHADOW',
        data: expect.objectContaining({
          status: 'SKIPPED',
          triggerReason: 'NO_THREAT_FINDING',
        }),
      }),
    ]);
    expect(execution.scanResult.analyzerSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'obfuscation',
        status: 'FAILED',
      }),
    ]));
    expect(execution.policyEligible).toBe(true);
  });

  it.each(['FAILED', 'TIMEOUT', 'SKIPPED'] as const)(
    'keeps OSV %s separate from scan status, evidence, and policy eligibility',
    async (feedStatus) => {
      const execution = await orchestrator({
        osvFeedClient: {
          query: jest.fn().mockResolvedValue(osvFeedResult(feedStatus)),
        },
      }).execute(request(), new PackageDeadline(30_000));

      expect(execution.osvFeed.feedStatus).toBe(feedStatus);
      expect(execution.scanResult.status).toBe('COMPLETED');
      expect(execution.scanResult.evidences).toEqual([]);
      expect(execution.scanResult.analyzerSummaries).toHaveLength(4);
      expect(execution.policyEligible).toBe(true);
    },
  );

  it('forwards whole-scan cancellation to an in-flight OSV query', async () => {
    const query = jest.fn(({ signal }: { signal: AbortSignal }) =>
      new Promise<OsvFeedResult>((resolve) => {
        signal.addEventListener('abort', () => resolve(osvFeedResult('TIMEOUT')), {
          once: true,
        });
      }));
    const deadline = new PackageDeadline(20);

    try {
      const execution = await orchestrator({ osvFeedClient: { query } })
        .execute(request(), deadline);

      expect(query).toHaveBeenCalledWith(expect.objectContaining({
        signal: deadline.signal,
      }));
      expect(deadline.signal.aborted).toBe(true);
      expect(execution.osvFeed).toMatchObject({
        feedStatus: 'TIMEOUT',
        errorCode: 'PARENT_ABORTED',
      });
      expect(execution.scanResult.status).toBe('COMPLETED');
      expect(execution.policyEligible).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it('builds the NormalizationInput from verified AnalysisContext and Analyzer results', async () => {
    const metadataResult = analyzerResult('metadata', [
      finding('metadata.lifecycle.postinstall', {
        scriptName: 'postinstall',
        scriptValue: 'node setup.js',
        observation: 'PRESENT',
      }),
    ]);
    const customRuleResult = analyzerResult('custom-rule');
    const guardDogResult = analyzerResult('guarddog');
    const guardDogAnalyzeResult = jest.fn().mockResolvedValue(guardDogResult);
    const evidenceNormalizer = new EvidenceNormalizer();
    const normalize = jest.spyOn(evidenceNormalizer, 'normalize');

    await orchestrator({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(metadataResult),
      },
      customRuleAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(customRuleResult),
      },
      guardDogAnalyzer: {
        analyzeResult: guardDogAnalyzeResult,
      },
      evidenceNormalizer,
    }).execute(request(), new PackageDeadline(30_000));

    expect(normalize).toHaveBeenCalledTimes(1);
    expect(guardDogAnalyzeResult).toHaveBeenCalledWith({
      context: expect.objectContaining({
        requestId: 'request-1',
        scanId: 'scan-1',
        artifact: expect.objectContaining({
          extractedPath: join('/tmp', 'scan-1', 'extracted'),
        }),
      }),
    }, expect.objectContaining({
      requestId: 'request-1',
      scanId: 'scan-1',
    }), expect.any(Object));
    expect(normalize).toHaveBeenCalledWith({
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: {
        ecosystem: 'npm',
        packageName: 'example',
        packageVersion: '1.0.0',
        artifactHash: ARTIFACT_HASH,
      },   
      artifactRoot: join('/tmp', 'scan-1', 'extracted'),
      analyzerResults: [
        expect.objectContaining({ ...metadataResult, execution: expect.objectContaining({
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          durationMs: expect.any(Number),
        }) }),
        expect.objectContaining({ ...customRuleResult, execution: expect.objectContaining({
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          durationMs: expect.any(Number),
        }) }),
        expect.objectContaining({ ...guardDogResult, execution: expect.objectContaining({
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          durationMs: expect.any(Number),
        }) }),
      ],
    });
  });

  it('builds the inactive Agent Planning input once after successful normalization', async () => {
    process.env.LLM_AGENT_ENABLED = 'false';
    process.env.LLM_AGENT_TRIGGER_MODE = 'DISABLED';
    const buildPlanningInput = jest.spyOn(agentPlanningAdapter, 'buildAgentPlanningInput');
    const evidenceNormalizer = new EvidenceNormalizer();
    const normalize = jest.spyOn(evidenceNormalizer, 'normalize');
    const obfuscationResult = {
      analyzerResult: analyzerResult('obfuscation'),
      derivedAnalyzerResults: [],
      evidenceCandidates: [],
      planningInput: {
        kind: 'TIER2_RESTORE_PROJECTION' as const,
        requestId: 'request-1', scanId: 'scan-1', artifactHash: ARTIFACT_HASH,
        restoreFiles: [], evidenceCandidates: [],
      },
      summary: {
        gptMode: 'off' as const, scannedFiles: 0, selectedFiles: 0,
        restoredFiles: 0, partialRestoredFiles: 0, unresolvedFiles: 0,
        newRuleIds: [], derivedAnalyzerStatuses: [], evidenceBundles: [],
        gpt: { status: 'NOT_REQUESTED' as const, durationMs: 0 },
      },
    };
    const analyzeObfuscation = jest.fn().mockResolvedValue(obfuscationResult);

    await orchestrator({
      evidenceNormalizer,
      obfuscationAnalyzer: { analyze: analyzeObfuscation },
    }).execute(request(), new PackageDeadline(30_000));

    expect(normalize).toHaveBeenCalledTimes(1);
    expect(buildPlanningInput).toHaveBeenCalledTimes(1);
    expect(normalize.mock.invocationCallOrder[0]).toBeLessThan(
      buildPlanningInput.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(buildPlanningInput).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ requestId: 'request-1', scanId: 'scan-1' }),
      tier1Results: expect.arrayContaining([
        expect.objectContaining({ analyzer: 'metadata' }),
        expect.objectContaining({ analyzer: 'custom-rule' }),
        expect.objectContaining({ analyzer: 'guarddog' }),
      ]),
      tier2Result: obfuscationResult,
      normalizationResult: expect.objectContaining({
        atomicEvidences: expect.any(Array),
        unmappedFindings: expect.any(Array),
        errors: expect.any(Array),
        summary: expect.any(Object),
      }),
    }));
    expect(analyzeObfuscation).toHaveBeenCalledTimes(1);
    expect(buildPlanningInput.mock.results[0]?.value.tier2.selection).toEqual({
      scannedFiles: 0,
      selectedFiles: 0,
    });
    buildPlanningInput.mockRestore();
  });

  it('builds Agent Planning input for the Tier 2 safe fallback without selection', async () => {
    process.env.LLM_AGENT_ENABLED = 'false';
    process.env.LLM_AGENT_TRIGGER_MODE = 'DISABLED';
    const buildPlanningInput = jest.spyOn(agentPlanningAdapter, 'buildAgentPlanningInput');
    const analyzeObfuscation = jest.fn().mockRejectedValue(new Error('tier2 failed'));

    const execution = await orchestrator({
      obfuscationAnalyzer: { analyze: analyzeObfuscation },
    }).execute(request(), new PackageDeadline(30_000));

    expect(buildPlanningInput).toHaveBeenCalledTimes(1);
    expect(buildPlanningInput.mock.results[0]?.value.tier2).toMatchObject({
      analyzer: { analyzer: 'obfuscation', status: 'FAILED' },
      derivedAnalyzers: [],
    });
    expect(buildPlanningInput.mock.results[0]?.value.tier2).not.toHaveProperty('restore');
    expect(buildPlanningInput.mock.results[0]?.value.tier2).not.toHaveProperty('selection');
    expect(execution.staticFilterResult).toMatchObject({ status: 'NO_ESCALATION_SIGNAL' });
    expect(analyzeObfuscation).toHaveBeenCalledTimes(1);
    buildPlanningInput.mockRestore();
  });

  it('evaluates the static filter once after Planning input creation without changing execution', async () => {
    process.env.LLM_AGENT_ENABLED = 'false';
    process.env.LLM_AGENT_TRIGGER_MODE = 'DISABLED';
    const buildPlanningInput = jest.spyOn(agentPlanningAdapter, 'buildAgentPlanningInput');
    const evaluate = jest.spyOn(staticFilter, 'evaluateStaticFilter');
    const evidenceNormalizer = new EvidenceNormalizer();
    const normalize = jest.spyOn(evidenceNormalizer, 'normalize');
    const analyzeObfuscation = jest.fn().mockResolvedValue({
      analyzerResult: analyzerResult('obfuscation'),
      derivedAnalyzerResults: [],
      evidenceCandidates: [],
      planningInput: {
        kind: 'TIER2_RESTORE_PROJECTION', requestId: 'request-1', scanId: 'scan-1',
        artifactHash: ARTIFACT_HASH, restoreFiles: [], evidenceCandidates: [],
      },
      restore: { outputRoot: '/tmp/derived', restored: [], unresolved: [], durationMs: 0, budgetExceeded: false },
      summary: {
        gptMode: 'off', scannedFiles: 0, selectedFiles: 0, restoredFiles: 0,
        partialRestoredFiles: 0, unresolvedFiles: 0, newRuleIds: [],
        derivedAnalyzerStatuses: [], evidenceBundles: [],
        gpt: { status: 'NOT_REQUESTED', durationMs: 0 },
      },
    });

    const execution = await orchestrator({
      evidenceNormalizer,
      obfuscationAnalyzer: { analyze: analyzeObfuscation },
    }).execute(request(), new PackageDeadline(30_000));

    expect(normalize).toHaveBeenCalledTimes(1);
    expect(buildPlanningInput).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(normalize.mock.invocationCallOrder[0]).toBeLessThan(evaluate.mock.invocationCallOrder[0] ?? 0);
    expect(buildPlanningInput.mock.invocationCallOrder[0]).toBeLessThan(evaluate.mock.invocationCallOrder[0] ?? 0);
    expect(evaluate).toHaveBeenCalledWith(buildPlanningInput.mock.results[0]?.value);
    expect(analyzeObfuscation).toHaveBeenCalledTimes(1);
    expect(execution.staticFilterResult).toMatchObject({ status: 'NO_ESCALATION_SIGNAL' });
    expect(execution.scanResult.status).toBe('COMPLETED');
    evaluate.mockRestore();
    buildPlanningInput.mockRestore();
  });

  it('normalizes a Metadata postinstall Finding into ScanResult Evidence', async () => {
    const metadataResult = analyzerResult('metadata', [
      finding(
        'metadata.lifecycle.postinstall',
        {
          scriptName: 'postinstall',
          scriptValue: 'node setup.js',
          observation: 'PRESENT',
        },
        { type: 'METADATA', jsonPointer: '/scripts/postinstall' },
      ),
    ]);

    const result = await executeScan({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(metadataResult),
      },
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.evidences).toEqual([
      expect.objectContaining({
        kind: 'ATOMIC',
        signal: expect.objectContaining({
          id: 'capability.lifecycle.postinstall',
          type: 'POSTINSTALL_SCRIPT',
        }),
        subject: {
          ecosystem: 'npm',
          packageName: 'example',
          packageVersion: '1.0.0',
          artifactHash: ARTIFACT_HASH,
        },
        sources: [
          expect.objectContaining({
            analyzer: 'metadata',
            analyzerVersion: '0.1.0',
            rawFindingId: 'metadata.lifecycle.postinstall:finding',
          }),
        ],
      }),
    ]);
  });

  it('normalizes Metadata consistency Findings without producing a partial ScanResult', async () => {
    const packageJson = {
      name: 'example',
      version: '1.0.0',
      license: 'MIT',
      repository: { type: 'git', url: 'https://github.com/tarball/example.git' },
    };
    const registryMetadata = {
      name: 'example',
      version: '1.0.0',
      license: 'Apache-2.0',
      repository: 'git+https://github.com/registry/example',
    };

    const result = await executeScan({
      registryMetadataClient: {
        query: jest.fn().mockResolvedValue({
          registryId: 'npmjs',
          metadataUrl: 'https://registry.npmjs.org/example/1.0.0',
          tarballUrl: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
          registryMetadata,
        }),
      },
      packageIdentityVerifier: {
        verify: jest.fn().mockResolvedValue(packageJson),
      },
      metadataAnalyzer: new MetadataAnalyzer(),
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.errors).toEqual([]);
    expect(result.evidences.map(({ signal }) => signal.id)).toEqual([
      'consistency.metadata.license-mismatch',
      'consistency.metadata.repository-mismatch',
    ]);
    expect(result.evidences.map(({ signal }) => signal.type)).toEqual([
      'METADATA_MISMATCH',
      'METADATA_MISMATCH',
    ]);
    expect(result.evidences.map(({ assertion }) => assertion.summary)).toEqual([
      expect.stringContaining('Registry version manifest license'),
      expect.stringContaining('Registry version manifest repository'),
    ]);
  });

  it('normalizes GuardDog Capability and Threat Findings into ScanResult Evidence', async () => {
    const parsed = parseGuardDogOutput(readFileSync(join(
      __dirname,
      'fixtures/guarddog/guarddog-3.1.0-detected.json',
    ), 'utf8'));
    const guardDogResult = analyzerResult('guarddog', parsed.findings.filter(
      ({ ruleId }) => ruleId === 'capability-network-outbound'
        || ruleId === 'threat-runtime-environment-read',
    ));

    const result = await executeScan({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(analyzerResult('metadata', [
          finding('metadata.lifecycle.postinstall'),
        ])),
      },
      guardDogAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(guardDogResult),
      },
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.evidences.map(({ signal }) => signal.type)).toEqual([
      'POSTINSTALL_SCRIPT',
      'NETWORK_EGRESS',
      'ENV_READ',
    ]);
    expect(result.evidences.map(({ sources }) => sources[0]?.rawFindingId)).toEqual([
      'metadata.lifecycle.postinstall:finding',
      'guarddog:capability-network-outbound:0',
      'guarddog:threat-runtime-environment-read:0',
    ]);
    expect(result.analyzerSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'guarddog',
        status: 'SUCCESS',
        findingCount: 2,
      }),
    ]));
  });

  it('treats an UNKNOWN GuardDog Finding as unmapped and PARTIAL', async () => {
    const result = await executeScan({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(analyzerResult('metadata', [
          finding('metadata.lifecycle.postinstall'),
        ])),
      },
      guardDogAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog', [
          guardDogFinding('unknown-guarddog-rule', 'UNKNOWN'),
        ])),
      },
    });

    expect(result.status).toBe('PARTIAL');
    expect(result.evidences).toHaveLength(1);
    expect(result.evidences[0]?.signal.type).toBe('POSTINSTALL_SCRIPT');
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'NORMALIZATION:UNMAPPED_FINDINGS' }),
    ]));
  });

  it.each([
    ['PARTIAL', 'PARTIAL'],
    ['FAILED', 'FAILED'],
    ['TIMEOUT', 'TIMEOUT'],
  ] as const)(
    'combines GuardDog %s into ScanResult %s without dropping other Analyzer results',
    async (guardDogStatus, expectedStatus) => {
      const guardDogResult = {
        ...analyzerResult('guarddog'),
        status: guardDogStatus,
      } as AnalyzerResult;
      const result = await executeScan({
        metadataAnalyzer: {
          analyzeResult: jest.fn().mockReturnValue(analyzerResult('metadata', [
            finding('metadata.lifecycle.postinstall'),
          ])),
        },
        guardDogAnalyzer: {
          analyzeResult: jest.fn().mockResolvedValue(guardDogResult),
        },
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.analyzerSummaries).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'metadata', status: 'SUCCESS' }),
        expect.objectContaining({ name: 'custom-rule', status: 'SUCCESS' }),
        expect.objectContaining({ name: 'guarddog', status: guardDogStatus }),
      ]));
    },
  );

  it('applies TIMEOUT over FAILED when Analyzer states differ', async () => {
    const failedCustomRule = {
      ...analyzerResult('custom-rule'),
      status: 'FAILED',
    } as AnalyzerResult;
    const timedOutGuardDog = {
      ...analyzerResult('guarddog'),
      status: 'TIMEOUT',
    } as AnalyzerResult;

    const result = await executeScan({
      customRuleAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(failedCustomRule),
      },
      guardDogAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(timedOutGuardDog),
      },
    });

    expect(result.status).toBe('TIMEOUT');
  });

  it('deduplicates GuardDog Findings but preserves the same Signal from another Analyzer', async () => {
    const first = guardDogFinding(
      'capability-process-spawn',
      'CAPABILITY',
      0,
      { match: 'spawn(', code: 'spawn(command)' },
      { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 2 },
    );
    const duplicate = {
      ...first,
      findingId: 'guarddog:capability-process-spawn:1',
    };
    const customRuleResult = analyzerResult('custom-rule', [
      finding('custom.lifecycle-process-coexistence', {
        interpretation: 'CO_OCCURRENCE_ONLY',
        signalRuleIds: ['custom.signal.process-access'],
        doesNotProve: 'Actual process execution',
      }),
    ]);

    const result = await executeScan({
      customRuleAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(customRuleResult),
      },
      guardDogAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(
          analyzerResult('guarddog', [first, duplicate]),
        ),
      },
    });

    const processEvidence = result.evidences.filter(
      ({ signal }) => signal.id === 'capability.process.spawn',
    );
    expect(processEvidence).toHaveLength(2);
    expect(processEvidence.map(({ sources }) => sources[0]?.analyzer)).toEqual([
      'custom-rule',
      'guarddog',
    ]);
    expect(processEvidence[1]?.sources.map(({ rawFindingId }) => rawFindingId)).toEqual([
      'guarddog:capability-process-spawn:0',
      'guarddog:capability-process-spawn:1',
    ]);
  });

  it('normalizes a Custom sensitive-file Finding into ScanResult Evidence', async () => {
    const customRuleResult = analyzerResult('custom-rule', [
      finding(
        'custom.sensitive-file-access',
        {
          interpretation: 'STATIC_PATTERN',
          signalRuleIds: ['custom.signal.sensitive-file-access'],
          doesNotProve: 'Sensitive data was read',
        },
        { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 1 },
      ),
    ]);

    const result = await executeScan({
      customRuleAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(customRuleResult),
      },
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.evidences).toEqual([
      expect.objectContaining({
        signal: expect.objectContaining({
          id: 'capability.filesystem.sensitive-read',
          type: 'SENSITIVE_FILE_READ',
        }),
        assertion: expect.objectContaining({ basis: 'PATTERN_MATCH' }),
        limitations: [expect.stringContaining('does not prove')],
      }),
    ]);
  });

  it('normalizes an env-network Finding into two ScanResult Evidence items', async () => {
    const customRuleResult = analyzerResult('custom-rule', [
      finding('custom.env-network-coexistence', {
        interpretation: 'CO_OCCURRENCE_ONLY',
        signalRuleIds: [
          'custom.signal.environment-access',
          'custom.signal.network-access',
        ],
        doesNotProve: 'Environment-to-network data flow',
      }),
    ]);

    const result = await executeScan({
      customRuleAnalyzer: {
        analyzeResult: jest.fn().mockResolvedValue(customRuleResult),
      },
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.evidences.map(({ signal }) => signal.id)).toEqual([
      'capability.environment.read',
      'capability.network.outbound',
    ]);
  });

  it('keeps mapped Evidence and returns PARTIAL for some UNMAPPED Findings', async () => {
    const metadataResult = analyzerResult('metadata', [
      finding('metadata.lifecycle.postinstall'),
      finding('metadata.lifecycle.unknown'),
    ]);

    const result = await executeScan({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(metadataResult),
      },
    });

    expect(result.status).toBe('PARTIAL');
    expect(result.evidences).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        stage: 'NORMALIZATION:UNMAPPED_FINDINGS',
        message: expect.stringContaining('1 Finding'),
        retryable: false,
      }),
    ]);
  });

  it('distinguishes all UNMAPPED Findings from a normal empty result', async () => {
    const metadataResult = analyzerResult('metadata', [
      finding('metadata.lifecycle.unknown-one'),
      finding('metadata.lifecycle.unknown-two'),
    ]);

    const result = await executeScan({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(metadataResult),
      },
    });

    expect(result.status).toBe('PARTIAL');
    expect(result.evidences).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        stage: 'NORMALIZATION:UNMAPPED_FINDINGS',
        message: expect.stringContaining('2 Finding'),
      }),
    ]);
  });

  it('keeps valid Evidence and returns PARTIAL when another Finding is INVALID', async () => {
    const metadataResult = analyzerResult('metadata', [
      { ruleId: '' } as never,
      finding('metadata.lifecycle.postinstall'),
    ]);

    const result = await executeScan({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(metadataResult),
      },
    });

    expect(result.status).toBe('PARTIAL');
    expect(result.evidences).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        stage: 'NORMALIZATION:INVALID_FINDING',
      }),
    ]);
  });

  it('preserves Artifact and Analyzer information when the Normalizer throws', async () => {
    const metadataResult = analyzerResult('metadata', [
      finding('metadata.lifecycle.postinstall'),
    ]);
    const normalize = jest.fn(() => {
      throw new Error('normalizer unavailable');
    });

    const result = await executeScan({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(metadataResult),
      },
      evidenceNormalizer: { normalize },
    });

    expect(result).toMatchObject({
      status: 'FAILED',
      artifactHash: ARTIFACT_HASH,
      evidences: [],
      analyzerSummaries: [
        {
          name: 'metadata',
          version: '0.1.0',
          status: 'SUCCESS',
          findingCount: 1,
        },
        {
          name: 'custom-rule',
          version: '0.1.0',
          status: 'SUCCESS',
        },
        {
          name: 'guarddog',
          version: '0.1.0',
          status: 'SUCCESS',
        },
        {
          name: 'obfuscation',
          version: '0.1.0',
          status: 'SUCCESS',
        },
      ],
      errors: [
        {
          code: 'INTERNAL_ERROR',
          stage: 'NORMALIZATION',
          message: 'normalizer unavailable',
          retryable: false,
        },
      ],
    });
  });

  it('converts Registry failures to a failed ScanResult', async () => {
    const query = jest.fn().mockRejectedValue(Object.assign(
      new Error('registry unavailable'),
      { code: 'METADATA_FETCH_FAILED', retryable: true },
    ));
    const result = await executeScan(
      { registryMetadataClient: { query } },
      request(),
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      artifactHash: '',
      errors: [{
        code: 'METADATA_FETCH_FAILED',
        stage: 'REGISTRY',
        retryable: true,
      }],
    });
  });

  it.each([
    ['download', 'tarballDownloader', 'download', 'DOWNLOAD_FAILED', 'DOWNLOAD'],
    ['integrity', 'tarballDownloader', 'download', 'INTEGRITY_MISMATCH', 'INTEGRITY'],
    ['extract', 'safeExtractor', 'extract', 'EXTRACT_FAILED', 'EXTRACT'],
    ['identity', 'packageIdentityVerifier', 'verify', 'IDENTITY_MISMATCH', 'IDENTITY'],
  ] as const)(
    'converts %s artifact failure to a failed ScanResult',
    async (_name, dependency, method, code, stage) => {
      const error = new ArtifactProcessingError(code, stage, `${stage} failed`);
      const failure = { [method]: jest.fn().mockRejectedValue(error) };
      const result = await executeScan({ [dependency]: failure });

      expect(result).toMatchObject({
        status: 'FAILED',
        artifactHash: '',
        errors: [{
          code,
          stage,
          message: `${stage} failed`,
          retryable: false,
        }],
      });
    },
  );

  it.each([
    ['SUCCESS', 'COMPLETED'],
    ['PARTIAL', 'PARTIAL'],
    ['FAILED', 'FAILED'],
    ['TIMEOUT', 'TIMEOUT'],
  ] as const)(
    'maps analyzer status %s to ScanResult status %s',
    async (analyzerStatus, scanStatus) => {
      const customRuleResult = {
        ...analyzerResult('custom-rule'),
        status: analyzerStatus,
      } as AnalyzerResult;
      const result = await executeScan({
        customRuleAnalyzer: {
          analyzeResult: jest.fn().mockResolvedValue(customRuleResult),
        },
      });

      expect(result.status).toBe(scanStatus);
      expect(result.analyzerSummaries).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'custom-rule', status: analyzerStatus }),
      ]));
    },
  );

  it('isolates an analyzer throw and preserves other Analyzer results', async () => {
    const result = await executeScan({
      customRuleAnalyzer: {
        analyzeResult: jest.fn().mockRejectedValue(new Error('analyzer crashed')),
      },
    });

    expect(result).toMatchObject({
      status: 'FAILED',
      artifactHash: ARTIFACT_HASH,
      analyzerSummaries: expect.arrayContaining([
        expect.objectContaining({ name: 'metadata', status: 'SUCCESS' }),
        expect.objectContaining({ name: 'custom-rule', status: 'FAILED' }),
        expect.objectContaining({ name: 'guarddog', status: 'SUCCESS' }),
      ]),
      errors: [{
        code: 'INTERNAL_ERROR',
        stage: 'ANALYZER:CUSTOM-RULE',
        analyzer: 'custom-rule',
        message: 'custom-rule Analyzer failed unexpectedly',
        retryable: false,
      }],
    });
  });

  it('keeps GuardDog Evidence and scanId isolated between Package executions', async () => {
    const analyzeResult = jest.fn(
      ({ context }: { context: AnalysisContext }) => Promise.resolve({
        ...analyzerResult('guarddog', [
          guardDogFinding('capability-network-outbound', 'CAPABILITY'),
        ]),
        requestId: context.requestId,
        scanId: context.scanId,
      }),
    );
    const runner = orchestrator({
      metadataAnalyzer: {
        analyzeResult: jest.fn().mockReturnValue(analyzerResult('metadata', [
          finding('metadata.lifecycle.postinstall'),
        ])),
      },
      guardDogAnalyzer: { analyzeResult },
    });

    const [first, second] = await Promise.all([
      runner.execute(
        { ...request(), scanId: 'scan-a', packageName: 'package-a' },
        new PackageDeadline(30_000),
      ),
      runner.execute(
        { ...request(), scanId: 'scan-b', packageName: 'package-b' },
        new PackageDeadline(30_000),
      ),
    ]);

    expect(first.scanResult.scanId).toBe('scan-a');
    expect(second.scanResult.scanId).toBe('scan-b');
    expect(first.scanResult.evidences[0]?.provenance.scanId).toBe('scan-a');
    expect(second.scanResult.evidences[0]?.provenance.scanId).toBe('scan-b');
    expect(first.scanResult.evidences).not.toBe(second.scanResult.evidences);
    expect(analyzeResult).toHaveBeenCalledTimes(2);
  });

  it('creates and forwards a scanId from ScanService', async () => {
    const execute = jest.fn().mockResolvedValue({
      scanResult: { status: 'COMPLETED' },
      calculatedIntegrity: CALCULATED_INTEGRITY,
      osvFeed: osvFeedResult(),
    });
    const save = jest.fn(() => ({
      schemaVersion: '0.1',
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' as const },
      artifactHash: ARTIFACT_HASH,
      status: 'COMPLETED' as const,
      evidences: [],
      analyzerSummaries: [],
      errors: [],
    }));
    const policyEvaluationClient = {
      evaluate: jest.fn().mockResolvedValue(undefined),
    };
    const artifactFileManager = {
      cleanupByScanId: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ScanService(
      { execute } as unknown as Orchestrator,
      { save } as unknown as ScanHistoryService,
      policyEvaluationClient as unknown as PolicyEvaluationClient,
      artifactFileManager as unknown as ArtifactFileManager,
    );

    const result = await service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
      integrity: null,
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1',
      registryId: 'npmjs',
      packageName: 'example',
      packageVersion: '1.0.0',
      expectedIntegrity: null,
      scanId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }), expect.any(Object));
    expect(save).toHaveBeenCalledWith({ status: 'COMPLETED' });
    expect(policyEvaluationClient.evaluate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'COMPLETED' });
    expect(result).not.toHaveProperty('calculatedIntegrity');
  });

  it.each([
    ['SUCCESS with advisories', osvFeedResult('SUCCESS')],
    ['SUCCESS with no advisories', { ...osvFeedResult('SUCCESS'), advisories: [] }],
    ['FAILED', osvFeedResult('FAILED')],
    ['TIMEOUT', osvFeedResult('TIMEOUT')],
    ['SKIPPED', osvFeedResult('SKIPPED')],
  ])('forwards OSV %s beside existing Evidence in the Policy request', async (_case, osvFeed) => {
    const saved = {
      schemaVersion: '0.1' as const,
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' as const },
      artifactHash: ARTIFACT_HASH,
      status: 'COMPLETED' as const,
      evidences: [{ evidenceId: 'evidence-1' }],
      analyzerSummaries: [],
      errors: [],
    };
    const evaluate = jest.fn().mockResolvedValue(undefined);
    const service = new ScanService(
      { execute: jest.fn().mockResolvedValue({
        scanResult: saved,
        calculatedIntegrity: CALCULATED_INTEGRITY,
        policyEligible: true,
        osvFeed,
      }) } as unknown as Orchestrator,
      { save: jest.fn().mockResolvedValue(saved) } as unknown as ScanHistoryService,
      { evaluate } as unknown as PolicyEvaluationClient,
      { cleanupByScanId: jest.fn().mockResolvedValue(undefined) } as unknown as ArtifactFileManager,
    );

    await service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
      integrity: EXPECTED_INTEGRITY,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({
      requestId: 'request-1',
      scanStatus: 'COMPLETED',
      scanId: 'scan-1',
      subject: {
        ecosystem: 'npm',
        packageName: 'example',
        packageVersion: '1.0.0',
        artifactHash: ARTIFACT_HASH,
        integrity: CALCULATED_INTEGRITY,
      },
      evidences: [{ evidenceId: 'evidence-1' }],
      osvFeed,
    });
    expect(saved.evidences).toEqual([{ evidenceId: 'evidence-1' }]);
    expect(saved.evidences).not.toContain(osvFeed);
  });

  it.each([
    ['calculatedIntegrity missing', {
      scanResult: { artifactHash: ARTIFACT_HASH },
    }],
    ['artifactHash empty', {
      scanResult: { artifactHash: '' },
      calculatedIntegrity: CALCULATED_INTEGRITY,
    }],
  ])('fails without calling Policy when %s', async (_case, execution) => {
    const evaluate = jest.fn();
    const service = new ScanService(
      { execute: jest.fn().mockResolvedValue(execution) } as unknown as Orchestrator,
      { save: jest.fn().mockResolvedValue(execution.scanResult) } as unknown as ScanHistoryService,
      { evaluate } as unknown as PolicyEvaluationClient,
      { cleanupByScanId: jest.fn().mockResolvedValue(undefined) } as unknown as ArtifactFileManager,
    );

    await expect(service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
      integrity: null,
    })).rejects.toMatchObject({
      code: 'POLICY_EVALUATION_FAILED',
      retryable: false,
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps Package scanIds and Evidence isolated across ScanService calls', async () => {
    const execute = jest.fn(async (executionRequest: ScanExecutionRequest) => ({
      scanResult: {
        schemaVersion: '0.1',
        requestId: executionRequest.requestId,
        scanId: executionRequest.scanId,
        subject: {
          name: executionRequest.packageName,
          version: executionRequest.packageVersion,
          ecosystem: 'npm' as const,
        },
        artifactHash: `hash-${executionRequest.packageName}`,
        status: 'COMPLETED' as const,
        evidences: [
          {
            schemaVersion: '0.1' as const,
            evidenceId: `evidence-${executionRequest.scanId}`,
            kind: 'ATOMIC' as const,
            signal: {
              id: 'capability.lifecycle.postinstall',
              type: 'POSTINSTALL_SCRIPT',
              category: 'METADATA',
            },
            subject: {
              ecosystem: 'npm' as const,
              packageName: executionRequest.packageName,
              packageVersion: executionRequest.packageVersion,
              artifactHash: `hash-${executionRequest.packageName}`,
            },
            assertion: {
              summary: 'postinstall present',
              basis: 'METADATA_VALUE' as const,
            },
            sources: [
              {
                analyzer: 'metadata',
                analyzerVersion: '0.1.0',
                ruleId: 'metadata.lifecycle.postinstall',
                rawFindingId: 'finding-1',
              },
            ],
            locations: [],
            provenance: {
              scanId: executionRequest.scanId,
              generatedBy: 'EVIDENCE_NORMALIZER' as const,
              observedAt: '2026-08-25T00:00:00.000Z',
            },
            limitations: [],
          },
        ],
        analyzerSummaries: [],
        errors: [],
      },
      calculatedIntegrity: `sha512-${executionRequest.packageName}`,
      osvFeed: osvFeedResult(),
    }));
    const history = new ScanHistoryService();
    const service = new ScanService(
      { execute } as unknown as Orchestrator,
      history,
      { evaluate: jest.fn().mockResolvedValue(undefined) } as unknown as PolicyEvaluationClient,
      { cleanupByScanId: jest.fn().mockResolvedValue(undefined) } as unknown as ArtifactFileManager,
    );

    const first = await service.scan({
      requestId: 'request-batch',
      packageName: 'first-package',
      version: '1.0.0',
      integrity: null,
    });
    const second = await service.scan({
      requestId: 'request-batch',
      packageName: 'second-package',
      version: '2.0.0',
      integrity: null,
    });

    expect(first.scanId).not.toBe(second.scanId);
    expect(first).toMatchObject({
      evidences: [{ provenance: { scanId: first.scanId } }],
    });
    expect(second).toMatchObject({
      evidences: [{ provenance: { scanId: second.scanId } }],
    });
    expect(history.findByRequestId('request-batch')).toEqual([first, second]);
  });

  it('supports reanalysis through a new request and preserves both history results', async () => {
    const execute = jest.fn(async (executionRequest: ScanExecutionRequest) => ({
      scanResult: {
        schemaVersion: '0.1',
        requestId: executionRequest.requestId,
        scanId: executionRequest.scanId,
        subject: {
          name: executionRequest.packageName,
          version: executionRequest.packageVersion,
          ecosystem: 'npm' as const,
        },
        artifactHash: ARTIFACT_HASH,
        status: 'COMPLETED' as const,
        evidences: [{
          evidenceId: `evidence-${executionRequest.scanId}`,
          provenance: { scanId: executionRequest.scanId },
        }],
        analyzerSummaries: [],
        errors: [],
      },
      calculatedIntegrity: CALCULATED_INTEGRITY,
      osvFeed: osvFeedResult(),
    }));
    const history = new ScanHistoryService();
    const evaluate = jest.fn().mockResolvedValue(undefined);
    const cleanupByScanId = jest.fn().mockResolvedValue(undefined);
    const service = new ScanService(
      { execute } as unknown as Orchestrator,
      history,
      { evaluate } as unknown as PolicyEvaluationClient,
      { cleanupByScanId } as unknown as ArtifactFileManager,
    );
    const packageInput = {
      packageName: 'same-package',
      version: '1.0.0',
      integrity: EXPECTED_INTEGRITY,
    };

    const first = await service.scan({ requestId: 'request-first', ...packageInput });
    const second = await service.scan({ requestId: 'request-second', ...packageInput });

    expect(first.requestId).toBe('request-first');
    expect(second.requestId).toBe('request-second');
    expect(first.scanId).not.toBe(second.scanId);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'request-first',
      packageName: 'same-package',
      packageVersion: '1.0.0',
      expectedIntegrity: EXPECTED_INTEGRITY,
    });
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      requestId: 'request-second',
      packageName: 'same-package',
      packageVersion: '1.0.0',
      expectedIntegrity: EXPECTED_INTEGRITY,
    });
    expect(history.findByScanId(first.scanId)).toBe(first);
    expect(history.findByScanId(second.scanId)).toBe(second);
    expect(history.findByRequestId('request-first')).toEqual([first]);
    expect(history.findByRequestId('request-second')).toEqual([second]);
    expect(first.evidences).not.toBe(second.evidences);
    expect(first.evidences[0]).toMatchObject({ provenance: { scanId: first.scanId } });
    expect(second.evidences[0]).toMatchObject({ provenance: { scanId: second.scanId } });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'request-first',
      scanId: first.scanId,
      subject: { packageName: 'same-package', packageVersion: '1.0.0' },
    });
    expect(evaluate.mock.calls[1]?.[0]).toMatchObject({
      requestId: 'request-second',
      scanId: second.scanId,
      subject: { packageName: 'same-package', packageVersion: '1.0.0' },
    });
    expect(cleanupByScanId).toHaveBeenCalledTimes(2);
    expect(cleanupByScanId).toHaveBeenNthCalledWith(1, first.scanId);
    expect(cleanupByScanId).toHaveBeenNthCalledWith(2, second.scanId);
  });

  it.each(['COMPLETED', 'PARTIAL', 'FAILED', 'TIMEOUT'] as const)(
    'cleans up artifacts after a %s scan result',
    async (status) => {
      const execute = jest.fn().mockResolvedValue({
        scanResult: { status },
        calculatedIntegrity: CALCULATED_INTEGRITY,
        osvFeed: osvFeedResult(),
      });
      const save = jest.fn().mockResolvedValue({
        requestId: 'request-1',
        scanId: 'scan-1',
        subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' as const },
        artifactHash: ARTIFACT_HASH,
        status,
        evidences: [],
      });
      const evaluate = jest.fn().mockResolvedValue(undefined);
      const cleanupByScanId = jest.fn().mockResolvedValue(undefined);
      const service = new ScanService(
        { execute } as unknown as Orchestrator,
        { save } as unknown as ScanHistoryService,
        { evaluate } as unknown as PolicyEvaluationClient,
        { cleanupByScanId } as unknown as ArtifactFileManager,
      );

      await service.scan({
        requestId: 'request-1',
        packageName: 'example',
        version: '1.0.0',
        integrity: null,
      });

      expect(cleanupByScanId).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/u));
    },
  );

  it('cleans up when Orchestrator throws', async () => {
    const originalError = new Error('orchestrator failed');
    const cleanupByScanId = jest.fn().mockResolvedValue(undefined);
    const service = new ScanService(
      { execute: jest.fn().mockRejectedValue(originalError) } as unknown as Orchestrator,
      {} as ScanHistoryService,
      {} as PolicyEvaluationClient,
      { cleanupByScanId } as unknown as ArtifactFileManager,
    );

    await expect(service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
    })).rejects.toBe(originalError);
    expect(cleanupByScanId).toHaveBeenCalledTimes(1);
  });

  it('cleans up when History save throws', async () => {
    const originalError = new Error('history failed');
    const cleanupByScanId = jest.fn().mockResolvedValue(undefined);
    const service = new ScanService(
      { execute: jest.fn().mockResolvedValue({
        scanResult: { status: 'COMPLETED' },
        calculatedIntegrity: CALCULATED_INTEGRITY,
        osvFeed: osvFeedResult(),
      }) } as unknown as Orchestrator,
      { save: jest.fn().mockRejectedValue(originalError) } as unknown as ScanHistoryService,
      {} as PolicyEvaluationClient,
      { cleanupByScanId } as unknown as ArtifactFileManager,
    );

    await expect(service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
    })).rejects.toBe(originalError);
    expect(cleanupByScanId).toHaveBeenCalledTimes(1);
  });

  it('cleans up when Policy Evaluation throws', async () => {
    const originalError = new Error('policy failed');
    const cleanupByScanId = jest.fn().mockResolvedValue(undefined);
    const service = new ScanService(
      { execute: jest.fn().mockResolvedValue({
        scanResult: { status: 'COMPLETED' },
        calculatedIntegrity: CALCULATED_INTEGRITY,
        osvFeed: osvFeedResult(),
      }) } as unknown as Orchestrator,
      { save: jest.fn().mockResolvedValue({
        requestId: 'request-1',
        scanId: 'scan-1',
        subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' as const },
        artifactHash: ARTIFACT_HASH,
        status: 'COMPLETED' as const,
        evidences: [],
      }) } as unknown as ScanHistoryService,
      { evaluate: jest.fn().mockRejectedValue(originalError) } as unknown as PolicyEvaluationClient,
      { cleanupByScanId } as unknown as ArtifactFileManager,
    );

    await expect(service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
    })).rejects.toBe(originalError);
    expect(cleanupByScanId).toHaveBeenCalledTimes(1);
  });

  it('preserves a successful result when cleanup fails', async () => {
    const saved = {
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' as const },
      artifactHash: ARTIFACT_HASH,
      status: 'COMPLETED' as const,
      evidences: [],
    };
    const service = new ScanService(
      { execute: jest.fn().mockResolvedValue({
        scanResult: { status: 'COMPLETED' },
        calculatedIntegrity: CALCULATED_INTEGRITY,
        osvFeed: osvFeedResult(),
      }) } as unknown as Orchestrator,
      { save: jest.fn().mockResolvedValue(saved) } as unknown as ScanHistoryService,
      { evaluate: jest.fn().mockResolvedValue(undefined) } as unknown as PolicyEvaluationClient,
      { cleanupByScanId: jest.fn().mockResolvedValue(new ArtifactStorageError('cleanup failed')) } as unknown as ArtifactFileManager,
    );

    await expect(service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
    })).resolves.toBe(saved);
  });

  it('preserves the original error when cleanup rejects', async () => {
    const originalError = new Error('policy failed');
    const service = new ScanService(
      { execute: jest.fn().mockRejectedValue(originalError) } as unknown as Orchestrator,
      {} as ScanHistoryService,
      {} as PolicyEvaluationClient,
      { cleanupByScanId: jest.fn().mockRejectedValue(new Error('cleanup failed')) } as unknown as ArtifactFileManager,
    );

    await expect(service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
    })).rejects.toBe(originalError);
  });

  it('records a pre-subject package timeout without calling Policy', async () => {
    const deadline = new PackageDeadline(1);
    const query = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        registryId: 'npmjs' as const,
        packageName: 'example',
        packageVersion: '1.0.0',
        tarballUrl: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        registryMetadata: {},
      };
    });

    try {
      const execution = await orchestrator({
        registryMetadataClient: { query },
      }).execute(request(), deadline);

      expect(execution.scanResult.status).toBe('TIMEOUT');
      expect(execution.scanResult.artifactHash).toBe('');
      expect(execution.calculatedIntegrity).toBeUndefined();
      expect(execution.policyEligible).toBe(false);
    } finally {
      deadline.dispose();
    }
  });

  it('keeps a valid subject for an analyzer package timeout', async () => {
    const deadline = new PackageDeadline(30_000);
    const timeoutResult = {
      ...analyzerResult('custom-rule'),
      status: 'TIMEOUT' as const,
    };

    try {
      const execution = await orchestrator({
        customRuleAnalyzer: {
          analyzeResult: jest.fn().mockResolvedValue(timeoutResult),
        },
      }).execute(request(), deadline);

      expect(execution.scanResult.status).toBe('TIMEOUT');
      expect(execution.scanResult.artifactHash).toBe(ARTIFACT_HASH);
      expect(execution.calculatedIntegrity).toBe(CALCULATED_INTEGRITY);
      expect(execution.policyEligible).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it('saves and evaluates a subject-complete TIMEOUT result', async () => {
    const saved = {
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' as const },
      artifactHash: ARTIFACT_HASH,
      status: 'TIMEOUT' as const,
      evidences: [],
    };
    const evaluate = jest.fn().mockResolvedValue(undefined);
    const service = new ScanService(
      { execute: jest.fn().mockResolvedValue({
        scanResult: saved,
        calculatedIntegrity: CALCULATED_INTEGRITY,
        policyEligible: true,
        osvFeed: osvFeedResult(),
      }) } as unknown as Orchestrator,
      { save: jest.fn().mockResolvedValue(saved) } as unknown as ScanHistoryService,
      { evaluate } as unknown as PolicyEvaluationClient,
      { cleanupByScanId: jest.fn().mockResolvedValue(undefined) } as unknown as ArtifactFileManager,
    );

    await expect(service.scan({
      requestId: 'request-1',
      packageName: 'example',
      version: '1.0.0',
    })).resolves.toBe(saved);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      scanStatus: 'TIMEOUT',
      subject: expect.objectContaining({
        artifactHash: ARTIFACT_HASH,
        integrity: CALCULATED_INTEGRITY,
      }),
    }));
  });
});
