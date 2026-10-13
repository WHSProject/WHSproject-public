// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const { requireSession, requirePermission } = vi.hoisted(() => {
  const redirect = async () => {
    throw new Error('REDIRECT /login')
  }
  return { requireSession: vi.fn(redirect), requirePermission: vi.fn(redirect) }
})

vi.mock('@/lib/auth/server/session', () => ({ requireSession, requirePermission }))

import LogsRoute from '@/app/(dashboard)/logs/page'
import OverviewRoute from '@/app/(dashboard)/page'
import PackagesRoute from '@/app/(dashboard)/packages/page'
import RequestsRoute from '@/app/(dashboard)/requests/page'
import RulesRoute from '@/app/(dashboard)/rules/page'
import VersionsRoute from '@/app/(dashboard)/versions/page'

const dashboardDir = fileURLToPath(new URL('../../../src/app/(dashboard)', import.meta.url))

describe('dashboard pages require a session', () => {
  it.each([
    ['/', OverviewRoute],
  ])('%s stops before rendering when signed out', async (_, Page) => {
    await expect(Page()).rejects.toThrow('REDIRECT /login')
  })

  it('/logs stops before reading download events when signed out', async () => {
    await expect(LogsRoute({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /login')
  })

  it('/requests stops before reading the install requests when signed out', async () => {
    await expect(RequestsRoute({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /login')
  })

  it('/packages stops before reading the package data when signed out', async () => {
    await expect(PackagesRoute({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /login')
  })

  it('/rules checks the policy:draft permission before reading the policy', async () => {
    await expect(RulesRoute()).rejects.toThrow('REDIRECT /login')
    expect(requirePermission).toHaveBeenCalledWith('policy:draft')
  })

  it('/versions checks the policy:draft permission before reading the policy', async () => {
    requirePermission.mockClear()
    await expect(VersionsRoute({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /login')
    expect(requirePermission).toHaveBeenCalledWith('policy:draft')
  })

  // 새 Dashboard 페이지를 만들 때 로그인 확인을 빠뜨리지 않도록 모든 page.tsx를 검사합니다.
  it('every page under (dashboard) calls requireSession or requirePermission', () => {
    const pages = readdirSync(dashboardDir, { recursive: true, encoding: 'utf8' }).filter((path) =>
      path.endsWith('page.tsx'),
    )

    expect(pages.length).toBeGreaterThanOrEqual(4)
    for (const page of pages) {
      const source = readFileSync(`${dashboardDir}/${page}`, 'utf8')
      expect(source, page).toMatch(/await require(Session|Permission)\(/u)
    }
  })
})
