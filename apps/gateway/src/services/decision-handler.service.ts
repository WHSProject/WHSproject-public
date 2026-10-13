import { Injectable } from '@nestjs/common';

import type { ApprovalRequestDto } from '../dto/approval-request.dto';
import type { ScannerRequestDto } from '../dto/scanner-request.dto';
import type { ArtifactIdentity } from '../types/artifact.types';
import {
  BlockedArtifact,
  DecisionEnforcementResult,
  DecisionLookupBatch,
  DecisionRoutingResult,
} from '../types/decision-lookup.types';
import { Decision, DecisionLookupStatus } from '../types/decision.types';

@Injectable()
export class DecisionHandlerService {
  classifyAndCreateScannerRequests(
    batch: DecisionLookupBatch,
  ): DecisionRoutingResult {
    if (!batch.requestId?.trim()) {
      throw new TypeError('requestId is required');
    }

    if (!Array.isArray(batch.results)) {
      throw new TypeError('results must be an array');
    }

    const hits: DecisionRoutingResult['hits'] = [];
    const scannerTargets: ArtifactIdentity[] = [];

    for (const result of batch.results) {
      switch (result.lookupStatus) {
        case DecisionLookupStatus.FOUND:
          if (!result.decision) {
            throw new TypeError(
              'FOUND result must include a DecisionRecord',
            );
          }

          hits.push(result);
          break;

        // 기존 판정이 없으면 Scanner 분석 대상으로 모은다.
        // 요청 변환은 분류가 끝난 뒤 한 번에 처리한다.
        case DecisionLookupStatus.NOT_FOUND:
          scannerTargets.push(result.artifact);
          break;

        default:
          throw new TypeError('Unsupported Decision lookup status');
      }
    }

    return {
      hits,
      scannerTargets,
      scannerRequest: this.toScannerRequest(batch.requestId, scannerTargets),
    };
  }

  // 통과 조건은 "전부 FOUND이고 전부 ACCEPT". FOUND는 판정 기록이 있다는 뜻일 뿐
  // 값이 REJECT일 수 있으므로 lookupStatus만 보고 통과시키면 안 된다.
  // REJECT / HOLD / REVIEW는 구분 없이 차단한다(PackageNotAllowedError → 403).
  evaluateEnforcement(batch: DecisionLookupBatch): DecisionEnforcementResult {
    if (!batch.requestId?.trim()) {
      throw new TypeError('requestId is required');
    }

    if (!Array.isArray(batch.results)) {
      throw new TypeError('results must be an array');
    }

    const blocked: BlockedArtifact[] = [];
    const approved: ArtifactIdentity[] = [];

    for (const result of batch.results) {
      if (result.lookupStatus === DecisionLookupStatus.NOT_FOUND) {
        blocked.push({
          artifact: result.artifact,
          reason: DecisionLookupStatus.NOT_FOUND,
        });
        continue;
      }

      if (!result.decision) {
        throw new TypeError('FOUND result must include a DecisionRecord');
      }

      if (result.decision.decision !== Decision.ACCEPT) {
        blocked.push({
          artifact: result.artifact,
          reason: result.decision.decision,
        });
        continue;
      }

      approved.push(result.artifact);
    }

    const allowed = blocked.length === 0 && approved.length > 0;

    return {
      allowed,
      blocked,
      approvalRequest: allowed
        ? this.toApprovalRequest(batch.requestId, approved)
        : null,
    };
  }

  // Verdaccio Plugin은 빈 integrity를 거부한다. 값이 없는 Artifact를 조용히 빼면
  // 승인되지 않은 Package가 통과하므로 오류로 드러낸다.
  private toApprovalRequest(
    requestId: string,
    artifacts: ArtifactIdentity[],
  ): ApprovalRequestDto {
    return {
      requestId,
      packages: artifacts.map((artifact) => {
        if (!artifact.integrity) {
          throw new TypeError(
            `integrity is required to register an approval: `
            + `${artifact.packageName}@${artifact.version}`,
          );
        }

        return {
          packageName: artifact.packageName,
          version: artifact.version,
          integrity: artifact.integrity,
        };
      }),
    };
  }

  // 분석 대상 전체를 한 번의 요청으로 변환한다.
  // 대상이 없으면 null을 반환해 빈 요청이 Scanner로 나가지 않게 한다.
  private toScannerRequest(
    requestId: string,
    artifacts: ArtifactIdentity[],
  ): ScannerRequestDto | null {
    if (artifacts.length === 0) {
      return null;
    }

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
