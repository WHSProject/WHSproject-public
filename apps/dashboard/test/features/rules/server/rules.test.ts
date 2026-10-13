// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyRules, loadRulesPage } from '@/features/rules/server/rules'
import { PolicyDbError } from '@/lib/policy/server/policy-db'

import { apiRule, predicates, rule } from '../../../lib/policy/fixtures'

const fetchMock = vi.fn()
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const active = (version = '0.1.2') => json(200, { policyKey: 'qa-npm-policy', policyVersion: version, ecosystem: 'npm', rules: [], predicates })
const detail = (rules: unknown[] = [apiRule()]) => json(200, { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version: '0.1.2', status: 'PUBLISHED', rules })
const versionList = (versions: string[]) => json(200, { policyKey: 'qa-npm-policy', versions: versions.map((version) => ({ version, status: 'ARCHIVED', createdBy: 'qa', updatedBy: 'qa', createdAt: '2026-09-30T00:00:00Z', publishedAt: null })) })
const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace('http://policy-db-api:9000', '')}`)
const sent = (index: number) => JSON.parse(fetchMock.mock.calls[index][1].body)

beforeEach(() => { vi.stubGlobal('fetch', fetchMock); vi.stubEnv('POLICY_DB_URL', 'http://policy-db-api:9000/') })
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('loadRulesPage', () => {
  it('reads the active version detail and the independent predicate registry', async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).endsWith('/active') ? active() : String(url).endsWith('/predicates') ? json(200, { predicates }) : detail())
    expect(await loadRulesPage()).toEqual({ status: 'ready', policy: { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version: '0.1.2', rules: [rule()] }, predicates })
    expect(calls()).toEqual(['GET /internal/v1/policies/active', 'GET /internal/v1/policies/qa-npm-policy/versions/0.1.2', 'GET /internal/v1/predicates'])
  })

  it('reports absent policy, service errors, malformed answers and unsupported rules', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { detail: { code: 'ACTIVE_POLICY_NOT_FOUND' } }))
    expect(await loadRulesPage()).toEqual({ status: 'no-policy' })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await loadRulesPage()).toEqual({ status: 'unavailable', code: 'POLICY_UNAVAILABLE' })
    fetchMock.mockResolvedValueOnce(active()).mockResolvedValueOnce(detail([apiRule({ decision: 'BLOCK' })])).mockResolvedValueOnce(json(200, { predicates }))
    expect(await loadRulesPage()).toEqual({ status: 'unavailable', code: 'POLICY_INVALID_RESPONSE' })
  })
})

describe('applyRules', () => {
  const input = { policyKey: 'qa-npm-policy', baseVersion: '0.1.2', rules: [rule()], username: 'kim_editor', userId: '00000000-0000-4000-8000-000000000001' }
  const setup = () => fetchMock.mockImplementation(async (url: string) => {
    const path = String(url).replace('http://policy-db-api:9000', '')
    if (path.endsWith('/active')) return active()
    if (path.endsWith('/predicates')) return json(200, { predicates })
    if (path.endsWith('/versions')) return versionList(['0.1.0', '0.1.1', '0.1.2'])
    return json(201, { policyKey: 'qa-npm-policy', version: '0.1.3', status: 'PUBLISHED' })
  })

  it('validates against the registry and submits one atomic create-and-activate request with actor id', async () => {
    setup()
    expect(await applyRules(input)).toEqual({ ok: true, version: '0.1.3' })
    expect(calls()).toEqual([
      'GET /internal/v1/policies/active',
      'GET /internal/v1/predicates',
      'GET /internal/v1/policies/qa-npm-policy/versions',
      'POST /internal/v1/policies/qa-npm-policy/versions',
    ])
    expect(sent(3)).toMatchObject({ baseVersion: '0.1.2', version: '0.1.3', createdBy: 'kim_editor', createdByUserId: input.userId, rules: [{ ruleCode: rule().ruleCode, name: rule().name }] })
  })

  it('rejects stale edit sessions, a mismatched key, and invalid rules before mutation', async () => {
    fetchMock.mockResolvedValueOnce(active('0.1.3'))
    await expect(applyRules(input)).rejects.toMatchObject({ code: 'POLICY_CHANGED', status: 409 })
    fetchMock.mockResolvedValueOnce(active())
    await expect(applyRules({ ...input, policyKey: 'other' })).rejects.toMatchObject({ code: 'POLICY_NOT_FOUND', status: 404 })
    fetchMock.mockResolvedValueOnce(active()).mockResolvedValueOnce(json(200, { predicates }))
    expect(await applyRules({ ...input, rules: [rule({ priority: 400 })] })).toMatchObject({ ok: false, issues: [{ ruleCode: 'RULE-REJECT-EXFIL' }] })
    expect(calls().filter((call) => call.startsWith('POST'))).toEqual([])
  })

  it('passes Policy rejections through with their contract code', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url).replace('http://policy-db-api:9000', '')
      if (path.endsWith('/active')) return active()
      if (path.endsWith('/predicates')) return json(200, { predicates })
      if (init?.method === 'POST') return json(409, { detail: { code: 'POLICY_VERSION_ALREADY_EXISTS' } })
      if (path.endsWith('/versions')) return versionList(['0.1.2'])
      return detail()
    })
    await expect(applyRules(input)).rejects.toMatchObject({ code: 'POLICY_VERSION_ALREADY_EXISTS', status: 409 })
  })

  it('preserves typed Policy DB errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(applyRules(input)).rejects.toBeInstanceOf(PolicyDbError)
  })
})
