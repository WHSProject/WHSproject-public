// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findRequesters, listRootRequests } from '@/lib/download-events/server/download-events'

import { loadOverview, RECENT_COUNT } from '@/features/overview/server/overview'

import { apiRule, summary } from '../../../lib/policy/fixtures'

const { getDecisionSummary, listPackages } = vi.hoisted(() => ({ getDecisionSummary: vi.fn(), listPackages: vi.fn() }))
vi.mock('@/lib/decision/server/decision-db', () => ({ getDecisionSummary, listPackages, DecisionDbError: class DecisionDbError extends Error { code: string; constructor(code: string) { super(code); this.code = code } } }))

vi.mock('@/lib/download-events/server/download-events', () => ({ findRequesters: vi.fn(), listRootRequests: vi.fn() }))

const now = new Date('2026-10-01T02:00:00Z')
const fetchMock = vi.fn()
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const rules = [
  apiRule(),
  apiRule({ ruleCode: 'RULE-REJECT-CONFIRMED-EXFIL', name: '인증 정보 유출 차단' }),
  apiRule({ ruleCode: 'RULE-HOLD', decision: 'HOLD' }),
  apiRule({ ruleCode: 'RULE-OFF', decision: 'ACCEPT', enabled: false }),
]
const policyApi = async (url: string) => {
  const path = String(url).replace('http://policy-db-api:9000', '')
  if (path === '/internal/v1/policies/active') return json(200, { policyKey: 'qa-npm-policy', policyVersion: '0.1.3', predicates: [] })
  if (path.endsWith('/versions')) return json(200, { policyKey: 'qa-npm-policy', versions: [summary({ version: '0.1.3', status: 'PUBLISHED', updatedBy: 'park_admin', publishedAt: '2026-10-01T05:20:00Z' })] })
  return json(200, { policyKey: 'qa-npm-policy', name: 'QA', version: '0.1.3', rules })
}

beforeEach(() => {
  vi.mocked(listRootRequests).mockResolvedValue([
    { requestId: 'r1', occurredAt: '2026-09-30T02:00:00Z', username: 'kim_dev', packageName: 'express', version: '5.0.0', outcome: 'DELIVERED', decision: 'ACCEPT', decisionId: 'd1' },
    { requestId: 'r2', occurredAt: '2026-09-30T03:00:00Z', username: null, packageName: 'left-pad', version: '1.3.0', outcome: 'UNAUTHENTICATED', decision: null, decisionId: null },
    { requestId: 'r3', occurredAt: now.toISOString(), username: 'kim_dev', packageName: 'express', version: '5.0.0', outcome: 'BLOCKED', decision: null, decisionId: null },
  ])
  vi.mocked(findRequesters).mockResolvedValue(new Map([['5a4298e8-0000-4000-8000-000000000001', 'kim_dev']]))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('POLICY_DB_URL', 'http://policy-db-api:9000')
  const hourly = Array.from({ length: 24 }, (_, index) => ({ hour: new Date(Date.UTC(2026, 9, 1, index)).toISOString(), total: index === 23 ? 20 : 0, notAccepted: 9 }))
  getDecisionSummary.mockResolvedValue({ from: '2026-09-30T02:00:00Z', to: '2026-10-01T02:00:00Z', total: 20, byDecision: { ACCEPT: 11, REJECT: 3, HOLD: 2, REVIEW: 4 }, hourly })
  listPackages.mockResolvedValue({ total: 6, items: [
    { decisionId: 'd1', requestId: '5a4298e8-0000-4000-8000-000000000001', packageName: 'minipass-fetch', version: '5.0.2', decision: 'REJECT', evaluatedAt: '2026-10-01T01:12:00Z', matchedRuleIds: ['RULE-REJECT-CONFIRMED-EXFIL'], policyKey: 'qa-npm-policy', policyVersion: '0.1.0' },
    { decisionId: 'd2', requestId: '5a4298e8-0000-4000-8000-000000000004', packageName: 'p-limit', version: '7.3.1', decision: 'ACCEPT', evaluatedAt: '2026-10-01T00:58:00Z', matchedRuleIds: ['RULE-ACCEPT-BENIGN'], policyKey: 'qa-npm-policy', policyVersion: '0.1.0' },
    ...Array.from({ length: 4 }, (_, i) => ({ decisionId: `d${i + 3}`, requestId: `r${i + 3}`, packageName: `pkg-${i}`, version: '1.0.0', decision: 'ACCEPT', evaluatedAt: '2026-10-01T00:00:00Z', matchedRuleIds: [], policyKey: 'qa-npm-policy', policyVersion: '0.1.0' })),
  ] })
  fetchMock.mockImplementation(policyApi)
})

afterEach(() => {
  vi.mocked(listRootRequests).mockReset()
  vi.mocked(findRequesters).mockReset()
  vi.restoreAllMocks()
  fetchMock.mockReset()
  getDecisionSummary.mockReset()
  listPackages.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('loadOverview', () => {
  it('builds the 24-hour summary, recent decisions and the active policy card', async () => {
    const data = await loadOverview(now)

    expect(listRootRequests).toHaveBeenCalledWith({ from: new Date('2026-09-30T02:00:00Z'), to: now, q: '', decision: 'ALL' })
    expect(data.installRequests).toEqual({ total: 3, hourly: [1, 1, ...Array(21).fill(0), 1] })
    expect(data.installError).toBeUndefined()
    expect(findRequesters).toHaveBeenCalledWith(data.recent.map((item) => item.requestId))
    expect(data.installRequests.hourly).toHaveLength(24)
    expect(data.installRequests.total).toBe(data.installRequests.hourly.reduce((a, b) => a + b, 0))
    expect(data.decisions.hourly).toHaveLength(24)
    expect(data.recent).toHaveLength(RECENT_COUNT)
    // 트리거된 Rule은 판정한 정책 버전(0.1.0)에서 이름을 찾고, 없는 코드는 코드 그대로 보여 줍니다.
    expect(data.recent[0]).toMatchObject({ packageName: 'minipass-fetch', username: expect.any(String), triggeredRule: { name: '인증 정보 유출 차단', others: 0 } })
    expect(data.recent[1]).toMatchObject({ packageName: 'p-limit', triggeredRule: { name: 'RULE-ACCEPT-BENIGN', others: 0 } })
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/versions/0.1.0'))).toHaveLength(1)
    // 사용 중인 Rule만 셉니다(꺼진 Rule 제외).
    expect(data.policy).toEqual({ status: 'ready', version: '0.1.3', enabledRules: 3, appliedBy: 'park_admin' })
  })

  it('isolates install query failure from decisions, policy and recent requesters', async () => {
    const error = new Error('unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listRootRequests).mockRejectedValue(error)
    const data = await loadOverview(now)
    expect(data.installError).toBe('DOWNLOAD_EVENTS_UNAVAILABLE')
    expect(data.installRequests).toEqual({ total: 0, hourly: Array(24).fill(0) })
    expect(data.decisionError).toBeUndefined()
    expect(data.decisions.total).toBe(20)
    expect(data.policy.status).toBe('ready')
    expect(data.recent).toHaveLength(RECENT_COUNT)
    expect(data.recent[0].username).toBe('kim_dev')
    expect(log).toHaveBeenCalledWith('설치 요청 조회 실패', error)
  })

  it('keeps recent decisions and rule names when requester lookup fails', async () => {
    const error = new Error('unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(findRequesters).mockRejectedValue(error)
    const data = await loadOverview(now)
    expect(data.recent).toHaveLength(RECENT_COUNT)
    expect(data.recent.every((item) => item.username === null)).toBe(true)
    expect(data.recent[0]).toMatchObject({ decisionId: 'd1', triggeredRule: { name: '인증 정보 유출 차단', others: 0 } })
    expect(data.installRequests.total).toBe(3)
    expect(data.policy.status).toBe('ready')
    expect(log).toHaveBeenCalledWith('설치 시도 사용자 조회 실패', error)
  })

  it('keeps the rest of the overview when the policy cannot be read', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const data = await loadOverview(now)

    expect(data.policy).toEqual({ status: 'unavailable', code: 'POLICY_UNAVAILABLE' })
    expect(data.recent).toHaveLength(RECENT_COUNT)
    expect(data.recent[0].triggeredRule).toEqual({ name: 'RULE-REJECT-CONFIRMED-EXFIL', others: 0 })
    expect(data.decisions.total).toBeGreaterThan(0)
  })

  it('tells when no policy is active', async () => {
    fetchMock.mockResolvedValue(json(404, { detail: { code: 'ACTIVE_POLICY_NOT_FOUND' } }))
    expect((await loadOverview(now)).policy).toEqual({ status: 'no-policy' })
  })
})
