import type { PolicyVersionSummary, Predicate, Rule } from '@/lib/policy/common/types'

// Policy 정책(Rule·Version) 테스트 공용 데이터입니다.

export const predicates: Predicate[] = [
  { code: 'CREDENTIAL_SOURCE_ACCESSED', description: 'Credential access', category: 'data', rejectAllowed: true },
  { code: 'DATA_REACHES_EXTERNAL_SINK', description: 'External sink', category: 'data', rejectAllowed: true },
  { code: 'OBFUSCATION_PRESENT', description: 'Obfuscation', category: 'analysis', rejectAllowed: true },
  { code: 'OSV_ADVISORY_APPLIES', description: 'OSV advisory', category: 'feed', rejectAllowed: false },
]

export const rule = (overrides: Partial<Rule> = {}): Rule => ({
  ruleCode: 'RULE-REJECT-EXFIL',
  name: 'Credential 유출 차단',
  decision: 'REJECT',
  priority: 90,
  enabled: true,
  matchAll: true,
  conditions: ['CREDENTIAL_SOURCE_ACCESSED', 'DATA_REACHES_EXTERNAL_SINK'],
  minimumSupport: 'SUPPORTED',
  onUnknown: 'HOLD',
  ...overrides,
})

export const reviewRule = rule({
  ruleCode: 'RULE-REVIEW-OBFUSCATION',
  name: '난독화 검토',
  decision: 'REVIEW',
  priority: 60,
  matchAll: false,
  conditions: ['OBFUSCATION_PRESENT', 'OSV_ADVISORY_APPLIES'],
  minimumSupport: 'PARTIAL',
  onUnknown: 'REVIEW',
})

// Policy DB API가 돌려주는 Rule(PolicyRuleCreate 형식)입니다.
export const apiRule = (overrides: Record<string, unknown> = {}) => ({
  ruleCode: 'RULE-REJECT-EXFIL',
  ruleKind: 'HARD',
  name: 'Credential 유출 차단',
  description: 'old description',
  enabled: true,
  decision: 'REJECT',
  priority: 90,
  conditions: {
    when: { allOf: [{ predicate: 'CREDENTIAL_SOURCE_ACCESSED' }, { predicate: 'DATA_REACHES_EXTERNAL_SINK' }] },
    minimumSupport: 'SUPPORTED',
    onUnknown: 'HOLD',
  },
  reasonCode: 'POLICY_CONFIRMED_EXFILTRATION',
  reasonMessage: 'Credential data reaches an external sink.',
  ...overrides,
})

// Policy 버전 목록의 한 줄(PolicyVersionSummary)입니다.
export const summary = (overrides: Partial<PolicyVersionSummary> = {}): PolicyVersionSummary => ({
  version: '0.1.2',
  status: 'ARCHIVED',
  createdBy: 'kim_editor',
  updatedBy: 'kim_editor',
  createdAt: '2026-09-30T05:00:00Z',
  publishedAt: '2026-09-30T05:00:00Z',
  ...overrides,
})
