import { cleanup, render, screen, within } from '@testing-library/react'
import { usePathname } from 'next/navigation'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: vi.fn(() => '/admin/users') }))

import { AdminLayout } from '@/features/admin'

afterEach(cleanup)

describe('AdminLayout', () => {
  it.each([
    ['/admin/users', '사용자 관리'],
    ['/admin/role-changes', '권한 변경 이력'],
  ])('marks the tab for %s as current', (pathname, current) => {
    vi.mocked(usePathname).mockReturnValue(pathname)
    render(<AdminLayout><p>content</p></AdminLayout>)

    const nav = within(screen.getByRole('navigation', { name: 'Admin 메뉴' }))
    expect(nav.getByRole('link', { name: current })).toHaveAttribute('aria-current', 'page')
    expect(nav.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByText('content')).toBeInTheDocument()
  })
})
