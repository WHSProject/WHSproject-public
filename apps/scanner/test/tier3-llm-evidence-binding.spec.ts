import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { loadLlmAgentEnvironment } from '../src/config/scanner-environment';
import { AgentOutputValidatorService } from '../src/llm-agent/agent-output-validator.service';
import { LlmAgentRunnerService, type AgentAnalysisResultV0_3 } from '../src/llm-agent/agent-runner.service';
import type { AgentAnalysisInputV0_3 } from '../src/llm-agent/artifact/agent-analysis-input.contract';
import { AgentInputV0_3Builder, type AgentInputV0_3Policy } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import type { AgentAssessmentV0_3, CompletedAgentOutputV0_3, GetFileRangeRequest } from '../src/llm-agent/artifact/agent-output-v0_3.contract';
import type { ValidatedAgentAnalysisPlan } from '../src/llm-agent/artifact/artifact.contract';
import { LlmAgentToolsService } from '../src/llm-agent/llm-agent-tools.service';
import { agentSummary, LlmEvidenceAdapter } from '../src/llm-agent/llm-evidence.adapter';
import {
  createMockArtifactResolver,
  deobfuscatedOnlyPlan,
  DEOBFUSCATED_ARTIFACT_ID,
  FIXTURE_ROOT,
  MOCK_ARCHIVE_SHA256,
  MOCK_SCAN_ID,
  mockExecutionInput,
  originalAndDeobfuscatedPlan,
  originalOnlyPlan,
  ORIGINAL_ARTIFACT_ID,
  StaticArtifactResolver,
} from './fixtures/tier3-artifacts/mock-artifacts';

const settings = loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '0' });
const inputPolicy: AgentInputV0_3Policy = {
  codeSlices: { maxInitialSlices: 8, maxLinesPerSlice: 80, maxInitialCodeLines: 120, maxTotalCodeLines: 80, maxFileSizeBytes: 65536 },
  maxToolCalls: 3,
  maxAdditionalCodeRequests: 2,
};
const context = { scanId: MOCK_SCAN_ID, packageName: 'tier3-fixture', packageVersion: '1.0.0', archiveSha256: MOCK_ARCHIVE_SHA256 };
const requestId = `agent-analysis:${MOCK_SCAN_ID}:0.3.0`;
const adapter = new LlmEvidenceAdapter();
const TIER1 = { findingId: 'tier1:env-read:1', evidenceId: 'AE-TIER1-001' };
const TIER2 = { findingId: 'tier2:env-read:1', evidenceId: 'AE-TIER2-001' };

type Ref = { sliceId: string; lines: [number, number] };
function assessment(id: string, refs: Ref[], evidence: { findingIds?: string[]; atomicEvidenceIds?: string[] }): AgentAssessmentV0_3 {
  const refList = refs.map((ref, index) => ({ id: `${id}-R${index + 1}`, sliceId: ref.sliceId, lines: ref.lines, role: 'SOURCE' as const }));
  return {
    id, type: 'CORRELATED_BEHAVIOR', signal: 'ENV_READ', category: 'CREDENTIAL', basis: 'PATTERN_MATCH', ...evidence,
    refs: refList, flow: { source: refList[0]!.id }, reachability: { status: 'POSSIBLE' },
    verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.6, reasonCodes: ['ENV_ACCESS'], rationale: 'Reads HOME from the environment.',
    claimScope: 'CODE_BEHAVIOR', limitations: [],
  };
}
const completed = (...assessments: AgentAssessmentV0_3[]): CompletedAgentOutputV0_3 => ({
  requestId, schemaVersion: '0.3.0', status: 'COMPLETED', assessments,
  summary: { verdict: 'SUSPICIOUS', confidence: 0.6, reasonCodes: ['ENV_ACCESS'] }, limitations: [], missingContext: [],
});
const fileRange = (artifactId: string, startLine: number, endLine: number): GetFileRangeRequest => ({
  id: 'REQ-1', type: 'GET_FILE_RANGE', target: { artifactId, filePath: 'install.js', startLine, endLine }, reasonCode: 'NEED_CONTEXT',
});

type Run = { input: AgentAnalysisInputV0_3; result: AgentAnalysisResultV0_3; resolver: StaticArtifactResolver; generate: jest.Mock };

async function run(plan: ValidatedAgentAnalysisPlan, ...outputs: unknown[]): Promise<Run> {
  return runWithResolver(plan, createMockArtifactResolver(), ...outputs);
}

async function runWithResolver(plan: ValidatedAgentAnalysisPlan, resolver: StaticArtifactResolver, ...outputs: unknown[]): Promise<Run> {
  const { input, registry } = await new AgentInputV0_3Builder().build(mockExecutionInput(plan, resolver), context, inputPolicy);
  const generate = jest.fn();
  for (const output of outputs) generate.mockResolvedValueOnce({ text: JSON.stringify(output), model: 'mock-model', usage: {}, durationMs: 1 });
  const result = await new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), new AgentOutputValidatorService(), settings).executeV0_3(input, { resolver, registry });
  return { input, result, resolver, generate };
}

describe('Tier 3 LLM Evidence artifact locations (#352, #390)', () => {
  describe.each([
    ['ORIGINAL_ONLY', originalOnlyPlan, ORIGINAL_ARTIFACT_ID, 'ORIGINAL', 'DIRECT', 'SLICE-001-1', 8, TIER1],
    ['DEOBFUSCATED_ONLY', deobfuscatedOnlyPlan, DEOBFUSCATED_ARTIFACT_ID, 'DEOBFUSCATED', 'UNMAPPED', 'SLICE-001-1', 17, TIER2],
    ['ORIGINAL_AND_DEOBFUSCATED', originalAndDeobfuscatedPlan, DEOBFUSCATED_ARTIFACT_ID, 'DEOBFUSCATED', 'UNMAPPED', 'SLICE-002-1', 17, TIER2],
  ] as const)('fixture %s', (_mode, plan, artifactId, representation, lineageStatus, initialSliceId, line, refs) => {
    it('converts a VERIFIED assessment into LLM_ASSESSMENT with one location per INITIAL and RUNTIME reference', async () => {
      const verified = assessment('A-1', [{ sliceId: initialSliceId, lines: [line, line] }, { sliceId: 'SLICE-R001', lines: [line - 1, line] }], { findingIds: [refs.findingId], atomicEvidenceIds: [refs.evidenceId] });
      const { input, result, resolver } = await run(plan, { requestId, schemaVersion: '0.3.0', status: 'NEEDS_ADDITIONAL_CODE', requests: [fileRange(artifactId, line - 1, line)] }, completed(verified));
      expect(result.validated?.assessments.map((item) => item.status)).toEqual(['VERIFIED']);

      const conversion = adapter.toEvidencesV0_3(input, result, resolver);

      expect(conversion.failures).toEqual([]);
      expect(conversion.evidences).toHaveLength(1);
      const evidence = conversion.evidences[0]!;
      expect(evidence).toMatchObject({
        evidenceId: `llm:${result.analysisId}:A-1`, kind: 'LLM_ASSESSMENT', verificationStatus: 'VERIFIED',
        subject: { ecosystem: 'npm', packageName: 'tier3-fixture', packageVersion: '1.0.0', artifactHash: MOCK_ARCHIVE_SHA256 },
        locations: [{ type: 'SOURCE_FILE', path: 'install.js', startLine: line, endLine: line, role: 'SOURCE', representation, lineageStatus }, { type: 'SOURCE_FILE', path: 'install.js', startLine: line - 1, endLine: line, role: 'SOURCE', representation, lineageStatus }],
        relatedFindingIds: [refs.findingId], relatedAtomicEvidenceIds: [refs.evidenceId],
        provenance: { scanId: MOCK_SCAN_ID, inputSchemaVersion: '0.3.0', outputSchemaVersion: '0.3.0', promptVersion: 'scanner-single-agent-0.3.2' },
      });
      const derivedFrom = representation === 'DEOBFUSCATED' ? { derivedFrom: { path: 'install.js' } } : {};
      expect(evidence.locations).toEqual([
        { type: 'SOURCE_FILE', path: 'install.js', startLine: line, endLine: line, role: 'SOURCE', representation, lineageStatus, ...derivedFrom },
        { type: 'SOURCE_FILE', path: 'install.js', startLine: line - 1, endLine: line, role: 'SOURCE', representation, lineageStatus, ...derivedFrom },
      ]);
      expect(conversion).not.toHaveProperty('bindings');
      expect(JSON.stringify(conversion)).not.toContain(FIXTURE_ROOT);
    });
  });

  it('keeps the same filePath apart by representation in the locations', async () => {
    const both = assessment('A-BOTH', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }, { sliceId: 'SLICE-002-1', lines: [17, 17] }],
      { findingIds: [TIER1.findingId, TIER2.findingId], atomicEvidenceIds: [TIER1.evidenceId, TIER2.evidenceId] });
    const { input, result, resolver } = await run(originalAndDeobfuscatedPlan, completed(both));

    const conversion = adapter.toEvidencesV0_3(input, result, resolver);

    expect(conversion.evidences[0]!.locations.map(({ path, representation, startLine, lineageStatus }) => ({ path, representation, startLine, lineageStatus }))).toEqual([
      { path: 'install.js', representation: 'ORIGINAL', startLine: 8, lineageStatus: 'DIRECT' },
      { path: 'install.js', representation: 'DEOBFUSCATED', startLine: 17, lineageStatus: 'UNMAPPED' },
    ]);
  });

  it('maps Tier 3 citations back to the original source when the artifact carries a mapping', async () => {
    const base = createMockArtifactResolver();
    const mappedResolver = new StaticArtifactResolver(await Promise.all(base.list().map(async (descriptor) => ({
      root: await base.resolveRoot(descriptor.artifactId),
      descriptor: descriptor.artifactId === DEOBFUSCATED_ARTIFACT_ID
        ? {
          ...descriptor,
          lineageStatus: 'MAPPED' as const,
          lineMappings: [{
            version: '0.1.0' as const,
            sourcePath: 'install.js',
            derivedPath: 'install.js',
            status: 'MAPPED' as const,
            entries: [{ derivedLine: 17, sourceLine: 8, confidence: 'EXACT' as const }],
            derivedLineCount: 18,
            mappedLineCount: 1,
            limitations: [],
          }],
        }
        : descriptor,
    }))));
    const verified = assessment('A-MAPPED', [{ sliceId: 'SLICE-001-1', lines: [17, 17] }], { findingIds: [TIER2.findingId] });
    const { input, result, resolver } = await runWithResolver(deobfuscatedOnlyPlan, mappedResolver, completed(verified));
    const conversion = adapter.toEvidencesV0_3(input, result, resolver);

    expect(conversion.evidences[0]?.locations[0]).toMatchObject({
      type: 'SOURCE_FILE',
      path: 'install.js',
      startLine: 17,
      endLine: 17,
      representation: 'DEOBFUSCATED',
      lineageStatus: 'MAPPED',
      derivedFrom: { path: 'install.js', startLine: 8, endLine: 8 },
    });
  });

  it('uses the full line mapping for RUNTIME slice lines outside the trimmed Agent input mapping (#385)', async () => {
    // Every restored line N maps to original line N + 100; the Agent input keeps only the initial slice lines 17-18 (#382).
    const base = createMockArtifactResolver();
    const entries = Array.from({ length: 18 }, (_, index) => ({ derivedLine: index + 1, sourceLine: index + 101, confidence: 'EXACT' as const }));
    const fullResolver = new StaticArtifactResolver(await Promise.all(base.list().map(async (descriptor) => ({
      root: await base.resolveRoot(descriptor.artifactId),
      descriptor: descriptor.artifactId === DEOBFUSCATED_ARTIFACT_ID
        ? { ...descriptor, lineageStatus: 'MAPPED' as const, lineMappings: [{ version: '0.1.0' as const, sourcePath: 'install.js', derivedPath: 'install.js',
          status: 'MAPPED' as const, entries, derivedLineCount: 18, mappedLineCount: 18, limitations: [] }] }
        : descriptor,
    }))));
    const cited = assessment('A-RUNTIME', [{ sliceId: 'SLICE-R001', lines: [12, 12] }], { findingIds: [TIER2.findingId] });
    const { input, result, resolver, generate } = await runWithResolver(deobfuscatedOnlyPlan, fullResolver,
      { requestId, schemaVersion: '0.3.0', status: 'NEEDS_ADDITIONAL_CODE', requests: [fileRange(DEOBFUSCATED_ARTIFACT_ID, 1, 12)] }, completed(cited));
    expect(input.artifactContext.artifacts.find((item) => item.artifactId === DEOBFUSCATED_ARTIFACT_ID)?.lineMappings?.[0]?.entries.map((entry) => entry.derivedLine)).toEqual([17, 18]);
    expect(result.validated?.assessments.map((item) => item.status)).toEqual(['VERIFIED']);

    const conversion = adapter.toEvidencesV0_3(input, result, resolver);

    const mapped = { lineageStatus: 'MAPPED', derivedFrom: { path: 'install.js', startLine: 112, endLine: 112 } };
    expect(conversion.evidences[0]?.locations[0]).toMatchObject({ startLine: 12, representation: 'DEOBFUSCATED', ...mapped });
    // The RUNTIME slice and the tool response the Agent saw carry the same lineage.
    expect(result.slices.find((slice) => slice.sliceId === 'SLICE-R001')).toMatchObject({ lineageStatus: 'MAPPED', derivedFrom: { file: 'install.js', startLine: 101, endLine: 112 } });
    expect(generate.mock.calls[1]?.[0]).toContain('"sliceId":"SLICE-R001","artifactId":"ARTIFACT-DEOBFUSCATED-001","filePath":"install.js","startLine":1,"endLine":12,"lineageStatus":"MAPPED","derivedFrom":{"file":"install.js","startLine":101,"endLine":112}');
  });

  it('emits LLM_ASSESSMENT that the shared Evidence Schema accepts, for original and mapped deobfuscated citations (#396)', async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/evidence-v0.1.schema.json'), 'utf8')) as object);
    const base = createMockArtifactResolver();
    const mappedResolver = new StaticArtifactResolver(await Promise.all(base.list().map(async (descriptor) => ({
      root: await base.resolveRoot(descriptor.artifactId),
      descriptor: descriptor.artifactId === DEOBFUSCATED_ARTIFACT_ID
        ? { ...descriptor, lineageStatus: 'MAPPED' as const, lineMappings: [{ version: '0.1.0' as const, sourcePath: 'install.js', derivedPath: 'install.js',
          status: 'MAPPED' as const, entries: [{ derivedLine: 17, sourceLine: 8, confidence: 'EXACT' as const }], derivedLineCount: 18, mappedLineCount: 1, limitations: [] }] }
        : descriptor,
    }))));
    const both = assessment('A-BOTH', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }, { sliceId: 'SLICE-002-1', lines: [17, 17] }],
      { findingIds: [TIER1.findingId, TIER2.findingId], atomicEvidenceIds: [TIER1.evidenceId, TIER2.evidenceId] });
    const { input, result, resolver } = await runWithResolver(originalAndDeobfuscatedPlan, mappedResolver, completed(both));

    const [evidence] = adapter.toEvidencesV0_3(input, result, resolver).evidences;

    expect(evidence!.locations).toEqual([
      { type: 'SOURCE_FILE', path: 'install.js', startLine: 8, endLine: 8, role: 'SOURCE', representation: 'ORIGINAL', lineageStatus: 'DIRECT' },
      { type: 'SOURCE_FILE', path: 'install.js', startLine: 17, endLine: 17, role: 'SOURCE', representation: 'DEOBFUSCATED', lineageStatus: 'MAPPED', derivedFrom: { path: 'install.js', startLine: 8, endLine: 8 } },
    ]);
    expect(validate(evidence) || validate.errors).toBe(true);
  });

  it('keeps the existing LLM_ASSESSMENT payload fields', async () => {
    const { input, result, resolver } = await run(originalOnlyPlan, completed(assessment('A-1', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] })));
    const [evidence] = adapter.toEvidencesV0_3(input, result, resolver).evidences;
    expect(Object.keys(evidence!).sort()).toEqual([
      'alternatives', 'assertion', 'confidence', 'evidenceId', 'executionContext', 'intentAssessment', 'kind', 'limitations', 'locations', 'provenance',
      'reachability', 'reasonCodes', 'relatedAtomicEvidenceIds', 'relatedFindingIds', 'schemaVersion', 'signal', 'sources', 'subject', 'verificationStatus',
    ]);
    expect(Object.keys(evidence!.locations[0]!).sort()).toEqual(['endLine', 'lineageStatus', 'path', 'representation', 'role', 'startLine', 'type']);
    expect(evidence!.sources).toEqual([{ analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.env-read', rawFindingId: TIER1.findingId }]);
  });

  it('preserves a non-blocking structured limitation in the existing Evidence string field', async () => {
    const runtimeLimited = assessment('A-RUNTIME', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] });
    runtimeLimited.limitations = [{ kind: 'RUNTIME_UNCONFIRMED', detail: 'No process execution was observed' }];
    const { input, result, resolver } = await run(originalOnlyPlan, completed(runtimeLimited));
    expect(result.validated?.assessments[0]?.status).toBe('VERIFIED');
    expect(adapter.toEvidencesV0_3(input, result, resolver).evidences[0]?.limitations).toEqual([
      '[ASSESSMENT][RUNTIME_UNCONFIRMED] No process execution was observed',
    ]);
  });

  it('preserves an unassessed Finding reason as an output limitation without creating or contaminating Evidence', async () => {
    const assessed = assessment('A-ASSESSABLE', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] });
    const output = completed(assessed);
    output.limitations = [{
      kind: 'CODE_MISSING',
      detail: `Finding ${TIER2.findingId} at install.js:17 remains unassessed because the required caller code is unavailable`,
    }];

    const { input, result, resolver } = await run(originalAndDeobfuscatedPlan, output);
    const conversion = adapter.toEvidencesV0_3(input, result, resolver);

    expect(result).toMatchObject({ status: 'COMPLETED' });
    expect(result.limitations).toContain(`[OUTPUT_LIMITATION][CODE_MISSING] Finding ${TIER2.findingId} at install.js:17 remains unassessed because the required caller code is unavailable`);
    expect(result.validated?.assessments).toHaveLength(1);
    expect(conversion.failures).toEqual([]);
    expect(conversion.evidences).toHaveLength(1);
    expect(conversion.evidences[0]).toMatchObject({ relatedFindingIds: [TIER1.findingId], limitations: [] });
    expect(conversion.evidences.some((evidence) => evidence.relatedFindingIds.includes(TIER2.findingId))).toBe(false);
  });

  it('converts an integrity-passed assessment while preserving local and applicable global limitations with their sources', async () => {
    const limited = assessment('A-LIMITED', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] });
    limited.limitations = [{ kind: 'CALLER_UNKNOWN', detail: 'No caller is present in the supplied code' }];
    const output = completed(limited);
    output.missingContext = [
      { kind: 'BINDING_UNKNOWN', detail: 'The constructor binding is not supplied', affectedAssessmentIds: ['A-LIMITED'] },
      { kind: 'OTHER', detail: 'Unscoped package context is incomplete' },
    ];
    const { input, result, resolver } = await run(originalOnlyPlan, output);

    expect(result.validated?.assessments[0]).toMatchObject({
      status: 'VERIFIED',
      evidenceIntegrity: { criteriaVersion: 'EVIDENCE_INTEGRITY_V1', status: 'PASSED' },
    });
    expect(result.limitations).toEqual(expect.arrayContaining([
      '[ASSESSMENT][CALLER_UNKNOWN] No caller is present in the supplied code',
      '[GLOBAL_MISSING_CONTEXT][BINDING_UNKNOWN] The constructor binding is not supplied',
      '[GLOBAL_MISSING_CONTEXT][OTHER] Unscoped package context is incomplete',
    ]));
    expect(adapter.toEvidencesV0_3(input, result, resolver).evidences[0]?.limitations).toEqual([
      '[ASSESSMENT][CALLER_UNKNOWN] No caller is present in the supplied code',
      '[GLOBAL_MISSING_CONTEXT][BINDING_UNKNOWN] The constructor binding is not supplied',
      '[GLOBAL_MISSING_CONTEXT][OTHER] Unscoped package context is incomplete',
    ]);
  });

  it('requires the explicit integrity result on output 0.3.0 instead of trusting the projected VERIFIED label alone', async () => {
    const { input, result, resolver } = await run(originalOnlyPlan, completed(
      assessment('A-1', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] }),
    ));
    const withoutIntegrity = structuredClone(result);
    delete withoutIntegrity.validated?.assessments[0]?.evidenceIntegrity;

    expect(withoutIntegrity.validated?.assessments[0]?.status).toBe('VERIFIED');
    expect(adapter.toEvidencesV0_3(input, withoutIntegrity, resolver).evidences).toEqual([]);
  });

  it('creates no Evidence for assessments that are not VERIFIED, and de-duplicates identical ones', async () => {
    const verified = assessment('A-OK', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] });
    const duplicate = { ...verified, id: 'A-DUP', refs: verified.refs.map((ref) => ({ ...ref, id: ref.id.replace('A-OK', 'A-DUP') })), flow: { source: 'A-DUP-R1' } };
    const rejected = assessment('A-REJECTED', [{ sliceId: 'SLICE-404', lines: [1, 1] }], { findingIds: [TIER1.findingId] });
    const partial = assessment('A-PARTIAL', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], {});
    const { input, result, resolver } = await run(originalOnlyPlan, completed(verified, duplicate, rejected, partial));
    expect(result.validated?.assessments.map((item) => item.status)).toEqual(['VERIFIED', 'VERIFIED', 'REJECTED', 'PARTIALLY_VERIFIED']);

    const conversion = adapter.toEvidencesV0_3(input, result, resolver);

    expect(conversion.evidences.map((evidence) => evidence.provenance.assessmentId)).toEqual(['A-OK']);
  });

  it('isolates a conversion failure to one assessment and reports it in the summary', async () => {
    const original = assessment('A-ORIGINAL', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] });
    const deobfuscated = assessment('A-DEOBFUSCATED', [{ sliceId: 'SLICE-002-1', lines: [17, 17] }], { findingIds: [TIER2.findingId] });
    const { input, result, resolver } = await run(originalAndDeobfuscatedPlan, completed(original, deobfuscated));
    expect(result.status).toBe('COMPLETED');
    const withoutDeobfuscated = { ...input, artifactContext: { ...input.artifactContext, artifacts: input.artifactContext.artifacts.filter((item) => item.artifactId !== DEOBFUSCATED_ARTIFACT_ID) } };

    const conversion = adapter.toEvidencesV0_3(withoutDeobfuscated, result, resolver);

    expect(conversion.evidences.map((evidence) => evidence.provenance.assessmentId)).toEqual(['A-ORIGINAL']);
    expect(conversion.failures).toEqual([{ assessmentId: 'A-DEOBFUSCATED', reason: 'EVIDENCE_CONVERSION_FAILED' }]);
    expect(agentSummary(result, conversion, 'ALWAYS_MODE')).toMatchObject({ status: 'PARTIAL', verifiedAssessmentCount: 2, generatedEvidenceCount: 1, rejectedAssessmentCount: 1 });
  });

  it('converts nothing when the run did not complete', async () => {
    const { input, result, resolver } = await run(originalOnlyPlan, { requestId, schemaVersion: '0.3.0', status: 'NEEDS_ADDITIONAL_CODE', requests: [fileRange(DEOBFUSCATED_ARTIFACT_ID, 1, 2)] });
    expect(result.status).toBe('FAILED');
    expect(adapter.toEvidencesV0_3(input, result, resolver)).toEqual({ evidences: [], failures: [] });
  });
});
