import type { AnalysisLimitationDiagnostic, EvidenceIntegrityValidation, ValidatedAssessment } from '../output.contract';
import type { AgentAnalysisInputV0_3 } from './agent-analysis-input.contract';
import type { CompletedAgentOutputV0_2 } from './agent-output-v0_2.contract';
import type { AgentAssessmentV0_3, CompletedAgentOutputV0_3 } from './agent-output-v0_3.contract';
import type { ArtifactResolver } from './artifact.contract';
import { ArtifactReadError, readArtifactSource, sha256Hex, type ArtifactSource } from './code-slice.factory';
import type { CodeSliceRegistry } from './code-slice.registry';

/**
 * Artifact-aware Output Validator for input 0.3.0 and legacy output 0.2.0 or
 * structured output 0.3.0. Code is
 * re-verified through sliceId → CodeSliceRegistry → artifactId →
 * ArtifactResolver instead of `root + slice.file`, so INITIAL and RUNTIME
 * slices share one lookup and the same filePath in different artifacts never
 * collides. Per-assessment isolation and the Scanner-side VERIFIED /
 * PARTIALLY_VERIFIED / REJECTED structure checks remain assessment-local.
 */

export interface ArtifactValidationContext {
  registry: CodeSliceRegistry;
  resolver: ArtifactResolver;
  maxFileSizeBytes: number;
  signal?: AbortSignal;
}

type ArtifactCompletedOutput = CompletedAgentOutputV0_2 | CompletedAgentOutputV0_3;
type ArtifactAssessment = CompletedAgentOutputV0_2['assessments'][number] | AgentAssessmentV0_3;
export interface ValidatedAgentAnalysisResultV0_3 { output: ArtifactCompletedOutput; assessments: ValidatedAssessment<ArtifactAssessment>[] }

function artifactsById<T extends { artifactId: string }>(bindings: readonly T[], key: (binding: T) => string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const set = map.get(key(binding)) ?? new Set<string>();
    set.add(binding.artifactId);
    map.set(key(binding), set);
  }
  return map;
}

export class ArtifactOutputValidator {
  async validate(input: AgentAnalysisInputV0_3, output: ArtifactCompletedOutput, context: ArtifactValidationContext): Promise<ValidatedAgentAnalysisResultV0_3> {
    if (output.requestId !== input.request.analysisRequestId) throw new Error('Agent output requestId mismatch');
    const findingIds = new Set(input.findings.map((item) => item.findingId));
    const evidenceIds = new Set(input.atomicEvidences.map((item) => item.evidenceId));
    const targets = new Map(input.analysisPlan.targets.map((item) => [item.targetId, item]));
    const findingArtifacts = artifactsById(input.artifactContext.findingLocations, (binding) => binding.findingId);
    const evidenceArtifacts = artifactsById(input.artifactContext.evidenceLocations, (binding) => binding.evidenceId);
    // One read per artifact file per validation run; a failed read is kept as its reason.
    const sources = new Map<string, Promise<ArtifactSource | ArtifactReadError>>();
    const readSource = (artifactId: string, filePath: string) => {
      const key = JSON.stringify([artifactId, filePath]);
      if (!sources.has(key)) {
        sources.set(key, readArtifactSource(context.resolver, artifactId, filePath, context.maxFileSizeBytes, context.signal)
          .catch((error: unknown) => { if (error instanceof ArtifactReadError) return error; throw error; }));
      }
      return sources.get(key)!;
    };

    const ids = new Set<string>();
    const assessments: ValidatedAssessment<ArtifactAssessment>[] = [];
    for (const assessment of output.assessments) {
      const issues: string[] = [];
      if (ids.has(assessment.id)) issues.push('Duplicate assessment ID');
      ids.add(assessment.id);
      const refIds = new Set<string>();
      const citedArtifacts = new Set<string>();
      for (const ref of assessment.refs) {
        if (refIds.has(ref.id)) issues.push('Duplicate reference ID');
        refIds.add(ref.id);
        const slice = context.registry.get(ref.sliceId);
        if (!slice) { issues.push('Unknown slice'); continue; }
        citedArtifacts.add(slice.artifactId);
        if (ref.lines[0] < slice.startLine || ref.lines[1] > slice.endLine || ref.lines[0] > ref.lines[1]) issues.push('Reference outside slice');
        if (sha256Hex(slice.content) !== slice.contentSha256) issues.push('Slice hash mismatch');
        if (slice.origin === 'INITIAL') {
          const target = slice.planningTargetId === null ? undefined : targets.get(slice.planningTargetId);
          if (!target) issues.push('Unknown planning target');
          else if (target.artifactId !== slice.artifactId || target.filePath !== slice.filePath) issues.push('Planning target and slice mismatch');
        }
        if (!context.resolver.describe(slice.artifactId)) { issues.push('Unknown artifact'); continue; }
        const source = await readSource(slice.artifactId, slice.filePath);
        if (source instanceof ArtifactReadError) { issues.push('Source file unavailable or unsafe'); continue; }
        if (ref.lines[1] > source.lineCount || slice.endLine > source.lineCount) { issues.push('Reference outside source file'); continue; }
        const raw = source.lines.slice(slice.startLine - 1, slice.endLine).join('\n');
        if (sha256Hex(raw) !== slice.sourceSha256) issues.push('Source changed after slicing');
        if (raw !== slice.content) issues.push('Source and slice mismatch');
      }
      const flow = assessment.flow;
      for (const id of [flow.trigger, flow.source, ...(flow.transforms ?? []), flow.sink, ...(flow.conditions ?? [])]) if (id && !refIds.has(id)) issues.push('Unknown flow reference');
      for (const id of assessment.findingIds ?? []) if (!findingIds.has(id)) issues.push('Unknown Finding ID');
      for (const id of assessment.atomicEvidenceIds ?? []) if (!evidenceIds.has(id)) issues.push('Unknown Atomic Evidence ID');
      issues.push(...lineageIssues(assessment, citedArtifacts, findingArtifacts, evidenceArtifacts));
      if (output.schemaVersion === '0.3.0') {
        const structured = assessment as AgentAssessmentV0_3;
        const analysisLimitations = limitationDiagnostics(structured, output);
        const evidenceIntegrity = integrityValidation(structured, issues, analysisLimitations);
        assessments.push({ assessment, status: projectedStatus(evidenceIntegrity), issues, evidenceIntegrity });
      } else {
        assessments.push({ assessment, status: legacyStatus(assessment, issues, output), issues });
      }
    }
    return { output, assessments };
  }
}

/**
 * A Finding or Evidence bound to artifacts that none of the cited slices come
 * from means original and deobfuscated lines were mixed up. Unbound items are
 * skipped; citing both ORIGINAL and DEOBFUSCATED slices is allowed.
 */
function lineageIssues(assessment: ArtifactAssessment, cited: ReadonlySet<string>, findings: Map<string, Set<string>>, evidences: Map<string, Set<string>>): string[] {
  if (cited.size === 0) return [];
  const issues: string[] = [];
  const mismatched = (bound: Set<string> | undefined) => bound !== undefined && ![...bound].some((artifactId) => cited.has(artifactId));
  for (const id of assessment.findingIds ?? []) if (mismatched(findings.get(id))) issues.push('Finding artifact lineage mismatch');
  for (const id of assessment.atomicEvidenceIds ?? []) if (mismatched(evidences.get(id))) issues.push('Atomic Evidence artifact lineage mismatch');
  return issues;
}

function limitationDiagnostics(assessment: AgentAssessmentV0_3, output: CompletedAgentOutputV0_3): AnalysisLimitationDiagnostic[] {
  const local = assessment.limitations.map(({ kind, detail }) => ({ source: 'ASSESSMENT' as const, kind, detail }));
  const global = output.missingContext
    .filter(({ affectedAssessmentIds }) => affectedAssessmentIds === undefined || affectedAssessmentIds.includes(assessment.id))
    .map(({ kind, detail, affectedAssessmentIds }) => ({
      source: 'GLOBAL_MISSING_CONTEXT' as const,
      kind,
      detail,
      ...(affectedAssessmentIds === undefined ? {} : { affectedAssessmentIds: [...affectedAssessmentIds] }),
    }));
  return [...local, ...global];
}

function integrityValidation(assessment: AgentAssessmentV0_3, issues: readonly string[], analysisLimitations: AnalysisLimitationDiagnostic[]): EvidenceIntegrityValidation {
  const status = issues.length > 0 ? 'REJECTED'
    : !assessment.findingIds?.length && !assessment.atomicEvidenceIds?.length ? 'INCOMPLETE'
      : 'PASSED';
  return { criteriaVersion: 'EVIDENCE_INTEGRITY_V1', status, errors: [...issues], analysisLimitations };
}

function projectedStatus(validation: EvidenceIntegrityValidation): ValidatedAssessment['status'] {
  if (validation.status === 'REJECTED') return 'REJECTED';
  if (validation.status === 'INCOMPLETE') return 'PARTIALLY_VERIFIED';
  return 'VERIFIED';
}

function legacyStatus(assessment: ArtifactAssessment, issues: readonly string[], output: CompletedAgentOutputV0_2): ValidatedAssessment['status'] {
  if (issues.length > 0) return 'REJECTED';
  if (!assessment.findingIds?.length && !assessment.atomicEvidenceIds?.length) return 'PARTIALLY_VERIFIED';
  if (output.missingContext.length > 0 || (assessment.limitations?.length ?? 0) > 0) return 'PARTIALLY_VERIFIED';
  return 'VERIFIED';
}
