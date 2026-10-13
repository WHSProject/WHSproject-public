import { getSessionCookie } from 'better-auth/cookies'
import { headers } from 'next/headers'
import { forbidden, redirect } from 'next/navigation'

import { hasPermission, type Permission } from '../common/permissions'
import { AUTH_ROUTES } from '../common/routes'
import { getAuth } from './auth'

// 서버 컴포넌트, Route Handler 전용입니다. 화면에서 메뉴를 숨기는 것은 UX일 뿐이고 실제 차단은 여기서 합니다.

// 현재 요청의 로그인 정보입니다. 로그인하지 않았으면 null입니다.
// headers()를 먼저 기다려야 next build가 페이지를 미리 그려 볼 때 Better Auth를 초기화하지 않습니다.
export async function getSession() {
  const requestHeaders = await headers()
  // 로그인 쿠키가 없으면 DB와 Better Auth를 거치지 않고 바로 null입니다.
  if (!getSessionCookie(requestHeaders)) return null
  return getAuth().api.getSession({ headers: requestHeaders })
}

export type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>

// 페이지·레이아웃: 로그인하지 않았으면 로그인 화면으로 보냅니다.
export async function requireSession(): Promise<Session> {
  const session = await getSession()
  if (!session) redirect(AUTH_ROUTES.login)
  return session
}

// 페이지: 권한이 없으면 403 "권한 없음" 화면(app/(dashboard)/forbidden.tsx)을 보여 줍니다.
// forbidden()은 next.config의 experimental.authInterrupts가 켜져 있어야 동작합니다.
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession()
  if (!hasPermission(session.user.role, permission)) forbidden()
  return session
}

type Authorization = { session: Session; response?: undefined } | { session?: undefined; response: Response }

// Route Handler: 로그인하지 않았으면 401, 권한이 없으면 403 응답을 돌려줍니다.
// 사용: const { session, response } = await authorize('user:manage'); if (response) return response
export async function authorize(permission: Permission): Promise<Authorization> {
  const session = await getSession()
  if (!session) return { response: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!hasPermission(session.user.role, permission)) {
    return { response: Response.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { session }
}
