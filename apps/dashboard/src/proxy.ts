import { getSessionCookie } from 'better-auth/cookies'
import { type NextRequest, NextResponse } from 'next/server'

import { AUTH_ROUTES } from '@/lib/auth/common/routes'

// 1겹 검사: 로그인 쿠키가 없으면 로그인 화면으로 보냅니다. DB를 보지 않고 쿠키가 "있는지"만 확인하므로
// 위조·만료된 쿠키는 통과합니다. 실제 세션 확인은 각 Dashboard 페이지의 requireSession()이 합니다.
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next()

  const login = new URL(AUTH_ROUTES.login, request.url)
  login.searchParams.set('callbackURL', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(login)
}

// 보호할 Dashboard 화면만 등록합니다. 없는 주소는 404를 유지하고(CI 검사), /api·인증 화면·정적 파일은 검사하지 않습니다.
// 새 Dashboard 화면을 만들면 여기에 추가합니다. 빠뜨려도 페이지의 requireSession()이 막습니다.
export const config = {
  matcher: ['/', '/requests/:path*', '/packages/:path*', '/logs/:path*', '/rules/:path*', '/versions/:path*', '/settings/:path*', '/admin/:path*'],
}
