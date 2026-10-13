import type { DecisionSummary, PackageSummary } from '@/lib/decision/types'

/** 적용 중 정책 카드. Policy를 읽지 못해도 Overview의 나머지는 보여 줍니다. */
export type ActivePolicyCard =
  | {
      status: 'ready'
      version: string
      /** 사용 중(enabled) Rule 수 */
      enabledRules: number
      appliedBy: string
    }
  | { status: 'no-policy' }
  | { status: 'unavailable'; code: string }

/** 최근 판정 한 줄: 판정을 만든 설치 요청의 사용자와 트리거된 Rule을 더합니다. */
export type RecentDecision = PackageSummary & {
  /** 판정을 처음 만든 설치 요청의 사용자. 요청 기록이 없으면 null */
  username: string | null
  /** 판정을 정한 Rule의 이름(그 정책 버전 기준, 찾지 못하면 Rule 코드)과 그 밖에 맞은 Rule 수. 맞은 Rule이 없으면 null */
  triggeredRule: { name: string; others: number } | null
}

export type OverviewData = {
  /** 설치 요청(루트 패키지 요청, user_db.download_events) 최근 24시간, 1시간씩 24칸(오래된 순) */
  installRequests: { total: number; hourly: number[] }
  /** 설치 요청 DB를 사용할 수 없을 때 해당 카드에만 표시할 연결 오류 */
  installError?: string | null
  decisions: DecisionSummary
  /** Decision DB를 사용할 수 없을 때 화면에 표시할 연결 오류 */
  decisionError?: string | null
  policy: ActivePolicyCard
  /** 최근 판정(Package 목록 첫 줄들) */
  recent: RecentDecision[]
}
