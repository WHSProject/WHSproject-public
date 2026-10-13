import type { Decision, DecisionFilterValue } from '@/lib/decision/types'

// user_db.download_events(Dashboard 소유, Gateway가 기록) 중 화면에서도 쓰는 타입입니다(docs/download-events-contract.md).
// 읽기는 server/download-events.ts(서버 전용)에서 합니다.

/** Logs 설치 기록 한 페이지의 건수입니다. 화면의 범위 안내와 서버 조회가 같은 값을 씁니다. */
export const LOG_PAGE_SIZE = 50

/** 요청 결과. 판정 전에 끝나면(인증 실패·오류) 판정이 없습니다. */
export type DownloadOutcome = 'DELIVERED' | 'BLOCKED' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'ERROR'

export const OUTCOME_LABELS: Record<DownloadOutcome, string> = {
  DELIVERED: '전달',
  FORBIDDEN: '권한 없음',
  BLOCKED: '차단',
  UNAUTHENTICATED: '인증 실패',
  ERROR: '오류',
}

export function outcomeLabel(outcome: DownloadOutcome, decision: Decision | null): string {
  return outcome === 'BLOCKED' && decision === null ? '판정 대기' : OUTCOME_LABELS[outcome]
}

/** user_db.download_events 한 행. Gateway가 tarball 요청마다 기록합니다. */
export type DownloadEvent = {
  id: string
  occurredAt: string
  /** Gateway 요청 ID(x-request-id). 로그 대조용입니다. */
  requestId: string
  userId: string | null
  /** 요청 당시 username. 인증되지 않은 요청이면 null입니다. */
  username: string | null
  sourceIp: string | null
  packageName: string
  version: string
  outcome: DownloadOutcome
  /** 판정 전에 끝난 요청은 null입니다. */
  decision: Decision | null
  httpStatus: number | null
}

/** 루트 패키지 요청(is_root = true): 사용자가 설치 명령으로 직접 지정한 패키지의 요청 */
export type RootRequest = {
  requestId: string
  occurredAt: string
  /** 인증되지 않은 요청이면 null */
  username: string | null
  packageName: string
  version: string
  outcome: DownloadOutcome
  /** 루트 패키지의 판정. 판정 전에 끝났으면 null */
  decision: Decision | null
  /** Gateway가 집행한 판정의 id(decision_id). Package 상세 연결에 씁니다. 판정 전에 끝났으면 null */
  decisionId: string | null
}

/** 루트 패키지 요청 조회 조건. q는 패키지 이름·사용자 부분 일치(대소문자 무시) */
export type RootRequestQuery = { from: Date; to: Date; q: string; decision: DecisionFilterValue }

/** 문제 패키지가 포함된 Root 설치 1건. install_dependency_history와 download_events를 root_request_id = request_id로 잇습니다. */
export type RootInstall = {
  rootRequestId: string
  rootPackageName: string
  rootPackageVersion: string
  /** 검색한 패키지가 그 설치에 포함된 버전 */
  matchedVersion: string
  /** download_events 행이 없거나 인증되지 않은 요청이면 null */
  username: string | null
  userId: string | null
  /** download_events.occurred_at. 행이 없으면 null */
  occurredAt: string | null
  /** install_dependency_history.captured_at */
  capturedAt: string
  /** download_events 행이 없으면 null */
  outcome: DownloadOutcome | null
  decision: Decision | null
}

/** 한 Root 설치에 포함된 의존성 1건 */
export type RootDependency = { packageName: string; version: string; integrity: string }
