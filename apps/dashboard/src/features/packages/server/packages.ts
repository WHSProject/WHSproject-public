import { DecisionDbError, getDecision, getEvidence, listEvidencesByArtifact, listPackages, listPackageVersions } from '@/lib/decision/server/decision-db'
import type { EvidenceRecord } from '@/lib/decision/types'
import type { Rule } from '@/lib/policy/common/types'
import { getActivePolicy, getPolicyVersion, PolicyDbError } from '@/lib/policy/server/policy-db'

import type { PackageDetail, PackageListPage, PackageSearch } from '../types/packages'

// Package 페이지의 읽기 순서입니다. 서버에서만 import합니다.

/** 한 페이지 패키지 수: 1080p 화면에서 목록 패널이 꽉 차는 정도(더 작은 화면은 패널 안에서 스크롤) */
export const PAGE_SIZE = 15

export type PackagesPageData = { list: PackageListPage; detail: PackageDetail | null; error?: string }

export async function loadPackagesPage(search: PackageSearch): Promise<PackagesPageData> {
  try {
    const [list, detail] = await Promise.all([loadList(search), search.selected ? loadDetail(search.selected) : null])
    return { list, detail }
  } catch (error) {
    if (!(error instanceof DecisionDbError)) throw error
    return { list: { items: [], total: 0, page: 1, pageCount: 1 }, detail: null, error: error.code }
  }
}

// 범위를 넘은 페이지(주소 직접 입력, 결과가 줄어든 경우)는 마지막 페이지를 보여 줍니다.
async function loadList({ q, decision, page }: PackageSearch): Promise<PackageListPage> {
  const first = await listPackages({ q, decision, page, pageSize: PAGE_SIZE })
  const pageCount = Math.max(1, Math.ceil(first.total / PAGE_SIZE))
  const { total, items } = page > pageCount ? await listPackages({ q, decision, page: pageCount, pageSize: PAGE_SIZE }) : first
  return { items, total, page: Math.min(page, pageCount), pageCount }
}

// 판정 1건 → 그 판정의 정책 버전 Rule, 근거, 같은 패키지의 다른 버전을 함께 읽습니다. 없는 판정이면 null입니다.
async function loadDetail(decisionId: string): Promise<PackageDetail | null> {
  const record = await getDecision(decisionId)
  if (!record) return null
  const citedEvidenceIds = [...new Set([...record.evidenceIds, ...record.assessmentIds])]

  const [policy, activeKey, directEvidences, history] = await Promise.all([
    policyRules(record.policyKey, record.policyVersion),
    activePolicyKey(),
    Promise.all(citedEvidenceIds.map(getEvidence)),
    listPackageVersions(record.subject.packageName),
  ])
  const unresolvedAssessmentIds = record.assessmentIds.filter((id) => {
    const index = citedEvidenceIds.indexOf(id)
    return index >= 0 && directEvidences[index] === null
  })
  const storedEvidences = unresolvedAssessmentIds.length > 0 ? await listEvidencesByArtifact(record) : []
  const evidences = citedEvidenceIds.map((id, index) => directEvidences[index]
    ?? resolveAssessment(id, record.assessmentIds, storedEvidences))

  return {
    decisionId: record.decisionId,
    packageName: record.subject.packageName,
    version: record.subject.packageVersion,
    decision: record.decision,
    evaluatedAt: record.evaluatedAt,
    reasonCode: record.reasonCode,
    reason: record.reason,
    policyKey: record.policyKey,
    policyVersion: record.policyVersion,
    policyError: 'error' in policy ? policy.error : null,
    // Version 페이지는 적용 중 정책 안에서만 버전을 찾으므로 정책이 같을 때만 연결합니다.
    policyLinkable: activeKey === record.policyKey,
    // 적용 중 버전이 아니라 판정한 버전의 Rule로 찾습니다.
    matchedRules: record.matchedRuleIds.map((ruleCode) => ({
      ruleCode,
      rule: 'rules' in policy ? (policy.rules.find((rule) => rule.ruleCode === ruleCode) ?? null) : null,
    })),
    evidences: evidences.flatMap((item) => (item
      ? [{ evidenceId: item.evidenceId, signalType: item.signal.type, category: item.signal.category, summary: item.assertion.summary }]
      : [])),
    missingEvidenceIds: citedEvidenceIds.filter((_, index) => evidences[index] === null),
    history,
  }
}

function resolveAssessment(id: string, assessmentIds: string[], evidences: EvidenceRecord[]): EvidenceRecord | null {
  if (!assessmentIds.includes(id)) return null
  return evidences.find((evidence) => evidence.kind === 'LLM_ASSESSMENT'
    && evidence.verificationStatus === 'VERIFIED'
    && evidence.provenance?.assessmentId === id) ?? null
}

// 적용 중 정책 key. 읽지 못하면 null(링크만 숨기고 나머지는 보여 줍니다).
async function activePolicyKey(): Promise<string | null> {
  try {
    return (await getActivePolicy())?.policyKey ?? null
  } catch (error) {
    if (error instanceof PolicyDbError) return null
    throw error
  }
}

// 정책 버전을 읽지 못해도 판정·근거는 보여 주도록 오류 코드만 돌려줍니다.
async function policyRules(policyKey: string, version: string): Promise<{ rules: Rule[] } | { error: string }> {
  try {
    return { rules: (await getPolicyVersion(policyKey, version)).rules }
  } catch (error) {
    if (error instanceof PolicyDbError) return { error: error.code }
    throw error
  }
}
