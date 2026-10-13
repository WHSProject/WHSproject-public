import { VERSION_PATTERN } from '@/lib/policy/common/format'
import type { PolicyVersionSummary } from '@/lib/policy/common/types'

// 버전 0.{Policy 내부 버전}.{사용자 버전}. 다시 적용할 수 있는 것은 보관된 버전 중 Policy 내부 버전(앞 두 자리)이
// 지금 적용 중 버전과 같은 것뿐입니다. 초안(발행에 실패해 남은 버전)은 적용된 적이 없어 되돌리기 대상이 아닙니다.
export type VersionState = 'active' | 'applicable' | 'blocked' | 'draft'

export const VERSION_STATE_LABELS: Record<VersionState, string> = {
  active: '적용 중',
  applicable: '적용 가능',
  blocked: '적용 불가',
  draft: '초안',
}

function internalVersion(version: string): string | null {
  const match = VERSION_PATTERN.exec(version)
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

export function versionState({ version, status }: Pick<PolicyVersionSummary, 'version' | 'status'>, activeVersion: string): VersionState {
  if (version === activeVersion) return 'active'
  if (status === 'DRAFT') return 'draft'
  const current = internalVersion(activeVersion)
  return current !== null && internalVersion(version) === current ? 'applicable' : 'blocked'
}
