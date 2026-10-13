// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { authorize, getSession } = vi.hoisted(() => ({
  authorize: vi.fn(async () => ({ session: { user: { id: 'a1' } } })),
  getSession: vi.fn(),
}))

vi.mock('@/lib/auth/server/session', () => ({ authorize, getSession }))

import { authorizeRequest, isUuid, readJsonObject } from '@/lib/auth/server/request'

const request = (headers: Record<string, string>, body?: string) =>
  new Request('http://localhost:5173/api/admin/users', { method: 'POST', headers, body })

describe('authorizeRequest', () => {
  beforeEach(() => vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:5173'))
  afterEach(() => {
    vi.unstubAllEnvs()
    authorize.mockClear()
    getSession.mockReset()
  })

  it('checks the permission for requests from the dashboard origin', async () => {
    const result = await authorizeRequest(request({ origin: 'http://localhost:5173' }), 'user:manage')
    expect(result.response).toBeUndefined()
    expect(authorize).toHaveBeenCalledWith('user:manage')
  })

  it('only requires a signed-in user when no permission is given', async () => {
    getSession.mockResolvedValueOnce({ user: { id: 'u1' } })
    await expect(authorizeRequest(request({ origin: 'http://localhost:5173' }))).resolves.toEqual({ session: { user: { id: 'u1' } } })

    getSession.mockResolvedValueOnce(null)
    const { response } = await authorizeRequest(request({ origin: 'http://localhost:5173' }))
    expect(response?.status).toBe(401)
    expect(await response?.json()).toEqual({ error: 'unauthorized' })
    expect(authorize).not.toHaveBeenCalled()
  })

  // 같은 localhost의 다른 포트(Gateway 등)도 쿠키가 실리는 "같은 사이트"라 Origin으로 막습니다.
  it.each([
    ['another port on localhost', { origin: 'http://localhost:3000' }],
    ['127.0.0.1 instead of localhost', { origin: 'http://127.0.0.1:5173' }],
    ['no origin header', {}],
  ])('rejects %s with 403 INVALID_ORIGIN before reading the session', async (_, headers) => {
    const { response } = await authorizeRequest(request(headers), 'user:manage')
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: 'INVALID_ORIGIN' })
    expect(authorize).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
  })
})

describe('request helpers', () => {
  it('accepts only UUIDs as ids', () => {
    expect(isUuid('00000000-0000-4000-8000-00000000000a')).toBe(true)
    for (const value of ['', '1', 'not-a-uuid', "1' OR '1'='1", '00000000-0000-4000-8000-00000000000a/extra']) {
      expect(isUuid(value), value).toBe(false)
    }
  })

  it('reads only JSON objects', async () => {
    await expect(readJsonObject(request({}, '{"role":"editor"}'))).resolves.toEqual({ role: 'editor' })
    for (const body of ['[]', 'null', '"text"', 'not json', undefined]) {
      await expect(readJsonObject(request({}, body)), String(body)).resolves.toBeNull()
    }
  })
})
