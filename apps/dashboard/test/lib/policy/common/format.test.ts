// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { parsePolicyRule, parsePredicate, parseRulesInput, toPolicyRule } from '@/lib/policy/common/format'

import { apiRule, reviewRule, rule } from '../fixtures'

describe('parsePolicyRule', () => {
  it('reads a Policy DB rule into the Dashboard format', () => {
    expect(parsePolicyRule(apiRule())).toEqual({ rule: rule() })
    expect(
      parsePolicyRule(apiRule({
        ruleCode: 'RULE-REVIEW-OBFUSCATION',
        name: '난독화 검토',
        decision: 'REVIEW',
        priority: 60,
        conditions: { when: { anyOf: [{ predicate: 'OBFUSCATION_PRESENT' }, { predicate: 'OSV_ADVISORY_APPLIES' }] }, minimumSupport: 'PARTIAL', onUnknown: 'REVIEW' },
      })),
    ).toEqual({ rule: reviewRule })
  })

  // 값이 없으면 Policy 엔진 기본값(SUPPORTED·HOLD)과 같게 채웁니다.
  it('fills missing coverage settings with the engine defaults and keeps out-of-range priorities for validation', () => {
    expect(parsePolicyRule(apiRule({ priority: 1000, conditions: { when: { allOf: [{ predicate: 'OBFUSCATION_PRESENT' }] } } }))).toEqual({
      rule: rule({ priority: 1000, conditions: ['OBFUSCATION_PRESENT'], minimumSupport: 'SUPPORTED', onUnknown: 'HOLD' }),
    })
  })

  // Policy 응답은 값이 없는 설정을 null로 보냅니다(PolicyConditions의 기본값 None).
  it('reads null coverage settings and conditions as the engine defaults', () => {
    const conditions = { when: { allOf: [{ predicate: 'OBFUSCATION_PRESENT' }], anyOf: null }, minimumSupport: null, onUnknown: null }
    expect(parsePolicyRule(apiRule({ conditions }))).toEqual({
      rule: rule({ conditions: ['OBFUSCATION_PRESENT'], minimumSupport: 'SUPPORTED', onUnknown: 'HOLD' }),
    })
    expect(parsePolicyRule(apiRule({ conditions: { when: null, minimumSupport: null, onUnknown: null } }))).toEqual({
      rule: rule({ conditions: [], minimumSupport: 'SUPPORTED', onUnknown: 'HOLD' }),
    })
    expect(parsePolicyRule(apiRule({ conditions: { when: {}, minimumSupport: null, onUnknown: 'SKIP' } }))).toBeNull()
  })

  it('marks rules this page cannot show as unsupported', () => {
    const both = { when: { allOf: [{ predicate: 'A' }], anyOf: [{ predicate: 'B' }] } }
    const nested = { when: { allOf: [{ predicate: 'A', negate: true }] } }
    const extra = { when: { noneOf: [{ predicate: 'A' }] } }
    for (const conditions of [both, nested, extra]) {
      expect(parsePolicyRule(apiRule({ conditions }))).toEqual({ unsupported: 'RULE-REJECT-EXFIL' })
    }
  })

  it.each([
    { decision: 'BLOCK' },
    { priority: '90' },
    { enabled: 'yes' },
    { conditions: { when: 'A' } },
    { conditions: { when: {}, minimumSupport: 'ANY' } },
  ])('rejects a malformed rule %#', (overrides) => {
    expect(parsePolicyRule(apiRule(overrides))).toBeNull()
  })
})

describe('toPolicyRule', () => {
  it('builds the current Policy DB request, filling the required kind and reason from the code and name', () => {
    expect(toPolicyRule(rule({ name: ' Credential 유출 차단 ' }))).toEqual({
      ruleCode: 'RULE-REJECT-EXFIL',
      ruleKind: 'HARD',
      name: 'Credential 유출 차단',
      description: null,
      enabled: true,
      decision: 'REJECT',
      priority: 90,
      conditions: {
        when: { allOf: [{ predicate: 'CREDENTIAL_SOURCE_ACCESSED' }, { predicate: 'DATA_REACHES_EXTERNAL_SINK' }] },
        minimumSupport: 'SUPPORTED',
        onUnknown: 'HOLD',
      },
      reasonCode: 'RULE-REJECT-EXFIL',
      reasonMessage: 'Credential 유출 차단',
    })
    expect(toPolicyRule(reviewRule).conditions).toEqual({
      when: { anyOf: [{ predicate: 'OBFUSCATION_PRESENT' }, { predicate: 'OSV_ADVISORY_APPLIES' }] },
      minimumSupport: 'PARTIAL',
      onUnknown: 'REVIEW',
    })
  })

  it('round-trips through the Policy format', () => {
    for (const item of [rule(), reviewRule]) expect(parsePolicyRule(toPolicyRule(item))).toEqual({ rule: item })
  })
})

describe('parseRulesInput', () => {
  it('accepts rules in the Dashboard format', () => {
    expect(parseRulesInput([rule(), reviewRule])).toEqual([rule(), reviewRule])
    expect(parseRulesInput([])).toEqual([])
  })

  it.each([
    null,
    'rules',
    [{ ...rule(), matchAll: 'yes' }],
    [{ ...rule(), conditions: 'A' }],
    [{ ...rule(), conditions: [1] }],
    [{ ...rule(), onUnknown: 'SKIP' }],
    [{ ...rule(), decision: 'ALLOW' }],
  ])('rejects malformed input %#', (value) => {
    expect(parseRulesInput(value)).toBeNull()
  })
})

describe('parsePredicate', () => {
  it('reads a predicate and treats a missing rejectAllowed as allowed', () => {
    expect(parsePredicate({ code: 'A', description: 'a', category: 'data', requiresFeedEvidence: false, rejectAllowed: false })).toEqual({
      code: 'A',
      description: 'a',
      category: 'data',
      rejectAllowed: false,
    })
    expect(parsePredicate({ code: 'B', description: 'b' })).toEqual({ code: 'B', description: 'b', category: null, rejectAllowed: true })
    expect(parsePredicate({ code: 'C' })).toBeNull()
  })
})
