import { POLICY_REQUEST_FAILED_MESSAGE, policyErrorMessage } from '@/lib/policy/common/errors'

// Versions API 주소(src/app/api/policies)입니다.
export const VERSIONS_API = {
  publish: (policyKey: string, version: string) =>
    `/api/policies/${encodeURIComponent(policyKey)}/versions/${encodeURIComponent(version)}/publish`,
} as const

export type ActivateRequestResult = { ok: true } | { ok: false; message: string }

// 활성화. baseVersion은 화면을 열었을 때의 적용 중 버전입니다.
export async function activateVersionRequest(policyKey: string, version: string, baseVersion: string): Promise<ActivateRequestResult> {
  try {
    const response = await fetch(VERSIONS_API.publish(policyKey, version), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion }),
    })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, message: policyErrorMessage(typeof data === 'object' && data !== null ? (data as Record<string, unknown>).error : null) }
  } catch {
    return { ok: false, message: POLICY_REQUEST_FAILED_MESSAGE }
  }
}
