import { revokeUserSession } from '@/features/settings/index.server'
import { apiError, authorizeRequest, isUuid } from '@/lib/auth/server/request'
import { getPool } from '@/lib/db'

// 로그인된 기기 하나를 로그아웃합니다. 본인 세션만 지우며, 지금 쓰는 기기는 로그아웃 버튼을 씁니다.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeRequest(request)
  if (auth.response) return auth.response

  const { id } = await params
  if (!isUuid(id)) return apiError('SESSION_NOT_FOUND', 404)
  // PostgreSQL은 UUID를 대소문자 구분 없이 비교하므로, 소문자로 맞춘 뒤 지금 쓰는 기기인지 확인합니다.
  const sessionId = id.toLowerCase()
  if (sessionId === auth.session.session.id.toLowerCase()) return apiError('CURRENT_SESSION', 400)

  const revoked = await revokeUserSession(getPool(), auth.session.user.id, sessionId)
  return revoked ? new Response(null, { status: 204 }) : apiError('SESSION_NOT_FOUND', 404)
}
