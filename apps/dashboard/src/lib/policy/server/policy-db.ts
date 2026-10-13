import { apiError } from '@/lib/auth/server/request'

import { parsePolicyRule, parsePredicate, toPolicyRule } from '../common/format'
import type { PolicyStatus, PolicyVersion, PolicyVersionSummary, Predicate, Rule } from '../common/types'

// Policy DB API(policy-db-api) 호출입니다. 서버에서만 import합니다.
// Policy API에는 인증이 없으므로 브라우저는 직접 부르지 않고, 권한 확인은 Dashboard API가 합니다.

const TIMEOUT_MS = 5_000

function baseUrl(): string {
  return (process.env.POLICY_DB_URL ?? 'http://127.0.0.1:9000').replace(/\/+$/u, '')
}

// code는 Dashboard API가 화면에 돌려주는 오류 코드입니다(common/errors.ts).
export class PolicyDbError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

// Policy 오류는 코드와 상태를 그대로 화면에 돌려주고, 그 밖의 오류는 Next.js가 500으로 처리하게 둡니다.
export function policyError(error: unknown): Response {
  if (error instanceof PolicyDbError) return apiError(error.code, error.status)
  throw error
}

const invalidResponse = () => new PolicyDbError('POLICY_INVALID_RESPONSE', 502)
const segment = (value: string) => encodeURIComponent(value)
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

async function call(path: string, init?: { method: 'POST'; body: unknown }): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: init?.method ?? 'GET',
      headers: { accept: 'application/json', ...(init ? { 'content-type': 'application/json' } : {}) },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    throw new PolicyDbError('POLICY_UNAVAILABLE', 503)
  }

  const body: unknown = await response.json().catch(() => null)
  if (response.ok) return body
  if (response.status >= 500) throw new PolicyDbError('POLICY_UNAVAILABLE', 502)
  // Policy는 { detail: { code } }로 거절 사유를 알려 줍니다(예: UNKNOWN_POLICY_PREDICATE).
  const code = record(record(body).detail).code
  if (typeof code === 'string') throw new PolicyDbError(code, response.status)
  throw new PolicyDbError(response.status === 422 ? 'POLICY_REJECTED' : `POLICY_HTTP_${response.status}`, response.status)
}

export type ActivePolicySummary = { policyKey: string; version: string; predicates: Predicate[] }

// 적용 중(PUBLISHED)인 정책. 없으면 null입니다. predicate 목록은 지금 이 응답에만 있습니다.
export async function getActivePolicy(): Promise<ActivePolicySummary | null> {
  let body: unknown
  try {
    body = await call('/internal/v1/policies/active')
  } catch (error) {
    if (error instanceof PolicyDbError && error.code === 'ACTIVE_POLICY_NOT_FOUND') return null
    throw error
  }
  const { policyKey, policyVersion, predicates } = record(body)
  const parsed = Array.isArray(predicates) ? predicates.map(parsePredicate) : null
  if (typeof policyKey !== 'string' || typeof policyVersion !== 'string' || !parsed || parsed.includes(null)) throw invalidResponse()
  return { policyKey, version: policyVersion, predicates: parsed as Predicate[] }
}

// 버전 상세(이름과 Rule 전체). 활성 정책 응답은 비활성 Rule·이름이 없어서 상세를 따로 읽습니다.
export async function getPolicyVersion(policyKey: string, version: string): Promise<PolicyVersion> {
  const body = record(await call(`/internal/v1/policies/${segment(policyKey)}/versions/${segment(version)}`))
  if (typeof body.name !== 'string' || !Array.isArray(body.rules)) throw invalidResponse()
  const rules: Rule[] = []
  for (const item of body.rules) {
    const parsed = parsePolicyRule(item)
    if (!parsed) throw invalidResponse()
    if ('unsupported' in parsed) throw new PolicyDbError('POLICY_UNSUPPORTED_RULE', 422)
    rules.push(parsed.rule)
  }
  return { policyKey, name: body.name, version, rules }
}

const STATUSES: readonly PolicyStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED']

// 버전 목록(Policy가 만든 시각 최신순으로 돌려줌)
export async function listPolicyVersions(policyKey: string): Promise<PolicyVersionSummary[]> {
  const { versions } = record(await call(`/internal/v1/policies/${segment(policyKey)}/versions`))
  if (!Array.isArray(versions)) throw invalidResponse()
  return versions.map((item) => {
    const { version, status, createdBy, updatedBy, createdByUserId, updatedByUserId, createdAt, publishedAt } = record(item)
    const strings = [version, createdBy, updatedBy, createdAt].every((value) => typeof value === 'string')
    if (!strings || !STATUSES.includes(status as PolicyStatus) || (publishedAt !== null && typeof publishedAt !== 'string')
      || (createdByUserId != null && typeof createdByUserId !== 'string') || (updatedByUserId != null && typeof updatedByUserId !== 'string')) {
      throw invalidResponse()
    }
    return {
      version, status, createdBy, updatedBy, createdAt, publishedAt,
      ...(typeof createdByUserId === 'string' ? { createdByUserId } : {}),
      ...(typeof updatedByUserId === 'string' ? { updatedByUserId } : {}),
    } as PolicyVersionSummary
  })
}

export async function listPredicates(): Promise<Predicate[]> {
  const { predicates } = record(await call('/internal/v1/predicates'))
  if (!Array.isArray(predicates)) throw invalidResponse()
  const parsed = predicates.map(parsePredicate)
  if (parsed.includes(null)) throw invalidResponse()
  return parsed as Predicate[]
}

export type CreateVersionInput = { policyKey: string; name: string; version: string; username: string; rules: Rule[] }

// 새 버전을 초안(DRAFT)으로 만듭니다. 바로 쓰려면 publishPolicyVersion으로 활성화합니다.
export async function createPolicyVersion({ policyKey, name, version, username, rules }: CreateVersionInput): Promise<void> {
  await call('/internal/v1/policies', {
    method: 'POST',
    body: { policyKey, name, ecosystem: 'npm', version, createdBy: username, updatedBy: username, rules: rules.map(toPolicyRule) },
  })
}

export type ApplyPolicyVersionInput = { policyKey: string; baseVersion: string; version: string; username: string; userId: string | null; rules: Rule[] }

export async function applyPolicyVersion({ policyKey, baseVersion, version, username, userId, rules }: ApplyPolicyVersionInput): Promise<void> {
  await call(`/internal/v1/policies/${segment(policyKey)}/versions`, {
    method: 'POST',
    body: { baseVersion, version, createdBy: username, createdByUserId: userId, rules },
  })
}

// 활성화: 이 버전이 판정에 쓰이고 기존 적용 버전은 Policy가 보관(ARCHIVED)합니다. Policy는 버전 상태를 검사하지 않습니다.
export async function publishPolicyVersion(policyKey: string, version: string, username: string, userId?: string): Promise<void> {
  await call(`/internal/v1/policies/${segment(policyKey)}/versions/${segment(version)}/publish`, {
    method: 'POST',
    body: { updatedBy: username, ...(userId ? { updatedByUserId: userId } : {}) },
  })
}
