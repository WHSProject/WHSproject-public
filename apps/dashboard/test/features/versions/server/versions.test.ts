// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { activateVersion, loadVersionsPage } from '@/features/versions/server/versions'

import { apiRule, predicates, rule, summary } from '../../../lib/policy/fixtures'

const fetchMock = vi.fn()
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const active = (version = '0.1.3') => json(200, { policyKey: 'qa-npm-policy', policyVersion: version, ecosystem: 'npm', rules: [], predicates })
const versions = [
  summary({ version: '0.1.4', status: 'DRAFT', publishedAt: null }),
  summary({ version: '0.1.3', status: 'PUBLISHED', updatedBy: 'park_admin' }),
  summary({ version: '0.1.2' }),
  summary({ version: '0.0.9' }),
]
const versionList = () => json(200, { policyKey: 'qa-npm-policy', versions })
const detail = (version: string) =>
  json(200, { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version, status: 'ARCHIVED', rules: [apiRule()] })

const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace('http://policy-db-api:9000', '')}`)

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('POLICY_DB_URL', 'http://policy-db-api:9000')
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('loadVersionsPage', () => {
  it('reads the active version, the version list and the rules of the version to view', async () => {
    fetchMock.mockResolvedValueOnce(active()).mockResolvedValueOnce(versionList()).mockResolvedValueOnce(detail('0.1.2'))

    expect(await loadVersionsPage('0.1.2')).toEqual({
      status: 'ready',
      policyKey: 'qa-npm-policy',
      activeVersion: '0.1.3',
      versions,
      viewed: { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version: '0.1.2', rules: [rule()] },
    })
    expect(calls()).toEqual([
      'GET /internal/v1/policies/active',
      'GET /internal/v1/policies/qa-npm-policy/versions',
      'GET /internal/v1/policies/qa-npm-policy/versions/0.1.2',
    ])
  })

  it.each([undefined, '9.9.9', '../active'])('shows the active version when the requested one (%s) is not in the list', async (view) => {
    fetchMock.mockResolvedValueOnce(active()).mockResolvedValueOnce(versionList()).mockResolvedValueOnce(detail('0.1.3'))
    expect(await loadVersionsPage(view)).toMatchObject({ status: 'ready', viewed: { version: '0.1.3' } })
    expect(calls()[2]).toBe('GET /internal/v1/policies/qa-npm-policy/versions/0.1.3')
  })

  it('reports no active policy, an unreachable service and a malformed list', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { detail: { code: 'ACTIVE_POLICY_NOT_FOUND' } }))
    expect(await loadVersionsPage(undefined)).toEqual({ status: 'no-policy' })

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await loadVersionsPage(undefined)).toEqual({ status: 'unavailable', code: 'POLICY_UNAVAILABLE' })

    fetchMock.mockResolvedValueOnce(active()).mockResolvedValueOnce(json(200, { versions: [{ version: '0.1.3', status: 'LIVE' }] }))
    expect(await loadVersionsPage(undefined)).toEqual({ status: 'unavailable', code: 'POLICY_INVALID_RESPONSE' })
  })
})

describe('activateVersion', () => {
  const input = { policyKey: 'qa-npm-policy', version: '0.1.2', baseVersion: '0.1.3', username: 'kim_editor' }

  it('publishes an applicable archived version as the signed-in user', async () => {
    fetchMock.mockResolvedValueOnce(active()).mockResolvedValueOnce(versionList()).mockResolvedValueOnce(json(200, { status: 'PUBLISHED' }))

    await activateVersion(input)
    expect(calls()).toEqual([
      'GET /internal/v1/policies/active',
      'GET /internal/v1/policies/qa-npm-policy/versions',
      'POST /internal/v1/policies/qa-npm-policy/versions/0.1.2/publish',
    ])
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ updatedBy: 'kim_editor' })
  })

  it.each([
    ['the active version changed since the page opened', { baseVersion: '0.1.2' }, 'POLICY_CHANGED', 409],
    ['the policy key does not match', { policyKey: 'other' }, 'POLICY_NOT_FOUND', 404],
    ['the version is not in the list', { version: '0.1.9' }, 'POLICY_VERSION_NOT_FOUND', 404],
    ['the version is already active', { version: '0.1.3' }, 'POLICY_VERSION_ALREADY_ACTIVE', 409],
    ['the version belongs to an older internal version', { version: '0.0.9' }, 'POLICY_VERSION_NOT_APPLICABLE', 422],
    ['the version is a draft', { version: '0.1.4' }, 'POLICY_VERSION_NOT_APPLICABLE', 422],
  ])('refuses when %s, without publishing', async (_, overrides, code, status) => {
    fetchMock.mockResolvedValueOnce(active()).mockResolvedValueOnce(versionList())
    await expect(activateVersion({ ...input, ...overrides })).rejects.toMatchObject({ code, status })
    expect(calls().filter((call) => call.startsWith('POST'))).toEqual([])
  })

  it('refuses when there is no active policy', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { detail: { code: 'ACTIVE_POLICY_NOT_FOUND' } }))
    await expect(activateVersion(input)).rejects.toMatchObject({ code: 'POLICY_NOT_FOUND', status: 409 })
  })
})
