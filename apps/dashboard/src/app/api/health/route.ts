// 인증과 무관하게 Dashboard 프로세스의 생존만 확인합니다. DB 등 외부 의존성은 검사하지 않습니다.
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ status: 'ok', service: 'dashboard' })
}
