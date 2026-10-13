import type { PolicyVersion, PolicyVersionSummary } from '@/lib/policy/common/types'
import { currentUsernames } from '@/lib/auth/server/user-identities'
import { getActivePolicy, getPolicyVersion, listPolicyVersions, PolicyDbError, publishPolicyVersion } from '@/lib/policy/server/policy-db'

import { versionState } from '../model/versions'

// Version 페이지의 정책 읽기·활성화 순서입니다. 서버에서만 import합니다.

export type VersionsPageData =
  | { status: 'ready'; policyKey: string; activeVersion: string; versions: PolicyVersionSummary[]; viewed: PolicyVersion }
  | { status: 'no-policy' }
  | { status: 'unavailable'; code: string }

// view: Rule을 볼 버전(주소의 ?view=). 목록에 없으면 적용 중 버전을 보여 줍니다.
export async function loadVersionsPage(view: string | undefined): Promise<VersionsPageData> {
  try {
    const active = await getActivePolicy()
    if (!active) return { status: 'no-policy' }
    const versions = await listPolicyVersions(active.policyKey)
    const usernames = await currentUsernames(versions.flatMap((item) => [item.createdByUserId, item.updatedByUserId]))
    const currentNames = versions.map((item) => ({
      ...item,
      createdBy: item.createdByUserId ? (usernames.get(item.createdByUserId) ?? item.createdBy) : item.createdBy,
      updatedBy: item.updatedByUserId ? (usernames.get(item.updatedByUserId) ?? item.updatedBy) : item.updatedBy,
    }))
    const target = view !== undefined && versions.some((item) => item.version === view) ? view : active.version
    const viewed = await getPolicyVersion(active.policyKey, target)
    return { status: 'ready', policyKey: active.policyKey, activeVersion: active.version, versions: currentNames, viewed }
  } catch (error) {
    if (error instanceof PolicyDbError) return { status: 'unavailable', code: error.code }
    throw error
  }
}

export type ActivateInput = { policyKey: string; version: string; baseVersion: string; username: string; userId?: string }

// 활성화: 이 버전이 판정에 쓰이고 지금 버전은 보관됩니다. Policy 발행 API는 버전 상태를 검사하지 않으므로
// 화면을 연 뒤 적용 버전이 바뀌었는지와 적용 가능한 버전인지를 여기서 다시 확인합니다.
export async function activateVersion({ policyKey, version, baseVersion, username, userId }: ActivateInput): Promise<void> {
  const active = await getActivePolicy()
  if (!active) throw new PolicyDbError('POLICY_NOT_FOUND', 409)
  if (active.policyKey !== policyKey) throw new PolicyDbError('POLICY_NOT_FOUND', 404)
  if (active.version !== baseVersion) throw new PolicyDbError('POLICY_CHANGED', 409)

  const target = (await listPolicyVersions(policyKey)).find((item) => item.version === version)
  if (!target) throw new PolicyDbError('POLICY_VERSION_NOT_FOUND', 404)
  const state = versionState(target, active.version)
  if (state === 'active') throw new PolicyDbError('POLICY_VERSION_ALREADY_ACTIVE', 409)
  if (state !== 'applicable') throw new PolicyDbError('POLICY_VERSION_NOT_APPLICABLE', 422)

  await publishPolicyVersion(policyKey, version, username, userId)
}
