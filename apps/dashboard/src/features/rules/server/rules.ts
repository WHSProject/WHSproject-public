import type { PolicyVersion, Predicate, Rule } from '@/lib/policy/common/types'
import {
  applyPolicyVersion,
  getActivePolicy,
  getPolicyVersion,
  listPolicyVersions,
  listPredicates,
  PolicyDbError,
} from '@/lib/policy/server/policy-db'

import { nextVersion, type RuleIssue, validateRules } from '../model/rules'

// Rule 페이지의 정책 읽기·적용 순서입니다. 서버에서만 import합니다. Policy DB API 호출은 lib/policy/server에 있습니다.

export type RulesPageData =
  | { status: 'ready'; policy: PolicyVersion; predicates: Predicate[] }
  | { status: 'no-policy' }
  | { status: 'unavailable'; code: string }

export async function loadRulesPage(): Promise<RulesPageData> {
  try {
    const active = await getActivePolicy()
    if (!active) return { status: 'no-policy' }
    const [policy, predicates] = await Promise.all([
      getPolicyVersion(active.policyKey, active.version),
      listPredicates(),
    ])
    return { status: 'ready', policy, predicates }
  } catch (error) {
    if (error instanceof PolicyDbError) return { status: 'unavailable', code: error.code }
    throw error
  }
}

export type ApplyInput = { policyKey: string; baseVersion: string; rules: Rule[]; username: string; userId?: string }
export type ApplyResult = { ok: true; version: string } | { ok: false; issues: RuleIssue[] }

// 적용 = 새 버전 생성 + 활성화를 Policy DB의 단일 트랜잭션 API로 요청합니다.
export async function applyRules({ policyKey, baseVersion, rules, username, userId }: ApplyInput): Promise<ApplyResult> {
  const active = await getActivePolicy()
  if (!active) throw new PolicyDbError('POLICY_NOT_FOUND', 409)
  if (active.policyKey !== policyKey) throw new PolicyDbError('POLICY_NOT_FOUND', 404)
  // 편집을 시작한 뒤 다른 사용자가 먼저 적용했으면 그 변경을 덮어쓰지 않도록 거절합니다.
  if (active.version !== baseVersion) throw new PolicyDbError('POLICY_CHANGED', 409)

  const predicates = await listPredicates()
  const issues = validateRules(rules, predicates)
  if (issues.length > 0) return { ok: false, issues }

  const versions = await listPolicyVersions(policyKey)
  const version = nextVersion(baseVersion, versions.map((item) => item.version))
  if (!version) throw new PolicyDbError('POLICY_INVALID_RESPONSE', 502)

  await applyPolicyVersion({ policyKey, baseVersion, version, username, userId: userId ?? null, rules })
  return { ok: true, version }
}
