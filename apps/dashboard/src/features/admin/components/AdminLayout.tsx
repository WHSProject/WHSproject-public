'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import styles from './AdminPage.module.css'

const TABS = [
  { href: '/admin/users', label: '사용자 관리' },
  { href: '/admin/role-changes', label: '권한 변경 이력' },
] as const

// Admin 화면 공통 틀(탭)입니다. 접근 차단은 각 page.tsx가 하며, 권한이 없으면 이 틀 대신 403 화면이 나옵니다.
export function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div className={styles.layout}>
      <div className={styles.pageHeading}><h1>Admin</h1><p>사용자 계정과 접근 권한을 관리합니다.</p></div>
      <nav className={styles.tabs} aria-label="Admin 메뉴">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`${styles.tab} ${active ? styles.tabActive : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>
      {children}
    </div>
  )
}
