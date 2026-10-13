import { createHash } from 'node:crypto';

import type { AnalyzerResult, Finding, FindingLocation } from '../../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';

export const AGENT_FINDING_CONTRACT_VERSION = '0.3.0';
export const AGENT_FINDING_PROJECTION_VERSION = '1.0.0';
export const AGENT_FINDING_DATA_MAX_BYTES = 65_536;
export const AGENT_FINDING_ANALYZERS = ['guarddog', 'metadata', 'custom-rule'] as const;
export type AgentFindingAnalyzer = (typeof AGENT_FINDING_ANALYZERS)[number];

export interface AgentFindingV0_3 {
  findingId: string;
  analyzer: AgentFindingAnalyzer;
  analyzerVersion: string;
  ruleId: string;
  type: string;
  message: string;
  location?: FindingLocation;
  data: Record<string, unknown>;
}

export interface AgentFindingProjectionFailure {
  code: 'ANALYZER_CONTEXT_MISSING' | 'ANALYZER_VERSION_MISSING' | 'ANALYZER_UNSUPPORTED'
    | 'FINDING_INVALID' | 'FINDING_ID_DUPLICATE' | 'FINDING_DATA_INVALID'
    | 'FINDING_DATA_TOO_LARGE' | 'PATH_LEAK_DETECTED';
  analyzer?: string;
  findingId?: string;
  originalBytes?: number;
  projectedBytes?: number;
  sourceHash?: string;
}

export interface AgentFindingProjectionEnvelope {
  contractVersion: typeof AGENT_FINDING_CONTRACT_VERSION;
  projectionVersion: typeof AGENT_FINDING_PROJECTION_VERSION;
  findings: AgentFindingV0_3[];
  provenance: {
    sourceContract: 'apps/scanner/src/domain/analysis.types.ts#Finding';
    sourceContractHash: string;
    agentFindingContractHash: string;
    projectionHash: string;
    analyzerVersions: Record<string, string>;
  };
  failures: AgentFindingProjectionFailure[];
}

export function projectAgentFindingsV0_3(
  analyzerResults: readonly AnalyzerResult[], sourceContractHash: string, agentFindingContractHash: string,
): AgentFindingProjectionEnvelope {
  if (!/^[a-f0-9]{64}$/u.test(sourceContractHash)) throw new Error('SOURCE_CONTRACT_HASH_INVALID');
  if (!/^[a-f0-9]{64}$/u.test(agentFindingContractHash)) throw new Error('AGENT_FINDING_CONTRACT_HASH_INVALID');
  const findings: AgentFindingV0_3[] = [], failures: AgentFindingProjectionFailure[] = [];
  const analyzerVersions: Record<string, string> = {}, ids = new Set<string>();
  for (const result of analyzerResults) {
    if (!result.analyzer) { failures.push({ code: 'ANALYZER_CONTEXT_MISSING' }); continue; }
    if (!AGENT_FINDING_ANALYZERS.includes(result.analyzer as AgentFindingAnalyzer)) {
      failures.push({ code: 'ANALYZER_UNSUPPORTED', analyzer: result.analyzer }); continue;
    }
    if (!result.analyzerVersion) {
      failures.push({ code: 'ANALYZER_VERSION_MISSING', analyzer: result.analyzer }); continue;
    }
    analyzerVersions[result.analyzer] = result.analyzerVersion;
    for (const finding of result.findings) {
      const projected = projectOne(finding, result.analyzer as AgentFindingAnalyzer, result.analyzerVersion, failures);
      if (!projected) continue;
      if (ids.has(projected.findingId)) {
        failures.push({ code: 'FINDING_ID_DUPLICATE', analyzer: result.analyzer, findingId: projected.findingId });
        continue;
      }
      ids.add(projected.findingId); findings.push(projected);
    }
  }
  findings.sort(compareFindings);
  const stableFindings = canonicalize(findings) as unknown as AgentFindingV0_3[];
  return {
    contractVersion: AGENT_FINDING_CONTRACT_VERSION,
    projectionVersion: AGENT_FINDING_PROJECTION_VERSION,
    findings: stableFindings,
    provenance: {
      sourceContract: 'apps/scanner/src/domain/analysis.types.ts#Finding', sourceContractHash,
      agentFindingContractHash,
      projectionHash: sha256(canonicalJson(stableFindings)),
      analyzerVersions: canonicalize(analyzerVersions) as Record<string, string>,
    },
    failures,
  };
}

export function validateAtomicEvidenceCompatibilityV0_3(
  evidences: readonly AtomicEvidenceV0_1[], findings: readonly AgentFindingV0_3[],
  expectedArtifactHash: string,
): void {
  const findingIds = new Set(findings.map(({ findingId }) => findingId)), evidenceIds = new Set<string>();
  for (const evidence of evidences) {
    if (evidenceIds.has(evidence.evidenceId)) throw new Error(`DUPLICATE_EVIDENCE_ID:${evidence.evidenceId}`);
    evidenceIds.add(evidence.evidenceId);
    if (evidence.subject.artifactHash !== expectedArtifactHash) throw new Error(`FOREIGN_EVIDENCE_SUBJECT:${evidence.evidenceId}`);
    for (const source of evidence.sources) {
      if (!findingIds.has(source.rawFindingId)) throw new Error(`DANGLING_EVIDENCE_SOURCE:${source.rawFindingId}`);
      const finding = findings.find(({ findingId }) => findingId === source.rawFindingId)!;
      if (source.analyzer !== finding.analyzer || source.analyzerVersion !== finding.analyzerVersion || source.ruleId !== finding.ruleId) {
        throw new Error(`EVIDENCE_SOURCE_PROVENANCE_MISMATCH:${evidence.evidenceId}`);
      }
    }
  }
}

export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }

function projectOne(finding: Finding, analyzer: AgentFindingAnalyzer, analyzerVersion: string,
  failures: AgentFindingProjectionFailure[]): AgentFindingV0_3 | undefined {
  if (!finding.findingId || !finding.ruleId || !finding.type || typeof finding.message !== 'string') {
    failures.push({ code: 'FINDING_INVALID', analyzer, findingId: finding.findingId }); return undefined;
  }
  try {
    rejectUnsafe(finding.location); rejectUnsafe(finding.data);
    const data = canonicalize(finding.data) as Record<string, unknown>;
    const source = canonicalJson(finding.data), originalBytes = Buffer.byteLength(source), projectedBytes = Buffer.byteLength(canonicalJson(data));
    if (projectedBytes > AGENT_FINDING_DATA_MAX_BYTES) {
      failures.push({ code: 'FINDING_DATA_TOO_LARGE', analyzer, findingId: finding.findingId,
        originalBytes, projectedBytes, sourceHash: sha256(source) }); return undefined;
    }
    return canonicalize({ findingId:finding.findingId, analyzer, analyzerVersion, ruleId:finding.ruleId,
      type:finding.type, message:finding.message, ...(finding.location===undefined?{}:{location:finding.location}), data }) as unknown as AgentFindingV0_3;
  } catch (error) {
    failures.push({ code: error instanceof Error && error.message === 'PATH_LEAK_DETECTED' ? 'PATH_LEAK_DETECTED' : 'FINDING_DATA_INVALID',
      analyzer, findingId:finding.findingId }); return undefined;
  }
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('NON_FINITE_NUMBER'); return value; }
  if (typeof value !== 'object' || Buffer.isBuffer(value)) throw new Error('NON_JSON_VALUE');
  if (seen.has(value)) throw new Error('CIRCULAR_VALUE'); seen.add(value);
  const output = Array.isArray(value)
    ? value.map((item) => canonicalize(item, seen))
    : Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key], seen)]));
  seen.delete(value); return output;
}
function rejectUnsafe(value: unknown): void {
  if (typeof value === 'string' && (/\/analysis\/package/u.test(value) || /\/Users\/[^/]+/u.test(value) || /\/private\/tmp\//u.test(value))) throw new Error('PATH_LEAK_DETECTED');
  if (Array.isArray(value)) value.forEach(rejectUnsafe);
  else if (value && typeof value === 'object') Object.values(value).forEach(rejectUnsafe);
}
function compareFindings(a: AgentFindingV0_3,b: AgentFindingV0_3): number {
  const ak=[a.analyzer,a.findingId,a.ruleId,a.location?.path??'',String(a.location?.startLine??0)].join('\0');
  const bk=[b.analyzer,b.findingId,b.ruleId,b.location?.path??'',String(b.location?.startLine??0)].join('\0'); return ak.localeCompare(bk);
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
