import type { Decision } from '@/lib/decision/types'

import type { MinimumSupport, OnUnknown, Predicate, Rule } from './types'

// Dashboard Rule 형식 ↔ 지금 Policy DB API 형식(PolicyRuleCreate) 변환입니다.
// Policy가 Dashboard 형식(docs/policy-rule-contract.md)을 직접 받게 되면 이 파일만 바꿉니다.

/** 정책 버전 0.{Policy 내부 버전}.{사용자 버전} */
export const VERSION_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const isDecision = (value: unknown): value is Decision => value === 'ACCEPT' || value === 'REJECT' || value === 'HOLD' || value === 'REVIEW'
const isMinimumSupport = (value: unknown): value is MinimumSupport => value === 'SUPPORTED' || value === 'PARTIAL'
const isOnUnknown = (value: unknown): value is OnUnknown => value === 'HOLD' || value === 'REVIEW' || value === 'IGNORE'

// 조건 목록 [{ predicate: 'CODE' }]을 코드 배열로 바꿉니다. 없으면(null 포함) 빈 배열, 다른 모양이면 null입니다.
function predicateCodes(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const codes = value.map((item) => (isObject(item) && typeof item.predicate === 'string' && Object.keys(item).length === 1 ? item.predicate : null))
  return codes.includes(null) ? null : (codes as string[])
}

export type ParsedPolicyRule = { rule: Rule } | { unsupported: string } | null

// Policy DB API의 Rule 한 개. 모든 조건(allOf)과 하나 이상(anyOf)을 함께 쓰는 등 이 화면이 표현하지 못하는
// Rule은 unsupported, 형식이 틀리면 null입니다. 값이 없는(Policy 응답의 null 포함) minimumSupport·onUnknown은
// Policy 엔진 기본값으로 채웁니다.
export function parsePolicyRule(value: unknown): ParsedPolicyRule {
  if (!isObject(value) || typeof value.ruleCode !== 'string' || typeof value.name !== 'string') return null
  if (!isDecision(value.decision) || typeof value.priority !== 'number' || typeof value.enabled !== 'boolean') return null
  const conditions = isObject(value.conditions) ? value.conditions : {}
  const when = conditions.when ?? {}
  if (!isObject(when)) return null
  const minimumSupport = conditions.minimumSupport ?? 'SUPPORTED'
  const onUnknown = conditions.onUnknown ?? 'HOLD'
  if (!isMinimumSupport(minimumSupport) || !isOnUnknown(onUnknown)) return null

  const allOf = predicateCodes(when.allOf)
  const anyOf = predicateCodes(when.anyOf)
  const extraKeys = Object.keys(when).some((key) => key !== 'allOf' && key !== 'anyOf')
  if (!allOf || !anyOf || extraKeys || (allOf.length > 0 && anyOf.length > 0)) return { unsupported: value.ruleCode }

  return {
    rule: {
      ruleCode: value.ruleCode,
      name: value.name,
      decision: value.decision,
      priority: value.priority,
      enabled: value.enabled,
      matchAll: anyOf.length === 0,
      conditions: anyOf.length === 0 ? allOf : anyOf,
      minimumSupport,
      onUnknown,
    },
  }
}

// 지금 Policy API는 ruleKind·사유가 필수라 채워 보냅니다. 엔진은 ruleKind를 쓰지 않고,
// 사유는 판정 결과(reason_code)에 남으므로 Rule을 알아볼 수 있게 식별 코드·이름을 씁니다.
export function toPolicyRule(rule: Rule): JsonObject {
  return {
    ruleCode: rule.ruleCode,
    ruleKind: 'HARD',
    name: rule.name.trim(),
    description: null,
    enabled: rule.enabled,
    decision: rule.decision,
    priority: rule.priority,
    conditions: {
      when: { [rule.matchAll ? 'allOf' : 'anyOf']: rule.conditions.map((predicate) => ({ predicate })) },
      minimumSupport: rule.minimumSupport,
      onUnknown: rule.onUnknown,
    },
    reasonCode: rule.ruleCode,
    reasonMessage: rule.name.trim(),
  }
}

export function parsePredicate(value: unknown): Predicate | null {
  if (!isObject(value) || typeof value.code !== 'string' || typeof value.description !== 'string') return null
  const category = typeof value.category === 'string' ? value.category : null
  return { code: value.code, description: value.description, category, rejectAllowed: value.rejectAllowed !== false }
}

// 브라우저가 보낸 Rule 목록(Dashboard 형식). 모양이 하나라도 틀리면 null입니다. 내용 검사는 validateRules가 합니다.
export function parseRulesInput(value: unknown): Rule[] | null {
  if (!Array.isArray(value)) return null
  const rules = value.map((item): Rule | null => {
    if (!isObject(item)) return null
    const { ruleCode, name, decision, priority, enabled, matchAll, conditions, minimumSupport, onUnknown } = item
    if (typeof ruleCode !== 'string' || typeof name !== 'string' || !isDecision(decision) || typeof priority !== 'number') return null
    if (typeof enabled !== 'boolean' || typeof matchAll !== 'boolean' || !isMinimumSupport(minimumSupport) || !isOnUnknown(onUnknown)) return null
    if (!Array.isArray(conditions) || !conditions.every((code) => typeof code === 'string')) return null
    return { ruleCode, name, decision, priority, enabled, matchAll, conditions: conditions as string[], minimumSupport, onUnknown }
  })
  return rules.includes(null) ? null : (rules as Rule[])
}
