// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { filterRules, groupByCategory, newRule, newRuleCode, nextVersion, NO_FILTER, validateRules } from '@/features/rules/model/rules'

import { predicates, reviewRule, rule } from '../../../lib/policy/fixtures'

const messages = (rules = [rule()]) => validateRules(rules, predicates).map((issue) => `${issue.ruleCode}:${issue.message}`)

describe('validateRules', () => {
  it('accepts valid rules', () => {
    expect(messages([rule(), reviewRule])).toEqual([])
  })

  it('requires a name and at least one registered condition', () => {
    expect(messages([rule({ name: '  ', conditions: [] })])).toEqual([
      'RULE-REJECT-EXFIL:Rule 이름을 입력하세요.',
      'RULE-REJECT-EXFIL:조건을 하나 이상 선택하세요.',
    ])
    expect(messages([rule({ conditions: ['NOT_REGISTERED', 'NOT_REGISTERED'] })])).toEqual([
      'RULE-REJECT-EXFIL:같은 조건이 두 번 들어 있습니다.',
      'RULE-REJECT-EXFIL:NOT_REGISTERED는 등록되지 않은 조건입니다.',
      'RULE-REJECT-EXFIL:NOT_REGISTERED는 등록되지 않은 조건입니다.',
    ])
  })

  it.each([0, 101, 1.5, Number.NaN, 400])('rejects priority %s outside 1~100', (priority) => {
    expect(messages([rule({ priority })])).toEqual(['RULE-REJECT-EXFIL:우선순위는 1~100 사이의 정수여야 합니다.'])
  })

  it('accepts the boundary priorities 1 and 100', () => {
    expect(messages([rule({ priority: 1 }), { ...reviewRule, priority: 100 }])).toEqual([])
  })

  it('rejects shared priorities on both rules, naming the other rule', () => {
    expect(messages([rule(), { ...reviewRule, priority: 90 }])).toEqual([
      'RULE-REJECT-EXFIL:우선순위 90를 다른 Rule(난독화 검토)도 쓰고 있습니다.',
      'RULE-REVIEW-OBFUSCATION:우선순위 90를 다른 Rule(Credential 유출 차단)도 쓰고 있습니다.',
    ])
  })

  // Policy 엔진은 REJECT 근거로 쓸 수 없는 조건이 있는 REJECT Rule을 매칭하지 않습니다.
  it('rejects a REJECT rule that relies on a condition not allowed for REJECT', () => {
    expect(messages([{ ...reviewRule, decision: 'REJECT' }])).toEqual([
      'RULE-REVIEW-OBFUSCATION:OSV_ADVISORY_APPLIES는 REJECT 근거로 쓸 수 없습니다.',
    ])
  })

  it('rejects malformed or duplicate rule codes', () => {
    expect(messages([rule({ ruleCode: 'bad code' })])).toEqual(['bad code:Rule 식별 코드 형식이 올바르지 않습니다.'])
    expect(messages([rule(), { ...reviewRule, ruleCode: 'RULE-REJECT-EXFIL' }])).toEqual([
      'RULE-REJECT-EXFIL:Rule 식별 코드가 다른 Rule과 같습니다.',
      'RULE-REJECT-EXFIL:Rule 식별 코드가 다른 Rule과 같습니다.',
    ])
  })
})

describe('new rules', () => {
  it('creates random codes that do not collide with existing ones', () => {
    const code = newRuleCode([])
    expect(code).toMatch(/^RULE-[0-9A-F]{8}$/u)
    expect(new Set(Array.from({ length: 200 }, () => newRuleCode([])).values()).size).toBe(200)
  })

  it('starts with the smallest unused priority and engine defaults', () => {
    const created = newRule([rule({ priority: 1 }), { ...reviewRule, priority: 2 }])
    expect(created).toMatchObject({ name: '', decision: 'REVIEW', priority: 3, enabled: true, matchAll: true, conditions: [], minimumSupport: 'SUPPORTED', onUnknown: 'HOLD' })
    expect(['RULE-REJECT-EXFIL', 'RULE-REVIEW-OBFUSCATION']).not.toContain(created.ruleCode)
  })
})

describe('nextVersion', () => {
  it('increments the user version within the same Policy version', () => {
    expect(nextVersion('0.1.0', ['0.1.0'])).toBe('0.1.1')
    // 발행에 실패해 남은 초안(0.1.4)도 건너뜁니다.
    expect(nextVersion('0.1.2', ['0.1.0', '0.1.2', '0.1.4', '0.2.9', '1.1.8', 'draft'])).toBe('0.1.5')
  })

  it('returns null for a version outside 0.x.y form', () => {
    expect(nextVersion('v1', [])).toBeNull()
  })
})

describe('filterRules', () => {
  const items = [rule(), reviewRule].map((item, key) => ({ key, rule: item }))

  const codes = (filter: Partial<typeof NO_FILTER>) => filterRules(items, { ...NO_FILTER, ...filter }).map((item) => item.rule.ruleCode)

  it('filters by decision', () => {
    expect(codes({})).toEqual(['RULE-REJECT-EXFIL', 'RULE-REVIEW-OBFUSCATION'])
    expect(codes({ decision: 'REJECT' })).toEqual(['RULE-REJECT-EXFIL'])
    expect(codes({ decision: 'ACCEPT' })).toEqual([])
  })

  // rule(): CREDENTIAL_SOURCE_ACCESSED + DATA_REACHES_EXTERNAL_SINK, reviewRule: OBFUSCATION_PRESENT + OSV_ADVISORY_APPLIES
  it('keeps rules that have all chosen conditions (AND) or any of them (OR)', () => {
    expect(codes({ conditions: ['CREDENTIAL_SOURCE_ACCESSED'] })).toEqual(['RULE-REJECT-EXFIL'])
    expect(codes({ conditions: ['CREDENTIAL_SOURCE_ACCESSED', 'DATA_REACHES_EXTERNAL_SINK'] })).toEqual(['RULE-REJECT-EXFIL'])
    expect(codes({ conditions: ['CREDENTIAL_SOURCE_ACCESSED', 'OBFUSCATION_PRESENT'] })).toEqual([])
    expect(codes({ conditions: ['CREDENTIAL_SOURCE_ACCESSED', 'OBFUSCATION_PRESENT'], matchAll: false })).toEqual([
      'RULE-REJECT-EXFIL',
      'RULE-REVIEW-OBFUSCATION',
    ])
    expect(codes({ conditions: ['NATIVE_BINARY_LOADED'], matchAll: false })).toEqual([])
  })

  it('combines the decision and condition filters', () => {
    expect(codes({ decision: 'REVIEW', conditions: ['CREDENTIAL_SOURCE_ACCESSED', 'OBFUSCATION_PRESENT'], matchAll: false })).toEqual([
      'RULE-REVIEW-OBFUSCATION',
    ])
  })

  it('groups predicates by category in their order', () => {
    expect(groupByCategory(predicates).map(([category, list]) => `${category}:${list.length}`)).toEqual(['data:2', 'analysis:1', 'feed:1'])
  })
})
