import { DECISIONS, type DecisionRecord, type DecisionSummary, type EvidenceRecord, type PackageListQuery, type PackageSummary } from '../types'

// Decision DB API·Evidence API 읽기입니다(Package·Overview 공용). 서버에서만 import합니다.

export class DecisionDbError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

function baseUrl(variable: 'DECISION_DB_URL' | 'EVIDENCE_DB_URL', fallbackPort: number): string {
  return (process.env[variable] ?? `http://127.0.0.1:${fallbackPort}`).replace(/\/+$/u, '')
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isDecision(value: unknown): value is DecisionRecord['decision'] {
  return DECISIONS.includes(value as DecisionRecord['decision'])
}

async function call(url: string, service: 'DECISION_DB' | 'EVIDENCE_DB' = 'DECISION_DB'): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5_000) })
  } catch {
    throw new DecisionDbError(`${service}_UNAVAILABLE`, 503)
  }
  const body: unknown = await response.json().catch(() => null)
  if (response.ok) return body
  const detail = object(object(body).detail)
  const code = typeof detail.code === 'string' ? detail.code : `${service}_HTTP_${response.status}`
  throw new DecisionDbError(response.status >= 500 ? `${service}_UNAVAILABLE` : code, response.status >= 500 ? 502 : response.status)
}

function parsePackageSummary(value: unknown): PackageSummary {
  const item = object(value)
  if (typeof item.decisionId !== 'string' || typeof item.requestId !== 'string'
    || typeof item.packageName !== 'string' || typeof item.version !== 'string' || !isDecision(item.decision)
    || typeof item.evaluatedAt !== 'string' || !Array.isArray(item.matchedRuleIds)
    || !item.matchedRuleIds.every((id) => typeof id === 'string')
    || typeof item.policyKey !== 'string' || typeof item.policyVersion !== 'string') {
    throw new DecisionDbError('DECISION_DB_INVALID_RESPONSE', 502)
  }
  return item as unknown as PackageSummary
}

function parseDecision(value: unknown): DecisionRecord {
  const item = object(value)
  const subject = object(item.subject)
  if (typeof item.decisionId !== 'string' || typeof item.requestId !== 'string' || !isDecision(item.decision)
    || typeof item.scanId !== 'string'
    || typeof item.reasonCode !== 'string' || typeof item.reason !== 'string'
    || !Array.isArray(item.matchedRuleIds) || !item.matchedRuleIds.every((id) => typeof id === 'string')
    || !Array.isArray(item.evidenceIds) || !item.evidenceIds.every((id) => typeof id === 'string')
    || !Array.isArray(item.assessmentIds) || !item.assessmentIds.every((id) => typeof id === 'string')
    || typeof item.policyKey !== 'string' || typeof item.policyVersion !== 'string'
    || subject.ecosystem !== 'npm' || typeof subject.packageName !== 'string' || typeof subject.packageVersion !== 'string'
    || (typeof subject.artifactHash256 !== 'string' && typeof subject.artifactHash512 !== 'string')
    || typeof item.evaluatedAt !== 'string') {
    throw new DecisionDbError('DECISION_DB_INVALID_RESPONSE', 502)
  }
  return item as unknown as DecisionRecord
}

function parseEvidence(value: unknown): EvidenceRecord {
  const item = object(value)
  const signal = object(item.signal)
  const assertion = object(item.assertion)
  if (typeof item.evidenceId !== 'string' || typeof signal.type !== 'string'
    || typeof signal.category !== 'string' || typeof assertion.summary !== 'string') {
    throw new DecisionDbError('EVIDENCE_DB_INVALID_RESPONSE', 502)
  }
  return item as unknown as EvidenceRecord
}

/** `GET /internal/v1/decisions/packages?q=&decision=&page=&pageSize=` */
export async function listPackages(query: PackageListQuery): Promise<{ total: number; items: PackageSummary[] }> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) })
  if (query.q) params.set('q', query.q)
  if (query.decision !== 'ALL') params.set('decision', query.decision)
  const body = object(await call(`${baseUrl('DECISION_DB_URL', 9100)}/internal/v1/decisions/packages?${params}`))
  if (typeof body.total !== 'number' || !Array.isArray(body.items)) throw new DecisionDbError('DECISION_DB_INVALID_RESPONSE', 502)
  return { total: body.total, items: body.items.map(parsePackageSummary) }
}

/** `GET /internal/v1/decisions/package-versions?packageName=` */
export async function listPackageVersions(packageName: string): Promise<PackageSummary[]> {
  const params = new URLSearchParams({ packageName })
  const body = object(await call(`${baseUrl('DECISION_DB_URL', 9100)}/internal/v1/decisions/package-versions?${params}`))
  if (!Array.isArray(body.versions)) throw new DecisionDbError('DECISION_DB_INVALID_RESPONSE', 502)
  return body.versions.map(parsePackageSummary)
}

/** `GET /internal/v1/decisions/by-decision-id/{decisionId}` (404면 null) */
export async function getDecision(decisionId: string): Promise<DecisionRecord | null> {
  try {
    return parseDecision(await call(`${baseUrl('DECISION_DB_URL', 9100)}/internal/v1/decisions/by-decision-id/${encodeURIComponent(decisionId)}`))
  } catch (error) {
    if (error instanceof DecisionDbError && error.status === 404) return null
    throw error
  }
}

/** `GET /internal/v1/evidences/{evidenceId}` (404면 null) */
export async function getEvidence(evidenceId: string): Promise<EvidenceRecord | null> {
  try {
    return parseEvidence(await call(`${baseUrl('EVIDENCE_DB_URL', 8100)}/internal/v1/evidences/${encodeURIComponent(evidenceId)}`, 'EVIDENCE_DB'))
  } catch (error) {
    if (error instanceof DecisionDbError && error.status === 404) return null
    throw error
  }
}

/** 짧은 Assessment citation을 저장된 Evidence ID로 연결하기 위한 exact artifact/scan 조회입니다. */
export async function listEvidencesByArtifact(record: DecisionRecord): Promise<EvidenceRecord[]> {
  const artifactHash = record.subject.artifactHash256 ?? record.subject.artifactHash512
  if (!artifactHash) return []
  const params = new URLSearchParams({
    ecosystem: record.subject.ecosystem,
    packageName: record.subject.packageName,
    packageVersion: record.subject.packageVersion,
    artifactHash,
    scanId: record.scanId,
  })
  const body = await call(`${baseUrl('EVIDENCE_DB_URL', 8100)}/internal/v1/evidences/by-artifact?${params}`, 'EVIDENCE_DB')
  if (!Array.isArray(body)) throw new DecisionDbError('EVIDENCE_DB_INVALID_RESPONSE', 502)
  return body.map(parseEvidence)
}

/** `GET /internal/v1/decisions/summary?from=&to=` */
export async function getDecisionSummary(from: Date, to: Date): Promise<DecisionSummary> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
  const body = object(await call(`${baseUrl('DECISION_DB_URL', 9100)}/internal/v1/decisions/summary?${params}`))
  const byDecision = object(body.byDecision)
  if (typeof body.from !== 'string' || typeof body.to !== 'string' || typeof body.total !== 'number'
    || !DECISIONS.every((decision) => typeof byDecision[decision] === 'number') || !Array.isArray(body.hourly)) {
    throw new DecisionDbError('DECISION_DB_INVALID_RESPONSE', 502)
  }
  return body as unknown as DecisionSummary
}
