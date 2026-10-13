import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { AnalysisContext, AnalyzerResult, FindingLocation } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';
import type { LlmAgentEnvironment } from '../config/scanner-environment';
import type { AgentAnalysisRequest, AgentAnalysisTarget, AgentLocation, AgentMissingData, AgentPackageContext, AgentTriggerDecision } from './agent.contract';
import { AGENT_TOOL_CATALOG } from './llm-agent-tools.service';
import { LlmAgentCodeSliceService } from './llm-agent-code-slice.service';

function stringValue(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
function safeLocation(location: FindingLocation | undefined, missing: AgentMissingData[]): AgentLocation | null {
  if (!location?.path) return null;
  const file = location.path.replace(/^\.\//u, '');
  if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) {
    missing.push({ type: 'LOCATION', description: 'Unsafe finding path omitted', impact: 'Source location unavailable' });
    return null;
  }
  return { file, startLine: location.startLine ?? null, endLine: location.endLine ?? null };
}
function collectExportPaths(value: unknown, result: string[]): void {
  if (typeof value === 'string') { if (/^\.?\.?\/[\w./-]+$/u.test(value)) result.push(value); return; }
  if (Array.isArray(value)) { value.forEach((item) => collectExportPaths(item, result)); return; }
  if (typeof value === 'object' && value !== null) Object.values(value).forEach((item) => collectExportPaths(item, result));
}
export function projectPackageContext(manifest: Record<string, unknown>): AgentPackageContext {
  const scripts = stringMap(manifest.scripts);
  const entryPoints: AgentPackageContext['entryPoints'] = [];
  const main = stringValue(manifest.main);
  if (main) entryPoints.push({ type: 'MAIN', value: main, location: null });
  const bin = typeof manifest.bin === 'string' ? manifest.bin : stringMap(manifest.bin);
  if (typeof bin === 'string') entryPoints.push({ type: 'BIN', value: bin, location: null });
  else Object.values(bin).forEach((value) => entryPoints.push({ type: 'BIN', value, location: null }));
  const exportPaths: string[] = [];
  collectExportPaths(manifest.exports, exportPaths);
  exportPaths.forEach((value) => entryPoints.push({ type: 'EXPORTS', value, location: null }));
  return {
    source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION',
    packageMetadata: { name: stringValue(manifest.name), version: stringValue(manifest.version), description: stringValue(manifest.description) },
    main, exports: manifest.exports ?? null, bin, scripts, dependencies: stringMap(manifest.dependencies), entryPoints,
    lifecycleScripts: (['preinstall', 'install', 'postinstall'] as const).flatMap((name) => scripts[name] ? [{ name, command: scripts[name], location: null }] : []),
  };
}

export interface AgentInputBuildData { context: AnalysisContext; calculatedIntegrity: string; analyzerResults: readonly AnalyzerResult[]; atomicEvidences: readonly AtomicEvidenceV0_1[]; triggerDecision: AgentTriggerDecision; settings: LlmAgentEnvironment }
@Injectable()
export class LlmAgentInputBuilderService {
  constructor(private readonly codeSlices: LlmAgentCodeSliceService) {}
  async build(data: AgentInputBuildData): Promise<AgentAnalysisRequest> {
    const { context, settings } = data;
    const missingData: AgentMissingData[] = [];
    if (!data.calculatedIntegrity) missingData.push({ type: 'INTEGRITY', description: 'Verified SHA-512 SRI unavailable', impact: 'Artifact integrity cannot be shown to Agent' });
    const packageContext = projectPackageContext(context.metadata.packageJson);
    const findings = data.analyzerResults.flatMap((result) => result.findings.map((finding) => ({
      findingId: finding.findingId, analyzer: result.analyzer, analyzerVersion: result.analyzerVersion,
      ruleId: finding.ruleId, kind: finding.type, description: finding.message,
      location: safeLocation(finding.location, missingData), rawMatch: typeof finding.data.match === 'string' ? finding.data.match : typeof finding.data.rawMatch === 'string' ? finding.data.rawMatch : null,
    })));
    const atomicEvidences = data.atomicEvidences.map((evidence) => ({
      evidenceId: evidence.evidenceId, signal: evidence.signal, assertion: evidence.assertion,
      sources: evidence.sources.map((source) => ({ ...source })),
      locations: evidence.locations.map((location) => safeLocation(location, missingData)).filter((location): location is AgentLocation => location !== null),
      limitations: [...evidence.limitations],
    }));
    const built = await this.codeSlices.build(context.artifact.extractedPath, packageContext, findings, {
      maxInitialSlices: settings.LLM_AGENT_MAX_INITIAL_SLICES, maxLinesPerSlice: settings.LLM_AGENT_MAX_LINES_PER_SLICE,
      maxInitialCodeLines: settings.LLM_AGENT_MAX_INITIAL_CODE_LINES, maxTotalCodeLines: settings.LLM_AGENT_MAX_TOTAL_CODE_LINES,
      maxFileSizeBytes: settings.LLM_AGENT_MAX_FILE_SIZE_BYTES,
    });
    missingData.push(...built.missingData);
    const targets: AgentAnalysisTarget[] = [];
    const conditions = data.triggerDecision.matchedConditions;
    if (conditions.includes('SENSITIVE_ACCESS_WITH_NETWORK')) targets.push('ENV_OR_SENSITIVE_FILE_TO_NETWORK');
    if (conditions.includes('DOWNLOAD_WRITE_EXECUTION_COMBINATION')) targets.push('NETWORK_DOWNLOAD_TO_FILE_WRITE_TO_PROCESS_EXECUTION');
    if (conditions.includes('LIFECYCLE_WITH_PROCESS_EXECUTION')) targets.push('LIFECYCLE_TO_PROCESS_EXECUTION');
    return {
      request: { analysisRequestId: randomUUID(), requestType: 'MALICIOUS_CODE_ANALYSIS', schemaVersion: settings.LLM_AGENT_INPUT_SCHEMA_VERSION, createdAt: new Date().toISOString(), requestId: context.requestId, scanId: context.scanId, inputProfile: 'CODE_FINDING_EVIDENCE' },
      subject: { ecosystem: 'npm', packageName: context.package.name, packageVersion: context.package.version, artifactHash: context.artifact.hash, integrity: data.calculatedIntegrity },
      packageContext, findings, atomicEvidences, analysisPolicy: { maxToolCalls: settings.LLM_AGENT_MAX_TOOL_CALLS, maxAdditionalCodeRequests: settings.LLM_AGENT_MAX_ADDITIONAL_CODE_REQUESTS, maxTotalCodeLines: settings.LLM_AGENT_MAX_TOTAL_CODE_LINES },
      initialCodeSlices: built.slices, analysisTargets: targets, toolResponseCatalog: AGENT_TOOL_CATALOG.map((item) => ({ ...item })), missingData,
    };
  }
}
