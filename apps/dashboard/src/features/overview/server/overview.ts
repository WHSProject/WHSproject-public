import { DecisionDbError, getDecisionSummary, listPackages } from '@/lib/decision/server/decision-db'
import type { PackageSummary } from '@/lib/decision/types'
import { findRequesters, listRootRequests } from '@/lib/download-events/server/download-events'
import { getActivePolicy, getPolicyVersion, listPolicyVersions, PolicyDbError } from '@/lib/policy/server/policy-db'
import { currentUsernames } from '@/lib/auth/server/user-identities'

import type { ActivePolicyCard, OverviewData, RecentDecision } from '../types/overview'

// Overview 페이지의 읽기 순서입니다. 서버에서만 import합니다.

export const RECENT_COUNT = 6
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export async function loadOverview(now = new Date()): Promise<OverviewData> {
  const from = new Date(now.getTime() - DAY_MS)
  const [decisionData, recentData, policy, installData] = await Promise.all([
    getDecisionSummary(from, now).then((data) => ({ data, error: null as string | null })).catch((error: unknown) => {
      if (error instanceof DecisionDbError) return { data: null, error: error.code }
      throw error
    }),
    listPackages({ q: '', decision: 'ALL', page: 1, pageSize: RECENT_COUNT }).then((data) => ({ data, error: null as string | null })).catch((error: unknown) => {
      if (error instanceof DecisionDbError) return { data: null, error: error.code }
      throw error
    }),
    loadPolicyCard(),
    // 설치 요청 = 루트 패키지 요청(Request 페이지와 같은 기준)
    listRootRequests({ from, to: now, q: '', decision: 'ALL' }).then((data) => ({ data, error: null as string | null })).catch((error: unknown) => {
      console.error('설치 요청 조회 실패', error)
      return { data: [], error: 'DOWNLOAD_EVENTS_UNAVAILABLE' }
    }),
  ])
  const decisions = decisionData.data ?? {
    from: from.toISOString(), to: now.toISOString(), total: 0,
    byDecision: { ACCEPT: 0, REJECT: 0, HOLD: 0, REVIEW: 0 },
    hourly: Array.from({ length: 24 }, (_, index) => ({ hour: new Date(from.getTime() + index * HOUR_MS).toISOString(), total: 0, notAccepted: 0 })),
  }
  const hourly = Array.from({ length: 24 }, () => 0)
  const installs = installData.data
  for (const item of installs) hourly[Math.min(23, Math.floor((Date.parse(item.occurredAt) - from.getTime()) / HOUR_MS))] += 1
  return {
    installRequests: { total: installs.length, hourly },
    ...(installData.error ? { installError: installData.error } : {}),
    decisions,
    ...((decisionData.error ?? recentData.error) ? { decisionError: decisionData.error ?? recentData.error! } : {}),
    policy,
    recent: await withRequesterAndRule(recentData.data?.items ?? []),
  }
}

// 최근 판정에 설치 요청 사용자(판정을 만든 요청, download_events)와 트리거된 Rule 이름을 붙입니다.
// Rule 이름은 각 판정의 정책 버전에서 찾습니다(최근 판정은 대부분 같은 버전이라 버전마다 한 번만 읽고, 읽지 못하면 Rule 코드).
async function withRequesterAndRule(items: PackageSummary[]): Promise<RecentDecision[]> {
  const versionKeys = [...new Set(items.map((item) => `${item.policyKey}@${item.policyVersion}`))]
  const [requesters, ruleNames] = await Promise.all([
    findRequesters(items.map((item) => item.requestId)).catch((error: unknown) => {
      console.error('설치 시도 사용자 조회 실패', error)
      return new Map<string, string | null>()
    }),
    Promise.all(versionKeys.map(async (key) => [key, await ruleNamesOf(key)] as const)).then((entries) => new Map(entries)),
  ])
  return items.map((item) => {
    const [first, ...rest] = item.matchedRuleIds
    const names = ruleNames.get(`${item.policyKey}@${item.policyVersion}`)
    return {
      ...item,
      username: requesters.get(item.requestId) ?? null,
      triggeredRule: first ? { name: names?.get(first) ?? first, others: rest.length } : null,
    }
  })
}

async function ruleNamesOf(key: string): Promise<Map<string, string> | null> {
  const at = key.lastIndexOf('@')
  try {
    const { rules } = await getPolicyVersion(key.slice(0, at), key.slice(at + 1))
    return new Map(rules.map((rule) => [rule.ruleCode, rule.name]))
  } catch (error) {
    if (error instanceof PolicyDbError) return null
    throw error
  }
}

// 적용 중 정책 → 그 버전의 Rule(사용 중인 것만 셈)과 버전 목록(적용한 사람)을 함께 읽습니다.
async function loadPolicyCard(): Promise<ActivePolicyCard> {
  try {
    const active = await getActivePolicy()
    if (!active) return { status: 'no-policy' }
    const [detail, versions] = await Promise.all([
      getPolicyVersion(active.policyKey, active.version),
      listPolicyVersions(active.policyKey),
    ])
    const currentNames = await currentUsernames(versions.map((item) => item.updatedByUserId))
    return {
      status: 'ready',
      version: active.version,
      enabledRules: detail.rules.filter((rule) => rule.enabled).length,
      appliedBy: (() => {
        const applied = versions.find((item) => item.version === active.version)
        return applied?.updatedByUserId ? (currentNames.get(applied.updatedByUserId) ?? applied.updatedBy) : (applied?.updatedBy ?? '-')
      })(),
    }
  } catch (error) {
    if (error instanceof PolicyDbError) return { status: 'unavailable', code: error.code }
    throw error
  }
}
