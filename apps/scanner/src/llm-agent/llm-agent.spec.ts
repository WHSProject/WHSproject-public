import { mkdtemp, writeFile, mkdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisContext, AnalyzerResult } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';
import { loadLlmAgentEnvironment } from '../config/scanner-environment';
import { projectPackageContext, LlmAgentInputBuilderService } from './llm-agent-input-builder.service';
import { LlmAgentTriggerService } from './llm-agent-trigger.service';
import { LlmAgentCodeSliceService } from './llm-agent-code-slice.service';
import { LlmAgentToolsService, type AgentToolUsage, type AgentToolRequest } from './llm-agent-tools.service';

const packageContext = projectPackageContext({ name: 'pkg', version: '1', scripts: { preinstall: 'node ./install.js' }, main: './main.js', bin: { cli: './bin.js' }, exports: { '.': './export.js' }, dependencies: { left: '1' } });
const result = (analyzer: string, ruleId: string, type = 'CAPABILITY', path?: string, startLine?: number): AnalyzerResult => ({ requestId: 'request', scanId: 'scan', analyzer, analyzerVersion: '1', status: 'SUCCESS', errors: [], findings: [{ findingId: ruleId, ruleId, type, message: ruleId, data: {}, ...(path ? { location: { type: 'SOURCE_FILE', path, ...(startLine ? { startLine } : {}) } } : {}) }] });
const evidence = (type: string): AtomicEvidenceV0_1 => ({ schemaVersion: '0.1', evidenceId: type, kind: 'ATOMIC', signal: { id: type, type, category: 'CODE' }, subject: { ecosystem: 'npm', packageName: 'pkg', packageVersion: '1', artifactHash: 'sha256' }, assertion: { summary: type, basis: 'PATTERN_MATCH' }, sources: [], locations: [], provenance: { scanId: 'scan', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: 'now' }, limitations: [] });

describe('LLM Agent trigger', () => {
  const trigger = new LlmAgentTriggerService();
  it('handles disabled, always and empty risk decisions', () => {
    expect(trigger.decide('DISABLED', packageContext, [], []).reason).toBe('AGENT_DISABLED');
    expect(trigger.decide('ALWAYS', packageContext, [], []).shouldExecute).toBe(true);
    expect(trigger.decide('RISK_BASED', projectPackageContext({}), [], []).shouldExecute).toBe(false);
  });
  it('keeps high-confidence GuardDog threat routing separate from generic capability routing', () => {
    expect(trigger.decide('RISK_BASED', projectPackageContext({}), [result('guarddog', 'threat-network-exfiltration', 'THREAT_INDICATOR')], []).matchedConditions)
      .toContain('GUARDDOG_THREAT_FOUND');
    expect(trigger.decide('RISK_BASED', projectPackageContext({}), [result('guarddog', 'capability-process-spawn')], [evidence('CHILD_PROCESS')]).matchedConditions)
      .not.toContain('GUARDDOG_THREAT_FOUND');
  });
  it('returns all structured conditions in one decision', () => {
    const decision = trigger.decide('RISK_BASED', packageContext, [result('guarddog', 'threat-install-script', 'THREAT_INDICATOR'), result('guarddog', 'capability-process-spawn', 'CAPABILITY')], [evidence('CHILD_PROCESS'), evidence('CREDENTIAL_READ'), evidence('NETWORK_EGRESS'), evidence('REMOTE_FETCH'), evidence('FILE_WRITE'), evidence('OBFUSCATED_CODE')]);
    expect(decision.shouldExecute).toBe(true);
    expect(decision.matchedConditions).toEqual(['GUARDDOG_THREAT_FOUND', 'LIFECYCLE_WITH_PROCESS_EXECUTION', 'SENSITIVE_ACCESS_WITH_NETWORK', 'DOWNLOAD_WRITE_EXECUTION_COMBINATION', 'OBFUSCATION_FOUND']);
  });
  it('requires two download/write/execution classes', () => {
    expect(trigger.decide('RISK_BASED', projectPackageContext({}), [], [evidence('REMOTE_FETCH')]).matchedConditions).toEqual([]);
    expect(trigger.decide('RISK_BASED', projectPackageContext({}), [], [evidence('REMOTE_FETCH'), evidence('FILE_WRITE')]).matchedConditions).toEqual([]);
    expect(trigger.decide('RISK_BASED', projectPackageContext({}), [], [evidence('REMOTE_FETCH'), evidence('FILE_WRITE'), evidence('CHILD_PROCESS')]).matchedConditions).toContain('DOWNLOAD_WRITE_EXECUTION_COMBINATION');
  });
});

describe('LLM Agent input, code and tools', () => {
  let root: string;
  const slices = new LlmAgentCodeSliceService();
  const tools = new LlmAgentToolsService();
  const settings = loadLlmAgentEnvironment({});
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-test-'));
    await writeFile(join(root, 'main.js'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
    for (const file of ['install.js', 'bin.js', 'export.js']) await writeFile(join(root, file), 'import x from "x";\nexec(x);');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('builds Scanner projections and keeps hashes separate', async () => {
    const context: AnalysisContext = { requestId: 'request', scanId: 'scan', package: { name: 'pkg', version: '1' }, artifact: { tarballPath: '/private/tarball', extractedPath: root, hash: 'sha256' }, metadata: { registryMetadata: { secret: 'registry' }, packageJson: { name: 'pkg', version: '1', ...{ main: './main.js', scripts: { preinstall: 'node ./install.js' }, dependencies: { left: '1' } } } } };
    const input = await new LlmAgentInputBuilderService(slices).build({ context, calculatedIntegrity: 'sha512-base64', analyzerResults: [result('custom-rule', 'custom.process-execution', 'CAPABILITY', 'main.js', 20)], atomicEvidences: [evidence('CHILD_PROCESS')], triggerDecision: { mode: 'RISK_BASED', shouldExecute: true, matchedConditions: ['LIFECYCLE_WITH_PROCESS_EXECUTION'], reason: 'RISK_CONDITION_MATCHED' }, settings });
    expect(input.subject).toMatchObject({ artifactHash: 'sha256', integrity: 'sha512-base64' });
    expect(input.packageContext.dependencies).toEqual({ left: '1' });
    expect(input.findings[0]).toMatchObject({ analyzer: 'custom-rule', ruleId: 'custom.process-execution', location: { file: 'main.js', startLine: 20 } });
    expect(input.atomicEvidences[0]?.signal.type).toBe('CHILD_PROCESS');
    expect(input.analysisTargets).toEqual(['LIFECYCLE_TO_PROCESS_EXECUTION']);
    expect(input.toolResponseCatalog.find((tool) => tool.tool === 'GET_FILE_RANGE')?.status).toBe('AVAILABLE');
    expect(JSON.stringify(input)).not.toMatch(/registry|groundTruth|private\/tarball|expectedBehavior/u);
  });
  it('uses finding lines, line-free findings and entry files with limits', async () => {
    const findings = [result('custom-rule', 'a', 'CAPABILITY', 'main.js', 20), result('custom-rule', 'b', 'CAPABILITY', 'main.js', 25), result('custom-rule', 'c', 'CAPABILITY', 'bin.js')].flatMap((r) => r.findings.map((f) => ({ findingId: f.findingId, analyzer: r.analyzer, analyzerVersion: r.analyzerVersion, ruleId: f.ruleId, kind: f.type, description: f.message, location: f.location ? { file: f.location.path!, startLine: f.location.startLine ?? null, endLine: null } : null, rawMatch: null })));
    const built = await slices.build(root, packageContext, findings, { maxInitialSlices: 5, maxLinesPerSlice: 40, maxInitialCodeLines: 100, maxTotalCodeLines: 100, maxFileSizeBytes: 1000 });
    expect(built.slices.filter((s) => s.file === 'main.js')).toHaveLength(1);
    expect(built.slices.find((s) => s.file === 'main.js')).toMatchObject({ startLine: 1, relatedFindingIds: ['a', 'b'] });
    expect(built.slices.some((s) => s.file === 'install.js')).toBe(true);
    expect(built.slices.some((s) => s.file === 'bin.js')).toBe(true);
    expect(built.slices.some((s) => s.file === 'export.js')).toBe(true);
    expect(built.slices.reduce((sum, s) => sum + s.endLine - s.startLine + 1, 0)).toBeLessThanOrEqual(100);
  });
  it('reports missing candidates and enforces slice, line and size limits', async () => {
    const empty = await slices.build(root, projectPackageContext({}), [], { maxInitialSlices: 1, maxLinesPerSlice: 2, maxInitialCodeLines: 2, maxTotalCodeLines: 2, maxFileSizeBytes: 1000 });
    expect(empty.missingData[0]?.type).toBe('CODE_CANDIDATE');
    const limited = await slices.build(root, packageContext, [], { maxInitialSlices: 1, maxLinesPerSlice: 2, maxInitialCodeLines: 2, maxTotalCodeLines: 2, maxFileSizeBytes: 1000 });
    expect(limited.slices).toHaveLength(1);
    expect(limited.slices[0]?.endLine).toBeLessThanOrEqual(2);
    const oversized = await slices.build(root, packageContext, [], { maxInitialSlices: 10, maxLinesPerSlice: 10, maxInitialCodeLines: 10, maxTotalCodeLines: 10, maxFileSizeBytes: 1 });
    expect(oversized.slices).toHaveLength(0);
    expect(oversized.missingData.some((item) => item.type === 'CODE_FILE')).toBe(true);
  });
  it('rejects unsafe paths, links, binary and oversized files', async () => {
    await symlink(join(root, 'main.js'), join(root, 'sym.js'));
    await link(join(root, 'main.js'), join(root, 'hard.js'));
    await writeFile(join(root, 'binary.js'), Buffer.from([0, 1]));
    await mkdir(join(root, 'dir'));
    await symlink(tmpdir(), join(root, 'dir', 'escape'));
    for (const file of ['../main.js', '/etc/passwd', 'sym.js', 'hard.js', 'binary.js', 'dir/escape/x']) {
      await expect(tools.getFileRange(root, { file, startLine: 1, endLine: 1 }, 10, 1000)).rejects.toThrow();
    }
    await expect(tools.getFileRange(root, { file: 'main.js', startLine: 1, endLine: 1 }, 10, 1)).rejects.toThrow();
  });
  it('validates ranges, limits, repetition and metadata projection', async () => {
    expect((await tools.getFileRange(root, { file: 'main.js', startLine: 20, endLine: 21 }, 10, 1000)).content).toBe('line 20\nline 21');
    await expect(tools.getFileRange(root, { file: 'none.js', startLine: 1, endLine: 2 }, 10, 1000)).rejects.toThrow();
    await expect(tools.getFileRange(root, { file: 'main.js', startLine: 0, endLine: 2 }, 10, 1000)).rejects.toThrow();
    await expect(tools.getFileRange(root, { file: 'main.js', startLine: 1, endLine: 12 }, 10, 1000)).rejects.toThrow();
    const usage: AgentToolUsage = { calls: 0, additionalCodeRequests: 0, codeLines: 0, requestKeys: new Set() };
    const request = { tool: 'GET_FILE_RANGE' as const, input: { file: 'main.js', startLine: 1, endLine: 2 } };
    await tools.execute(request, root, packageContext, { maxToolCalls: 2, maxAdditionalCodeRequests: 1, maxTotalCodeLines: 3 }, 10, 1000, usage);
    await expect(tools.execute(request, root, packageContext, { maxToolCalls: 2, maxAdditionalCodeRequests: 1, maxTotalCodeLines: 3 }, 10, 1000, usage)).rejects.toThrow('Repeated');
    await expect(tools.execute({ tool: 'GET_FILE_RANGE', input: { file: 'main.js', startLine: 3, endLine: 4 } }, root, packageContext, { maxToolCalls: 2, maxAdditionalCodeRequests: 1, maxTotalCodeLines: 3 }, 10, 1000, usage)).rejects.toThrow();
    await expect(tools.execute({ tool: 'GET_CALLERS', input: {} } as unknown as AgentToolRequest, root, packageContext, { maxToolCalls: 2, maxAdditionalCodeRequests: 1, maxTotalCodeLines: 3 }, 10, 1000, usage)).rejects.toThrow('unavailable');
    await expect(tools.execute({ tool: 'GET_PACKAGE_METADATA', input: {} }, root, packageContext, { maxToolCalls: 1, maxAdditionalCodeRequests: 1, maxTotalCodeLines: 3 }, 10, 1000, { calls: 1, additionalCodeRequests: 0, codeLines: 0, requestKeys: new Set() })).rejects.toThrow('Tool call limit');
    expect(tools.getPackageMetadata(packageContext).dependencies).toEqual({ left: '1' });
    expect(() => loadLlmAgentEnvironment({ LLM_AGENT_TRIGGER_MODE: 'INVALID' })).toThrow();
    expect(() => loadLlmAgentEnvironment({ LLM_AGENT_MAX_TOTAL_CODE_LINES: '1' })).toThrow();
  });
});
