// @vitest-environment node
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { config, proxy } from '@/proxy'

describe('proxy matcher', () => {
  it.each(['/', '/requests', '/packages', '/logs', '/rules', '/versions', '/packages/detail', '/settings', '/admin', '/admin/users', '/admin/role-changes'])(
    'checks the dashboard page %s',
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true)
    },
  )

  // CI는 /unknown/nested가 404인지, /api/health와 폰트가 열려 있는지 검사합니다.
  it.each([
    '/login',
    '/signup',
    '/verify-email',
    '/forgot-password',
    '/reset-password',
    '/api/health',
    '/api/auth/get-session',
    '/unknown/nested',
    '/fonts/wanted-sans-10.woff2',
    '/_next/static/chunks/app.js',
  ])('leaves %s unchecked', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false)
  })
})

describe('proxy', () => {
  it('redirects to /login with the original path when there is no session cookie', () => {
    const response = proxy(new NextRequest('http://localhost:5173/requests?day=today'))

    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('callbackURL')).toBe('/requests?day=today')
  })

  it('lets the request through when a session cookie exists (the page verifies it)', () => {
    const response = proxy(
      new NextRequest('http://localhost:5173/', { headers: { cookie: 'better-auth.session_token=forged.value' } }),
    )

    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })
})
