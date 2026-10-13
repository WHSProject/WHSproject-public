import { adminActionError, changeUserRole } from '@/features/admin/index.server'
import { roles } from '@/lib/auth/common/permissions'
import { apiError, authorizeRequest, isUuid, readJsonObject } from '@/lib/auth/server/request'
import { getPool } from '@/lib/db'

// 권한 변경: 자기 자신·마지막 Admin은 바꿀 수 없고, 강등하면 대상의 로그인을 모두 끊습니다.
// 변경 내용은 권한 변경 이력에 변경한 Admin과 함께 남습니다.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeRequest(request, 'user:manage')
  if (auth.response) return auth.response

  const { id } = await params
  if (!isUuid(id)) return apiError('USER_NOT_FOUND', 404)

  const role = (await readJsonObject(request))?.role
  if (typeof role !== 'string' || !Object.hasOwn(roles, role)) return apiError('INVALID_ROLE', 400)

  const result = await changeUserRole(getPool(), { actorId: auth.session.user.id, targetId: id, role })
  if (!result.ok) return adminActionError(result.code)
  return Response.json({ changed: result.changed })
}
