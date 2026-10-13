import { Injectable } from '@nestjs/common';

import { DecisionLookupClient } from '../clients/decision-lookup.client';
import type { DecisionLookupRequestDto } from '../dto/decision-lookup.dto';
import type { ArtifactIdentity } from '../types/artifact.types';
import type { DecisionLookupBatch } from '../types/decision-lookup.types';
import type {
  DependencyResolutionResult,
} from '../types/dependency-tree.types';
import { DecisionLookupAdapterService } from './decision-lookup-adapter.service';

@Injectable()
export class DecisionLookupService {
  constructor(
    private readonly decisionLookupClient: DecisionLookupClient,
    private readonly decisionLookupAdapterService: DecisionLookupAdapterService,
  ) {}

  // 검사 대상 Artifact 목록에 대해 기존 Decision이 있는지 한 번에 조회한다.
  async lookup(
    resolution: DependencyResolutionResult,
  ): Promise<DecisionLookupBatch> {
    const { requestId, artifacts } = resolution;

    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw new TypeError('requestId is required');
    }

    if (!Array.isArray(artifacts)) {
      throw new TypeError('artifacts must be an array');
    }

    const response = await this.decisionLookupClient.lookup(
      this.toRequest(requestId, artifacts),
    );

    return this.decisionLookupAdapterService.adapt(
      requestId,
      artifacts,
      response,
    );
  }

  private toRequest(
    requestId: string,
    artifacts: ArtifactIdentity[],
  ): DecisionLookupRequestDto {
    return {
      requestId,
      packages: artifacts.map((artifact) => ({
        packageName: artifact.packageName,
        version: artifact.version,
        integrity: artifact.integrity,
      })),
    };
  }
}
