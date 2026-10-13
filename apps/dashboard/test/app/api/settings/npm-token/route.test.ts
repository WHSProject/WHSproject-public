// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getSession, query } = vi.hoisted(() => ({ getSession: vi.fn(), query: vi.fn() }))
// 세션 조회/기존 권한 검사는 대체하고 실제 Origin 검사와 토큰 저장 코드를 실행한다.
vi.mock('@/lib/auth/server/session', () => ({
  getSession,
  authorize: async () => {
    const session = await getSession()
    if (!session) return { response: Response.json({ error: 'unauthorized' }, { status: 401 }) }
    if (!['developer', 'editor', 'admin'].includes(session.user.role)) return { response: Response.json({ error: 'forbidden' }, { status: 403 }) }
    return { session }
  },
}))
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }))
import { POST, DELETE } from '@/app/api/settings/npm-token/route'

const origin = 'http://localhost:5173'
const request = (method: string, from = origin) => new Request(`${origin}/api/settings/npm-token`, {
  method, headers: { origin: from, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: 'someone-else' }),
})

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', origin)
  getSession.mockReset().mockResolvedValue({ user: { id: 'self', role: 'developer' } })
  query.mockReset().mockResolvedValue({ rows: [{ expires_at: new Date('2026-10-11T00:00:00Z') }] })
})
afterEach(() => vi.unstubAllEnvs())

describe('npm token API', () => {
  it('uses session identity, returns the secret once, and stores only its hash', async () => {
    const response = await POST(request('POST'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const data = await response.json()
    expect(data.token).toMatch(/^whs_npm_[A-Za-z0-9_-]{43}$/)
    const params = query.mock.calls[0][1]
    expect(params[0]).toBe('self')
    expect(params[1]).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(query.mock.calls)).not.toContain(data.token)
  })
  it('rejects current DB permission loss even if the session role still permits issuance', async () => {
    query.mockResolvedValue({ rows: [] })
    expect((await POST(request('POST'))).status).toBe(403)
  })
  it.each(['POST', 'DELETE'])('requires a session and correct Origin for %s', async (method) => {
    const handler = method === 'POST' ? POST : DELETE
    expect((await handler(request(method, 'https://other.example'))).status).toBe(403)
    getSession.mockResolvedValue(null)
    expect((await handler(request(method))).status).toBe(401)
    expect(query).not.toHaveBeenCalled()
  })
  it('allows a Viewer to revoke only their own token, but not issue one', async () => {
    getSession.mockResolvedValue({ user: { id: 'self', role: 'viewer' } })
    expect((await POST(request('POST'))).status).toBe(403)
    expect((await DELETE(request('DELETE'))).status).toBe(204)
    expect(query).toHaveBeenCalledWith('DELETE FROM npm_tokens WHERE user_id = $1', ['self'])
  })
  it('does not leak DB error details', async () => {
    query.mockRejectedValue(new Error('private database details'))
    const response = await POST(request('POST'))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('private database details')
  })
})
