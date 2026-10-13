import type { Decision, DecisionFilterValue, PackageSummary } from '@/lib/decision/types'
import type { Rule } from '@/lib/policy/common/types'

// ── 화면 형식 ──

export type PackageQuery = { q: string; decision: DecisionFilterValue; page: number }

/** 주소 값 전체. selected는 상세로 볼 판정(decisionId)이며, 없으면 상세를 비워 둡니다. */
export type PackageSearch = PackageQuery & { selected?: string }

export type PackageListPage = { items: PackageSummary[]; total: number; page: number; pageCount: number }

/** 매칭 Rule. 판정한 정책 버전에서 코드를 찾지 못했거나 정책 버전을 읽지 못하면 rule은 null입니다. */
export type MatchedRule = { ruleCode: string; rule: Rule | null }

export type EvidenceSummary = { evidenceId: string; signalType: string; category: string; summary: string }

export type PackageDetail = {
  decisionId: string
  packageName: string
  version: string
  decision: Decision
  evaluatedAt: string
  reasonCode: string
  reason: string
  policyKey: string
  policyVersion: string
  /** 판정한 정책 버전을 읽지 못한 이유(오류 코드). 읽었으면 null입니다. */
  policyError: string | null
  /** 판정한 정책이 지금 적용 중인 정책(policyKey)과 같아 Version 페이지로 연결할 수 있는지 */
  policyLinkable: boolean
  matchedRules: MatchedRule[]
  evidences: EvidenceSummary[]
  /** 판정에는 있지만 Evidence API에서 찾지 못한 근거 */
  missingEvidenceIds: string[]
  /** 같은 패키지의 버전별 최신 판정(최신순) */
  history: PackageSummary[]
}
