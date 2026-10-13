import { POLICY_REQUEST_FAILED_MESSAGE, policyErrorMessage } from '@/lib/policy/common/errors'
import type { Rule } from '@/lib/policy/common/types'

import type { RuleIssue } from '../model/rules'

// Rules API 주소(src/app/api/policies)입니다.
export const RULES_API = {
  versions: (policyKey: string) => `/api/policies/${encodeURIComponent(policyKey)}/versions`,
} as const

export type ApplyRequestResult = { ok: true; version: string } | { ok: false; message: string; issues: RuleIssue[] }

// 적용: 새 버전 생성 + 활성화. baseVersion은 편집을 시작한 적용 버전입니다.
export async function applyRulesRequest(policyKey: string, baseVersion: string, rules: Rule[]): Promise<ApplyRequestResult> {
  try {
    const response = await fetch(RULES_API.versions(policyKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion, rules }),
    })
    const data: unknown = await response.json().catch(() => null)
    const body = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
    if (response.ok && typeof body.version === 'string') return { ok: true, version: body.version }
    const issues = Array.isArray(body.issues) ? (body.issues as RuleIssue[]) : []
    return { ok: false, message: policyErrorMessage(body.error), issues }
  } catch {
    return { ok: false, message: POLICY_REQUEST_FAILED_MESSAGE, issues: [] }
  }
}
