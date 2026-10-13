import { ADMIN_REQUEST_FAILED_MESSAGE, adminErrorMessage } from '../model/errors'

// Admin API 주소(src/app/api/admin)입니다.
export const ADMIN_API = {
  users: '/api/admin/users',
  userPasswordLink: (id: string) => `/api/admin/users/${encodeURIComponent(id)}/password-link`,
  userRole: (id: string) => `/api/admin/users/${encodeURIComponent(id)}/role`,
  userBan: (id: string) => `/api/admin/users/${encodeURIComponent(id)}/ban`,
} as const

// data: 성공 응답 본문(JSON). 본문이 없으면(204) null입니다.
export type AdminRequestResult<T = unknown> = { ok: true; data: T | null } | { ok: false; message: string }

// 성공하면 화면을 서버 데이터로 다시 그리도록(router.refresh) 호출한 쪽에 알립니다.
export async function sendAdminRequest<T = unknown>(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<AdminRequestResult<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (response.ok) return { ok: true, data: (await response.json().catch(() => null)) as T | null }

    const data: unknown = await response.json().catch(() => null)
    const code = typeof data === 'object' && data !== null && 'error' in data ? data.error : undefined
    return { ok: false, message: adminErrorMessage(code) }
  } catch {
    return { ok: false, message: ADMIN_REQUEST_FAILED_MESSAGE }
  }
}
