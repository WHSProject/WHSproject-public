import { applyRules } from '@/features/rules/index.server'
import { apiError, authorizeRequest, readJsonObject } from '@/lib/auth/server/request'
import { parseRulesInput, VERSION_PATTERN } from '@/lib/policy/common/format'
import { policyError } from '@/lib/policy/server/policy-db'

// 적용: 편집한 Rule 목록으로 새 버전을 만들고 바로 활성화합니다. 기존 적용 버전은 보관됩니다.
// 화면과 같은 규칙으로 다시 검사하고, 실패하면 400과 검사 결과(issues)를 돌려줍니다.
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const auth = await authorizeRequest(request, 'policy:publish')
  if (auth.response) return auth.response

  const { key } = await params
  const body = await readJsonObject(request)
  const rules = parseRulesInput(body?.rules)
  const baseVersion = typeof body?.baseVersion === 'string' ? body.baseVersion : ''
  if (!rules || !VERSION_PATTERN.test(baseVersion)) return apiError('INVALID_RULES', 400)

  try {
    const result = await applyRules({
      policyKey: key,
      baseVersion,
      rules,
      username: auth.session.user.username ?? auth.session.user.name,
      userId: auth.session.user.id,
    })
    if (!result.ok) return Response.json({ error: 'INVALID_RULES', issues: result.issues }, { status: 400 })
    return Response.json({ version: result.version }, { status: 201 })
  } catch (error) {
    return policyError(error)
  }
}
