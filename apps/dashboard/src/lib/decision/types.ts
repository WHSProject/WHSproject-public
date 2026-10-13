export type Decision = 'ACCEPT' | 'REJECT' | 'HOLD' | 'REVIEW'

/** 화면에서 판정을 나열하는 순서(판정 필터, Rule 판정 선택). 모든 페이지가 이 순서를 씁니다. */
export const DECISIONS: readonly Decision[] = ['ACCEPT', 'REJECT', 'HOLD', 'REVIEW']

/** 판정 필터의 선택값. 'ALL'은 전체를 뜻합니다. */
export type DecisionFilterValue = Decision | 'ALL'

// ── Decision DB API·Evidence API 응답 중 Dashboard가 쓰는 필드입니다(docs/package-decision-contract.md). ──
// 읽기는 server/decision-db.ts(서버 전용)에서 하고, 여기에는 화면에서도 쓰는 타입만 둡니다.

/** 판정 상세 `GET /internal/v1/decisions/by-decision-id/{decisionId}` */
export type DecisionRecord = {
  decisionId: string
  /** 판정을 만든 Gateway 요청 ID(x-request-id). user_db.download_events.request_id와 같은 값입니다. */
  requestId: string
  scanId: string
  decision: Decision
  reasonCode: string
  reason: string
  /** 판정에 쓰인 Rule 코드(ruleCode) */
  matchedRuleIds: string[]
  evidenceIds: string[]
  /** VERIFIED LLM_ASSESSMENT Evidence cited by Policy. */
  assessmentIds: string[]
  policyKey: string
  policyVersion: string
  subject: {
    ecosystem: 'npm'
    packageName: string
    packageVersion: string
    artifactHash256?: string
    artifactHash512?: string
  }
  evaluatedAt: string
}

/** Evidence `GET /internal/v1/evidences/{evidenceId}` */
export type EvidenceRecord = {
  evidenceId: string
  kind?: string
  signal: { type: string; category: string }
  assertion: { summary: string }
  provenance?: { scanId?: string; assessmentId?: string }
  verificationStatus?: string
}

/** 패키지 버전의 최신 판정 한 줄(목록·버전 이력·최근 판정). 요청한 목록 API의 항목 형식과 같습니다. */
export type PackageSummary = {
  decisionId: string
  requestId: string
  packageName: string
  version: string
  decision: Decision
  evaluatedAt: string
  /** 판정에 쓰인 Rule 코드(첫 번째가 판정을 정한 Rule)와 그 정책 버전 */
  matchedRuleIds: string[]
  policyKey: string
  policyVersion: string
}

/** 목록 요청 값 `GET /internal/v1/decisions/packages?q=&decision=&page=&pageSize=` */
export type PackageListQuery = { q: string; decision: DecisionFilterValue; page: number; pageSize: number }

/** 판정 요약 `GET /internal/v1/decisions/summary?from=&to=` (요청 API). hourly는 from부터 1시간씩 */
export type DecisionSummary = {
  from: string
  to: string
  total: number
  byDecision: Record<Decision, number>
  hourly: { hour: string; total: number; notAccepted: number }[]
}
