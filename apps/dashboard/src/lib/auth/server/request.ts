import type { Permission } from '../common/permissions'
import { authorize, getSession } from './session'

// 로그인 쿠키로 인증하는 Route Handler(Admin API, 개인 설정 API)의 공용 도구입니다. 서버에서만 import합니다.

// 응답 본문은 { error: 코드 } 입니다. 화면이 코드를 문구로 바꿉니다.
export function apiError(code: string, status: number): Response {
  return Response.json({ error: code }, { status })
}

// 사용자가 접속하는 Dashboard 주소입니다(compose: DASHBOARD_PUBLIC_URL). 비밀번호 설정 링크도 이 주소로 만듭니다.
export function dashboardOrigin(): string {
  return new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:5173').origin
}

type RequestAuthorization =
  | { session: NonNullable<Awaited<ReturnType<typeof getSession>>>; response?: undefined }
  | { session?: undefined; response: Response }

// 이 Dashboard 화면에서 보낸 요청만 받습니다. 쿠키는 같은 사이트(예: 같은 localhost의 다른 포트)에서
// 보낸 요청에도 실리므로 Origin을 확인합니다. 브라우저는 GET이 아닌 요청에 Origin을 항상 붙입니다.
// permission이 없으면 로그인만 확인합니다(401). 있으면 권한도 확인합니다(403).
export async function authorizeRequest(request: Request, permission?: Permission): Promise<RequestAuthorization> {
  if (request.headers.get('origin') !== dashboardOrigin()) return { response: apiError('INVALID_ORIGIN', 403) }
  if (permission) return authorize(permission)

  const session = await getSession()
  return session ? { session } : { response: apiError('unauthorized', 401) }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

// 주소의 id가 UUID가 아니면 DB에 묻지 않고 "없음"으로 처리합니다.
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

// JSON 객체가 아니면 null입니다.
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}
