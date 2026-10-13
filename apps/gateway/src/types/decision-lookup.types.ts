import { ApprovalRequestDto } from '../dto/approval-request.dto';
import { ScannerRequestDto } from '../dto/scanner-request.dto';
import { ArtifactIdentity } from './artifact.types';
import {
  Decision,
  DecisionLookupStatus,
  DecisionRecord,
} from './decision.types';

export interface FoundDecisionLookupResult {
  artifact: ArtifactIdentity;
  lookupStatus: DecisionLookupStatus.FOUND;
  decision: DecisionRecord;
}

export interface NotFoundDecisionLookupResult {
  artifact: ArtifactIdentity;
  lookupStatus: DecisionLookupStatus.NOT_FOUND;
}

export type DecisionLookupResult =
  | FoundDecisionLookupResult
  | NotFoundDecisionLookupResult;

export interface DecisionLookupBatch {
  requestId: string;
  results: DecisionLookupResult[];
}

// Service 반환 타입

export interface DecisionRoutingResult {
  hits: FoundDecisionLookupResult[];

  // 기존 판정이 없어 Scanner 분석이 필요한 Artifact 목록
  scannerTargets: ArtifactIdentity[];

  // scannerTargets를 배치 요청 1건으로 변환한 값.
  // 분석 대상이 하나도 없으면 null이며, 빈 요청을 Scanner로 보내지 않는다.
  scannerRequest: ScannerRequestDto | null;
}

// 집행 판단 결과.
//
// 통과는 "의존성 전부가 FOUND이고 전부 ACCEPT"인 경우만이다.
// 하나라도 아니면 차단하며, 차단 사유를 blocked에 담는다.
export interface DecisionEnforcementResult {
  allowed: boolean;

  // 차단 사유가 된 Artifact 목록. 통과면 비어 있다.
  blocked: BlockedArtifact[];

  // 승인 목록 등록에 사용할 요청. 통과가 아니면 null이다.
  approvalRequest: ApprovalRequestDto | null;
}

export interface BlockedArtifact {
  artifact: ArtifactIdentity;

  // 판정이 없으면 NOT_FOUND, 있으면 그 Decision 값
  reason: Decision | DecisionLookupStatus.NOT_FOUND;
}
