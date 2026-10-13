'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { type ReactNode, useState } from 'react'

import { ThemeToggle } from '@/components/ui/ThemeToggle/ThemeToggle'

import { authClient } from '@/lib/auth/client'
import { AUTH_ROUTES } from '@/lib/auth/common/routes'
import { hardNavigate } from '@/lib/navigation'

import styles from './AppShell.module.css'

export type ShellUser = {
  name: string
  role: string
  // 메뉴 표시 여부(UX용). 실제 차단은 각 페이지와 API가 합니다.
  canAccessAdmin?: boolean
  canEditRules?: boolean
}

const navIcons: Record<string, ReactNode> = {
  '/': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect width="7" height="9" x="3" y="3" rx="1" />
  <rect width="7" height="5" x="14" y="3" rx="1" />
  <rect width="7" height="9" x="14" y="12" rx="1" />
  <rect width="7" height="5" x="3" y="16" rx="1" />
</svg>,
  '/requests': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
  <path d="M3 3v5h5" />
  <path d="M12 7v5l4 2" />
</svg>,
  '/packages': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
  <path d="M12 22V12" />
  <path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" />
  <path d="m7.5 4.27 9 5.15" />
</svg>,
  '/logs': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M15 12h-5" />
  <path d="M15 8h-5" />
  <path d="M19 17V5a2 2 0 0 0-2-2H4" />
  <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
</svg>,
  '/rules': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  <path d="m9 12 2 2 4-4" />
</svg>,
  '/versions': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <line x1="6" x2="6" y1="3" y2="15" />
  <circle cx="18" cy="6" r="3" />
  <circle cx="6" cy="18" r="3" />
  <path d="M18 9a9 9 0 0 1-9 9" />
</svg>,
  '/settings': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
  <circle cx="12" cy="12" r="3" />
</svg>,
  '/admin': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
  <circle cx="9" cy="7" r="4" />
  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
</svg>,
}

const pageTitles: Record<string, string> = {
  '/': 'Overview',
  '/requests': '설치 요청',
  '/packages': '패키지 저장소',
  '/logs': '설치 기록',
  '/rules': '판정 정책 편집',
  '/versions': '정책 버전',
  '/settings': '개인 설정',
}

// 권한 없는 사용자의 403 화면에는 Admin 화면 이름도 보이지 않게 합니다.
const adminPageTitles: Record<string, string> = {
  '/admin/users': '사용자 관리',
  '/admin/role-changes': '권한 변경 이력',
}

// user가 없으면(로그인하지 않은 404 화면 등) 사용자 영역을 표시하지 않습니다.
export function AppShell({ children, user = null }: { children: ReactNode; user?: ShellUser | null }) {
  const pathname = usePathname()
  const title = pageTitles[pathname] ?? (user?.canAccessAdmin ? adminPageTitles[pathname] : undefined)
  const [signingOut, setSigningOut] = useState(false)

  async function handleSignOut() {
    setSigningOut(true)
    await authClient.signOut()
    hardNavigate(AUTH_ROUTES.login)
  }

  const isActive = (href: string) => pathname === href
    || (href !== '/' && pathname.startsWith(`${href}/`))

  const navClassName = (href: string) =>
    `${styles.navItem} ${isActive(href) ? styles.active : ''}`

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">A</span>
          <span>
            <strong>ARGUS</strong>
            <small>SUPPLY CHAIN</small>
          </span>
        </div>

        <nav className={styles.navigation} aria-label="주요 메뉴">
          <Link className={navClassName('/')} aria-current={isActive('/') ? 'page' : undefined} href="/">
            {navIcons['/']}
            Overview
          </Link>
          <Link className={navClassName('/requests')} aria-current={isActive('/requests') ? 'page' : undefined} href="/requests">
            {navIcons['/requests']}
            Request
          </Link>
          <Link className={navClassName('/packages')} aria-current={isActive('/packages') ? 'page' : undefined} href="/packages">
            {navIcons['/packages']}
            Package
          </Link>
          <Link className={navClassName('/logs')} aria-current={isActive('/logs') ? 'page' : undefined} href="/logs">
            {navIcons['/logs']}
            Log
          </Link>
          {user?.canEditRules ? (
            <>
              <hr className={styles.navSeparator} />
              <Link className={navClassName('/rules')} aria-current={isActive('/rules') ? 'page' : undefined} href="/rules">
                {navIcons['/rules']}
                Rule
              </Link>
              <Link className={navClassName('/versions')} aria-current={isActive('/versions') ? 'page' : undefined} href="/versions">
                {navIcons['/versions']}
                Version
              </Link>
            </>
          ) : null}
          {user ? (
            <>
              <hr className={styles.navSeparator} />
              <Link className={navClassName('/settings')} aria-current={isActive('/settings') ? 'page' : undefined} href="/settings">
                {navIcons['/settings']}
                Setting
              </Link>
              {user.canAccessAdmin ? (
                <Link className={navClassName('/admin')} aria-current={isActive('/admin') ? 'page' : undefined} href="/admin">
                  {navIcons['/admin']}
                  Admin
                </Link>
              ) : null}
            </>
          ) : null}
        </nav>
        <div className={styles.sidebarFooter}>패키지 공급망 보안<small>ARGUS SECURITY DASHBOARD</small></div>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.header}>
          <p>Security operations{title ? <> — <strong>{title}</strong></> : null}</p>
          <div className={styles.headerActions}>
          <ThemeToggle />
          {user ? (
            <div className={styles.account}>
              {/* 사용자 영역을 누르면 개인 설정으로 갑니다(사이드 메뉴 Setting과 같은 화면). */}
              <Link className={styles.user} href="/settings" aria-label={`${user.name} 개인 설정`}>
                <span className={styles.avatar} aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
                <span>{user.name}</span>
                <small className={styles.role}>{user.role}</small>
              </Link>
              <button type="button" className={styles.signOut} onClick={handleSignOut} disabled={signingOut}>
                로그아웃
              </button>
            </div>
          ) : null}
          </div>
        </header>
        <main className={styles.main}>
          {children}
        </main>
      </div>
    </div>
  )
}
