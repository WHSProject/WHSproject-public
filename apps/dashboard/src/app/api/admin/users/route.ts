import { adminActionError, createUserAccount } from '@/features/admin/index.server'
import { roles } from '@/lib/auth/common/permissions'
import { isValidUsername, normalizeUsername } from '@/lib/auth/common/username'
import { apiError, authorizeRequest, readJsonObject } from '@/lib/auth/server/request'
import { getPool } from '@/lib/db'

// 계정 생성: username과 역할로 계정을 만들고 비밀번호 설정 링크를 돌려줍니다. 링크는 Admin이 직접 전달합니다.
export async function POST(request: Request) {
  const auth = await authorizeRequest(request, 'user:manage')
  if (auth.response) return auth.response

  const body = await readJsonObject(request)
  const username = typeof body?.username === 'string' ? normalizeUsername(body.username) : ''
  if (!isValidUsername(username)) return apiError('INVALID_USERNAME', 400)
  const role = body?.role
  if (typeof role !== 'string' || !Object.hasOwn(roles, role)) return apiError('INVALID_ROLE', 400)

  const result = await createUserAccount(getPool(), { actorId: auth.session.user.id, username, role })
  if (!result.ok) return adminActionError(result.code)
  return Response.json({ id: result.id, ...result.link }, { status: 201 })
}
