import { adminActionError, setUserBanned } from '@/features/admin/index.server'
import { apiError, authorizeRequest, isUuid } from '@/lib/auth/server/request'
import { getPool } from '@/lib/db'

// 비활성화(PUT)·활성화(DELETE): 자기 자신·마지막 Admin은 비활성화할 수 없습니다.
// 비활성화하면 대상의 로그인을 모두 끊고, 다시 로그인하면 admin 플러그인이 BANNED_USER로 막습니다.
async function update(request: Request, params: Promise<{ id: string }>, banned: boolean) {
  const auth = await authorizeRequest(request, 'user:manage')
  if (auth.response) return auth.response

  const { id } = await params
  if (!isUuid(id)) return apiError('USER_NOT_FOUND', 404)

  const result = await setUserBanned(getPool(), { actorId: auth.session.user.id, targetId: id, banned })
  if (!result.ok) return adminActionError(result.code)
  return Response.json({ changed: result.changed })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return update(request, params, true)
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return update(request, params, false)
}
