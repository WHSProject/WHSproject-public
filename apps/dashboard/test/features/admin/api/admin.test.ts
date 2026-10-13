// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ADMIN_API, sendAdminRequest } from '@/features/admin/api/admin'
import { ADMIN_REQUEST_FAILED_MESSAGE } from '@/features/admin/model/errors'

describe('admin API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('encodes ids in API paths', () => {
    expect(ADMIN_API.userRole('a/b')).toBe('/api/admin/users/a%2Fb/role')
    expect(ADMIN_API.userPasswordLink('a/b')).toBe('/api/admin/users/a%2Fb/password-link')
  })

  it('reports success, API error codes, unreadable errors and network failures', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(sendAdminRequest('/x', 'DELETE')).resolves.toEqual({ ok: true, data: null })

    fetchMock.mockResolvedValueOnce(Response.json({ url: 'u', expiresAt: 'e' }, { status: 201 }))
    await expect(sendAdminRequest('/x', 'POST')).resolves.toEqual({ ok: true, data: { url: 'u', expiresAt: 'e' } })

    fetchMock.mockResolvedValueOnce(Response.json({ error: 'USERNAME_TAKEN' }, { status: 409 }))
    await expect(sendAdminRequest('/x', 'POST', { username: 'a' })).resolves.toEqual({ ok: false, message: '이미 있는 username입니다.' })

    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 500 }))
    await expect(sendAdminRequest('/x', 'PUT')).resolves.toEqual({ ok: false, message: ADMIN_REQUEST_FAILED_MESSAGE })

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(sendAdminRequest('/x', 'PUT')).resolves.toEqual({ ok: false, message: ADMIN_REQUEST_FAILED_MESSAGE })
  })
})
