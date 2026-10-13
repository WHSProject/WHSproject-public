import { adminActionError, issuePasswordLink } from '@/features/admin/index.server'
import { apiError, authorizeRequest, isUuid } from '@/lib/auth/server/request'
import { getPool } from '@/lib/db'

// 비밀번호 설정·재설정 링크 발급. 새로 발급하면 이전 링크는 쓸 수 없고, 자기 비밀번호는 개인 설정에서 바꿉니다.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeRequest(request, 'user:manage')
  if (auth.response) return auth.response

  const { id } = await params
  if (!isUuid(id)) return apiError('USER_NOT_FOUND', 404)

  const result = await issuePasswordLink(getPool(), { actorId: auth.session.user.id, targetId: id })
  if (!result.ok) return adminActionError(result.code)
  return Response.json(result.link, { status: 201 })
}
