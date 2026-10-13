import type { Decision } from '@/lib/decision/types'

// Rule·Version 기능이 같이 쓰는 Policy 정책 형식입니다. Rule 형식은 docs/policy-rule-contract.md를 따릅니다.

/** 이 Rule을 확정하려면 분석이 어디까지 끝나야 하는지. SUPPORTED: 분석 완료일 때만, PARTIAL: 일부만 분석돼도 */
export type MinimumSupport = 'SUPPORTED' | 'PARTIAL'

/** 조건을 판단할 수 없을 때(근거 불명확·분석 부족)의 결과. IGNORE는 이 Rule을 무시하고 계속 진행 */
export type OnUnknown = 'HOLD' | 'REVIEW' | 'IGNORE'

export type Rule = {
  /** 식별 코드. Dashboard가 만들고 버전이 바뀌어도 유지합니다. 판정 결과(matched_rule_ids)에 남습니다. */
  ruleCode: string
  name: string
  decision: Decision
  /** 1~100, 큰 값부터 평가 */
  priority: number
  enabled: boolean
  /** true: 모든 조건(AND), false: 하나 이상(OR) */
  matchAll: boolean
  /** Policy에 등록된 predicate 코드 */
  conditions: string[]
  minimumSupport: MinimumSupport
  onUnknown: OnUnknown
}

export type Predicate = {
  code: string
  description: string
  category: string | null
  /** false면 REJECT Rule의 근거로 쓸 수 없습니다(Policy 엔진이 매칭하지 않음). */
  rejectAllowed: boolean
}

/** 정책 한 버전(이름과 Rule 전체) */
export type PolicyVersion = {
  policyKey: string
  name: string
  version: string
  rules: Rule[]
}

export type PolicyStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'

/** 버전 목록의 한 줄. 발행하면 그 버전의 updatedBy·publishedAt이 적용한 사람·시각이 됩니다. */
export type PolicyVersionSummary = {
  version: string
  status: PolicyStatus
  createdBy: string
  updatedBy: string
  createdByUserId?: string | null
  updatedByUserId?: string | null
  createdAt: string
  publishedAt: string | null
}
