import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeSlicePolicy } from '../src/llm-agent/agent.contract';
import type { ArtifactDescriptor, ValidatedAgentAnalysisPlan, ValidatedPlanningTarget } from '../src/llm-agent/artifact/artifact.contract';
import { ArtifactCodeSliceBuilder, initialSliceId } from '../src/llm-agent/artifact/artifact-code-slice.builder';
import { readArtifactSource, registerCodeSlice } from '../src/llm-agent/artifact/code-slice.factory';
import { InMemoryCodeSliceRegistry } from '../src/llm-agent/artifact/code-slice.registry';
import { selectLegacySliceCandidates } from '../src/llm-agent/legacy-slice-candidates';
import { projectPackageContext } from '../src/llm-agent/llm-agent-input-builder.service';
import {
  createMockArtifactResolver,
  deobfuscatedOnlyPlan,
  DEOBFUSCATED_ARTIFACT_ID,
  FIXTURE_ROOT,
  originalAndDeobfuscatedPlan,
  originalOnlyPlan,
  ORIGINAL_ARTIFACT_ID,
  StaticArtifactResolver,
} from './fixtures/tier3-artifacts/mock-artifacts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const policy: CodeSlicePolicy = { maxInitialSlices: 8, maxLinesPerSlice: 80, maxInitialCodeLines: 120, maxTotalCodeLines: 200, maxFileSizeBytes: 65536 };
const builder = new ArtifactCodeSliceBuilder();
const resolver = createMockArtifactResolver();

async function fileLines(artifactDirectory: string, file: string): Promise<string[]> {
  const text = (await readFile(join(FIXTURE_ROOT, artifactDirectory, file), 'utf8')).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function target(overrides: Partial<ValidatedPlanningTarget> & Pick<ValidatedPlanningTarget, 'targetId' | 'artifactId' | 'filePath'>): ValidatedPlanningTarget {
  return { priority: 'MEDIUM', findingRefs: ['finding'], evidenceRefs: [], reasonCodes: ['TEST'], ...overrides };
}

function planOf(analysisMode: ValidatedAgentAnalysisPlan['analysisMode'], targets: ValidatedPlanningTarget[]): ValidatedAgentAnalysisPlan {
  return { planId: 'PLAN-TEST', shouldExecute: true, analysisMode, targets, focusBehaviors: [], analysisTargets: [], limitations: [], validation: { status: 'VALIDATED' } };
}

describe('Tier 3 artifact-aware code slices (#340)', () => {
  describe('mock fixtures', () => {
    it('builds an ORIGINAL_ONLY plan from the original artifact', async () => {
      const registry = new InMemoryCodeSliceRegistry();
      const { slices, issues } = await builder.build(originalOnlyPlan, resolver, registry, policy);
      const lines = await fileLines('original', 'install.js');
      expect(issues).toEqual([]);
      expect(slices).toEqual([{
        sliceId: 'SLICE-001-1', artifactId: ORIGINAL_ARTIFACT_ID, filePath: 'install.js', startLine: 1, endLine: lines.length,
        content: lines.join('\n'), contentSha256: sha256(lines.join('\n')), sourceSha256: sha256(lines.join('\n')),
        origin: 'INITIAL', boundaryConfidence: 'HIGH', planningTargetId: 'TARGET-001', additionalCodeRequestId: null, agentRequestId: null,
        contentRedacted: false, redactionTypes: [], selectionReason: 'Planning target TARGET-001: LIFECYCLE_ENTRY',
        relatedFindingIds: ['tier1:env-read:1'], relatedEvidenceIds: ['AE-TIER1-001'],
        lineageStatus: 'DIRECT',
      }]);
      expect(registry.list()).toEqual(slices);
    });

    it('builds a DEOBFUSCATED_ONLY plan from the requested range of the restored artifact', async () => {
      const { slices, issues } = await builder.build(deobfuscatedOnlyPlan, resolver, new InMemoryCodeSliceRegistry(), policy);
      const lines = await fileLines('deobfuscated', 'install.js');
      expect(issues).toEqual([]);
      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatchObject({ artifactId: DEOBFUSCATED_ARTIFACT_ID, startLine: 17, endLine: 18, boundaryConfidence: 'MEDIUM', content: lines.slice(16, 18).join('\n') });
    });

    it('keeps the same filePath in ORIGINAL and DEOBFUSCATED artifacts as different code', async () => {
      const registry = new InMemoryCodeSliceRegistry();
      const { slices } = await builder.build(originalAndDeobfuscatedPlan, resolver, registry, policy);
      const [original, restored] = slices;
      expect(slices).toHaveLength(2);
      expect(original).toMatchObject({ sliceId: 'SLICE-001-1', artifactId: ORIGINAL_ARTIFACT_ID, filePath: 'install.js', planningTargetId: 'TARGET-001' });
      expect(restored).toMatchObject({ sliceId: 'SLICE-002-1', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js', planningTargetId: 'TARGET-002' });
      expect(original!.content).not.toBe(restored!.content);
      expect(original!.contentSha256).not.toBe(restored!.contentSha256);
      expect(registry.get('SLICE-001-1')?.artifactId).toBe(ORIGINAL_ARTIFACT_ID);
      expect(registry.get('SLICE-002-1')?.artifactId).toBe(DEOBFUSCATED_ARTIFACT_ID);
    });

    it('describes the deobfuscated artifact with lineage and without filesystem roots', () => {
      const descriptors = resolver.list();
      expect(descriptors.map((item) => [item.artifactId, item.representation, item.analysisPass, item.derivedFromArtifactId, item.lineageStatus])).toEqual([
        [ORIGINAL_ARTIFACT_ID, 'ORIGINAL', 'TIER1', undefined, 'DIRECT'],
        [DEOBFUSCATED_ARTIFACT_ID, 'DEOBFUSCATED', 'TIER2', ORIGINAL_ARTIFACT_ID, 'UNMAPPED'],
      ]);
      expect(JSON.stringify(descriptors)).not.toContain(FIXTURE_ROOT);
      for (const descriptor of descriptors) expect(descriptor.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('builder scope', () => {
    it('creates slices only for plan targets, never from package entry points or lifecycle files', async () => {
      const { slices } = await builder.build(originalOnlyPlan, resolver, new InMemoryCodeSliceRegistry(), policy);
      expect(slices.map((slice) => slice.filePath)).toEqual(['install.js']);
      expect(slices.map((slice) => slice.filePath)).not.toContain('lib/util.js');
      expect(slices.map((slice) => slice.filePath)).not.toContain('package.json');
    });

    it('creates nothing when shouldExecute is false', async () => {
      const plan: ValidatedAgentAnalysisPlan = { ...originalOnlyPlan, shouldExecute: false, targets: [] };
      expect(await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), policy)).toEqual({ slices: [], issues: [] });
    });

    it('rejects targets whose representation is outside analysisMode', async () => {
      const plan = planOf('ORIGINAL_ONLY', [target({ targetId: 'T-1', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js' })]);
      expect(await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), policy)).toEqual({ slices: [], issues: [{ targetId: 'T-1', reason: 'REPRESENTATION_NOT_ALLOWED' }] });
    });

    it('does not merge overlapping ranges of different targets and charges shared lines per target (decision A)', async () => {
      const plan = planOf('DEOBFUSCATED_ONLY', [
        target({ targetId: 'T-1', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js', preferredRange: { startLine: 2, endLine: 9 } }),
        target({ targetId: 'T-2', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js', preferredRange: { startLine: 6, endLine: 14 } }),
      ]);
      const { slices, issues } = await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), { ...policy, maxInitialCodeLines: 17 });
      expect(slices.map((slice) => [slice.sliceId, slice.planningTargetId, slice.startLine, slice.endLine])).toEqual([
        ['SLICE-001-1', 'T-1', 2, 9],
        ['SLICE-002-1', 'T-2', 6, 14],
      ]);
      // 8 + 9 = 17 lines: overlapping lines 6-9 are charged to both targets.
      expect(issues).toEqual([]);
      const tight = await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), { ...policy, maxInitialCodeLines: 16 });
      expect(tight.issues).toEqual([{ targetId: 'T-2', reason: 'RANGE_TRUNCATED' }]);
    });

    it('slices supplement targets from their own line budget without changing the regular targets', async () => {
      const plan = planOf('DEOBFUSCATED_ONLY', [
        target({ targetId: 'T-1', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js', preferredRange: { startLine: 2, endLine: 14 } }),
        target({ targetId: 'T-2', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js', preferredRange: { startLine: 15, endLine: 18 } }),
      ]);
      const tight = { ...policy, maxInitialCodeLines: 5 };
      const regular = await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), tight);
      expect(regular.slices.map((slice) => [slice.planningTargetId, slice.startLine, slice.endLine])).toEqual([['T-1', 2, 6]]);
      expect(regular.issues).toEqual([{ targetId: 'T-1', reason: 'RANGE_TRUNCATED' }, { targetId: 'T-2', reason: 'LINE_BUDGET_EXHAUSTED' }]);

      const supplemented = await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), tight, undefined, { fromTargetIndex: 1, maxCodeLines: 3 });
      // T-1 is still cut at the regular budget; T-2 gets exactly the supplement.
      expect(supplemented.slices.map((slice) => [slice.planningTargetId, slice.startLine, slice.endLine])).toEqual([['T-1', 2, 6], ['T-2', 15, 17]]);
      expect(supplemented.slices[0]).toEqual(regular.slices[0]);
      expect(supplemented.issues).toEqual([{ targetId: 'T-1', reason: 'RANGE_TRUNCATED' }, { targetId: 'T-2', reason: 'RANGE_TRUNCATED' }]);
    });

    it('produces contiguous, non-overlapping chunks within one target', async () => {
      const { slices } = await builder.build(planOf('DEOBFUSCATED_ONLY', [target({ targetId: 'T-1', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js' })]), resolver, new InMemoryCodeSliceRegistry(), { ...policy, maxLinesPerSlice: 5 });
      for (const [index, slice] of slices.entries()) {
        expect(slice.planningTargetId).toBe('T-1');
        if (index > 0) expect(slice.startLine).toBe(slices[index - 1]!.endLine + 1);
      }
    });

    it('is deterministic and never encodes line ranges or paths in slice IDs', async () => {
      const first = await builder.build(originalAndDeobfuscatedPlan, resolver, new InMemoryCodeSliceRegistry(), policy);
      const second = await builder.build(originalAndDeobfuscatedPlan, resolver, new InMemoryCodeSliceRegistry(), policy);
      expect(second).toEqual(first);
      for (const slice of first.slices) {
        expect(slice.sliceId).toMatch(/^SLICE-\d{3}-\d+$/);
        expect(slice.sliceId).not.toContain('install');
      }
      expect(initialSliceId(0, 1)).toBe('SLICE-001-1');
      expect(initialSliceId(11, 3)).toBe('SLICE-012-3');
    });
  });

  describe('ranges and budgets', () => {
    const deobfuscated = (targetId: string, preferredRange?: { startLine: number; endLine: number }) =>
      target({ targetId, artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js', ...(preferredRange ? { preferredRange } : {}) });

    it('clips a range past the end of file and reports ranges outside or invalid', async () => {
      const lineCount = (await fileLines('deobfuscated', 'install.js')).length;
      const plan = planOf('DEOBFUSCATED_ONLY', [
        deobfuscated('T-CLIP', { startLine: lineCount - 1, endLine: lineCount + 50 }),
        deobfuscated('T-OUT', { startLine: lineCount + 1, endLine: lineCount + 5 }),
        deobfuscated('T-BAD', { startLine: 5, endLine: 2 }),
      ]);
      const { slices, issues } = await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), policy);
      expect(slices.map((slice) => [slice.planningTargetId, slice.startLine, slice.endLine, slice.boundaryConfidence])).toEqual([['T-CLIP', lineCount - 1, lineCount, 'LOW']]);
      expect(issues).toEqual([{ targetId: 'T-OUT', reason: 'RANGE_OUTSIDE_FILE' }, { targetId: 'T-BAD', reason: 'INVALID_RANGE' }]);
    });

    it('splits a long target by maxLinesPerSlice with sequential IDs', async () => {
      const { slices } = await builder.build(planOf('DEOBFUSCATED_ONLY', [deobfuscated('T-1')]), resolver, new InMemoryCodeSliceRegistry(), { ...policy, maxLinesPerSlice: 7 });
      expect(slices.map((slice) => [slice.sliceId, slice.startLine, slice.endLine, slice.boundaryConfidence])).toEqual([
        ['SLICE-001-1', 1, 7, 'LOW'], ['SLICE-001-2', 8, 14, 'LOW'], ['SLICE-001-3', 15, 18, 'LOW'],
      ]);
    });

    it('counts initial lines against the smaller of the initial and total line budgets', async () => {
      const plan = planOf('DEOBFUSCATED_ONLY', [deobfuscated('T-1'), deobfuscated('T-2')]);
      const { slices, issues } = await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), { ...policy, maxInitialCodeLines: 50, maxTotalCodeLines: 10 });
      expect(slices.map((slice) => [slice.planningTargetId, slice.startLine, slice.endLine])).toEqual([['T-1', 1, 10]]);
      expect(issues).toEqual([{ targetId: 'T-1', reason: 'RANGE_TRUNCATED' }, { targetId: 'T-2', reason: 'LINE_BUDGET_EXHAUSTED' }]);
    });

    it('stops at maxInitialSlices', async () => {
      const plan = planOf('DEOBFUSCATED_ONLY', [deobfuscated('T-1', { startLine: 1, endLine: 2 }), deobfuscated('T-2', { startLine: 3, endLine: 4 })]);
      const { slices, issues } = await builder.build(plan, resolver, new InMemoryCodeSliceRegistry(), { ...policy, maxInitialSlices: 1 });
      expect(slices).toHaveLength(1);
      expect(issues).toEqual([{ targetId: 'T-2', reason: 'SLICE_LIMIT_REACHED' }]);
    });
  });

  describe('safe reading', () => {
    let root: string;
    let unsafeResolver: StaticArtifactResolver;
    const descriptor: ArtifactDescriptor = { artifactId: 'ARTIFACT-TMP', representation: 'ORIGINAL', analysisPass: 'TIER1', contentSha256: '0'.repeat(64), lineageStatus: 'DIRECT', producer: 'test' };

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'tier3-slice-'));
      await mkdir(join(root, 'pkg'));
      await writeFile(join(root, 'pkg', 'ok.js'), 'const a = 1;\n');
      await writeFile(join(root, 'outside.js'), 'secret();\n');
      await writeFile(join(root, 'pkg', 'binary.js'), Buffer.from([0x61, 0x00, 0x62]));
      await writeFile(join(root, 'pkg', 'big.js'), 'x'.repeat(100));
      await writeFile(join(root, 'pkg', 'hard-source.js'), 'hard();\n');
      await link(join(root, 'pkg', 'hard-source.js'), join(root, 'pkg', 'hard.js'));
      await symlink(join(root, 'outside.js'), join(root, 'pkg', 'link.js'));
      unsafeResolver = new StaticArtifactResolver([{ descriptor, root: join(root, 'pkg') }]);
    });
    afterEach(async () => rm(root, { recursive: true, force: true }));

    it('rejects traversal, links, binary and oversized files without leaking paths', async () => {
      const files = ['../outside.js', 'link.js', 'hard.js', 'binary.js', 'big.js', 'missing.js', 'ok.js'];
      const plan = planOf('ORIGINAL_ONLY', files.map((filePath, index) => target({ targetId: `T-${index + 1}`, artifactId: 'ARTIFACT-TMP', filePath })));
      const { slices, issues } = await builder.build(plan, unsafeResolver, new InMemoryCodeSliceRegistry(), { ...policy, maxFileSizeBytes: 50 });
      expect(slices.map((slice) => slice.filePath)).toEqual(['ok.js']);
      expect(issues).toEqual([
        { targetId: 'T-1', reason: 'FILE_REJECTED' },
        { targetId: 'T-2', reason: 'FILE_REJECTED' },
        { targetId: 'T-3', reason: 'FILE_REJECTED' },
        { targetId: 'T-4', reason: 'FILE_REJECTED' },
        { targetId: 'T-5', reason: 'FILE_REJECTED' },
        { targetId: 'T-6', reason: 'FILE_UNAVAILABLE' },
      ]);
      expect(JSON.stringify(issues)).not.toContain(root);
    });

    it('reports an unknown artifact', async () => {
      const plan = planOf('ORIGINAL_ONLY', [target({ targetId: 'T-1', artifactId: 'ARTIFACT-MISSING', filePath: 'ok.js' })]);
      expect((await builder.build(plan, unsafeResolver, new InMemoryCodeSliceRegistry(), policy)).issues).toEqual([{ targetId: 'T-1', reason: 'ARTIFACT_NOT_FOUND' }]);
    });
  });

  describe('code slice registry and shared factory', () => {
    it('registers a RUNTIME slice through the shared factory next to INITIAL slices', async () => {
      const registry = new InMemoryCodeSliceRegistry();
      await builder.build(deobfuscatedOnlyPlan, resolver, registry, policy);
      const source = await readArtifactSource(resolver, ORIGINAL_ARTIFACT_ID, 'lib/util.js', policy.maxFileSizeBytes);
      const runtime = registerCodeSlice(registry, source, { startLine: 4, endLine: 7 }, {
        sliceId: 'SLICE-R001', origin: 'RUNTIME', boundaryConfidence: 'MEDIUM', planningTargetId: null,
        additionalCodeRequestId: 'REQ-001', agentRequestId: 'CR-1', selectionReason: 'Agent request CR-1', relatedFindingIds: [], relatedEvidenceIds: [],
      });
      expect(runtime).toMatchObject({ artifactId: ORIGINAL_ARTIFACT_ID, filePath: 'lib/util.js', origin: 'RUNTIME', additionalCodeRequestId: 'REQ-001', agentRequestId: 'CR-1', contentRedacted: false, redactionTypes: [], selectionReason: 'Agent request CR-1' });
      expect(runtime.contentSha256).toBe(runtime.sourceSha256);
      expect(registry.list().map((slice) => [slice.sliceId, slice.origin])).toEqual([['SLICE-001-1', 'INITIAL'], ['SLICE-R001', 'RUNTIME']]);
    });

    it('keeps registered slices immutable', async () => {
      const registry = new InMemoryCodeSliceRegistry();
      const { slices } = await builder.build(originalOnlyPlan, resolver, registry, policy);
      const stored = registry.get('SLICE-001-1')!;
      const content = stored.content;
      expect(slices[0]).toBe(stored);
      expect(Object.isFrozen(stored)).toBe(true);
      expect(() => { (stored as { content: string }).content = 'tampered'; }).toThrow(TypeError);
      expect(() => { (stored as { planningTargetId: string | null }).planningTargetId = null; }).toThrow(TypeError);
      expect(() => stored.relatedFindingIds.push('F-X')).toThrow(TypeError);
      expect(() => (registry.list() as unknown as unknown[]).push({})).not.toThrow();
      expect(registry.list()).toHaveLength(1);

      const input = { ...stored, sliceId: 'SLICE-002-1', relatedFindingIds: ['F-1'] };
      registry.register(input);
      input.content = 'changed after register';
      input.relatedFindingIds.push('F-2');
      expect(registry.get('SLICE-002-1')).toMatchObject({ content, relatedFindingIds: ['F-1'] });
    });

    it('enforces INITIAL/RUNTIME provenance rules, unique IDs and valid ranges', async () => {
      const registry = new InMemoryCodeSliceRegistry();
      const [slice] = (await builder.build(originalOnlyPlan, resolver, registry, policy)).slices;
      expect(() => registry.register(slice!)).toThrow('Duplicate slice ID');
      const fresh = new InMemoryCodeSliceRegistry();
      expect(() => fresh.register({ ...slice!, planningTargetId: null })).toThrow('requires planningTargetId');
      expect(() => fresh.register({ ...slice!, additionalCodeRequestId: 'REQ-001' })).toThrow('must not reference an additional code request');
      expect(() => fresh.register({ ...slice!, origin: 'RUNTIME', planningTargetId: null })).toThrow('requires additionalCodeRequestId');
      expect(() => fresh.register({ ...slice!, origin: 'RUNTIME', additionalCodeRequestId: 'REQ-001' })).toThrow('must not reference a planning target');
      expect(() => fresh.register({ ...slice!, startLine: 5, endLine: 4 })).toThrow('invalid line range');
      expect(fresh.list()).toEqual([]);
    });

    it('rejects a factory range outside the source file', async () => {
      const source = await readArtifactSource(resolver, ORIGINAL_ARTIFACT_ID, 'install.js', policy.maxFileSizeBytes);
      expect(() => registerCodeSlice(new InMemoryCodeSliceRegistry(), source, { startLine: 1, endLine: source.lineCount + 1 }, {
        sliceId: 'SLICE-R001', origin: 'RUNTIME', boundaryConfidence: 'LOW', planningTargetId: null,
        additionalCodeRequestId: 'REQ-001', agentRequestId: null, selectionReason: 'Agent request', relatedFindingIds: [], relatedEvidenceIds: [],
      })).toThrow('outside the source file');
    });
  });

  describe('legacy target selection', () => {
    it('keeps finding, lifecycle and entry-point candidates in the legacy order', () => {
      const context = projectPackageContext({ name: 'pkg', version: '1', scripts: { postinstall: 'node ./install.js' }, main: './main.js' });
      const candidates = selectLegacySliceCandidates(context, [{ findingId: 'F-1', analyzer: 'guarddog', analyzerVersion: '1', ruleId: 'r', kind: 'CAPABILITY', description: 'd', location: { file: 'a.js', startLine: 3, endLine: null }, rawMatch: null }]);
      expect(candidates.map((candidate) => [candidate.file, candidate.line, candidate.reason])).toEqual([
        ['a.js', 3, 'finding:F-1'], ['install.js', null, 'lifecycle:postinstall'], ['main.js', null, 'entry:MAIN'],
      ]);
    });
  });
});
