// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecisionRecord, PackageSummary } from '@/lib/decision/types'

const db = vi.hoisted(() => ({
  listPackages: vi.fn(),
  listPackageVersions: vi.fn(),
  getDecision: vi.fn(),
  getEvidence: vi.fn(),
  listEvidencesByArtifact: vi.fn(),
}))
vi.mock('@/lib/decision/server/decision-db', () => db)

import { loadPackagesPage, PAGE_SIZE } from '@/features/packages/server/packages'

import { apiRule } from '../../../lib/policy/fixtures'

const item = (version: string): PackageSummary => ({
  decisionId: `dec_${version}`, requestId: 'req_1', packageName: 'minipass-fetch', version, decision: 'REJECT', evaluatedAt: '2026-10-01T01:12:00Z', matchedRuleIds: [], policyKey: 'qa-npm-policy', policyVersion: '0.1.0',
})
const record: DecisionRecord = {
  decisionId: 'dec_5.0.2',
  requestId: 'req_1',
  scanId: 'scan_1',
  decision: 'REJECT',
  reasonCode: 'POLICY_CONFIRMED_EXFILTRATION',
  reason: 'Credential data reaches an external sink.',
  matchedRuleIds: ['RULE-REJECT-EXFIL', 'RULE-REMOVED'],
  evidenceIds: ['ev_1', 'ev_gone'],
  assessmentIds: ['llm:analysis-1:assessment-1'],
  policyKey: 'qa-npm-policy',
  policyVersion: '0.1.0',
  subject: { ecosystem: 'npm', packageName: 'minipass-fetch', packageVersion: '5.0.2', artifactHash256: 'artifact-1' },
  evaluatedAt: '2026-10-01T01:12:00Z',
}
const search = { q: '', decision: 'ALL' as const, page: 1 }

const fetchMock = vi.fn()
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const policyResponses = (activeKey = 'qa-npm-policy') => async (url: string) => (String(url).endsWith('/policies/active')
  ? json({ policyKey: activeKey, policyVersion: '0.2.0', predicates: [] })
  : json({ policyKey: 'qa-npm-policy', name: 'QA', version: '0.1.0', rules: [apiRule()] }))
const fetched = () => fetchMock.mock.calls.map(([url]) => String(url).replace('http://policy-db-api:9000', '')).sort()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('POLICY_DB_URL', 'http://policy-db-api:9000')
  db.listPackages.mockResolvedValue({ total: 23, items: [item('5.0.2')] })
  db.listPackageVersions.mockResolvedValue([item('5.0.2'), item('5.0.1')])
  db.getDecision.mockResolvedValue(record)
  db.listEvidencesByArtifact.mockResolvedValue([])
  db.getEvidence.mockImplementation(async (id: string) =>
    id === 'ev_1' ? { evidenceId: 'ev_1', signal: { type: 'CREDENTIAL_FILE_READ', category: 'CREDENTIAL' }, assertion: { summary: 'Reads ~/.npmrc' } }
      : id === 'llm:analysis-1:assessment-1' ? { evidenceId: id, signal: { type: 'LLM_ASSESSMENT', category: 'PACKAGE_METADATA' }, assertion: { summary: 'The URL is package metadata.' } }
        : null)
  fetchMock.mockImplementation(policyResponses())
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('loadPackagesPage', () => {
  it('loads one page and no detail until a package is selected', async () => {
    const data = await loadPackagesPage({ ...search, q: 'mini', decision: 'REJECT' })

    expect(db.listPackages).toHaveBeenCalledWith({ q: 'mini', decision: 'REJECT', page: 1, pageSize: PAGE_SIZE })
    expect(data.list).toEqual({ items: [item('5.0.2')], total: 23, page: 1, pageCount: 2 })
    expect(data.detail).toBeNull()
    expect(db.getDecision).not.toHaveBeenCalled()
  })

  it('shows the last page when the page is out of range', async () => {
    const data = await loadPackagesPage({ ...search, page: 9 })

    expect(db.listPackages).toHaveBeenLastCalledWith({ q: '', decision: 'ALL', page: 2, pageSize: PAGE_SIZE })
    expect(data.list.page).toBe(2)
  })

  it('builds the detail from the decision, the rules of its own policy version, evidence and history', async () => {
    const { detail } = await loadPackagesPage({ ...search, selected: 'dec_5.0.2' })

    // 적용 중 버전이 아니라 판정한 버전(0.1.0)을 읽습니다.
    expect(fetched()).toEqual(['/internal/v1/policies/active', '/internal/v1/policies/qa-npm-policy/versions/0.1.0'])
    expect(db.listPackageVersions).toHaveBeenCalledWith('minipass-fetch')
    expect(detail).toMatchObject({
      packageName: 'minipass-fetch',
      version: '5.0.2',
      reasonCode: 'POLICY_CONFIRMED_EXFILTRATION',
      policyVersion: '0.1.0',
      policyError: null,
      policyLinkable: true,
      evidences: [
        { evidenceId: 'ev_1', signalType: 'CREDENTIAL_FILE_READ', category: 'CREDENTIAL', summary: 'Reads ~/.npmrc' },
        { evidenceId: 'llm:analysis-1:assessment-1', signalType: 'LLM_ASSESSMENT', category: 'PACKAGE_METADATA', summary: 'The URL is package metadata.' },
      ],
      missingEvidenceIds: ['ev_gone'],
      history: [item('5.0.2'), item('5.0.1')],
    })
    expect(detail?.matchedRules.map(({ ruleCode, rule }) => [ruleCode, rule?.name ?? null]))
      .toEqual([['RULE-REJECT-EXFIL', 'Credential 유출 차단'], ['RULE-REMOVED', null]])
  })

  it('keeps the decision when the policy version cannot be read', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const { detail } = await loadPackagesPage({ ...search, selected: 'dec_5.0.2' })

    expect(detail?.policyError).toBe('POLICY_UNAVAILABLE')
    expect(detail?.policyLinkable).toBe(false)
    expect(detail?.matchedRules).toEqual([{ ruleCode: 'RULE-REJECT-EXFIL', rule: null }, { ruleCode: 'RULE-REMOVED', rule: null }])
    expect(detail?.evidences).toHaveLength(2)
  })

  it('resolves a cited short Assessment ID through the exact artifact and scan evidence list', async () => {
    db.getDecision.mockResolvedValue({ ...record, evidenceIds: [], assessmentIds: ['assessment-http-metadata-links'] })
    db.getEvidence.mockResolvedValue(null)
    db.listEvidencesByArtifact.mockResolvedValue([
      { evidenceId: 'llm:analysis-1:unrelated', kind: 'LLM_ASSESSMENT', verificationStatus: 'VERIFIED', provenance: { assessmentId: 'unrelated' }, signal: { type: 'OTHER', category: 'PACKAGE_METADATA' }, assertion: { summary: 'Not cited.' } },
      { evidenceId: 'llm:analysis-1:assessment-http-metadata-links', kind: 'LLM_ASSESSMENT', verificationStatus: 'VERIFIED', provenance: { assessmentId: 'assessment-http-metadata-links' }, signal: { type: 'PACKAGE_METADATA', category: 'PACKAGE_METADATA' }, assertion: { summary: 'The URLs are metadata.' } },
    ])

    const { detail } = await loadPackagesPage({ ...search, selected: 'dec_5.0.2' })

    expect(db.listEvidencesByArtifact).toHaveBeenCalledWith(expect.objectContaining({ scanId: 'scan_1' }))
    expect(detail?.evidences).toEqual([{ evidenceId: 'llm:analysis-1:assessment-http-metadata-links', signalType: 'PACKAGE_METADATA', category: 'PACKAGE_METADATA', summary: 'The URLs are metadata.' }])
    expect(detail?.missingEvidenceIds).toEqual([])
  })

  it('does not link to the Version page when the decision policy is not the active one', async () => {
    fetchMock.mockImplementation(policyResponses('prod-npm-policy'))
    const { detail } = await loadPackagesPage({ ...search, selected: 'dec_5.0.2' })

    expect(detail?.policyLinkable).toBe(false)
    expect(detail?.matchedRules[0].rule?.name).toBe('Credential 유출 차단')
  })

  it('returns no detail for an unknown decision', async () => {
    db.getDecision.mockResolvedValue(null)
    const { detail } = await loadPackagesPage({ ...search, selected: 'dec_unknown' })

    expect(detail).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
