import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { ArtifactFileManager } from '../../artifact/storage/artifact-file-manager';
import {
  PackageDeadline,
} from '../package-deadline';
import { loadScannerEnvironment } from '../../config/scanner-environment';
import type { ScanResult } from '../../domain/analysis.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { ScanHistoryService } from '../../history/scan-history.service';
import {
  PolicyEvaluationClient,
  PolicyEvaluationError,
} from '../../policy/policy-evaluation.client';
import { Orchestrator } from '../orchestrator/orchestrator';
import { buildPolicyEvaluationRequest } from '../../policy/policy-evaluation.request';
import { EvidencePersistenceClient } from '../../evidence/evidence-persistence.client';

export interface ScanRequest {
  requestId: string;
  packageName: string;
  version: string;
  integrity?: string | null;
  registryId?: string;
}

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly history: ScanHistoryService,
    private readonly policyEvaluationClient: PolicyEvaluationClient,
    private readonly artifactFileManager: ArtifactFileManager,
    @Optional() private readonly evidencePersistenceClient?: EvidencePersistenceClient,
  ) {}

  async scan(request: ScanRequest): Promise<ScanResult> {
    const scanId = randomUUID();
    const deadline = new PackageDeadline(
      loadScannerEnvironment().SCANNER_PACKAGE_TIMEOUT_MS,
    );

    try {
      const execution = await this.orchestrator.execute({
        requestId: request.requestId,
        scanId,
        registryId: request.registryId ?? 'npmjs',
        packageName: request.packageName,
        packageVersion: request.version,
        expectedIntegrity: request.integrity,
      }, deadline);

      const saved = await this.history.save(execution.scanResult);
      const calculatedIntegrity = execution.calculatedIntegrity;
      const policyPrerequisitesMissing =
        execution.policyEligible === false
        || calculatedIntegrity === undefined
        || saved.artifactHash === '';
      if (policyPrerequisitesMissing && saved.status === 'TIMEOUT') {
        return saved;
      }
      if (policyPrerequisitesMissing) {
        throw new PolicyEvaluationError(
          'Policy Evaluation prerequisites are missing',
          null,
          false,
          ScannerErrorCode.POLICY_EVALUATION_FAILED,
        );
      }

      await this.evidencePersistenceClient?.saveAll(saved.evidences);
      await this.policyEvaluationClient.evaluate(buildPolicyEvaluationRequest(saved, execution, calculatedIntegrity));
      return saved;
    } finally {
      deadline.dispose();
      await this.cleanupArtifacts(scanId);
    }
  }

  private async cleanupArtifacts(scanId: string): Promise<void> {
    try {
      const cleanupError = await this.artifactFileManager.cleanupByScanId(scanId);
      if (cleanupError !== undefined) {
        this.logger.warn(`Artifact cleanup failed for scan ${scanId}: ${cleanupError.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown cleanup error';
      this.logger.warn(`Artifact cleanup failed for scan ${scanId}: ${message}`);
    }
  }
}
