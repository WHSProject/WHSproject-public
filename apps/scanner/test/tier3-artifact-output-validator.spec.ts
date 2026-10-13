import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLlmAgentEnvironment } from '../src/config/scanner-environment';
import { AgentOutputValidatorService } from '../src/llm-agent/agent-output-validator.service';
import { LlmAgentRunnerService } from '../src/llm-agent/agent-runner.service';
import type { AgentAnalysisInputV0_3 } from '../src/llm-agent/artifact/agent-analysis-input.contract';
import { AgentInputV0_3Builder, type AgentInputV0_3Policy } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import type { CompletedAgentOutputV0_2 } from '../src/llm-agent/artifact/agent-output-v0_2.contract';
import type { AgentAssessmentV0_3, CompletedAgentOutputV0_3, StructuredMissingContext } from '../src/llm-agent/artifact/agent-output-v0_3.contract';
import type { ArtifactResolver, ValidatedAgentAnalysisPlan } from '../src/llm-agent/artifact/artifact.contract';
import { ArtifactOutputValidator } from '../src/llm-agent/artifact/artifact-output.validator';
import { InMemoryCodeSliceRegistry, type CodeSliceRegistry } from '../src/llm-agent/artifact/code-slice.registry';
import { RuntimeCodeTool } from '../src/llm-agent/artifact/runtime-code-tool';
import { LlmAgentToolsService } from '../src/llm-agent/llm-agent-tools.service';
import type { AgentAssessment } from '../src/llm-agent/output.contract';
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

const inputPolicy: AgentInputV0_3Policy = {
  codeSlices: { maxInitialSlices: 8, maxLinesPerSlice: 80, maxInitialCodeLines: 120, maxTotalCodeLines: 80, maxFileSizeBytes: 65536 },
  maxToolCalls: 3,
  maxAdditionalCodeRequests: 2,
};
const context = { scanId: MOCK_SCAN_ID, packageName: 'tier3-fixture', packageVersion: '1.0.0', archiveSha256: MOCK_ARCHIVE_SHA256 };
const requestId = `agent-analysis:${MOCK_SCAN_ID}:0.3.0`;
const validator = new ArtifactOutputValidator();
const TIER1 = { findingId: 'tier1:env-read:1', evidenceId: 'AE-TIER1-001' };
const TIER2 = { findingId: 'tier2:env-read:1', evidenceId: 'AE-TIER2-001' };

type Ref = { sliceId: string; lines: [number, number] };
function assessment(id: string, refs: Ref[], evidence: { findingIds?: string[]; atomicEvidenceIds?: string[] }): AgentAssessment {
  const refList = refs.map((ref, index) => ({ id: `${id}-R${index + 1}`, sliceId: ref.sliceId, lines: ref.lines, role: 'SOURCE' as const }));
  return {
    id, type: 'CORRELATED_BEHAVIOR', signal: 'ENV_READ', category: 'CREDENTIAL', basis: 'PATTERN_MATCH', ...evidence,
    refs: refList, flow: { source: refList[0]!.id }, reachability: { status: 'POSSIBLE' },
    verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.6, reasonCodes: ['ENV_ACCESS'],
  };
}
const completed = (...assessments: AgentAssessment[]): CompletedAgentOutputV0_2 => ({
  requestId, schemaVersion: '0.2.0', status: 'COMPLETED', assessments,
  summary: { verdict: 'SUSPICIOUS', confidence: 0.6, reasonCodes: ['ENV_ACCESS'] }, limitations: [], missingContext: [],
});
function structuredAssessment(id: string, kind?: AgentAssessmentV0_3['limitations'][number]['kind']): AgentAssessmentV0_3 {
  return {
    ...assessment(id, [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER1.findingId] }),
    claimScope: 'CODE_BEHAVIOR',
    limitations: kind ? [{ kind, detail: `${kind} detail` }] : [],
  };
}
const structuredCompleted = (
  assessments: AgentAssessmentV0_3[],
  missingContext: StructuredMissingContext[] = [],
): CompletedAgentOutputV0_3 => ({
  requestId, schemaVersion: '0.3.0', status: 'COMPLETED', assessments,
  summary: { verdict: 'SUSPICIOUS', confidence: 0.6, reasonCodes: ['ENV_ACCESS'] },
  limitations: [], missingContext,
});
const tier1 = (refs: Ref[]) => assessment('A-T1', refs, { findingIds: [TIER1.findingId], atomicEvidenceIds: [TIER1.evidenceId] });
const tier2 = (refs: Ref[]) => assessment('A-T2', refs, { findingIds: [TIER2.findingId], atomicEvidenceIds: [TIER2.evidenceId] });

async function prepare(plan: ValidatedAgentAnalysisPlan, resolver: ArtifactResolver = createMockArtifactResolver()) {
  const { input, registry } = await new AgentInputV0_3Builder().build(mockExecutionInput(plan, resolver), context, inputPolicy);
  return { input, registry, resolver };
}

async function addRuntimeSlice(registry: CodeSliceRegistry, resolver: ArtifactResolver, input: AgentAnalysisInputV0_3, artifactId: string, startLine: number, endLine: number) {
  const usage = { calls: 0, additionalCodeRequests: 0, codeLines: 0, requestKeys: new Set<string>() };
  const outcome = await new RuntimeCodeTool().getFileRange(
    { id: 'REQ-1', type: 'GET_FILE_RANGE', target: { artifactId, filePath: 'install.js', startLine, endLine }, reasonCode: 'NEED_CONTEXT' },
    { resolver, registry, analysisMode: input.analysisPlan.analysisMode, policy: input.analysisPolicy, maxLinesPerRequest: 20, maxFileSizeBytes: 65536, usage },
  );
  if ('unavailable' in outcome) throw new Error('expected a served slice');
  return outcome.slice;
}

async function statuses(input: AgentAnalysisInputV0_3, output: CompletedAgentOutputV0_2 | CompletedAgentOutputV0_3, registry: CodeSliceRegistry, resolver: ArtifactResolver) {
  const result = await validator.validate(input, output, { registry, resolver, maxFileSizeBytes: 65536 });
  return Object.fromEntries(result.assessments.map((item) => [item.assessment.id, {
    status: item.status, issues: item.issues, ...(item.evidenceIntegrity === undefined ? {} : { evidenceIntegrity: item.evidenceIntegrity }),
  }]));
}

describe('Tier 3 artifact-aware Output Validator (#348)', () => {
  describe.each([
    ['ORIGINAL_ONLY', originalOnlyPlan, ORIGINAL_ARTIFACT_ID, 'SLICE-001-1', 8, TIER1],
    ['DEOBFUSCATED_ONLY', deobfuscatedOnlyPlan, DEOBFUSCATED_ARTIFACT_ID, 'SLICE-001-1', 17, TIER2],
    ['ORIGINAL_AND_DEOBFUSCATED', originalAndDeobfuscatedPlan, DEOBFUSCATED_ARTIFACT_ID, 'SLICE-002-1', 17, TIER2],
  ] as const)('fixture %s', (_mode, plan, artifactId, initialSliceId, line, refs) => {
    it('re-verifies INITIAL and RUNTIME slices through the registry and the artifact resolver', async () => {
      const { input, registry, resolver } = await prepare(plan);
      const runtime = await addRuntimeSlice(registry, resolver, input, artifactId, line - 1, line);
      const good = assessment('A-OK', [{ sliceId: initialSliceId, lines: [line, line] }, { sliceId: runtime.sliceId, lines: [line - 1, line] }], { findingIds: [refs.findingId], atomicEvidenceIds: [refs.evidenceId] });

      const result = await statuses(input, completed(good), registry, resolver);

      expect(result['A-OK']).toEqual({ status: 'VERIFIED', issues: [] });
    });
  });

  describe('same filePath in ORIGINAL and DEOBFUSCATED', () => {
    it('checks each slice against its own artifact and allows citing both', async () => {
      const { input, registry, resolver } = await prepare(originalAndDeobfuscatedPlan);
      const both = assessment('A-BOTH', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }, { sliceId: 'SLICE-002-1', lines: [17, 17] }],
        { findingIds: [TIER1.findingId, TIER2.findingId], atomicEvidenceIds: [TIER1.evidenceId, TIER2.evidenceId] });

      const result = await statuses(input, completed(tier1([{ sliceId: 'SLICE-001-1', lines: [8, 8] }]), tier2([{ sliceId: 'SLICE-002-1', lines: [17, 17] }]), both), registry, resolver);

      expect(Object.values(result).map((item) => item.status)).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED']);
    });

    it('rejects a Finding or Evidence whose artifact is not among the cited slices (lineage mix-up)', async () => {
      const { input, registry, resolver } = await prepare(originalAndDeobfuscatedPlan);
      const findingMix = assessment('A-FINDING', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER2.findingId] });
      const evidenceMix = assessment('A-EVIDENCE', [{ sliceId: 'SLICE-002-1', lines: [17, 17] }], { atomicEvidenceIds: [TIER1.evidenceId] });

      const result = await statuses(input, completed(findingMix, evidenceMix, tier1([{ sliceId: 'SLICE-001-1', lines: [8, 8] }])), registry, resolver);

      expect(result['A-FINDING']).toEqual({ status: 'REJECTED', issues: ['Finding artifact lineage mismatch'] });
      expect(result['A-EVIDENCE']).toEqual({ status: 'REJECTED', issues: ['Atomic Evidence artifact lineage mismatch'] });
      expect(result['A-T1']!.status).toBe('VERIFIED');
    });

    it('skips the lineage check for a Finding or Evidence without an artifact binding', async () => {
      const { input, registry, resolver } = await prepare(originalAndDeobfuscatedPlan);
      const unbound = structuredClone(input);
      unbound.artifactContext.findingLocations = [];
      unbound.artifactContext.evidenceLocations = [];
      const result = await statuses(unbound, completed(assessment('A-UNBOUND', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: [TIER2.findingId] })), registry, resolver);
      expect(result['A-UNBOUND']).toEqual({ status: 'VERIFIED', issues: [] });
    });
  });

  describe('rejects only the failing assessment', () => {
    const ok = tier1([{ sliceId: 'SLICE-001-1', lines: [8, 8] }]);
    const bad = (refs: Ref[]) => assessment('A-BAD', refs, { findingIds: [TIER1.findingId] });

    async function expectRejected(issue: string, output: CompletedAgentOutputV0_2, prepared: { input: AgentAnalysisInputV0_3; registry: CodeSliceRegistry; resolver: ArtifactResolver }) {
      const result = await statuses(prepared.input, output, prepared.registry, prepared.resolver);
      expect(result['A-BAD']!.status).toBe('REJECTED');
      expect(result['A-BAD']!.issues).toContain(issue);
      expect(result['A-T1']).toEqual({ status: 'VERIFIED', issues: [] });
      expect(JSON.stringify(result)).not.toContain(FIXTURE_ROOT);
    }

    it('an unknown slice and a reference outside the slice', async () => {
      const prepared = await prepare(originalOnlyPlan);
      await expectRejected('Unknown slice', completed(ok, bad([{ sliceId: 'SLICE-R009', lines: [1, 1] }])), prepared);
      const runtime = await addRuntimeSlice(prepared.registry, prepared.resolver, prepared.input, ORIGINAL_ARTIFACT_ID, 2, 4);
      await expectRejected('Reference outside slice', completed(ok, bad([{ sliceId: runtime.sliceId, lines: [5, 5] }])), prepared);
    });

    it('a slice whose content no longer matches its hash', async () => {
      const prepared = await prepare(originalOnlyPlan);
      const tampered = new InMemoryCodeSliceRegistry();
      for (const slice of prepared.registry.list()) tampered.register(slice);
      const runtime = await addRuntimeSlice(prepared.registry, prepared.resolver, prepared.input, ORIGINAL_ARTIFACT_ID, 2, 4);
      tampered.register({ ...runtime, content: `${runtime.content} ` });
      await expectRejected('Slice hash mismatch', completed(ok, bad([{ sliceId: runtime.sliceId, lines: [2, 2] }])), { ...prepared, registry: tampered });
    });

    it('an artifact the resolver no longer knows and a file that cannot be read', async () => {
      const prepared = await prepare(originalAndDeobfuscatedPlan);
      const base = prepared.resolver;
      const withoutDeobfuscated: ArtifactResolver = {
        describe: (id) => (id === DEOBFUSCATED_ARTIFACT_ID ? undefined : base.describe(id)), list: () => base.list(), resolveRoot: (id, signal) => base.resolveRoot(id, signal),
      };
      await expectRejected('Unknown artifact', completed(ok, bad([{ sliceId: 'SLICE-002-1', lines: [17, 17] }])), { ...prepared, resolver: withoutDeobfuscated });

      const missingRoot = new StaticArtifactResolver(base.list().map((descriptor) => ({ descriptor, root: join(FIXTURE_ROOT, descriptor.artifactId === DEOBFUSCATED_ARTIFACT_ID ? 'missing' : 'original') })));
      await expectRejected('Source file unavailable or unsafe', completed(ok, bad([{ sliceId: 'SLICE-002-1', lines: [17, 17] }])), { ...prepared, resolver: missingRoot });
    });

    it('a planning target that is missing or does not match the INITIAL slice, but not for RUNTIME slices', async () => {
      const prepared = await prepare(originalAndDeobfuscatedPlan);
      const moved = structuredClone(prepared.input);
      moved.analysisPlan.targets[1]!.filePath = 'lib/util.js';
      await expectRejected('Planning target and slice mismatch', completed(ok, bad([{ sliceId: 'SLICE-002-1', lines: [17, 17] }])), { ...prepared, input: moved });

      const dropped = structuredClone(prepared.input);
      dropped.analysisPlan.targets.splice(1, 1);
      await expectRejected('Unknown planning target', completed(ok, bad([{ sliceId: 'SLICE-002-1', lines: [17, 17] }])), { ...prepared, input: dropped });

      const runtime = await addRuntimeSlice(prepared.registry, prepared.resolver, prepared.input, ORIGINAL_ARTIFACT_ID, 7, 8);
      const runtimeOnly = assessment('A-RUNTIME', [{ sliceId: runtime.sliceId, lines: [8, 8] }], { findingIds: [TIER1.findingId] });
      const result = await statuses(dropped, completed(ok, runtimeOnly), prepared.registry, prepared.resolver);
      expect(Object.values(result).map((item) => item.status)).toEqual(['VERIFIED', 'VERIFIED']);
    });

    it('unknown Finding and Atomic Evidence IDs', async () => {
      const prepared = await prepare(originalOnlyPlan);
      await expectRejected('Unknown Finding ID', completed(ok, assessment('A-BAD', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { findingIds: ['tier9:none'] })), prepared);
      await expectRejected('Unknown Atomic Evidence ID', completed(ok, assessment('A-BAD', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], { atomicEvidenceIds: ['AE-NONE'] })), prepared);
    });

    describe('a source file changed after slicing', () => {
      let root: string;
      beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tier3-validator-')); });
      afterEach(async () => { await rm(root, { recursive: true, force: true }); });

      it('is detected by re-reading the artifact', async () => {
        await cp(join(FIXTURE_ROOT, 'original'), join(root, 'original'), { recursive: true });
        await cp(join(FIXTURE_ROOT, 'deobfuscated'), join(root, 'deobfuscated'), { recursive: true });
        const resolver = new StaticArtifactResolver(createMockArtifactResolver().list().map((descriptor) => ({
          descriptor, root: join(root, descriptor.artifactId === ORIGINAL_ARTIFACT_ID ? 'original' : 'deobfuscated'),
        })));
        const prepared = await prepare(originalAndDeobfuscatedPlan, resolver);
        const original = await readFile(join(root, 'deobfuscated', 'install.js'), 'utf8');
        await writeFile(join(root, 'deobfuscated', 'install.js'), original.replace('process.env.HOME', 'process.env.USER'));

        const result = await statuses(prepared.input, completed(ok, bad([{ sliceId: 'SLICE-002-1', lines: [17, 17] }])), prepared.registry, resolver);

        expect(result['A-BAD']).toMatchObject({ status: 'REJECTED', issues: expect.arrayContaining(['Source changed after slicing']) });
        expect(result['A-T1']!.status).toBe('VERIFIED');
        expect(JSON.stringify(result)).not.toContain(root);
      });
    });
  });

  it('keeps the existing PARTIALLY_VERIFIED rules', async () => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    const noEvidence = assessment('A-NONE', [{ sliceId: 'SLICE-001-1', lines: [8, 8] }], {});
    const limited = { ...tier1([{ sliceId: 'SLICE-001-1', lines: [8, 8] }]), limitations: ['OBFUSCATED'] };
    const result = await statuses(input, completed(noEvidence, limited), registry, resolver);
    expect([result['A-NONE']!.status, result['A-T1']!.status]).toEqual(['PARTIALLY_VERIFIED', 'PARTIALLY_VERIFIED']);
  });

  describe('structured limitation scope in output 0.3.0', () => {
    it('does not block a static claim for RUNTIME_UNCONFIRMED alone', async () => {
      const { input, registry, resolver } = await prepare(originalOnlyPlan);
      const runtimeOnly = structuredAssessment('A-RUNTIME', 'RUNTIME_UNCONFIRMED');
      const result = await statuses(input, structuredCompleted([runtimeOnly], [{
        kind: 'RUNTIME_UNCONFIRMED', detail: 'No process execution was observed', affectedAssessmentIds: ['A-RUNTIME'],
      }]), registry, resolver);
      expect(result['A-RUNTIME']).toMatchObject({
        status: 'VERIFIED', issues: [],
        evidenceIntegrity: { criteriaVersion: 'EVIDENCE_INTEGRITY_V1', status: 'PASSED', errors: [], analysisLimitations: [
          { source: 'ASSESSMENT', kind: 'RUNTIME_UNCONFIRMED' },
          { source: 'GLOBAL_MISSING_CONTEXT', kind: 'RUNTIME_UNCONFIRMED', affectedAssessmentIds: ['A-RUNTIME'] },
        ] },
      });
    });

    it.each(['CODE_MISSING', 'BINDING_UNKNOWN', 'DATA_FLOW_UNKNOWN', 'CALLER_UNKNOWN', 'RESTORE_UNCERTAIN', 'PAYLOAD_UNKNOWN', 'INTENT_UNKNOWN', 'OTHER'] as const)(
      'preserves %s without using it as an integrity hold', async (kind) => {
        const { input, registry, resolver } = await prepare(originalOnlyPlan);
        const result = await statuses(input, structuredCompleted([structuredAssessment('A-HOLD', kind)]), registry, resolver);
        expect(result['A-HOLD']).toMatchObject({ status: 'VERIFIED', evidenceIntegrity: {
          criteriaVersion: 'EVIDENCE_INTEGRITY_V1', status: 'PASSED',
          analysisLimitations: [{ source: 'ASSESSMENT', kind }],
        } });
      },
    );

    it('preserves scoped global context only on named assessments and unscoped context on all', async () => {
      const { input, registry, resolver } = await prepare(originalOnlyPlan);
      const left = structuredAssessment('A-LEFT');
      const right = structuredAssessment('A-RIGHT');
      const scoped = await statuses(input, structuredCompleted([left, right], [{
        kind: 'CALLER_UNKNOWN', detail: 'Caller is outside the supplied slice', affectedAssessmentIds: ['A-LEFT'],
      }]), registry, resolver);
      expect([scoped['A-LEFT']!.status, scoped['A-RIGHT']!.status]).toEqual(['VERIFIED', 'VERIFIED']);
      expect(scoped['A-LEFT']!.evidenceIntegrity!.analysisLimitations).toHaveLength(1);
      expect(scoped['A-RIGHT']!.evidenceIntegrity!.analysisLimitations).toEqual([]);

      const global = await statuses(input, structuredCompleted([left, right], [{ kind: 'OTHER', detail: 'Scope cannot be determined' }]), registry, resolver);
      expect([global['A-LEFT']!.status, global['A-RIGHT']!.status]).toEqual(['VERIFIED', 'VERIFIED']);
      expect(global['A-LEFT']!.evidenceIntegrity!.analysisLimitations).toEqual([
        { source: 'GLOBAL_MISSING_CONTEXT', kind: 'OTHER', detail: 'Scope cannot be determined' },
      ]);
      expect(global['A-RIGHT']!.evidenceIntegrity!.analysisLimitations).toEqual(global['A-LEFT']!.evidenceIntegrity!.analysisLimitations);
    });

    it('rejects a cross-assessment flow ref before considering runtime limitations', async () => {
      const { input, registry, resolver } = await prepare(originalOnlyPlan);
      const first = structuredAssessment('A-FIRST');
      const second = structuredAssessment('A-SECOND', 'RUNTIME_UNCONFIRMED');
      second.flow.source = first.refs[0]!.id;
      const result = await statuses(input, structuredCompleted([first, second]), registry, resolver);
      expect(result['A-SECOND']).toMatchObject({
        status: 'REJECTED', issues: ['Unknown flow reference'],
        evidenceIntegrity: { criteriaVersion: 'EVIDENCE_INTEGRITY_V1', status: 'REJECTED', errors: ['Unknown flow reference'] },
      });
    });

    it('does not mutate structured limitations or missing context', async () => {
      const { input, registry, resolver } = await prepare(originalOnlyPlan);
      const output = structuredCompleted([structuredAssessment('A-RUNTIME', 'RUNTIME_UNCONFIRMED')], [{
        kind: 'RUNTIME_UNCONFIRMED', detail: 'No network observation', affectedAssessmentIds: ['A-RUNTIME'],
      }]);
      const before = structuredClone(output);
      await statuses(input, output, registry, resolver);
      expect(output).toEqual(before);
    });
  });

  it('refuses output for a different analysis request', async () => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    await expect(validator.validate(input, { ...completed(), requestId: 'other' }, { registry, resolver, maxFileSizeBytes: 65536 })).rejects.toThrow('requestId mismatch');
  });

  describe('0.3.0 runner path', () => {
    const settings = loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '0' });
    const run = async (output: CompletedAgentOutputV0_3) => {
      const { input, registry, resolver } = await prepare(originalOnlyPlan);
      const generate = jest.fn().mockResolvedValue({ text: JSON.stringify(output), model: 'mock-model', usage: {}, durationMs: 1 });
      return new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), new AgentOutputValidatorService(), settings).executeV0_3(input, { resolver, registry });
    };

    it('is COMPLETED when every assessment is VERIFIED', async () => {
      const result = await run(structuredCompleted([structuredAssessment('A-T1')]));
      expect(result.status).toBe('COMPLETED');
      expect(result.validated?.assessments.map((item) => item.status)).toEqual(['VERIFIED']);
    });

    it('is PARTIAL when an assessment is rejected', async () => {
      const bad = structuredAssessment('A-BAD');
      bad.refs[0]!.sliceId = 'SLICE-404';
      const result = await run(structuredCompleted([structuredAssessment('A-T1'), bad]));
      expect(result.status).toBe('PARTIAL');
      expect(result.validated?.assessments.map((item) => item.status)).toEqual(['VERIFIED', 'REJECTED']);
      expect(JSON.stringify(result)).not.toContain(FIXTURE_ROOT);
    });
  });
});
