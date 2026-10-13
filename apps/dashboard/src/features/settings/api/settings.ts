import { type SettingsErrorLike, sessionErrorMessage, SETTINGS_REQUEST_FAILED_MESSAGE } from '../model/errors'

// 개인 설정 API 주소(src/app/api/settings)입니다.
export const SETTINGS_API = {
  session: (id: string) => `/api/settings/sessions/${encodeURIComponent(id)}`,
} as const

export type SettingsRequestResult = { ok: true } | { ok: false; message: string }

// 실패 응답 본문 { error: 코드 } 를 읽습니다.
async function responseError(response: Response): Promise<SettingsErrorLike> {
  const data: unknown = await response.json().catch(() => null)
  const code = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error : undefined
  return { status: response.status, code }
}

// 로그인된 기기 하나를 로그아웃합니다.
export async function revokeSession(id: string): Promise<SettingsRequestResult> {
  try {
    const response = await fetch(SETTINGS_API.session(id), { method: 'DELETE' })
    if (response.ok) return { ok: true }
    return { ok: false, message: sessionErrorMessage(await responseError(response)) }
  } catch {
    return { ok: false, message: SETTINGS_REQUEST_FAILED_MESSAGE }
  }
}
