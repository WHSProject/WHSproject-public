import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { projectPackageContext } from '../src/llm-agent/llm-agent-input-builder.service';
import {
  AGENT_TOOL_CATALOG_V0_3,
  ANALYSIS_TARGETS,
  FOCUS_BEHAVIORS,
  type AgentAnalysisInputV0_3,
} from '../src/llm-agent/artifact/agent-analysis-input.contract';
import { AgentInputV0_3Builder, findingKind, toPackageContextV0_3, type AgentInputV0_3Policy } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import { validateAgentAnalysisInputV0_3 } from '../src/llm-agent/artifact/agent-input-v0_3.validator';
import type { ArtifactDescriptor, ValidatedAgentAnalysisPlan } from '../src/llm-agent/artifact/artifact.contract';
import type { Tier3ExecutionInput } from '../src/llm-agent/artifact/agent-analysis-input.contract';
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

const contractsRoot = join(__dirname, '../../../packages/contracts');
const readSchema = (file: string) => JSON.parse(readFileSync(join(contractsRoot, file), 'utf8')) as Record<string, any>;
const inputSchema = readSchema('agent-analysis-request-v0.3.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(readSchema('evidence-v0.1.schema.json'));
const validateSchema: ValidateFunction = ajv.compile(inputSchema);

const policy: AgentInputV0_3Policy = {
  codeSlices: { maxInitialSlices: 8, maxLinesPerSlice: 80, maxInitialCodeLines: 120, maxTotalCodeLines: 200, maxFileSizeBytes: 65536 },
  maxToolCalls: 2,
  maxAdditionalCodeRequests: 2,
};
const context = { scanId: MOCK_SCAN_ID, packageName: 'tier3-fixture', packageVersion: '1.0.0', archiveSha256: MOCK_ARCHIVE_SHA256 };
const builder = new AgentInputV0_3Builder();

function schemaErrors(input: unknown): string[] {
  return validateSchema(input) ? [] : (validateSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

async function build(plan: ValidatedAgentAnalysisPlan) {
  return builder.build(mockExecutionInput(plan), context, policy);
}

function repeatedCapabilityExecution(): Tier3ExecutionInput {
  const execution = mockExecutionInput(deobfuscatedOnlyPlan);
  const validation = {
    before: Array.from({ length: 60 }, (_, i) => `capability.fixture.${i}`),
    after: Array.from({ length: 60 }, (_, i) => `capability.fixture.${i}`),
    status: 'PRESERVED' as const, preserved: [], lost: [], discovered: [], comparisons: [], limitations: [],
  };
  execution.atomicEvidences[0]!.analysisPass = 'TIER2';
  execution.atomicEvidences[0]!.capabilityPreservation = structuredClone(validation);
  execution.capabilityPreservation = {
    status: 'PRESERVED', limitations: [],
    files: [{ originalPath: 'install.js', deobfuscatedPaths: ['install.js'], restoreStatus: 'RESTORED', validation }],
  };
  return execution;
}

describe('Tier 3 lossless shared capability projection (#416)', () => {
  it.each([false, true])('aligns common-report lineage to Agent file without changing Evidence path (shared=%s)', async (shared) => {
    const execution = repeatedCapabilityExecution();
    const observation = {
      analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.env-read', findingId: 'tier2:env-read:1',
      path: 'install.js', startLine: 17, endLine: 18, representation: 'DEOBFUSCATED' as const,
      lineageStatus: 'MAPPED' as const, derivedFrom: { path: 'install.js', startLine: 8, endLine: 9 },
    };
    execution.capabilityPreservation!.files[0]!.validation.comparisons = [{
      capability: 'capability.environment.read', status: 'PRESERVED', original: [], deobfuscated: [observation],
    }];
    execution.atomicEvidences[0]!.capabilityPreservation = structuredClone(execution.capabilityPreservation!.files[0]!.validation);
    if (!shared) execution.atomicEvidences[0]!.capabilityPreservation!.lost.push('different-validation-retained');
    const snapshot = JSON.stringify(execution.atomicEvidences);
    const { input } = await builder.build(execution, context, policy);
    expect(input.capabilityPreservation?.files[0]?.validation.comparisons?.[0]?.deobfuscated[0]?.derivedFrom)
      .toEqual({ file: 'install.js', startLine: 8, endLine: 9 });
    expect(execution.capabilityPreservation!.files[0]!.validation.comparisons![0]!.deobfuscated[0]!.derivedFrom)
      .toEqual({ path: 'install.js', startLine: 8, endLine: 9 });
    expect(JSON.stringify(execution.atomicEvidences)).toBe(snapshot);
    if (shared) expect(input.atomicEvidences[0]?.capabilityPreservation).toBeUndefined();
    else expect(input.atomicEvidences).toEqual(execution.atomicEvidences);
    expect(schemaErrors(input)).toEqual([]);
    expect(validateAgentAnalysisInputV0_3(input)).toEqual([]);
  });

  it('keeps IDs, bindings, plan references, full common report and reconstructable evidence', async () => {
    const execution = repeatedCapabilityExecution();
    const before = JSON.stringify({ ...execution, artifacts: execution.artifacts.list() });
    const { input } = await builder.build(execution, context, policy);
    const pointer = input.missingData.find((item) => item.field === 'atomicEvidences[0].capabilityPreservation');
    expect(pointer?.reason).toContain('capabilityPreservation.files[0].validation');
    expect(input.atomicEvidences[0]?.capabilityPreservation).toBeUndefined();
    expect(input.capabilityPreservation).toEqual(execution.capabilityPreservation);
    expect({ ...input.atomicEvidences[0], capabilityPreservation: input.capabilityPreservation?.files[0]?.validation })
      .toEqual(execution.atomicEvidences[0]);
    expect(input.artifactContext.evidenceLocations).toEqual(execution.bindings.evidenceBindings);
    expect(input.artifactContext.findingLocations).toEqual(execution.bindings.findingBindings);
    expect(input.findings).toEqual(execution.findings);
    expect(input.analysisPlan.targets).toEqual(execution.validatedPlan.targets);
    expect(JSON.stringify({ ...execution, artifacts: execution.artifacts.list() })).toBe(before);
    expect(schemaErrors(input)).toEqual([]);
    expect(validateAgentAnalysisInputV0_3(input)).toEqual([]);
    const expanded = { ...input, atomicEvidences: execution.atomicEvidences,
      missingData: input.missingData.filter((item) => item !== pointer) };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(Buffer.byteLength(JSON.stringify(expanded)));
  });

  it.each([
    ['absent common report', (x: Tier3ExecutionInput) => { delete x.capabilityPreservation; }],
    ['different validation data', (x: Tier3ExecutionInput) => { x.capabilityPreservation!.files[0]!.validation.lost.push('capability.not-equivalent'); }],
    ['ambiguous common report', (x: Tier3ExecutionInput) => { x.capabilityPreservation!.files.push(structuredClone(x.capabilityPreservation!.files[0]!)); }],
    ['unrelated file', (x: Tier3ExecutionInput) => { x.capabilityPreservation!.files[0]!.deobfuscatedPaths = ['other.js']; }],
    ['no evidence binding', (x: Tier3ExecutionInput) => { x.bindings.evidenceBindings = []; }],
    ['original artifact binding', (x: Tier3ExecutionInput) => { x.bindings.evidenceBindings[0]!.artifactId = ORIGINAL_ARTIFACT_ID; }],
    ['unspecified analysis pass', (x: Tier3ExecutionInput) => { delete x.atomicEvidences[0]!.analysisPass; }],
    ['Tier1 evidence', (x: Tier3ExecutionInput) => { x.atomicEvidences[0]!.analysisPass = 'TIER1'; }],
    ['multi-file binding', (x: Tier3ExecutionInput) => { x.bindings.evidenceBindings.push({ ...x.bindings.evidenceBindings[0]!, filePath: 'other.js' }); }],
  ] as const)('retains the inline report for %s', async (_name, change) => {
    const execution = repeatedCapabilityExecution(); change(execution);
    const { input } = await builder.build(execution, context, policy);
    expect(input.atomicEvidences).toEqual(execution.atomicEvidences);
    expect(input.missingData.some((item) => item.field.endsWith('.capabilityPreservation'))).toBe(false);
    expect(schemaErrors(input)).toEqual([]);
    expect(validateAgentAnalysisInputV0_3(input)).toEqual([]);
  });

  it('does not increase size by replacing a small report with a larger reference', async () => {
    const execution = repeatedCapabilityExecution();
    const validation = { before: [], after: [], status: 'NOT_APPLICABLE' as const,
      preserved: [], lost: [], discovered: [], comparisons: [], limitations: [] };
    execution.capabilityPreservation!.files[0]!.validation = validation;
    execution.atomicEvidences[0]!.capabilityPreservation = structuredClone(validation);
    const { input } = await builder.build(execution, context, policy);
    expect(input.atomicEvidences).toEqual(execution.atomicEvidences);
    expect(input.missingData.some((item) => item.field.endsWith('.capabilityPreservation'))).toBe(false);
  });

  it('shares equal data regardless of object key order and points to the correct file index', async () => {
    const execution = repeatedCapabilityExecution();
    const original = execution.capabilityPreservation!.files[0]!;
    original.validation = Object.fromEntries(Object.entries(original.validation).reverse()) as typeof original.validation;
    execution.capabilityPreservation!.files.unshift({ ...structuredClone(original), deobfuscatedPaths: ['other.js'] });
    const { input } = await builder.build(execution, context, policy);
    expect(input.atomicEvidences[0]?.capabilityPreservation).toBeUndefined();
    expect(input.missingData.find((item) => item.field.endsWith('.capabilityPreservation'))?.reason)
      .toContain('capabilityPreservation.files[1].validation');
  });
});

describe('Tier 3 input 0.3.0 (#341)', () => {
  describe.each([
    ['ORIGINAL_ONLY', originalOnlyPlan],
    ['DEOBFUSCATED_ONLY', deobfuscatedOnlyPlan],
    ['ORIGINAL_AND_DEOBFUSCATED', originalAndDeobfuscatedPlan],
  ] as const)('fixture %s', (_mode, plan) => {
    it('builds an input that passes the JSON Schema and the semantic validator', async () => {
      const { input, registry } = await build(plan);
      expect(schemaErrors(input)).toEqual([]);
      expect(validateAgentAnalysisInputV0_3(input)).toEqual([]);
      expect(input.request).toEqual({ analysisRequestId: `agent-analysis:${MOCK_SCAN_ID}:0.3.0`, requestType: 'MALICIOUS_CODE_ANALYSIS', schemaVersion: '0.3.0', scanId: MOCK_SCAN_ID, createdAt: null });
      expect(input.initialCodeSlices.length).toBeGreaterThan(0);
      expect(registry.list().map((slice) => slice.sliceId)).toEqual(input.initialCodeSlices.map((slice) => slice.sliceId));
    });
  });

  it('keeps the same filePath of ORIGINAL and DEOBFUSCATED artifacts apart', async () => {
    const { input } = await build(originalAndDeobfuscatedPlan);
    expect(input.initialCodeSlices.map((slice) => [slice.artifactId, slice.filePath, slice.planningTargetId])).toEqual([
      [ORIGINAL_ARTIFACT_ID, 'install.js', 'TARGET-001'],
      [DEOBFUSCATED_ARTIFACT_ID, 'install.js', 'TARGET-002'],
    ]);
    expect(input.artifactContext.findingLocations.map((item) => [item.findingId, item.artifactId])).toEqual([
      ['tier1:env-read:1', ORIGINAL_ARTIFACT_ID],
      ['tier2:env-read:1', DEOBFUSCATED_ARTIFACT_ID],
    ]);
    expect(input.artifactContext.evidenceLocations.map((item) => [item.evidenceId, item.artifactId])).toEqual([
      ['AE-TIER1-001', ORIGINAL_ARTIFACT_ID],
      ['AE-TIER2-001', DEOBFUSCATED_ARTIFACT_ID],
    ]);
    expect(input.artifactContext.artifacts.find((item) => item.artifactId === DEOBFUSCATED_ARTIFACT_ID)).toMatchObject({ derivedFromArtifactId: ORIGINAL_ARTIFACT_ID, lineageStatus: 'UNMAPPED' });
  });

  it('passes capability preservation through to the Tier3 Agent input', async () => {
    const execution = mockExecutionInput(originalAndDeobfuscatedPlan);
    execution.capabilityPreservation = {
      status: 'PRESERVED',
      files: [{
        originalPath: 'install.js',
        deobfuscatedPaths: ['install.js'],
        restoreStatus: 'RESTORED',
        validation: {
          before: ['capability.network.outbound'],
          after: ['capability.network.outbound', 'capability.process.spawn'],
          status: 'PRESERVED',
          preserved: ['capability.network.outbound'],
          lost: [],
          discovered: ['capability.process.spawn'],
          comparisons: [],
          limitations: [],
        },
      }],
      limitations: [],
    };

    const { input } = await builder.build(execution, context, policy);

    expect(schemaErrors(input)).toEqual([]);
    expect(input.capabilityPreservation).toMatchObject({
      status: 'PRESERVED',
      files: [{ validation: { preserved: ['capability.network.outbound'], discovered: ['capability.process.spawn'] } }],
    });
  });

  it('carries mapped coordinates from the Tier 2 artifact into Tier 3 slices and schema input', async () => {
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
            entries: [
              { derivedLine: 17, sourceLine: 8, confidence: 'EXACT' as const },
              { derivedLine: 18, sourceLine: 9, confidence: 'EXACT' as const },
            ],
            derivedLineCount: 18,
            mappedLineCount: 2,
            limitations: [],
          }],
        }
        : descriptor,
    }))));
    const { input } = await builder.build(mockExecutionInput(deobfuscatedOnlyPlan, mappedResolver), context, policy);

    expect(schemaErrors(input)).toEqual([]);
    expect(validateAgentAnalysisInputV0_3(input)).toEqual([]);
    expect(input.artifactContext.artifacts.find((item) => item.artifactId === DEOBFUSCATED_ARTIFACT_ID)).toMatchObject({
      lineageStatus: 'MAPPED',
      lineMappings: [{ sourcePath: 'install.js', derivedPath: 'install.js' }],
    });
    expect(input.initialCodeSlices[0]).toMatchObject({
      filePath: 'install.js',
      startLine: 17,
      endLine: 18,
      lineageStatus: 'MAPPED',
      derivedFrom: { file: 'install.js', startLine: 8, endLine: 9 },
    });
  });

  it('sends only initial-slice line mappings while keeping the resolver mapping intact', async () => {
    const base = createMockArtifactResolver();
    const fullEntries = Array.from({ length: 50 }, (_, index) => ({ derivedLine: index + 1, sourceLine: index + 1, confidence: 'EXACT' as const }));
    const mappedResolver = new StaticArtifactResolver(await Promise.all(base.list().map(async (item) => ({
      root: await base.resolveRoot(item.artifactId),
      descriptor: item.artifactId === DEOBFUSCATED_ARTIFACT_ID ? {
        ...item, lineageStatus: 'MAPPED' as const,
        lineMappings: [{ version: '0.1.0' as const, sourcePath: 'install.js', derivedPath: 'install.js', status: 'MAPPED' as const,
          entries: fullEntries, derivedLineCount: 50, mappedLineCount: 50, limitations: [] }],
      } : item,
    }))));
    const { input } = await builder.build(mockExecutionInput(deobfuscatedOnlyPlan, mappedResolver), context, policy);
    const mapping = input.artifactContext.artifacts.find((item) => item.artifactId === DEOBFUSCATED_ARTIFACT_ID)?.lineMappings?.[0];
    expect(mapping?.entries.map((entry) => entry.derivedLine)).toEqual([17, 18]);
    expect(mapping?.mappedLineCount).toBe(2);
    expect(mapping?.limitations).toContain('AGENT_INPUT_LINE_MAPPING_TRUNCATED');
    expect(input.analysisPlan.limitations).toContain('AGENT_INPUT_LINE_MAPPING_TRUNCATED');
    expect(mappedResolver.describe(DEOBFUSCATED_ARTIFACT_ID)?.lineMappings?.[0]?.entries).toHaveLength(50);
    expect(schemaErrors(input)).toEqual([]);
    expect(validateAgentAnalysisInputV0_3(input)).toEqual([]);
  });

  it('never exposes artifact roots, providerRef or 0.2.0-only fields', async () => {
    const base = createMockArtifactResolver();
    const leaky = new StaticArtifactResolver(await Promise.all(base.list().map(async (descriptor) => ({
      descriptor: { ...descriptor, providerRef: `provider://${descriptor.artifactId}` } as ArtifactDescriptor,
      root: await base.resolveRoot(descriptor.artifactId),
    }))));
    const { input } = await builder.build(mockExecutionInput(originalAndDeobfuscatedPlan, leaky), context, policy);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain(FIXTURE_ROOT);
    expect(serialized).not.toContain(JSON.stringify(FIXTURE_ROOT).slice(1, -1));
    expect(serialized).not.toContain('providerRef');
    expect(serialized).not.toContain('GET_PACKAGE_METADATA');
    for (const key of ['requestId', 'inputProfile']) expect(input.request).not.toHaveProperty(key);
    for (const key of ['artifactHash', 'integrity']) expect(input.subject).not.toHaveProperty(key);
    for (const key of ['packageMetadata', 'bin']) expect(input.packageContext).not.toHaveProperty(key);
    expect(input).not.toHaveProperty('analysisTargets');
    expect(schemaErrors(input)).toEqual([]);
  });

  it('is deterministic for identical inputs', async () => {
    expect((await build(originalAndDeobfuscatedPlan)).input).toEqual((await build(originalAndDeobfuscatedPlan)).input);
  });

  it('builds an empty plan without slices when shouldExecute is false', async () => {
    const plan: ValidatedAgentAnalysisPlan = { ...originalOnlyPlan, shouldExecute: false, targets: [], focusBehaviors: [], analysisTargets: [] };
    const { input } = await build(plan);
    expect(input.initialCodeSlices).toEqual([]);
    expect(input.missingData).toContainEqual({ field: 'initialCodeSlices', reason: 'Planning decided that Tier 3 analysis is not required.' });
    expect(schemaErrors(input)).toEqual([]);
    expect(validateAgentAnalysisInputV0_3(input)).toEqual([]);

    const broken: AgentAnalysisInputV0_3 = { ...input, analysisPlan: { ...input.analysisPlan, focusBehaviors: ['NETWORK_EGRESS'] } };
    expect(schemaErrors(broken).join(' ')).toContain('/analysisPlan/focusBehaviors');
    expect(validateAgentAnalysisInputV0_3(broken)).toContain('shouldExecute=false requires empty targets, focusBehaviors and analysisTargets');
  });

  it('keeps TypeScript constants and the JSON Schema in sync', () => {
    const plan = inputSchema.properties.analysisPlan.properties;
    expect(plan.focusBehaviors.items.enum).toEqual([...FOCUS_BEHAVIORS]);
    expect(plan.analysisTargets.items.enum).toEqual([...ANALYSIS_TARGETS]);
    expect(inputSchema.properties.toolResponseCatalog.items.properties.tool.enum).toEqual(AGENT_TOOL_CATALOG_V0_3.map((item) => item.tool));
    expect(AGENT_TOOL_CATALOG_V0_3.filter((item) => item.status === 'AVAILABLE').map((item) => item.tool)).toEqual(['GET_FILE_RANGE']);
  });

  describe('schema and semantic rejection', () => {
    let valid: AgentAnalysisInputV0_3;
    beforeAll(async () => { valid = (await build(originalAndDeobfuscatedPlan)).input; });
    const mutate = (change: (input: AgentAnalysisInputV0_3) => void): AgentAnalysisInputV0_3 => {
      const copy = structuredClone(valid);
      change(copy);
      return copy;
    };

    it('rejects internal locations and unknown fields in the schema', () => {
      expect(schemaErrors(mutate((input) => { (input.artifactContext.artifacts[0] as unknown as Record<string, unknown>).rootRef = 'package'; }))).not.toEqual([]);
      expect(schemaErrors(mutate((input) => { input.artifactContext.findingLocations[0]!.filePath = '/abs/install.js'; }))).not.toEqual([]);
      expect(schemaErrors(mutate((input) => { input.artifactContext.findingLocations[0]!.filePath = '../install.js'; }))).not.toEqual([]);
      expect(schemaErrors(mutate((input) => { (input.toolResponseCatalog[0] as { tool: string }).tool = 'GET_PACKAGE_METADATA'; }))).not.toEqual([]);
      expect(schemaErrors(mutate((input) => { (input.analysisPlan as { analysisTargets: string[] }).analysisTargets = ['UNKNOWN_FLOW']; }))).not.toEqual([]);
      expect(schemaErrors(mutate((input) => { (input.initialCodeSlices[0] as { origin: string }).origin = 'RUNTIME'; }))).not.toEqual([]);
      expect(schemaErrors(mutate((input) => { delete input.artifactContext.artifacts[1]!.derivedFromArtifactId; }))).not.toEqual([]);
      // Old 0.3.0 vocabulary before aligning with the shared Evidence location lineageStatus (#358).
      expect(schemaErrors(mutate((input) => { (input.artifactContext.artifacts[0] as unknown as Record<string, unknown>).lineageStatus = 'EXACT'; }))).not.toEqual([]);
      expect(schemaErrors(mutate((input) => {
        const artifact = input.artifactContext.artifacts[0] as unknown as Record<string, unknown>;
        artifact.mappingStatus = artifact.lineageStatus;
        delete artifact.lineageStatus;
      }))).not.toEqual([]);
    });

    it('detects broken references, lineage and provenance', () => {
      const errors = (change: (input: AgentAnalysisInputV0_3) => void) => validateAgentAnalysisInputV0_3(mutate(change)).join('\n');
      expect(errors((input) => { input.analysisPlan.targets[0]!.findingRefs.push('missing-finding'); })).toContain('references unknown Finding missing-finding');
      expect(errors((input) => { input.artifactContext.evidenceLocations[0]!.evidenceId = 'AE-MISSING'; })).toContain('evidenceLocations references unknown Atomic Evidence AE-MISSING');
      expect(errors((input) => { input.initialCodeSlices[0]!.planningTargetId = 'TARGET-404'; })).toContain('must reference a planning target');
      expect(errors((input) => { input.initialCodeSlices[0]!.artifactId = DEOBFUSCATED_ARTIFACT_ID; })).toContain('does not match target');
      expect(errors((input) => { input.initialCodeSlices[0]!.content += '\n// changed'; })).toContain('contentSha256 does not match content');
      expect(errors((input) => { input.artifactContext.artifacts[1]!.derivedFromArtifactId = DEOBFUSCATED_ARTIFACT_ID; })).toContain('must derive from an ORIGINAL artifact');
      expect(errors((input) => { input.artifactContext.artifacts[0]!.analysisPass = 'TIER2'; })).toContain('must use analysisPass TIER1');
      expect(errors((input) => { input.artifactContext.artifacts[0]!.lineageStatus = 'UNMAPPED'; })).toContain('ORIGINAL must use lineageStatus DIRECT');
      expect(errors((input) => { input.artifactContext.artifacts[1]!.lineageStatus = 'DIRECT'; })).toContain('DEOBFUSCATED must not use lineageStatus DIRECT');
      expect(errors((input) => { input.analysisPlan.analysisMode = 'ORIGINAL_ONLY'; })).toContain('is outside ORIGINAL_ONLY');
      expect(errors((input) => { input.findings.push({ ...input.findings[0]! }); })).toContain('Duplicate Finding ID');
    });

    it('detects Ground Truth fields, unsafe evidence paths and leaked internal strings', () => {
      expect(validateAgentAnalysisInputV0_3(mutate((input) => { (input.findings[0] as unknown as Record<string, unknown>).expectedVerdict = 'MALICIOUS'; }))).toContain('Ground Truth field is not allowed: $.findings[0].expectedVerdict');
      expect(validateAgentAnalysisInputV0_3(mutate((input) => { input.atomicEvidences[0]!.locations[0]!.path = 'C:\\pkg\\install.js'; })).join(' ')).toContain('Unsafe path in Atomic Evidence');
      expect(validateAgentAnalysisInputV0_3(valid, { forbiddenSubstrings: ['install.js'] })).toContain('Scanner-internal location leaked into Agent input');
    });

    it('fails the build instead of returning an invalid input', async () => {
      const execution = mockExecutionInput(originalOnlyPlan);
      execution.findings = [];
      await expect(builder.build(execution, context, policy)).rejects.toThrow('Invalid Tier 3 input 0.3.0');
    });
  });

  describe('0.2.0 projections', () => {
    it('drops packageMetadata and bin but keeps BIN entry points', () => {
      const legacy = projectPackageContext({ name: 'pkg', version: '1', description: 'd', main: './main.js', bin: { cli: './cli.js' }, scripts: { postinstall: 'node x.js' } });
      const projected = toPackageContextV0_3(legacy);
      expect(projected).not.toHaveProperty('packageMetadata');
      expect(projected).not.toHaveProperty('bin');
      expect(projected.description).toBe('d');
      expect(projected.entryPoints.map((entry) => entry.type)).toEqual(['MAIN', 'BIN']);
    });

    it('maps Scanner finding types to Agent finding kinds', () => {
      expect(['THREAT_INDICATOR', 'CAPABILITY_PATTERN', 'CAPABILITY', 'LIFECYCLE_SCRIPT'].map(findingKind)).toEqual(['THREAT', 'CAPABILITY', 'CAPABILITY', 'OTHER']);
    });
  });
});
