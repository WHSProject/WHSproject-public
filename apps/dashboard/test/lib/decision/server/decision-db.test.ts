// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDecision, getDecisionSummary, getEvidence, listEvidencesByArtifact, listPackages, listPackageVersions, DecisionDbError } from '@/lib/decision/server/decision-db'
import { decisionRecords, evidenceRecords } from '@/lib/decision/server/decision-db.mock'

const fetchMock = vi.fn()
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const item = (record: (typeof decisionRecords)[number]) => ({
  decisionId: record.decisionId, requestId: record.requestId, packageName: record.subject.packageName,
  version: record.subject.packageVersion, decision: record.decision, evaluatedAt: record.evaluatedAt,
  matchedRuleIds: record.matchedRuleIds, policyKey: record.policyKey, policyVersion: record.policyVersion,
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('DECISION_DB_URL', 'http://decision-db-api:9100/')
  vi.stubEnv('EVIDENCE_DB_URL', 'http://evidence-api:8100/')
})
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('Decision DB and Evidence HTTP adapters', () => {
  it('requests package pages with encoded search and decision filters', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { total: 1, items: [item(decisionRecords[0])] }))
    const result = await listPackages({ q: '@scope/pkg 1.2', decision: 'REJECT', page: 2, pageSize: 15 })
    expect(result.total).toBe(1)
    expect(result.items[0].packageName).toBe('minipass-fetch')
    expect(fetchMock.mock.calls[0][0]).toBe('http://decision-db-api:9100/internal/v1/decisions/packages?page=2&pageSize=15&q=%40scope%2Fpkg+1.2&decision=REJECT')
  })

  it('reads package versions, decision details, and evidence details from their services', async () => {
    const decision = decisionRecords[0]
    fetchMock
      .mockResolvedValueOnce(json(200, { packageName: 'minipass-fetch', versions: [item(decision)] }))
      .mockResolvedValueOnce(json(200, decision))
      .mockResolvedValueOnce(json(200, evidenceRecords[0]))
      .mockResolvedValueOnce(json(200, [evidenceRecords[0]]))
    expect((await listPackageVersions('@scope/name'))[0].version).toBe('5.0.2')
    expect(await getDecision(decision.decisionId)).toMatchObject({ reasonCode: decision.reasonCode, policyKey: 'qa-npm-policy', assessmentIds: [] })
    expect(await getEvidence(evidenceRecords[0].evidenceId)).toMatchObject({ signal: evidenceRecords[0].signal })
    expect(await listEvidencesByArtifact(decision)).toHaveLength(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('packageName=%40scope%2Fname')
    expect(String(fetchMock.mock.calls[2][0])).toContain('http://evidence-api:8100/internal/v1/evidences/')
    expect(String(fetchMock.mock.calls[3][0])).toContain('artifactHash=artifact-001')
    expect(String(fetchMock.mock.calls[3][0])).toContain('scanId=6b5399f9-0000-4000-8000-000000000001')
  })

  it('reads summaries and maps missing records to null', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', total: 1, byDecision: { ACCEPT: 0, REJECT: 1, HOLD: 0, REVIEW: 0 }, hourly: [] }))
      .mockResolvedValueOnce(json(404, { detail: { code: 'DECISION_NOT_FOUND' } }))
      .mockResolvedValueOnce(json(404, { detail: { code: 'EVIDENCE_NOT_FOUND' } }))
    expect((await getDecisionSummary(new Date('2026-10-01Z'), new Date('2026-10-02Z'))).byDecision.REJECT).toBe(1)
    expect(await getDecision('missing')).toBeNull()
    expect(await getEvidence('missing')).toBeNull()
  })

  it('surfaces service and invalid-response failures with stable codes', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(listPackages({ q: '', decision: 'ALL', page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'DECISION_DB_UNAVAILABLE' })
    fetchMock.mockResolvedValueOnce(json(200, { total: 'bad', items: [] }))
    await expect(listPackages({ q: '', decision: 'ALL', page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'DECISION_DB_INVALID_RESPONSE' })
    fetchMock.mockResolvedValueOnce(json(503, {}))
    await expect(listPackages({ q: '', decision: 'ALL', page: 1, pageSize: 10 })).rejects.toBeInstanceOf(DecisionDbError)
  })
})
