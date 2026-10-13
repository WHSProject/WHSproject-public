import { issueNpmToken, revokeNpmToken } from '@/features/settings/index.server'
import { apiError, authorizeRequest } from '@/lib/auth/server/request'
import { getPool } from '@/lib/db'

export async function POST(request: Request) {
  const auth = await authorizeRequest(request, 'package:install')
  if (auth.response) return auth.response
  try {
    const token = await issueNpmToken(getPool(), auth.session.user.id)
    return token
      ? Response.json(token, { headers: { 'Cache-Control': 'no-store' } })
      : apiError('INSTALL_NOT_PERMITTED', 403)
  } catch {
    return apiError('TOKEN_UPDATE_FAILED', 500)
  }
}

export async function DELETE(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.response) return auth.response
  try {
    await revokeNpmToken(getPool(), auth.session.user.id)
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return apiError('TOKEN_UPDATE_FAILED', 500)
  }
}
