import { activateVersion } from '@/features/versions/index.server'
import { apiError, authorizeRequest, readJsonObject } from '@/lib/auth/server/request'
import { VERSION_PATTERN } from '@/lib/policy/common/format'
import { policyError } from '@/lib/policy/server/policy-db'

// 활성화(되돌리기): 이 버전을 적용 중으로 바꾸고 지금 버전은 보관합니다.
// baseVersion은 화면을 열었을 때의 적용 중 버전으로, 그 사이 바뀌었으면 409로 거절합니다.
export async function POST(request: Request, { params }: { params: Promise<{ key: string; version: string }> }) {
  const auth = await authorizeRequest(request, 'policy:publish')
  if (auth.response) return auth.response

  const { key, version } = await params
  const body = await readJsonObject(request)
  const baseVersion = typeof body?.baseVersion === 'string' ? body.baseVersion : ''
  if (!VERSION_PATTERN.test(version) || !VERSION_PATTERN.test(baseVersion)) return apiError('INVALID_VERSION', 400)

  try {
    await activateVersion({ policyKey: key, version, baseVersion, username: auth.session.user.username ?? auth.session.user.name, userId: auth.session.user.id })
    return Response.json({ version })
  } catch (error) {
    return policyError(error)
  }
}
