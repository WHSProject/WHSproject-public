import { Injectable, Logger } from '@nestjs/common';
import type { AgentAnalysisRequest } from './agent.contract';
import type { AgentAnalysisResultV0_3 } from './agent-runner.service';
import type { AgentAnalysisInputV0_3 } from './artifact/agent-analysis-input.contract';
import type { AgentAssessmentV0_3, StructuredLimitation } from './artifact/agent-output-v0_3.contract';
import type { ArtifactDescriptor, ArtifactResolver, CodeRepresentation, LineageStatus } from './artifact/artifact.contract';
import type { AnalysisLimitationDiagnostic, AgentAnalysisResult, AgentAnalysisSummary, AgentAssessment, ValidatedAssessment } from './output.contract';
import type { EvidenceSource } from '../evidence/normalizer/evidence-normalizer.types';
import { mapDerivedLineRange, mappingForPath } from '../analyzers/obfuscation/line-mapping';

export interface LlmAssessmentEvidence {
  schemaVersion: '0.1'; evidenceId: string; kind: 'LLM_ASSESSMENT';
  signal: { id: string; type: string; category: string };
  subject: { ecosystem: 'npm'; packageName: string; packageVersion: string; artifactHash: string };
  assertion: { summary: string; basis: AgentAssessment['basis'] }; executionContext: { flow: AgentAssessment['flow'] };
  reachability: AgentAssessment['reachability']; intentAssessment: NonNullable<AgentAssessment['intentAssessment']>; verificationStatus: 'VERIFIED';
  confidence: number; reasonCodes: string[]; alternatives: NonNullable<AgentAssessment['alternatives']>;
  /** Shared Evidence location shape (`evidence-v0.1.schema.json`); Evidence API and Policy reject other keys such as `file`. */
  locations: Array<{ type: 'SOURCE_FILE'; path: string; startLine: number; endLine: number; role: AgentAssessment['refs'][number]['role']; representation?: CodeRepresentation; lineageStatus?: LineageStatus; derivedFrom?: EvidenceLocationDerivedFrom }>;
  relatedFindingIds: string[]; relatedAtomicEvidenceIds: string[];
  sources: EvidenceSource[]; limitations: string[]; provenance: { scanId: string; producerType: 'LLM_AGENT'; analysisId: string; assessmentId: string; agentType: 'SINGLE_AGENT'; agentVersion: string; model: string; promptVersion: string; inputSchemaVersion: string; outputSchemaVersion: string };
}
export interface EvidenceLocationDerivedFrom { path: string; startLine?: number; endLine?: number }
export interface LlmEvidenceConversionFailure { assessmentId: string; reason: 'EVIDENCE_CONVERSION_FAILED' }
export interface LlmEvidenceConversionResult { evidences: LlmAssessmentEvidence[]; failures: LlmEvidenceConversionFailure[] }

/**
 * Lineage of one cited location. Original code is DIRECT. Deobfuscated code is
 * UNMAPPED until line mappings to the original are available (same rule as the
 * Evidence Normalizer for Tier 2 locations); MAPPED needs per-line data.
 */
function locationLineage(
  artifact: Pick<ArtifactDescriptor, 'representation' | 'lineageStatus' | 'lineMappings'>,
  filePath: string,
  startLine: number,
  endLine: number,
): { lineageStatus: LineageStatus; derivedFrom?: EvidenceLocationDerivedFrom } {
  if (artifact.representation === 'ORIGINAL') return { lineageStatus: 'DIRECT' };
  const mapping = mappingForPath(artifact.lineMappings, filePath);
  const lineage = mapDerivedLineRange(mapping, mapping?.sourcePath ?? filePath, startLine, endLine);
  return {
    lineageStatus: lineage.lineageStatus,
    derivedFrom: {
      path: lineage.derivedFrom.path,
      ...(lineage.derivedFrom.startLine === undefined ? {} : { startLine: lineage.derivedFrom.startLine }),
      ...(lineage.derivedFrom.endLine === undefined ? {} : { endLine: lineage.derivedFrom.endLine }),
    },
  };
}

type EvidenceLocation = LlmAssessmentEvidence['locations'][number];
type EvidenceSubject = LlmAssessmentEvidence['subject'];

/** What differs between the 0.2.0 and 0.3.0 inputs; VERIFIED-only conversion, de-duplication and failure isolation are shared. */
interface ConversionContext {
  scanId: string;
  subject: EvidenceSubject;
  findings: ReadonlyArray<{ findingId: string; analyzer: string; analyzerVersion: string; ruleId: string }>;
  inputSchemaVersion: string;
  locations(assessment: AgentAssessment | AgentAssessmentV0_3): EvidenceLocation[];
}

function evidenceLimitations(
  limitations: readonly string[] | readonly StructuredLimitation[] | undefined,
  diagnostics: readonly AnalysisLimitationDiagnostic[] | undefined,
): string[] {
  if (diagnostics !== undefined) return diagnostics.map(({ source, kind, detail }) => `[${source}][${kind}] ${detail}`);
  return (limitations ?? []).map((item) => typeof item === 'string' ? item : `[ASSESSMENT][${item.kind}] ${item.detail}`);
}

@Injectable()
export class LlmEvidenceAdapter {
  private readonly logger = new Logger(LlmEvidenceAdapter.name);

  toEvidences(request: AgentAnalysisRequest, result: AgentAnalysisResult): LlmEvidenceConversionResult {
    if ((result.status !== 'COMPLETED' && result.status !== 'PARTIAL') || !result.validated) return { evidences: [], failures: [] };
    const slices = new Map((result.effectiveRequest ?? request).initialCodeSlices.map((slice) => [slice.sliceId, slice]));
    return this.convert(result, result.validated.assessments, {
      scanId: request.request.scanId,
      subject: { ecosystem: request.subject.ecosystem, packageName: request.subject.packageName, packageVersion: request.subject.packageVersion, artifactHash: request.subject.artifactHash },
      findings: request.findings,
      inputSchemaVersion: request.request.schemaVersion,
      locations: (assessment) => assessment.refs.flatMap((ref) => { const slice = slices.get(ref.sliceId); return slice ? [{ type: 'SOURCE_FILE' as const, path: slice.file, startLine: ref.lines[0], endLine: ref.lines[1], role: ref.role }] : []; }),
    });
  }

  /**
   * Input 0.3.0 path. References resolve through the result's registry slices
   * (INITIAL and RUNTIME) to artifact, file and the Validator-checked lines;
   * each location records the artifact's `representation` (#390), so no
   * separate artifact binding is produced. Lineage uses the resolver's full
   * line mappings: the Agent input keeps only the initial-slice part (#382), so
   * RUNTIME slice lines outside it would otherwise look UNMAPPED.
   */
  toEvidencesV0_3(input: AgentAnalysisInputV0_3, result: AgentAnalysisResultV0_3, resolver: Pick<ArtifactResolver, 'describe'>): LlmEvidenceConversionResult {
    if ((result.status !== 'COMPLETED' && result.status !== 'PARTIAL') || !result.validated) return { evidences: [], failures: [] };
    const slices = new Map(result.slices.map((slice) => [slice.sliceId, slice]));
    const listed = new Set(input.artifactContext.artifacts.map((artifact) => artifact.artifactId));
    const artifactOf = (artifactId: string) => {
      const artifact = listed.has(artifactId) ? resolver.describe(artifactId) : undefined;
      if (!artifact) throw new Error('Unknown artifact');
      return artifact;
    };
    const sliceOf = (sliceId: string) => {
      const slice = slices.get(sliceId);
      if (!slice) throw new Error('Unknown slice');
      return slice;
    };
    return this.convert(result, result.validated.assessments, {
      scanId: input.request.scanId,
      subject: { ecosystem: input.subject.ecosystem, packageName: input.subject.packageName, packageVersion: input.subject.packageVersion, artifactHash: input.subject.archiveSha256 },
      findings: input.findings.map((finding) => ({ ...finding, analyzerVersion: finding.analyzerVersion ?? 'unknown' })),
      inputSchemaVersion: input.request.schemaVersion,
      locations: (assessment) => assessment.refs.map((ref) => {
        const slice = sliceOf(ref.sliceId);
        const artifact = artifactOf(slice.artifactId);
        return {
          type: 'SOURCE_FILE' as const,
          path: slice.filePath,
          startLine: ref.lines[0],
          endLine: ref.lines[1],
          role: ref.role,
          representation: artifact.representation,
          ...locationLineage(artifact, slice.filePath, ref.lines[0], ref.lines[1]),
        };
      }),
    });
  }

  private convert(result: Pick<AgentAnalysisResult, 'analysisId' | 'model' | 'promptVersion' | 'outputSchemaVersion'>,
    validated: readonly ValidatedAssessment<AgentAssessment | AgentAssessmentV0_3>[], context: ConversionContext): LlmEvidenceConversionResult {
    const seen = new Set<string>();
    const evidences: LlmAssessmentEvidence[] = [];
    const failures: LlmEvidenceConversionFailure[] = [];
    for (const [index, { assessment, status, evidenceIntegrity }] of validated.entries()) {
      const integrityEligible = result.outputSchemaVersion === '0.3.0'
        ? evidenceIntegrity?.criteriaVersion === 'EVIDENCE_INTEGRITY_V1' && evidenceIntegrity.status === 'PASSED'
        : status === 'VERIFIED';
      if (!integrityEligible) continue;
      try {
      if (!assessment.findingIds?.length && !assessment.atomicEvidenceIds?.length) continue;
      const key = JSON.stringify([assessment.signal, [...(assessment.findingIds ?? [])].sort(), [...(assessment.atomicEvidenceIds ?? [])].sort(), assessment.refs.map((ref) => [ref.sliceId, ref.lines]).sort()]);
      if (seen.has(key)) continue;
      const evidence: LlmAssessmentEvidence = { schemaVersion: '0.1', evidenceId: `llm:${result.analysisId}:${assessment.id}`, kind: 'LLM_ASSESSMENT',
        signal: { id: assessment.signal, type: assessment.signal, category: assessment.category },
        subject: { ...context.subject },
        assertion: { summary: assessment.rationale ?? assessment.signal, basis: assessment.basis }, executionContext: { flow: assessment.flow },
        reachability: assessment.reachability, intentAssessment: assessment.intentAssessment ?? 'UNKNOWN', verificationStatus: 'VERIFIED',
        confidence: assessment.confidence, reasonCodes: [...assessment.reasonCodes], alternatives: assessment.alternatives ?? [],
        locations: context.locations(assessment),
        relatedFindingIds: assessment.findingIds ?? [], relatedAtomicEvidenceIds: assessment.atomicEvidenceIds ?? [],
        sources: context.findings.filter((finding) => assessment.findingIds?.includes(finding.findingId)).map((finding) => ({ analyzer: finding.analyzer, analyzerVersion: finding.analyzerVersion, ruleId: finding.ruleId, rawFindingId: finding.findingId })),
        limitations: evidenceLimitations(assessment.limitations, evidenceIntegrity?.analysisLimitations), provenance: { scanId: context.scanId, producerType: 'LLM_AGENT', analysisId: result.analysisId, assessmentId: assessment.id,
          agentType: 'SINGLE_AGENT', agentVersion: '0.1.0', model: result.model ?? '', promptVersion: result.promptVersion,
          inputSchemaVersion: context.inputSchemaVersion, outputSchemaVersion: result.outputSchemaVersion },
      };
      evidences.push(evidence);
      seen.add(key);
      } catch (error) {
        let assessmentId = `assessment-${index + 1}`;
        try { if (typeof assessment.id === 'string') assessmentId = assessment.id; } catch { /* malformed Assessment ID */ }
        failures.push({ assessmentId, reason: 'EVIDENCE_CONVERSION_FAILED' });
        this.logger.warn(JSON.stringify({ scanId: context.scanId, analysisId: result.analysisId, assessmentId,
          failureStage: 'LLM_EVIDENCE_CONVERSION', errorType: error instanceof Error ? 'ERROR' : 'UNKNOWN' }));
      }
    }
    return { evidences, failures };
  }
}

/** Fields `agentSummary` reads; both the 0.2.0 and the 0.3.0 run results provide them. */
type SummarizedRun = Omit<AgentAnalysisResult, 'output' | 'validated' | 'effectiveRequest'> & {
  validated?: {
    assessments: readonly ValidatedAssessment<
      AgentAssessment | AgentAssessmentV0_3
    >[];
  };
};

export function agentSummary(result: SummarizedRun, conversion: LlmEvidenceConversionResult, triggerReason: string): AgentAnalysisSummary {
  const assessments = result.validated?.assessments ?? [];
  const rejectedCount = assessments.filter((item) => item.status === 'REJECTED').length + conversion.failures.length;
  return { status: conversion.failures.length > 0 && result.status === 'COMPLETED' ? 'PARTIAL' : result.status, analysisId: result.analysisId, assessmentCount: assessments.length,
    verifiedAssessmentCount: assessments.filter((item) => item.status === 'VERIFIED').length,
    generatedEvidenceCount: conversion.evidences.length, rejectedAssessmentCount: rejectedCount,
    limitations: [...result.limitations, ...(conversion.failures.length > 0 ? ['LLM Evidence conversion failed for one or more Assessments'] : [])],
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    model: result.model, promptVersion: result.promptVersion, toolCalls: result.toolCalls, additionalCodeRequests: result.additionalCodeRequests,
    modelCalls: result.modelCalls, usage: result.usage, durationMs: result.durationMs, triggerReason };
}
