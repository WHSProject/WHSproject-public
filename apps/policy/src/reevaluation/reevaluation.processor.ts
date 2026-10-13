import type { Evidence } from '../contracts/evidence';
import type { PolicySnapshot } from '../contracts/policy';
import { HttpDecisionDbClient } from '../decision/decision-db.client';
import { HttpPolicyLlmAuditClient } from '../llm/policy-llm-audit.client';
import { PolicyEvaluationService } from '../evaluation/policy-evaluation.service';
import { HttpActivePolicyClient } from '../policy/active-policy.client';
import {
  feedRequestFromSnapshot,
  HttpReevaluationJobClient,
  type ReevaluationJob,
  type ReevaluationJobClient,
} from './reevaluation.client';

export interface ReevaluationProcessResult {
  jobId: string;
  status: 'SKIPPED' | 'COMPLETED' | 'FAILED';
  decisionId?: string;
  errorCode?: string;
}

export interface ReevaluationAuditStore {
  save(audit: NonNullable<Awaited<ReturnType<PolicyEvaluationService['evaluate']>>['audit']>): Promise<unknown>;
}

export class PolicyReevaluationProcessor {
  constructor(
    private readonly jobs: ReevaluationJobClient,
    private readonly policyClient: Pick<HttpActivePolicyClient, 'fetchActive'>,
    private readonly evaluator: PolicyEvaluationService,
    private readonly auditClient: ReevaluationAuditStore,
    private readonly decisionClient: Pick<HttpDecisionDbClient, 'save'>,
  ) {}

  async process(jobId: string): Promise<ReevaluationProcessResult> {
    let claim: Awaited<ReturnType<ReevaluationJobClient['claim']>>;
    try {
      claim = await this.jobs.claim(jobId);
    } catch (error) {
      return { jobId, status: 'FAILED', errorCode: errorCode(error) };
    }
    if (!claim.claimed) return { jobId, status: claim.job.status === 'COMPLETED' ? 'COMPLETED' : 'SKIPPED' };

    const job = claim.job;
    try {
      const previous = await this.jobs.getDecision(job.previousDecisionId);
      if (previous.feedSnapshotId !== job.previousSnapshotId) throw new Error('REEVALUATION_PREVIOUS_SNAPSHOT_MISMATCH');
      const snapshot = await this.jobs.getSnapshot(job.triggerSnapshotId);
      validateSnapshot(job, snapshot);
      const artifactHash = previous.subject.artifactHash256 ?? previous.subject.artifactHash512;
      if (!artifactHash) throw new Error('REEVALUATION_ARTIFACT_IDENTITY_MISSING');
      const stored = await this.jobs.getEvidence({
        ecosystem: previous.subject.ecosystem,
        packageName: previous.subject.packageName,
        packageVersion: previous.subject.packageVersion,
        artifactHash,
        scanId: previous.scanId,
      });
      const evidences = selectReferencedEvidence(previous.evidenceIds, previous.assessmentIds, stored);
      const policy = await this.policyClient.fetchActive();
      const request = feedRequestFromSnapshot(previous, snapshot, evidences);
      const evaluation = await this.evaluator.evaluate(request, policy);

      if (evaluation.audit) await this.auditClient.save(evaluation.audit);
      if (evaluation.shadow) await this.auditClient.save(evaluation.shadow.audit);
      if (evaluation.llm.status !== 'COMPLETED') throw new Error(evaluation.llm.failureCode ?? 'POLICY_LLM_UNAVAILABLE');

      const decisionId = `dec_${previous.requestId}_reeval_${job.id}`;
      await this.decisionClient.save(
        request,
        policy,
        evaluation.decision,
        new Date().toISOString(),
        { snapshotId: snapshot.id },
        {
          decisionId,
          previousDecisionId: previous.decisionId,
          triggerSnapshotId: snapshot.id,
          reevaluationJobId: job.id,
        },
      );
      return { jobId, status: 'COMPLETED', decisionId };
    } catch (error) {
      const code = errorCode(error);
      try { await this.jobs.fail(job.id, code, error instanceof Error ? error.message : String(error)); } catch { /* preserve the original failure */ }
      return { jobId, status: 'FAILED', errorCode: code };
    }
  }
}

function validateSnapshot(job: ReevaluationJob, snapshot: Awaited<ReturnType<ReevaluationJobClient['getSnapshot']>>): void {
  if (snapshot.id !== job.triggerSnapshotId || snapshot.source !== 'OSV' || snapshot.ecosystem !== job.ecosystem
    || snapshot.packageName !== job.packageName || snapshot.packageVersion !== job.packageVersion
    || !Array.isArray(snapshot.rawAdvisories) || !/^[0-9a-f]{64}$/u.test(snapshot.contentDigest)) {
    throw new Error('REEVALUATION_INVALID_TRIGGER_SNAPSHOT');
  }
}

function selectReferencedEvidence(evidenceIds: string[], assessmentIds: string[], stored: Evidence[]): Evidence[] {
  const requiredEvidenceIds = new Set(evidenceIds);
  const requiredAssessmentIds = new Set(assessmentIds);
  const selected = stored.filter((evidence) => requiredEvidenceIds.has(evidence.evidenceId)
    || (evidence.kind === 'LLM_ASSESSMENT' && (
      requiredAssessmentIds.has(evidence.evidenceId)
      || (typeof evidence.provenance.assessmentId === 'string' && requiredAssessmentIds.has(evidence.provenance.assessmentId))
    )));
  const foundEvidenceIds = new Set(selected.map((evidence) => evidence.evidenceId));
  for (const evidenceId of evidenceIds) if (!foundEvidenceIds.has(evidenceId)) throw new Error(`REEVALUATION_EVIDENCE_NOT_FOUND:${evidenceId}`);
  for (const assessmentId of assessmentIds) {
    if (!selected.some((evidence) => evidence.kind === 'LLM_ASSESSMENT' && (evidence.evidenceId === assessmentId || evidence.provenance.assessmentId === assessmentId))) {
      throw new Error(`REEVALUATION_ASSESSMENT_NOT_FOUND:${assessmentId}`);
    }
  }
  return selected;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(':', 1)[0] || 'REEVALUATION_FAILED';
}

export function createDefaultReevaluationProcessor(
  evaluator: PolicyEvaluationService,
): PolicyReevaluationProcessor {
  return new PolicyReevaluationProcessor(
    new HttpReevaluationJobClient(),
    new HttpActivePolicyClient(),
    evaluator,
    new HttpPolicyLlmAuditClient(),
    new HttpDecisionDbClient(),
  );
}
