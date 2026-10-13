import type { DecisionFilterValue } from '@/lib/decision/types'
import { VERSION_PATTERN } from '@/lib/policy/common/format'
import type { Predicate, Rule } from '@/lib/policy/common/types'

// 화면과 Dashboard API가 같은 규칙으로 Rule을 검사합니다.

export const PRIORITY_MIN = 1
export const PRIORITY_MAX = 100

export const RULE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u

export type RuleIssue = { ruleCode: string; message: string }

export function validateRules(rules: readonly Rule[], predicates: readonly Predicate[]): RuleIssue[] {
  const known = new Map(predicates.map((predicate) => [predicate.code, predicate]))
  const issues: RuleIssue[] = []
  const issue = (rule: Rule, message: string) => issues.push({ ruleCode: rule.ruleCode, message })

  for (const rule of rules) {
    if (!RULE_CODE_PATTERN.test(rule.ruleCode)) issue(rule, 'Rule 식별 코드 형식이 올바르지 않습니다.')
    if (rules.filter((other) => other.ruleCode === rule.ruleCode).length > 1) issue(rule, 'Rule 식별 코드가 다른 Rule과 같습니다.')
    if (rule.name.trim() === '') issue(rule, 'Rule 이름을 입력하세요.')

    if (!Number.isInteger(rule.priority) || rule.priority < PRIORITY_MIN || rule.priority > PRIORITY_MAX) {
      issue(rule, `우선순위는 ${PRIORITY_MIN}~${PRIORITY_MAX} 사이의 정수여야 합니다.`)
    } else {
      const same = rules.filter((other) => other !== rule && other.priority === rule.priority)
      if (same.length > 0) issue(rule, `우선순위 ${rule.priority}를 다른 Rule(${same.map((other) => other.name.trim() || other.ruleCode).join(', ')})도 쓰고 있습니다.`)
    }

    if (rule.conditions.length === 0) issue(rule, '조건을 하나 이상 선택하세요.')
    if (new Set(rule.conditions).size !== rule.conditions.length) issue(rule, '같은 조건이 두 번 들어 있습니다.')
    for (const code of rule.conditions) {
      const predicate = known.get(code)
      if (!predicate) issue(rule, `${code}는 등록되지 않은 조건입니다.`)
      // Policy 엔진은 REJECT 근거로 쓸 수 없는 조건이 있는 REJECT Rule을 매칭하지 않으므로 미리 막습니다.
      else if (rule.decision === 'REJECT' && !predicate.rejectAllowed) issue(rule, `${code}는 REJECT 근거로 쓸 수 없습니다.`)
    }
  }
  return issues
}

// 삭제된 코드를 다시 쓰지 않도록 순서 번호 대신 무작위 값을 씁니다(약 43억 가지). 지금 Rule과만 겹치지 않으면 됩니다.
export function newRuleCode(existing: readonly string[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4))
    const code = `RULE-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`
    if (!existing.includes(code)) return code
  }
}

export function newRule(rules: readonly Rule[]): Rule {
  const used = new Set(rules.map((rule) => rule.priority))
  let priority = PRIORITY_MIN
  while (used.has(priority) && priority < PRIORITY_MAX) priority++
  return {
    ruleCode: newRuleCode(rules.map((rule) => rule.ruleCode)),
    name: '',
    decision: 'REVIEW',
    priority,
    enabled: true,
    matchAll: true,
    conditions: [],
    minimumSupport: 'SUPPORTED',
    onUnknown: 'HOLD',
  }
}

// 버전 0.{Policy 내부 버전}.{사용자 버전}: 같은 내부 버전 중 가장 큰 사용자 버전 + 1.
// 적용에 실패해 남은 초안 번호도 목록에 있으므로 건너뜁니다.
export function nextVersion(active: string, versions: readonly string[]): string | null {
  const base = VERSION_PATTERN.exec(active)
  if (!base) return null
  const [, major, minor] = base
  const patches = [active, ...versions].flatMap((version) => {
    const match = VERSION_PATTERN.exec(version)
    return match && match[1] === major && match[2] === minor ? [Number(match[3])] : []
  })
  return `${major}.${minor}.${Math.max(...patches) + 1}`
}

export type RuleFilter = {
  decision: DecisionFilterValue
  /** 고른 조건(predicate) 코드. 비어 있으면 조건으로 거르지 않습니다. */
  conditions: readonly string[]
  /** true: 고른 조건을 모두 가진 Rule(AND), false: 하나라도 가진 Rule(OR) */
  matchAll: boolean
}

export const NO_FILTER: RuleFilter = { decision: 'ALL', conditions: [], matchAll: true }

export function filterRules<T extends { rule: Rule }>(items: readonly T[], filter: RuleFilter): T[] {
  return items.filter(({ rule }) => {
    if (filter.decision !== 'ALL' && rule.decision !== filter.decision) return false
    if (filter.conditions.length === 0) return true
    const has = (code: string) => rule.conditions.includes(code)
    return filter.matchAll ? filter.conditions.every(has) : filter.conditions.some(has)
  })
}

export function groupByCategory(predicates: readonly Predicate[]): [string, Predicate[]][] {
  const groups = new Map<string, Predicate[]>()
  for (const predicate of predicates) {
    const category = predicate.category ?? '기타'
    groups.set(category, [...(groups.get(category) ?? []), predicate])
  }
  return [...groups.entries()]
}
